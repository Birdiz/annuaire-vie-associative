import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrate, openDatabase } from "../src/db/index.ts";
import { MIGRATIONS } from "../src/db/migrations.ts";

/**
 * Migration du lot 8 : la phase du run.
 *
 * Ce que la colonne apporte n'est pas une donnee de plus, c'est une reponse a « ou en
 * est-on ? » posee depuis un ecran qui ne voit pas la console. Le test verifie surtout
 * qu'un run anterieur, qui n'en a pas, reste lisible.
 */

test("une base au schema 6 se migre, et ses runs anterieurs restent lisibles", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("PRAGMA foreign_keys = ON");

  migrate(db, undefined, MIGRATIONS.filter((m) => m.version <= 6));
  db.prepare(
    "INSERT INTO run (departement, started_at, finished_at, statut) " +
      "VALUES ('35', '2026-08-01T10:00:00.000Z', '2026-08-01T10:40:00.000Z', 'termine')",
  ).run();

  assert.equal(migrate(db, undefined, MIGRATIONS), MIGRATIONS.length - 6);

  const run = db.prepare("SELECT * FROM run").get() as Record<string, unknown>;
  assert.equal(run["statut"], "termine");
  assert.equal(run["phase"], null, "un run d'avant la colonne n'a pas de phase, et ce n'est pas une erreur");
});

test("la phase accepte les trois passes et se vide a la cloture", (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());

  db.prepare("INSERT INTO run (departement, started_at, statut, phase) VALUES ('35', 't', 'en_cours', 'amorce')").run();
  for (const phase of ["decouverte", "normalisation"]) {
    db.prepare("UPDATE run SET phase = ? WHERE id = 1").run(phase);
    assert.equal((db.prepare("SELECT phase FROM run WHERE id = 1").get() as { phase: string }).phase, phase);
  }

  db.prepare("UPDATE run SET statut = 'termine', phase = NULL WHERE id = 1").run();
  assert.equal((db.prepare("SELECT phase FROM run WHERE id = 1").get() as { phase: null }).phase, null);
});
