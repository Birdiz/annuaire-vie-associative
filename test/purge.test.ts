import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { openDatabase } from "../src/db/index.ts";
import { purge, cutoffFor } from "../src/purge.ts";
import { HttpCache } from "../src/http/cache.ts";
import { Counters, ETAPE } from "../src/metrics/counters.ts";
import { JobQueue } from "../src/jobs/queue.ts";
import { fixedClock, toIso } from "../src/clock.ts";
import { makeTempDir } from "./helpers/tmp.ts";

const MAINTENANT = Date.parse("2026-08-17T12:00:00.000Z");
const JOUR = 86_400_000;

function setup(t: TestContext) {
  const dir = makeTempDir(t);
  const db = openDatabase(join(dir, "test.sqlite"));
  t.after(() => db.close());
  return { db, dir, clock: fixedClock(MAINTENANT), counters: new Counters(db, null) };
}

function ajouterContact(db: ReturnType<typeof openDatabase>, codeInsee: string, collectedAt: number): void {
  db.prepare(
    `INSERT INTO contact (code_insee, kind, valeur, valeur_normalisee, source_url,
                          methode_extraction, confiance, collected_at)
     VALUES (?, 'email', ?, ?, 'https://mairie.fr/a', 'dom:mailto', 0.8, ?)`,
  ).run(codeInsee, `c${collectedAt}@x.fr`, `c${collectedAt}@x.fr`, toIso(collectedAt));
}

function ajouterCommune(db: ReturnType<typeof openDatabase>, codeInsee: string): void {
  db.prepare(
    "INSERT INTO commune (code_insee, nom, departement, created_at, updated_at) VALUES (?, 'X', '35', ?, ?)",
  ).run(codeInsee, toIso(MAINTENANT), toIso(MAINTENANT));
}

test("la borne de retention tombe exactement trois ans avant", () => {
  assert.equal(toIso(cutoffFor(MAINTENANT)), "2023-08-17T12:00:00.000Z");
  assert.equal(toIso(cutoffFor(Date.parse("2027-02-28T00:00:00.000Z"))), "2024-02-28T00:00:00.000Z");
  // Le 29 fevrier n'existe pas trois ans plus tot : JavaScript reporte au 1er mars.
  // Un jour de decalage sur une retention de trois ans, tous les quatre ans : on
  // l'accepte plutot que d'ajouter une arithmetique calendaire maison.
  assert.equal(toIso(cutoffFor(Date.parse("2028-02-29T00:00:00.000Z"))), "2025-03-01T00:00:00.000Z");
});

test("aux bornes : trois ans moins un jour reste, trois ans plus un jour part", (t) => {
  const { db, clock, counters } = setup(t);
  ajouterCommune(db, "35001");

  const borne = cutoffFor(MAINTENANT);
  ajouterContact(db, "35001", borne + JOUR); // dans le delai
  ajouterContact(db, "35001", borne - JOUR); // hors delai

  const resultat = purge(db, undefined, clock, counters);

  assert.equal(resultat.contacts, 1);
  const restants = db.prepare("SELECT collected_at FROM contact").all() as { collected_at: string }[];
  assert.equal(restants.length, 1);
  assert.equal(restants[0]?.collected_at, toIso(borne + JOUR));
  assert.equal(counters.get(ETAPE.purge, "contacts_supprimes"), 1);
});

test("les donnees ouvertes ne sont pas purgees, seules les donnees collectees le sont", (t) => {
  const { db, clock, counters } = setup(t);
  ajouterCommune(db, "35001");
  db.prepare(
    `INSERT INTO association (rna_id, code_insee, nom, nom_normalise, source_creation, created_at, updated_at)
     VALUES ('W351', '35001', 'Club', 'club', 'rna', ?, ?)`,
  ).run(toIso(MAINTENANT - 10 * 365 * JOUR), toIso(MAINTENANT - 10 * 365 * JOUR));

  ajouterContact(db, "35001", cutoffFor(MAINTENANT) - JOUR);

  purge(db, undefined, clock, counters);

  assert.equal((db.prepare("SELECT count(*) AS n FROM association").get() as { n: number }).n, 1);
  assert.equal((db.prepare("SELECT count(*) AS n FROM commune").get() as { n: number }).n, 1);
  assert.equal((db.prepare("SELECT count(*) AS n FROM contact").get() as { n: number }).n, 0);
});

test("les pages anciennes et le HTML brut correspondant partent ensemble", (t) => {
  const { db, dir, clock, counters } = setup(t);
  const cache = new HttpCache(join(dir, "cache"));

  const vieux = cutoffFor(MAINTENANT) - JOUR;
  const inserer = db.prepare(
    `INSERT INTO page (url_hash, campagne, url, domaine, planifiee_at, fetched_at)
     VALUES (?, 'c', ?, 'a.fr', ?, ?)`,
  );
  inserer.run("h1", "https://a.fr/1", toIso(vieux), toIso(vieux));
  inserer.run("h2", "https://a.fr/2", toIso(MAINTENANT), toIso(MAINTENANT));
  // Planifiee il y a plus de trois ans et jamais visitee : sans date de recuperation,
  // c'est la date d'enfilement qui la rend purgeable. Sinon elle consommerait le
  // budget de sa commune indefiniment.
  inserer.run("h3", "https://a.fr/3", toIso(vieux), null);
  // Planifiee aujourd'hui et pas encore visitee : elle reste.
  inserer.run("h4", "https://a.fr/4", toIso(MAINTENANT), null);

  const resultat = purge(db, cache, clock, counters);

  assert.equal(resultat.pages, 2);
  const restantes = (db.prepare("SELECT url_hash FROM page ORDER BY url_hash").all() as { url_hash: string }[])
    .map((row) => row.url_hash);
  assert.deepEqual(restantes, ["h2", "h4"], "une page planifiee de longue date doit partir");
});

test("un run ancien emporte ses jobs et ses metriques", (t) => {
  const { db, clock } = setup(t);
  const vieux = toIso(cutoffFor(MAINTENANT) - JOUR);

  const info = db
    .prepare("INSERT INTO run (departement, started_at, statut) VALUES ('35', ?, 'termine')")
    .run(vieux);
  const runId = Number(info.lastInsertRowid);

  new JobQueue(db).enqueue("t", "j1", null, { runId });
  new Counters(db, runId).inc("http", "requests", 12);

  const resultat = purge(db, undefined, clock);

  assert.equal(resultat.runs, 1);
  assert.equal((db.prepare("SELECT count(*) AS n FROM job").get() as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT count(*) AS n FROM metric WHERE run_id IS NOT NULL").get() as { n: number }).n, 0);
});

test("rejouer la purge est sans effet supplementaire", (t) => {
  const { db, clock, counters } = setup(t);
  ajouterCommune(db, "35001");
  ajouterContact(db, "35001", cutoffFor(MAINTENANT) - JOUR);

  assert.equal(purge(db, undefined, clock, counters).contacts, 1);
  assert.equal(purge(db, undefined, clock, counters).contacts, 0);
  assert.equal(counters.get(ETAPE.purge, "contacts_supprimes"), 1);
});

test("la purge d'une base vierge ne fait rien et n'echoue pas", (t) => {
  const { db, dir, clock } = setup(t);
  const resultat = purge(db, new HttpCache(join(dir, "cache")), clock);
  assert.deepEqual(
    { ...resultat, cutoff: "" },
    { contacts: 0, pages: 0, runs: 0, entreesCache: 0, cutoff: "" },
  );
});
