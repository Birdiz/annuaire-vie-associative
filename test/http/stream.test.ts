import { test } from "node:test";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { openDatabase } from "../../src/db/index.ts";
import { Counters } from "../../src/metrics/counters.ts";
import { HttpCache } from "../../src/http/cache.ts";
import { DomainThrottle } from "../../src/http/throttle.ts";
import type { LookupFn } from "../../src/http/throttle.ts";
import { HttpClient, buildUserAgent } from "../../src/http/client.ts";
import type { Handler } from "../helpers/server.ts";
import { startServer, robotsAllowAll } from "../helpers/server.ts";
import { makeTempDir } from "../helpers/tmp.ts";

const CONTACT = "https://exemple.fr/contact";
const lookupLocal: LookupFn = async () => ({ address: "127.0.0.1", family: 4 });
const CORPS = "0123456789abcdefghijklmnopqrstuvwxyz";

async function setup(t: TestContext, routes: Record<string, Handler>) {
  const server = await startServer(t, { "/robots.txt": robotsAllowAll, ...routes });
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const client = new HttpClient({
    cache: new HttpCache(makeTempDir(t)),
    throttle: new DomainThrottle({ minDelayMs: 5, lookup: lookupLocal }),
    counters: new Counters(db, null),
    userAgent: buildUserAgent("0.1.0", CONTACT),
    cacheTtlMs: 3_600_000,
  });
  return { server, client };
}

/** Sert `CORPS` en honorant `Range`, avec un ETag fixe. */
const dumpAvecRange: Handler = (req, res) => {
  const plage = /^bytes=(\d+)-$/.exec(String(req.headers["range"] ?? ""));
  const entetes: Record<string, string> = { "content-type": "text/plain", etag: '"v1"' };
  if (plage?.[1] !== undefined) {
    const debut = Number(plage[1]);
    const fragment = CORPS.slice(debut);
    res.writeHead(206, {
      ...entetes,
      "content-length": String(Buffer.byteLength(fragment)),
      "content-range": `bytes ${debut}-${CORPS.length - 1}/${CORPS.length}`,
    });
    res.end(fragment);
    return;
  }
  res.writeHead(200, { ...entetes, "content-length": String(CORPS.length) });
  res.end(CORPS);
};

/** Ignore `Range` et renvoie toujours la ressource entiere : le cas que `If-Range` ne couvre pas. */
const dumpQuiIgnoreRange: Handler = (_req, res) => {
  res.writeHead(200, { "content-type": "text/plain", "content-length": String(CORPS.length), etag: '"v2"' });
  res.end(CORPS);
};

async function collecter(body: AsyncIterable<Uint8Array>): Promise<string> {
  const morceaux: Uint8Array[] = [];
  for await (const morceau of body) morceaux.push(morceau);
  return Buffer.concat(morceaux).toString("utf8");
}

test("lit une ressource entiere au fil de l'eau", async (t) => {
  const { server, client } = await setup(t, { "/dump": dumpAvecRange });
  const flux = await client.openStream(`${server.origin}/dump`);
  assert.equal(flux.kind, "ok");
  assert.equal(flux.resumed, false);
  assert.equal(flux.totalBytes, CORPS.length);
  assert.equal(flux.etag, '"v1"');
  assert.equal(await collecter(flux.body), CORPS);
});

test("reprend a un offset et signale la reprise", async (t) => {
  const { server, client } = await setup(t, { "/dump": dumpAvecRange });
  const flux = await client.openStream(`${server.origin}/dump`, { fromByte: 10, identityEncoding: true });
  assert.equal(flux.kind, "ok");
  assert.equal(flux.resumed, true);
  // Sur une reponse partielle, c'est `Content-Range` qui porte la taille de la ressource.
  assert.equal(flux.totalBytes, CORPS.length);
  assert.equal(await collecter(flux.body), CORPS.slice(10));
});

test("un serveur qui ignore Range est detecte, pour ne pas recoller deux moities", async (t) => {
  const { server, client } = await setup(t, { "/dump": dumpQuiIgnoreRange });
  const flux = await client.openStream(`${server.origin}/dump`, { fromByte: 10 });
  assert.equal(flux.kind, "ok");
  // Le serveur a repondu 200 : l'appelant doit repartir de zero plutot que d'ajouter
  // ce corps complet a ce qu'il avait deja consomme.
  assert.equal(flux.resumed, false);
  assert.equal(await collecter(flux.body), CORPS);
});

test("identityEncoding refuse la compression de transport", async (t) => {
  const { server, client } = await setup(t, { "/dump": dumpAvecRange });
  const flux = await client.openStream(`${server.origin}/dump`, { identityEncoding: true });
  assert.equal(flux.kind, "ok");
  await collecter(flux.body);
  const requete = server.requests.find((r) => r.url.startsWith("/dump"));
  assert.equal(requete?.headers["accept-encoding"], "identity");
});

test("le User-Agent identifiable est envoye sur un flux aussi", async (t) => {
  const { server, client } = await setup(t, { "/dump": dumpAvecRange });
  const flux = await client.openStream(`${server.origin}/dump`);
  assert.equal(flux.kind, "ok");
  await collecter(flux.body);
  const requete = server.requests.find((r) => r.url.startsWith("/dump"));
  assert.match(String(requete?.headers["user-agent"]), /^AnnuaireVieAssociative\/.+\(\+https:\/\//);
});

test("robots.txt vaut aussi pour les flux", async (t) => {
  const { server, client } = await setup(t, {
    "/robots.txt": (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("User-agent: *\nDisallow: /prive/\n");
    },
    "/prive/dump": dumpAvecRange,
  });
  const flux = await client.openStream(`${server.origin}/prive/dump`);
  assert.equal(flux.kind, "blocked");
});

test("un statut d'erreur est rendu sans exception", async (t) => {
  const { server, client } = await setup(t, {});
  const flux = await client.openStream(`${server.origin}/absent`);
  assert.equal(flux.kind, "status");
  assert.equal(flux.status, 404);
});

test("le throttle s'applique aux flux", async (t) => {
  const { server, client } = await setup(t, { "/a": dumpAvecRange, "/b": dumpAvecRange });
  const premier = await client.openStream(`${server.origin}/a`);
  assert.equal(premier.kind, "ok");
  await collecter(premier.body);
  const avant = performance.now();
  const second = await client.openStream(`${server.origin}/b`);
  assert.equal(second.kind, "ok");
  await collecter(second.body);
  assert.ok(performance.now() - avant >= 4, "la seconde requete doit attendre le delai minimal");
});
