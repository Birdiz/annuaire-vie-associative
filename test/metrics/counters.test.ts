import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, transaction } from "../../src/db/index.ts";
import { Counters, ETAPE } from "../../src/metrics/counters.ts";
import type { TestContext } from "node:test";

/**
 * Les compteurs sont **l'oracle** des tests de reprise : `test/decouverte/reprise.test.ts`
 * s'en sert explicitement pour prouver l'exactement-une-fois, parce que les index uniques
 * de `contact` masqueraient un rejeu. Un oracle sans test propre est un oracle qu'on croit
 * sur parole — si `inc` avait un defaut, le code teste et le juge seraient faux ensemble.
 */

function base(t: TestContext) {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  return db;
}

test("les increments s'accumulent, par etape et par nom", (t) => {
  const c = new Counters(base(t), null);
  c.inc(ETAPE.http, "requests");
  c.inc(ETAPE.http, "requests", 4);
  c.inc(ETAPE.http, "cache_hits");
  c.inc(ETAPE.decouverte, "requests");

  assert.equal(c.get(ETAPE.http, "requests"), 5);
  assert.equal(c.get(ETAPE.http, "cache_hits"), 1);
  assert.equal(c.get(ETAPE.decouverte, "requests"), 1, "deux etapes ne partagent pas un compteur");
  assert.equal(c.get(ETAPE.http, "jamais_vu"), 0, "un compteur jamais touche vaut zero");
});

test("un increment nul n'ecrit rien", (t) => {
  const db = base(t);
  const c = new Counters(db, null);
  c.inc(ETAPE.http, "requests", 0);
  const lignes = db.prepare("SELECT count(*) AS n FROM metric").get() as { n: number };
  assert.equal(lignes.n, 0);
});

test("les compteurs d'un run ne se melangent pas aux compteurs globaux", (t) => {
  const db = base(t);
  db.prepare("INSERT INTO run (id, departement, started_at, statut) VALUES (1, '35', 't', 'en_cours')").run();
  db.prepare("INSERT INTO run (id, departement, started_at, statut) VALUES (2, '35', 't', 'en_cours')").run();

  const global = new Counters(db, null);
  const run1 = global.forRun(1);
  const run2 = global.forRun(2);

  global.inc(ETAPE.http, "requests", 10);
  run1.inc(ETAPE.http, "requests", 3);
  run2.inc(ETAPE.http, "requests", 5);

  assert.equal(global.get(ETAPE.http, "requests"), 10);
  assert.equal(run1.get(ETAPE.http, "requests"), 3);
  assert.equal(run2.get(ETAPE.http, "requests"), 5);
});

test("un increment dans une transaction avortee ne survit pas", (t) => {
  // C'est la propriete sur laquelle repose l'oracle : le compteur et l'effet qu'il mesure
  // sont commites ensemble, ou pas du tout (§8).
  const db = base(t);
  const c = new Counters(db, null);
  c.inc(ETAPE.http, "requests", 2);

  assert.throws(() =>
    transaction(db, () => {
      c.inc(ETAPE.http, "requests", 40);
      throw new Error("echec apres l'increment");
    }),
  );

  assert.equal(c.get(ETAPE.http, "requests"), 2, "l'increment annule ne doit rien laisser");
});

test("l'ordre prepare une fois rend le meme resultat que mille appels", (t) => {
  const c = new Counters(base(t), null);
  for (let i = 0; i < 1_000; i += 1) c.inc(ETAPE.jobs, "enqueued");
  assert.equal(c.get(ETAPE.jobs, "enqueued"), 1_000);
});
