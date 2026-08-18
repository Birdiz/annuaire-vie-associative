import { test } from "node:test";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { openDatabase } from "../../src/db/index.ts";
import { Counters, ETAPE } from "../../src/metrics/counters.ts";
import { HttpCache } from "../../src/http/cache.ts";
import { DomainThrottle } from "../../src/http/throttle.ts";
import type { LookupFn } from "../../src/http/throttle.ts";
import { HttpClient, TooLargeError, buildUserAgent } from "../../src/http/client.ts";
import type { Handler } from "../helpers/server.ts";
import { startServer, text, robotsAllowAll } from "../helpers/server.ts";
import { makeTempDir } from "../helpers/tmp.ts";

const CONTACT = "https://exemple.fr/contact";
const lookupLocal: LookupFn = async () => ({ address: "127.0.0.1", family: 4 });

async function setup(
  t: TestContext,
  routes: Record<string, Handler>,
  options: { minDelayMs?: number; cacheTtlMs?: number } = {},
) {
  const server = await startServer(t, { "/robots.txt": robotsAllowAll, ...routes });
  const db = openDatabase(":memory:");
  t.after(() => db.close());

  const counters = new Counters(db, null);
  const client = new HttpClient({
    cache: new HttpCache(makeTempDir(t)),
    throttle: new DomainThrottle({ minDelayMs: options.minDelayMs ?? 5, lookup: lookupLocal }),
    counters,
    userAgent: buildUserAgent("0.1.0", CONTACT),
    cacheTtlMs: options.cacheTtlMs ?? 3_600_000,
  });

  return { server, client, counters };
}

test("une reponse est mise en cache et la requete suivante n'atteint pas le reseau", async (t) => {
  const { server, client, counters } = await setup(t, { "/page": text("<html>a</html>") });

  const premier = await client.fetch(`${server.origin}/page`);
  const second = await client.fetch(`${server.origin}/page`);

  assert.equal(premier.kind, "ok");
  assert.equal(premier.source, "network");
  assert.equal(second.kind, "ok");
  assert.equal(second.source, "cache");
  assert.equal(server.countOf("/page"), 1, "la seconde requete aurait du etre servie par le cache");
  assert.equal(counters.get(ETAPE.http, "cache_hits"), 1);
  assert.equal(counters.get(ETAPE.http, "cache_miss"), 1);
});

test("le User-Agent annonce le produit et une URL de contact joignable", async (t) => {
  const { server, client } = await setup(t, { "/page": text("ok") });
  await client.fetch(`${server.origin}/page`);

  for (const requete of server.requests) {
    const ua = String(requete.headers["user-agent"]);
    assert.match(ua, /^AnnuaireVieAssociative\/0\.1\.0 \(\+https:\/\/exemple\.fr\/contact\)$/, requete.url);
  }
});

test("une URL interdite par robots.txt n'est jamais demandee", async (t) => {
  const { server, client, counters } = await setup(t, {
    "/robots.txt": text("User-agent: *\nDisallow: /prive\n"),
    "/prive": text("secret"),
    "/public": text("ok"),
  });

  const interdit = await client.fetch(`${server.origin}/prive`);
  const autorise = await client.fetch(`${server.origin}/public`);

  assert.equal(interdit.kind, "blocked");
  assert.match(interdit.reason, /robots\.txt interdit/);
  assert.equal(autorise.kind, "ok");
  assert.equal(server.countOf("/prive"), 0, "aucune requete ne doit partir vers une URL interdite");
  assert.equal(counters.get(ETAPE.http, "robots_blocked"), 1);
});

test("robots.txt absent (404) autorise la collecte", async (t) => {
  const { server, client } = await setup(t, {
    "/robots.txt": text("introuvable", 404),
    "/page": text("ok"),
  });
  assert.equal((await client.fetch(`${server.origin}/page`)).kind, "ok");
});

test("robots.txt en erreur serveur (5xx) fait renoncer a tout le site", async (t) => {
  const { server, client } = await setup(t, {
    "/robots.txt": text("panne", 503),
    "/page": text("ok"),
  });

  const resultat = await client.fetch(`${server.origin}/page`);

  assert.equal(resultat.kind, "blocked");
  assert.equal(server.countOf("/page"), 0);
});

test("robots.txt n'est demande qu'une fois par origine", async (t) => {
  const { server, client } = await setup(t, { "/a": text("a"), "/b": text("b") });

  await client.fetch(`${server.origin}/a`);
  await client.fetch(`${server.origin}/b`);

  assert.equal(server.countOf("/robots.txt"), 1);
});

test("un Crawl-delay superieur au plancher est respecte", async (t) => {
  const { server, client } = await setup(
    t,
    { "/robots.txt": text("User-agent: *\nCrawl-delay: 0.3\n"), "/a": text("a"), "/b": text("b") },
    { minDelayMs: 5 },
  );

  await client.fetch(`${server.origin}/a`);
  await client.fetch(`${server.origin}/b`);

  const pages = server.requests.filter((r) => r.url === "/a" || r.url === "/b");
  assert.equal(pages.length, 2);
  const ecart = pages[1]!.at - pages[0]!.at;
  assert.ok(ecart >= 295, `Crawl-delay de 300 ms non respecte : ${ecart.toFixed(0)} ms`);
});

test("une entree perimee est revalidee, et un 304 evite de retelecharger", async (t) => {
  const etag = '"v1"';
  const { server, client, counters } = await setup(
    t,
    {
      "/page": (req, res) => {
        if (req.headers["if-none-match"] === etag) {
          res.writeHead(304, { etag });
          res.end();
          return;
        }
        res.writeHead(200, { etag, "content-type": "text/html" });
        res.end("<html>v1</html>");
      },
    },
    { cacheTtlMs: 0 },
  );

  const premier = await client.fetch(`${server.origin}/page`);
  const second = await client.fetch(`${server.origin}/page`);

  assert.equal(premier.kind, "ok");
  assert.equal(premier.source, "network");
  assert.equal(second.kind, "ok");
  assert.equal(second.source, "revalidated");
  assert.equal(second.body.toString(), "<html>v1</html>", "le corps vient du cache");
  assert.equal(counters.get(ETAPE.http, "revalidated"), 1);
  assert.equal(server.countOf("/page"), 2);
});

test("les redirections sont suivies et le corps final est mis en cache", async (t) => {
  const { server, client } = await setup(t, {
    "/depart": (_req, res) => {
      res.writeHead(302, { location: "/arrivee" });
      res.end();
    },
    "/arrivee": text("<html>arrivee</html>"),
  });

  const resultat = await client.fetch(`${server.origin}/depart`);

  assert.equal(resultat.kind, "ok");
  assert.equal(resultat.body.toString(), "<html>arrivee</html>");
  assert.match(resultat.meta.finalUrl, /\/arrivee$/);
  assert.equal(resultat.meta.url, `${server.origin}/depart`, "la cle de cache reste l'URL demandee");
});

test("une redirection vers un chemin interdit est bloquee", async (t) => {
  const { server, client } = await setup(t, {
    "/robots.txt": text("User-agent: *\nDisallow: /prive\n"),
    "/depart": (_req, res) => {
      res.writeHead(302, { location: "/prive" });
      res.end();
    },
    "/prive": text("secret"),
  });

  const resultat = await client.fetch(`${server.origin}/depart`);

  assert.equal(resultat.kind, "blocked");
  assert.equal(server.countOf("/prive"), 0);
});

test("une boucle de redirection s'arrete au plafond", async (t) => {
  const { server, client } = await setup(t, {
    "/boucle": (_req, res) => {
      res.writeHead(302, { location: "/boucle?n=1" });
      res.end();
    },
  });

  const resultat = await client.fetch(`${server.origin}/boucle`);

  assert.equal(resultat.kind, "status");
  assert.equal(resultat.status, 310);
  assert.ok(server.countOf("/boucle") <= 6, "le plafond de redirections doit s'appliquer");
});

test("un 429 est signale et repousse le creneau du domaine", async (t) => {
  const { server, client, counters } = await setup(t, {
    "/page": (_req, res) => {
      res.writeHead(429, { "retry-after": "1" });
      res.end("trop vite");
    },
  });

  const debut = performance.now();
  const resultat = await client.fetch(`${server.origin}/page`);
  assert.equal(resultat.kind, "status");
  assert.equal(resultat.status, 429);
  assert.equal(counters.get(ETAPE.http, "throttled_429"), 1);

  await client.fetch(`${server.origin}/autre`).catch(() => undefined);
  const ecoule = performance.now() - debut;
  assert.ok(ecoule >= 950, `le Retry-After de 1 s doit etre respecte (${ecoule.toFixed(0)} ms)`);
});

test("une reponse trop volumineuse est refusee, annoncee ou non", async (t) => {
  const gros = "x".repeat(200_000);
  const { server, client } = await setup(t, {
    // Cas facile : le serveur annonce sa taille, on refuse avant de lire.
    "/annonce": text(gros, 200, { "content-length": String(gros.length) }),
    // Cas reel : encodage par blocs, aucune taille annoncee. Seul le plafond applique
    // pendant la lecture protege ici — c'est lui qu'on veut voir declencher.
    "/inconnu": (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      for (let i = 0; i < 20; i += 1) res.write("x".repeat(10_000));
      res.end();
    },
  });

  await assert.rejects(() => client.fetch(`${server.origin}/annonce`, { maxBytes: 1_000 }), TooLargeError);
  await assert.rejects(() => client.fetch(`${server.origin}/inconnu`, { maxBytes: 1_000 }), TooLargeError);
});

test("un schema non http est refuse avant toute requete", async (t) => {
  const { client } = await setup(t, {});
  await assert.rejects(() => client.fetch("ftp://exemple.fr/fichier"), /Schema non supporte/);
  await assert.rejects(() => client.fetch("file:///etc/passwd"), /Schema non supporte/);
});

test("un statut d'erreur est rendu tel quel, sans mise en cache", async (t) => {
  const { server, client } = await setup(t, { "/absent": text("introuvable", 404) });

  const premier = await client.fetch(`${server.origin}/absent`);
  const second = await client.fetch(`${server.origin}/absent`);

  assert.equal(premier.kind, "status");
  assert.equal(premier.status, 404);
  assert.equal(second.kind, "status");
  assert.equal(server.countOf("/absent"), 2, "une erreur ne doit pas etre servie depuis le cache");
});

/**
 * Les autres tests utilisent un delai court pour rester rapides. Celui-ci verifie la
 * valeur reelle de l'invariant §4.3, de bout en bout, sans rien injecter.
 */
test("INVARIANT : deux requetes vers un meme hote sont espacees d'au moins 2 s", { timeout: 30_000 }, async (t) => {
  const server = await startServer(t, {
    "/robots.txt": robotsAllowAll,
    "/a": text("a"),
    "/b": text("b"),
  });
  const db = openDatabase(":memory:");
  t.after(() => db.close());

  // On mesure au depart et non a l'arrivee : la premiere requete ouvre une connexion
  // TCP quand la seconde reutilise le keep-alive, si bien que l'ecart mesure cote
  // serveur est legerement inferieur a l'ecart reel entre nos emissions. C'est bien
  // l'instant ou l'on sollicite le site que l'invariant contraint.
  const departs: { url: string; at: number }[] = [];
  const client = new HttpClient({
    cache: new HttpCache(makeTempDir(t)),
    // Aucun delai injecte : c'est la valeur de production qui est mesuree.
    throttle: new DomainThrottle({ lookup: lookupLocal }),
    counters: new Counters(db, null),
    userAgent: buildUserAgent("0.1.0", CONTACT),
    cacheTtlMs: 3_600_000,
    fetchImpl: (input, init) => {
      departs.push({ url: String(input), at: performance.now() });
      return globalThis.fetch(input, init);
    },
  });

  await client.fetch(`${server.origin}/a`);
  await client.fetch(`${server.origin}/b`);

  const pages = departs.filter((r) => r.url.endsWith("/a") || r.url.endsWith("/b"));
  assert.equal(pages.length, 2);
  const ecart = pages[1]!.at - pages[0]!.at;
  assert.ok(ecart >= 2_000, `espacement insuffisant : ${ecart.toFixed(1)} ms`);
});
