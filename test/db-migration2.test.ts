import { test } from "node:test";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { openDatabase } from "../src/db/index.ts";
import { MIGRATIONS } from "../src/db/migrations.ts";

function base(t: TestContext) {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  return db;
}

function insererCommune(db: ReturnType<typeof openDatabase>, code: string): void {
  db.prepare(
    "INSERT INTO commune (code_insee, nom, departement, created_at, updated_at) VALUES (?, ?, ?, 't', 't')",
  ).run(code, `Commune ${code}`, code.slice(0, 2));
}

test("la migration 2 est appliquee au demarrage", (t) => {
  const db = base(t);
  const versions = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
  assert.deepEqual(versions.map((ligne) => Number(ligne.version)), MIGRATIONS.map((m) => m.version));
  assert.ok(MIGRATIONS.some((m) => m.version === 2), "la migration 2 doit exister");
});

test("une commune resolue sans provenance est refusee par la base", (t) => {
  const db = base(t);
  insererCommune(db, "35001");
  assert.throws(
    () =>
      db
        .prepare("UPDATE commune SET statut_resolution = 'resolue', url_mairie = ? WHERE code_insee = '35001'")
        .run("https://mairie.fr"),
    /provenance/,
  );
});

test("une commune resolue sans URL est refusee meme avec une provenance", (t) => {
  const db = base(t);
  insererCommune(db, "35002");
  assert.throws(
    () =>
      db
        .prepare(
          "UPDATE commune SET statut_resolution = 'resolue', resolution_source_url = 'https://src', " +
            "resolution_collected_at = 't' WHERE code_insee = '35002'",
        )
        .run(),
    /provenance/,
  );
});

test("l'insertion directe d'une commune resolue sans provenance est refusee", (t) => {
  const db = base(t);
  assert.throws(
    () =>
      db
        .prepare(
          "INSERT INTO commune (code_insee, nom, departement, statut_resolution, url_mairie, created_at, updated_at) " +
            "VALUES ('35003', 'X', '35', 'resolue', 'https://x.fr', 't', 't')",
        )
        .run(),
    /provenance/,
  );
});

test("une commune resolue avec provenance complete est acceptee", (t) => {
  const db = base(t);
  insererCommune(db, "35004");
  db.prepare(
    "UPDATE commune SET statut_resolution = 'resolue', url_mairie = ?, resolution_source_url = ?, " +
      "resolution_collected_at = ?, resolution_confiance = 1.0 WHERE code_insee = '35004'",
  ).run("https://mairie.fr", "https://source.fr/dump", "2026-08-18T00:00:00.000Z");
  const ligne = db.prepare("SELECT statut_resolution, resolution_confiance FROM commune WHERE code_insee = '35004'").get();
  assert.equal(ligne?.statut_resolution, "resolue");
});

test("une commune sans site n'exige aucune provenance", (t) => {
  const db = base(t);
  insererCommune(db, "35005");
  db.prepare("UPDATE commune SET statut_resolution = 'sans_site' WHERE code_insee = '35005'").run();
  const ligne = db.prepare("SELECT statut_resolution FROM commune WHERE code_insee = '35005'").get();
  assert.equal(ligne?.statut_resolution, "sans_site");
});

test("un seul dump en cours par source", (t) => {
  const db = base(t);
  const inserer = db.prepare("INSERT INTO dump (source, url, started_at) VALUES (?, ?, 't')");
  inserer.run("rna_waldec", "https://exemple.fr/waldec.csv");
  assert.throws(() => inserer.run("rna_waldec", "https://exemple.fr/waldec.csv"), /UNIQUE/);
  // Une autre source reste possible, et un dump termine ne bloque plus.
  inserer.run("annuaire_local", "https://exemple.fr/local.json");
  db.prepare("UPDATE dump SET statut = 'termine' WHERE source = 'rna_waldec'").run();
  inserer.run("rna_waldec", "https://exemple.fr/waldec.csv");
  const compte = db.prepare("SELECT count(*) AS n FROM dump WHERE source = 'rna_waldec'").get();
  assert.equal(compte?.n, 2);
});

test("un offset de reprise negatif est refuse", (t) => {
  const db = base(t);
  db.prepare("INSERT INTO dump (source, url, started_at) VALUES ('rna_import', 'https://x.fr', 't')").run();
  assert.throws(() => db.prepare("UPDATE dump SET consumed_bytes = -1 WHERE source = 'rna_import'").run(), /CHECK/);
});

test("association accepte une date de dissolution", (t) => {
  const db = base(t);
  insererCommune(db, "35006");
  db.prepare(
    "INSERT INTO association (rna_id, code_insee, nom, nom_normalise, source_creation, date_dissolution, created_at, updated_at) " +
      "VALUES ('W351', '35006', 'Club', 'club', 'rna', '2020-01-01', 't', 't')",
  ).run();
  const ligne = db.prepare("SELECT date_dissolution FROM association WHERE rna_id = 'W351'").get();
  assert.equal(ligne?.date_dissolution, "2020-01-01");
});
