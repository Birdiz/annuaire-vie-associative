import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "../src/db/index.ts";
import { MIGRATIONS } from "../src/db/migrations.ts";
import { sansCedex } from "../src/seed/annuaire.ts";

/**
 * Migration 13 — une commune ne s'appelle pas « Bruzou Cedex ». Le client qui installe la
 * nouvelle version retrouve le bon nom sans rien taper, et sans nouvel amorcage.
 */

function baseAuSchema12(t: { after: (f: () => void) => void }): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db, undefined, MIGRATIONS.filter((m) => m.version <= 12));
  return db;
}

test("la mention Cedex quitte le nom de la commune, et rien d'autre ne bouge", (t) => {
  const db = baseAuSchema12(t);
  const inserer = db.prepare(
    "INSERT INTO commune (code_insee, nom, departement, created_at, updated_at) VALUES (?, ?, '35', 't', 't')",
  );
  for (const [code, nom] of [
    ["35001", "Bruzou Cedex"],
    ["35002", "Saint-Ru CEDEX 9"],
    ["35003", "Cedexville"],
    ["35004", "La Roche-Cedeaux"],
  ] as const) {
    inserer.run(code, nom);
  }

  migrate(db, undefined, MIGRATIONS);

  const noms = db.prepare("SELECT nom FROM commune ORDER BY code_insee").all().map((l) => (l as { nom: string }).nom);
  assert.deepEqual(noms, ["Bruzou", "Saint-Ru", "Cedexville", "La Roche-Cedeaux"]);
});

test("le seed retire la meme mention que la migration", () => {
  // Deux chemins qui doivent s'accorder : l'amorcage de demain et la reparation d'hier.
  assert.equal(sansCedex("Bruzou Cedex"), "Bruzou");
  assert.equal(sansCedex("Saint-Ru CEDEX 9"), "Saint-Ru");
  assert.equal(sansCedex("Cedexville"), "Cedexville");
});
