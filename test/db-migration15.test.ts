import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "../src/db/index.ts";
import { MIGRATIONS } from "../src/db/migrations.ts";

/**
 * Migration 15 — la preuve des cartes de relecture (ADR-040). Une base anterieure garde ses
 * contacts tels quels, sans preuve : c'est la reparation, qui relit le cache, qui la donne.
 * Une preuve absente n'est pas un trou de provenance — la base l'accepte.
 */

test("les contacts deja en base passent la migration, sans preuve et sans perdre leur provenance", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db, undefined, MIGRATIONS.filter((m) => m.version <= 14));
  db.prepare(
    "INSERT INTO commune (code_insee, nom, departement, created_at, updated_at) VALUES ('35047', 'Bruz', '35', 't', 't')",
  ).run();
  db.prepare(
    "INSERT INTO contact (code_insee, kind, valeur, valeur_normalisee, source_url, methode_extraction, confiance, collected_at) " +
      "VALUES ('35047', 'email', 'club@asso.example', 'club@asso.example', 'https://bruz.example/a', 'dom:mailto', 0.9, 't')",
  ).run();

  migrate(db, undefined, MIGRATIONS);

  const ligne = db.prepare("SELECT source_url, extrait FROM contact").get() as { source_url: string; extrait: unknown };
  assert.equal(ligne.source_url, "https://bruz.example/a");
  assert.equal(ligne.extrait, null);
});
