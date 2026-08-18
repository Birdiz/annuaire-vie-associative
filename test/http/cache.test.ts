import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync, utimesSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { HttpCache, canonicalizeUrl, urlHash, writeAtomic } from "../../src/http/cache.ts";
import { makeTempDir } from "../helpers/tmp.ts";

const META = {
  finalUrl: "https://exemple.fr/a",
  status: 200,
  etag: '"abc"',
  lastModified: "Mon, 17 Aug 2026 06:00:00 GMT",
  contentType: "text/html",
  fetchedAt: "2026-08-17T10:00:00.000Z",
};

test("la canonicalisation ramene les variantes d'une meme URL a une seule cle", () => {
  const attendu = "https://exemple.fr/page?a=1&b=2";
  for (const variante of [
    "https://exemple.fr/page?a=1&b=2",
    "https://EXEMPLE.fr/page?b=2&a=1",
    "https://exemple.fr:443/page?a=1&b=2#ancre",
    "HTTPS://exemple.fr/page?b=2&a=1#autre",
  ]) {
    assert.equal(canonicalizeUrl(variante), attendu, variante);
  }

  assert.equal(canonicalizeUrl("http://exemple.fr:80/"), "http://exemple.fr/");
  assert.equal(canonicalizeUrl("https://exemple.fr"), "https://exemple.fr/");
});

test("la casse du chemin est preservee, contrairement a celle de l'hote", () => {
  assert.notEqual(canonicalizeUrl("https://exemple.fr/Page"), canonicalizeUrl("https://exemple.fr/page"));
  assert.equal(urlHash("https://EXEMPLE.fr/a"), urlHash("https://exemple.fr/a"));
});

test("une entree ecrite se relit a l'identique", (t) => {
  const cache = new HttpCache(makeTempDir(t));
  const corps = Buffer.from("<html>contenu</html>", "utf8");

  const meta = cache.set("https://exemple.fr/a", META, corps);
  assert.equal(meta.size, corps.byteLength);

  const hit = cache.get("https://EXEMPLE.fr/a");
  assert.deepEqual(hit?.body, corps);
  assert.equal(hit?.meta.etag, '"abc"');
});

test("un corps tronque est traite comme une absence, pas comme une entree valide", (t) => {
  const dir = makeTempDir(t);
  const cache = new HttpCache(dir);
  cache.set("https://exemple.fr/a", META, Buffer.from("contenu complet"));

  const bodyPath = join(dir, cache.relativeBodyPath("https://exemple.fr/a"));
  writeFileSync(bodyPath, "tronq");

  assert.equal(cache.get("https://exemple.fr/a"), undefined);
  assert.equal(existsSync(bodyPath), false, "l'entree invalide doit etre nettoyee");
});

test("des metadonnees illisibles sont traitees comme une absence", (t) => {
  const dir = makeTempDir(t);
  const cache = new HttpCache(dir);
  cache.set("https://exemple.fr/a", META, Buffer.from("x"));

  const hash = urlHash("https://exemple.fr/a");
  writeFileSync(join(dir, hash.slice(0, 2), hash.slice(2, 4), `${hash}.meta.json`), "{ tronque");

  assert.equal(cache.get("https://exemple.fr/a"), undefined);
});

test("un corps manquant invalide l'entree", (t) => {
  const dir = makeTempDir(t);
  const cache = new HttpCache(dir);
  cache.set("https://exemple.fr/a", META, Buffer.from("x"));
  rmSync(join(dir, cache.relativeBodyPath("https://exemple.fr/a")));

  assert.equal(cache.get("https://exemple.fr/a"), undefined);
});

test("touch rafraichit l'horodatage sans toucher au corps", (t) => {
  const cache = new HttpCache(makeTempDir(t));
  const corps = Buffer.from("stable");
  cache.set("https://exemple.fr/a", META, corps);

  cache.touch("https://exemple.fr/a", "2026-08-18T00:00:00.000Z");

  const hit = cache.get("https://exemple.fr/a");
  assert.equal(hit?.meta.fetchedAt, "2026-08-18T00:00:00.000Z");
  assert.deepEqual(hit?.body, corps);
});

test("l'ecriture atomique ne laisse aucun fichier temporaire derriere elle", (t) => {
  const dir = makeTempDir(t);
  const cache = new HttpCache(dir);
  cache.set("https://exemple.fr/a", META, Buffer.from("contenu"));

  const hash = urlHash("https://exemple.fr/a");
  const fichiers = readdirSync(join(dir, hash.slice(0, 2), hash.slice(2, 4)));
  assert.deepEqual(fichiers.filter((f) => f.includes(".tmp")), []);
  assert.equal(fichiers.length, 2);
});

test("writeAtomic remplace le contenu en une seule etape", (t) => {
  const cible = join(makeTempDir(t), "fichier");
  writeAtomic(cible, Buffer.from("premier"));
  writeAtomic(cible, Buffer.from("second"));
  assert.equal(readFileSync(cible, "utf8"), "second");
});

test("la purge supprime les entrees anterieures a la borne et conserve les autres", (t) => {
  const dir = makeTempDir(t);
  const cache = new HttpCache(dir);

  cache.set("https://exemple.fr/vieux", META, Buffer.from("vieux"));
  cache.set("https://exemple.fr/recent", META, Buffer.from("recent"));

  const hash = urlHash("https://exemple.fr/vieux");
  const metaPath = join(dir, hash.slice(0, 2), hash.slice(2, 4), `${hash}.meta.json`);
  const vieilleDate = new Date("2020-01-01T00:00:00.000Z");
  utimesSync(metaPath, vieilleDate, vieilleDate);

  const supprimes = cache.pruneOlderThan(Date.parse("2023-01-01T00:00:00.000Z"));

  assert.equal(supprimes, 1);
  assert.equal(cache.get("https://exemple.fr/vieux"), undefined);
  assert.ok(cache.get("https://exemple.fr/recent"));
});

test("la purge d'un cache vide ne fait rien et n'echoue pas", (t) => {
  assert.equal(new HttpCache(makeTempDir(t)).pruneOlderThan(Date.now()), 0);
});
