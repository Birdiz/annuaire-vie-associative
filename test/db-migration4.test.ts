import { test } from "node:test";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { migrate, openDatabase } from "../src/db/index.ts";
import { MIGRATIONS } from "../src/db/migrations.ts";

/**
 * Migration du lot 4 : le verdict de l'etape [4] sur `page`, et les champs temporels
 * du RNA sur `association` — la dette que l'ADR-013 posait comme prealable a ce lot.
 */

function base(t: TestContext) {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  return db;
}

function insererCommune(db: DatabaseSync, code: string): void {
  db.prepare(
    "INSERT INTO commune (code_insee, nom, departement, created_at, updated_at) VALUES (?, ?, ?, 't', 't')",
  ).run(code, `Commune ${code}`, code.slice(0, 2));
}

function insererPage(db: DatabaseSync, hash: string, code: string): void {
  db.prepare(
    "INSERT INTO page (url_hash, campagne, url, domaine, code_insee, statut) " +
      "VALUES (?, '2026-08-21', ?, 'bruz.example', ?, 'visitee')",
  ).run(hash, `https://bruz.example/${hash}`, code);
}

test("la migration 4 est appliquee au demarrage", (t) => {
  const db = base(t);
  const versions = (db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as {
    version: number;
  }[]).map((ligne) => Number(ligne.version));
  assert.deepEqual(versions, MIGRATIONS.map((m) => m.version));
  assert.ok(MIGRATIONS.some((m) => m.version === 4), "la migration 4 doit exister");
});

test("une base au schema 3 se migre sans perdre ses lignes", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("PRAGMA foreign_keys = ON");

  migrate(db, undefined, MIGRATIONS.filter((m) => m.version <= 3));
  insererCommune(db, "35047");
  insererPage(db, "abc", "35047");
  db.prepare(
    "INSERT INTO association (rna_id, code_insee, nom, nom_normalise, source_creation, created_at, updated_at) " +
      "VALUES ('W351', '35047', 'Club de Bruz', 'club de bruz', 'rna', 't', 't')",
  ).run();

  assert.equal(migrate(db, undefined, MIGRATIONS), 1, "seule la migration 4 reste a appliquer");

  const page = db.prepare("SELECT url, prefiltre_verdict FROM page WHERE url_hash = 'abc'").get() as {
    url: string;
    prefiltre_verdict: string | null;
  };
  assert.equal(page.url, "https://bruz.example/abc");
  assert.equal(page.prefiltre_verdict, null, "une page anterieure au filtre n'a pas de verdict");

  const association = db
    .prepare("SELECT nom, date_declaration FROM association WHERE rna_id = 'W351'")
    .get() as { nom: string; date_declaration: string | null };
  assert.equal(association.nom, "Club de Bruz");
  assert.equal(association.date_declaration, null);
});

test("la base refuse un verdict de pre-filtre inconnu", (t) => {
  const db = base(t);
  insererCommune(db, "35047");
  insererPage(db, "abc", "35047");

  assert.throws(
    () => db.prepare("UPDATE page SET prefiltre_verdict = 'peut-etre' WHERE url_hash = 'abc'").run(),
    /CHECK/,
    "seuls « retenue » et « ecartee » ont un sens pour l'etape [6]",
  );

  for (const verdict of ["retenue", "ecartee"]) {
    db.prepare("UPDATE page SET prefiltre_verdict = ? WHERE url_hash = 'abc'").run(verdict);
  }
});

test("une page porte son score, son motif et le compte de contacts extraits", (t) => {
  const db = base(t);
  insererCommune(db, "35047");
  insererPage(db, "abc", "35047");

  db.prepare(
    "UPDATE page SET prefiltre_score = 12.5, prefiltre_verdict = 'retenue', prefiltre_motif = 'liste', " +
      "prefiltre_at = 't', prefiltre_version = 1, contacts_extraits = 3 WHERE url_hash = 'abc'",
  ).run();

  const ligne = db
    .prepare(
      "SELECT prefiltre_score, prefiltre_motif, prefiltre_version, contacts_extraits FROM page " +
        "WHERE url_hash = 'abc'",
    )
    .get() as Record<string, number | string>;
  assert.equal(ligne["prefiltre_score"], 12.5);
  assert.equal(ligne["prefiltre_motif"], "liste");
  // La version rend repondable « quels verdicts sont perimes » apres un reglage.
  assert.equal(ligne["prefiltre_version"], 1);
  assert.equal(ligne["contacts_extraits"], 3);
});

test("association accepte les champs temporels du RNA", (t) => {
  const db = base(t);
  insererCommune(db, "35047");
  db.prepare(
    "INSERT INTO association (rna_id, code_insee, nom, nom_normalise, source_creation, " +
      "date_creation, date_declaration, position_rna, maj_rna, created_at, updated_at) " +
      "VALUES ('W351', '35047', 'Club', 'club', 'rna', '1998-03-02', '2021-06-14', 'A', " +
      "'2021-06-14T09:00:00', 't', 't')",
  ).run();

  const ligne = db
    .prepare("SELECT date_creation, date_declaration, position_rna, maj_rna FROM association WHERE rna_id = 'W351'")
    .get() as Record<string, string>;
  assert.equal(ligne["date_creation"], "1998-03-02");
  assert.equal(ligne["date_declaration"], "2021-06-14");
  assert.equal(ligne["position_rna"], "A");
  assert.equal(ligne["maj_rna"], "2021-06-14T09:00:00");
});
