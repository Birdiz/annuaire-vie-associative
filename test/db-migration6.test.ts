import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrate, openDatabase } from "../src/db/index.ts";
import { MIGRATIONS } from "../src/db/migrations.ts";

/**
 * Migration du lot 6 : ou ranger une correction humaine, et ce que la base refuse
 * d'elle-meme.
 */

function peupler(db: DatabaseSync): void {
  db.prepare(
    "INSERT INTO commune (code_insee, nom, departement, created_at, updated_at) " +
      "VALUES ('35047', 'Bruzou', '35', 't', 't')",
  ).run();
  db.prepare(
    "INSERT INTO contact (code_insee, kind, valeur, valeur_normalisee, is_generique, " +
      "source_url, methode_extraction, confiance, collected_at, review_statut) " +
      "VALUES ('35047', 'email', 'mairie@bruzou.example', 'mairie@bruzou.example', 1, " +
      "'https://bruzou.example/a', 'dom:mailto', 0.9, 't', 'valide')",
  ).run();
}

test("une base au schema 5 se migre sans perdre ses lignes", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("PRAGMA foreign_keys = ON");

  migrate(db, undefined, MIGRATIONS.filter((m) => m.version <= 5));
  peupler(db);

  assert.equal(migrate(db, undefined, MIGRATIONS), MIGRATIONS.length - 5);

  const contact = db.prepare("SELECT * FROM contact").get() as Record<string, unknown>;
  assert.equal(contact["review_statut"], "valide", "un arbitrage anterieur survit a la migration");
  assert.equal(contact["valeur_corrigee"], null);
  assert.equal(contact["review_at"], null);
});

test("le trigger tient la coherence de « corrige », a l'insertion comme a la mise a jour", (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  peupler(db);

  assert.throws(
    () => db.prepare("UPDATE contact SET review_statut = 'corrige' WHERE id = 1").run(),
    /valeur corrigee/,
    "un statut « corrige » sans correction est une contradiction",
  );

  assert.throws(
    () =>
      db
        .prepare(
          "INSERT INTO contact (code_insee, kind, valeur, valeur_normalisee, source_url, " +
            "methode_extraction, confiance, collected_at, review_statut) " +
            "VALUES ('35047', 'email', 'a@b.example', 'a@b.example', 'u', 'm', 0.5, 't', 'corrige')",
        )
        .run(),
    /valeur corrigee/,
  );

  // Vider la correction d'une ligne deja corrigee doit echouer par le meme trigger :
  // sans la clause sur `valeur_corrigee`, cette ecriture-la passerait.
  db.prepare("UPDATE contact SET valeur_corrigee = 'x@y.example', review_statut = 'corrige' WHERE id = 1").run();
  assert.throws(
    () => db.prepare("UPDATE contact SET valeur_corrigee = NULL WHERE id = 1").run(),
    /valeur corrigee/,
  );

  assert.equal(
    (db.prepare("SELECT valeur_corrigee FROM contact WHERE id = 1").get() as { valeur_corrigee: string })
      .valeur_corrigee,
    "x@y.example",
  );
});

test("l'index de la file de revue existe, et il est partiel", (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());

  const index = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_contact_a_revoir'")
    .get() as { sql: string } | undefined;

  assert.ok(index !== undefined, "la file de revue doit avoir son index");
  assert.match(index.sql, /WHERE review_statut = 'a_revoir'/, "un contact arbitre n'a rien a y faire");
});
