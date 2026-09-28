import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "../src/db/index.ts";
import { MIGRATIONS } from "../src/db/migrations.ts";

/**
 * Migration 14 — le role des pages (ADR-038). Une base collectee par une version anterieure
 * garde ses pages, et elles comptent toutes dans le budget d'exploration : c'est ce qu'elles
 * etaient.
 */

function baseAuSchema13(t: { after: (f: () => void) => void }): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db, undefined, MIGRATIONS.filter((m) => m.version <= 13));
  db.prepare(
    "INSERT INTO commune (code_insee, nom, departement, created_at, updated_at) VALUES ('35047', 'Bruz', '35', 't', 't')",
  ).run();
  return db;
}

const INSERER_PAGE = `
  INSERT INTO page (url_hash, campagne, url, domaine, code_insee, planifiee_at, profondeur, statut)
  VALUES (?, '2026-08-18', ?, 'bruz.example', '35047', 't', 0, 'visitee')
`;

test("les pages deja en base deviennent de l'exploration", (t) => {
  const db = baseAuSchema13(t);
  db.prepare(INSERER_PAGE).run("h1", "https://bruz.example/");

  migrate(db, undefined, MIGRATIONS);

  assert.deepEqual(
    db.prepare("SELECT url, role FROM page").all().map((ligne) => ({ ...(ligne as object) })),
    [{ url: "https://bruz.example/", role: "exploration" }],
  );
});

test("la base refuse un role qu'elle ne connait pas", (t) => {
  const db = baseAuSchema13(t);
  migrate(db, undefined, MIGRATIONS);
  db.prepare(INSERER_PAGE).run("h1", "https://bruz.example/");
  assert.throws(() => db.prepare("UPDATE page SET role = 'annuaire' WHERE url_hash = 'h1'").run(), /CHECK/);
  db.prepare("UPDATE page SET role = 'fiche' WHERE url_hash = 'h1'").run();
});
