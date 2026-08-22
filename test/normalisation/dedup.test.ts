import { test } from "node:test";
import assert from "node:assert/strict";

import { openDatabase } from "../../src/db/index.ts";
import { Counters, ETAPE } from "../../src/metrics/counters.ts";
import { dedupliquer } from "../../src/normalisation/dedup.ts";
import { CODE_INSEE, DEPARTEMENT, preparerCorpus } from "../helpers/corpus.ts";
import type { TestContext } from "node:test";

/**
 * Etape [7] : la limite que le README annoncait — un meme email present a la fois
 * rattache a une association et au niveau commune.
 */

function ouvrir(t: TestContext): ReturnType<typeof openDatabase> {
  const { dbFile } = preparerCorpus(t);
  const db = openDatabase(dbFile);
  t.after(() => db.close());
  return db;
}

function valeurs(db: ReturnType<typeof openDatabase>, rattache: boolean): string[] {
  return (
    db
      .prepare(
        "SELECT valeur_normalisee FROM contact WHERE association_id IS " +
          (rattache ? "NOT NULL" : "NULL") +
          " ORDER BY valeur_normalisee",
      )
      .all() as unknown as { valeur_normalisee: string }[]
  ).map((ligne) => ligne.valeur_normalisee);
}

test("la ligne commune disparait, la ligne rattachee survit", (t) => {
  const db = ouvrir(t);

  assert.deepEqual(valeurs(db, false), ["contact@tennis-bruzou.example", "mairie@bruzou.example"]);

  const supprimes = dedupliquer(db, DEPARTEMENT);
  assert.equal(supprimes, 1);

  assert.deepEqual(
    valeurs(db, false),
    ["mairie@bruzou.example"],
    "seul le doublon part ; un email vu nulle part ailleurs reste au niveau commune",
  );
  assert.deepEqual(
    valeurs(db, true),
    ["contact@tennis-bruzou.example", "marie.dupont@theatre-landes.example", "+33299000000"].sort(),
    "aucune ligne rattachee ne doit avoir ete touchee",
  );
});

test("rejouer la deduplication ne change plus rien : elle est idempotente", (t) => {
  const db = ouvrir(t);

  assert.equal(dedupliquer(db, DEPARTEMENT), 1);
  const apres = valeurs(db, false).concat(valeurs(db, true)).sort();

  assert.equal(dedupliquer(db, DEPARTEMENT), 0, "le second passage n'a plus rien a supprimer");
  assert.equal(dedupliquer(db, DEPARTEMENT), 0);
  assert.deepEqual(valeurs(db, false).concat(valeurs(db, true)).sort(), apres);
});

test("le compteur suit les suppressions reelles, et ne gonfle pas au rejeu", (t) => {
  const db = ouvrir(t);
  const counters = new Counters(db, null);

  dedupliquer(db, DEPARTEMENT, counters);
  dedupliquer(db, DEPARTEMENT, counters);

  assert.equal(counters.get(ETAPE.normalisation, "doublons_supprimes"), 1);
});

test("un doublon d'une autre commune n'est pas emporte", (t) => {
  const db = ouvrir(t);

  db.prepare(
    "INSERT INTO commune (code_insee, nom, departement, created_at, updated_at) " +
      "VALUES ('35048', 'Autreville', ?, 't', 't')",
  ).run(DEPARTEMENT);
  // Meme adresse, autre commune, et aucune association ne la porte la-bas : la regle
  // raisonne par commune, cette ligne doit survivre.
  db.prepare(
    "INSERT INTO contact (association_id, code_insee, kind, valeur, valeur_normalisee, " +
      "is_generique, source_url, methode_extraction, confiance, collected_at) " +
      "VALUES (NULL, '35048', 'email', 'contact@tennis-bruzou.example', " +
      "'contact@tennis-bruzou.example', 1, 'https://autreville.example/x', 'dom:mailto', 0.9, 't')",
  ).run();

  assert.equal(dedupliquer(db, DEPARTEMENT), 1);

  const restants = db
    .prepare("SELECT count(*) AS n FROM contact WHERE code_insee = '35048'")
    .get() as { n: number };
  assert.equal(Number(restants.n), 1, "la commune voisine n'a pas d'association porteuse");

  void CODE_INSEE;
});
