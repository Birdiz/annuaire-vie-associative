import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync, utimesSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { HttpCache, canonicalizeUrl, urlHash, writeAtomic } from "../../src/http/cache.ts";
import { makeTempDir } from "../helpers/tmp.ts";

const META = {
  finalUrl: "https://exemple.example/a",
  status: 200,
  etag: '"abc"',
  lastModified: "Mon, 17 Aug 2026 06:00:00 GMT",
  contentType: "text/html",
  fetchedAt: "2026-08-17T10:00:00.000Z",
};

test("la canonicalisation ramene les variantes d'une meme URL a une seule cle", () => {
  const attendu = "https://exemple.example/page?a=1&b=2";
  for (const variante of [
    "https://exemple.example/page?a=1&b=2",
    "https://EXEMPLE.example/page?b=2&a=1",
    "https://exemple.example:443/page?a=1&b=2#ancre",
    "HTTPS://exemple.example/page?b=2&a=1#autre",
  ]) {
    assert.equal(canonicalizeUrl(variante), attendu, variante);
  }

  assert.equal(canonicalizeUrl("http://exemple.example:80/"), "http://exemple.example/");
  assert.equal(canonicalizeUrl("https://exemple.example"), "https://exemple.example/");
});

test("la casse du chemin est preservee, contrairement a celle de l'hote", () => {
  assert.notEqual(canonicalizeUrl("https://exemple.example/Page"), canonicalizeUrl("https://exemple.example/page"));
  assert.equal(urlHash("https://EXEMPLE.example/a"), urlHash("https://exemple.example/a"));
});

test("une entree ecrite se relit a l'identique", (t) => {
  const cache = new HttpCache(makeTempDir(t));
  const corps = Buffer.from("<html>contenu</html>", "utf8");

  const meta = cache.set("https://exemple.example/a", META, corps);
  assert.equal(meta.size, corps.byteLength);

  const hit = cache.get("https://EXEMPLE.example/a");
  assert.deepEqual(hit?.body, corps);
  assert.equal(hit?.meta.etag, '"abc"');
});

test("un corps tronque est traite comme une absence, pas comme une entree valide", (t) => {
  const dir = makeTempDir(t);
  const cache = new HttpCache(dir);
  cache.set("https://exemple.example/a", META, Buffer.from("contenu complet"));

  const bodyPath = join(dir, cache.relativeBodyPath("https://exemple.example/a"));
  writeFileSync(bodyPath, "tronq");

  assert.equal(cache.get("https://exemple.example/a"), undefined);
  assert.equal(existsSync(bodyPath), false, "l'entree invalide doit etre nettoyee");
});

test("des metadonnees illisibles sont traitees comme une absence", (t) => {
  const dir = makeTempDir(t);
  const cache = new HttpCache(dir);
  cache.set("https://exemple.example/a", META, Buffer.from("x"));

  const hash = urlHash("https://exemple.example/a");
  writeFileSync(join(dir, hash.slice(0, 2), hash.slice(2, 4), `${hash}.meta.json`), "{ tronque");

  assert.equal(cache.get("https://exemple.example/a"), undefined);
});

test("un corps manquant invalide l'entree", (t) => {
  const dir = makeTempDir(t);
  const cache = new HttpCache(dir);
  cache.set("https://exemple.example/a", META, Buffer.from("x"));
  rmSync(join(dir, cache.relativeBodyPath("https://exemple.example/a")));

  assert.equal(cache.get("https://exemple.example/a"), undefined);
});

test("touch rafraichit l'horodatage sans toucher au corps", (t) => {
  const cache = new HttpCache(makeTempDir(t));
  const corps = Buffer.from("stable");
  cache.set("https://exemple.example/a", META, corps);

  cache.touch("https://exemple.example/a", "2026-08-18T00:00:00.000Z");

  const hit = cache.get("https://exemple.example/a");
  assert.equal(hit?.meta.fetchedAt, "2026-08-18T00:00:00.000Z");
  assert.deepEqual(hit?.body, corps);
});

test("l'ecriture atomique ne laisse aucun fichier temporaire derriere elle", (t) => {
  const dir = makeTempDir(t);
  const cache = new HttpCache(dir);
  cache.set("https://exemple.example/a", META, Buffer.from("contenu"));

  const hash = urlHash("https://exemple.example/a");
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

  cache.set("https://exemple.example/vieux", META, Buffer.from("vieux"));
  cache.set("https://exemple.example/recent", META, Buffer.from("recent"));

  const hash = urlHash("https://exemple.example/vieux");
  const metaPath = join(dir, hash.slice(0, 2), hash.slice(2, 4), `${hash}.meta.json`);
  const vieilleDate = new Date("2020-01-01T00:00:00.000Z");
  utimesSync(metaPath, vieilleDate, vieilleDate);

  const supprimes = cache.pruneOlderThan(Date.parse("2023-01-01T00:00:00.000Z"));

  assert.equal(supprimes, 1);
  assert.equal(cache.get("https://exemple.example/vieux"), undefined);
  assert.ok(cache.get("https://exemple.example/recent"));
});

test("la purge d'un cache vide ne fait rien et n'echoue pas", (t) => {
  assert.equal(new HttpCache(makeTempDir(t)).pruneOlderThan(Date.now()), 0);
});

test("la purge date sur fetchedAt, pas sur le mtime du fichier", (t) => {
  // Une restauration de sauvegarde, un `docker cp` ou une synchronisation cloud
  // reecrivent les horodatages du systeme de fichiers. Se fier au mtime rendait
  // « fraiches » — et donc immortelles — des donnees personnelles de plus de trois ans.
  const dir = makeTempDir(t);
  const cache = new HttpCache(dir);
  cache.set("https://exemple.example/vieux", { ...META, fetchedAt: "2020-03-01T00:00:00.000Z" }, Buffer.from("v"));
  cache.set("https://exemple.example/recent", { ...META, fetchedAt: "2026-08-01T00:00:00.000Z" }, Buffer.from("r"));

  // Tout le repertoire vient d'etre restaure : mtime du jour sur les deux entrees.
  const maintenant = new Date();
  for (const chemin of cheminsMeta(dir)) utimesSync(chemin, maintenant, maintenant);

  const supprimes = cache.pruneOlderThan(Date.parse("2023-08-17T00:00:00.000Z"), Date.now());

  assert.equal(supprimes, 1);
  assert.equal(cache.get("https://exemple.example/vieux"), undefined, "l'entree de 2020 devait partir");
  assert.ok(cache.get("https://exemple.example/recent"), "l'entree de 2026 devait rester");
});

test("la purge emporte les corps orphelins et les temporaires abandonnes", (t) => {
  // `set()` ecrit le corps puis les metadonnees : un `kill -9` entre les deux laisse un
  // `.body` seul, et `writeAtomic` interrompu laisse un `.tmp`. Les deux portent du HTML
  // de mairie. La purge ne parcourant que les `*.meta.json`, ils survivaient a jamais.
  const dir = makeTempDir(t);
  const cache = new HttpCache(dir);
  cache.set("https://exemple.example/a", META, Buffer.from("a"));

  const hash = urlHash("https://exemple.example/a");
  const sousDossier = join(dir, hash.slice(0, 2), hash.slice(2, 4));
  const orphelin = join(sousDossier, `${"f".repeat(64)}.body`);
  const temporaire = join(sousDossier, `${"e".repeat(64)}.body.4242.tmp`);
  writeFileSync(orphelin, "contact@mairie.example");
  writeFileSync(temporaire, "contact@mairie.example");

  // Plus vieux que le delai de grace : ces fichiers ne sont pas en cours d'ecriture.
  const hier = new Date(Date.now() - 86_400_000);
  for (const chemin of [orphelin, temporaire]) utimesSync(chemin, hier, hier);

  const supprimes = cache.pruneOlderThan(Date.parse("2023-08-17T00:00:00.000Z"), Date.now());

  assert.equal(existsSync(orphelin), false, "le corps orphelin devait partir");
  assert.equal(existsSync(temporaire), false, "le temporaire abandonne devait partir");
  assert.equal(supprimes, 2);
  assert.ok(cache.get("https://exemple.example/a"), "l'entree complete et recente devait rester");
});

test("une ecriture en cours n'est pas prise pour un abandon", (t) => {
  const dir = makeTempDir(t);
  const cache = new HttpCache(dir);
  cache.set("https://exemple.example/a", META, Buffer.from("a"));
  const hash = urlHash("https://exemple.example/a");
  const enCours = join(dir, hash.slice(0, 2), hash.slice(2, 4), `${"d".repeat(64)}.body.99.tmp`);
  writeFileSync(enCours, "en cours");

  cache.pruneOlderThan(Date.parse("2023-08-17T00:00:00.000Z"), Date.now());
  assert.ok(existsSync(enCours), "un temporaire de la seconde ne doit pas etre efface sous un autre process");
});

test("lire une entree sans metadonnees en supprime le corps", (t) => {
  const dir = makeTempDir(t);
  const cache = new HttpCache(dir);
  cache.set("https://exemple.example/a", META, Buffer.from("a"));

  const hash = urlHash("https://exemple.example/a");
  const sousDossier = join(dir, hash.slice(0, 2), hash.slice(2, 4));
  rmSync(join(sousDossier, `${hash}.meta.json`));

  assert.equal(cache.get("https://exemple.example/a"), undefined);
  assert.equal(existsSync(join(sousDossier, `${hash}.body`)), false, "le corps devenu illisible devait partir");
});

function cheminsMeta(racine: string): string[] {
  const trouves: string[] = [];
  for (const bucket of readdirSync(racine)) {
    for (const sous of readdirSync(join(racine, bucket))) {
      for (const fichier of readdirSync(join(racine, bucket, sous))) {
        if (fichier.endsWith(".meta.json")) trouves.push(join(racine, bucket, sous, fichier));
      }
    }
  }
  return trouves;
}
