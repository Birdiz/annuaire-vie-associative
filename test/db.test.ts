import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase, migrate, transaction, MigrationError } from "../src/db/index.ts";
import { MIGRATIONS } from "../src/db/migrations.ts";
import { makeTempDir } from "./helpers/tmp.ts";

function openTestDb(t: import("node:test").TestContext) {
  const db = openDatabase(join(makeTempDir(t), "test.sqlite"));
  t.after(() => db.close());
  return db;
}

const NOW = "2026-08-17T10:00:00.000Z";

function seedCommune(db: DatabaseSync, codeInsee = "35238"): void {
  db.prepare(
    "INSERT INTO commune (code_insee, nom, departement, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(codeInsee, "Rennes", "35", NOW, NOW);
}

function seedAssociation(db: DatabaseSync, codeInsee = "35238"): number {
  const info = db
    .prepare(
      `INSERT INTO association (rna_id, code_insee, nom, nom_normalise, source_creation, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'rna', ?, ?)`,
    )
    .run("W353000123", codeInsee, "Club de tir a l'arc", "club de tir a l arc", NOW, NOW);
  return Number(info.lastInsertRowid);
}

function insertContact(db: DatabaseSync, overrides: Record<string, unknown> = {}): void {
  const values = {
    association_id: null,
    code_insee: null,
    kind: "email",
    valeur: "Contact@Exemple.example",
    valeur_normalisee: "contact@exemple.example",
    is_generique: 1,
    source_url: "https://mairie-exemple.example/associations",
    methode_extraction: "dom:mailto",
    confiance: 0.9,
    collected_at: NOW,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO contact (association_id, code_insee, kind, valeur, valeur_normalisee, is_generique,
                          source_url, methode_extraction, confiance, collected_at)
     VALUES (:association_id, :code_insee, :kind, :valeur, :valeur_normalisee, :is_generique,
             :source_url, :methode_extraction, :confiance, :collected_at)`,
  ).run(values);
}

test("migrer deux fois de suite ne change rien", (t) => {
  const file = join(makeTempDir(t), "test.sqlite");

  const first = openDatabase(file);
  const appliedFirst = migrate(first);
  first.close();

  const second = openDatabase(file);
  const appliedSecond = migrate(second);
  const versions = second.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
  second.close();

  assert.equal(appliedFirst, 0, "openDatabase a deja tout applique");
  assert.equal(appliedSecond, 0);
  assert.equal(versions.length, MIGRATIONS.length);
});

test("une migration deja appliquee qui change fait echouer le demarrage", (t) => {
  const db = openTestDb(t);
  const altered = [{ version: 1, name: "init", sql: "SELECT 1" }];

  assert.throws(() => migrate(db, undefined, altered), (error: unknown) => {
    assert.ok(error instanceof MigrationError);
    assert.match(error.message, /a change apres avoir ete appliquee/);
    return true;
  });
});

test("une migration qui echoue laisse la base intacte", (t) => {
  const db = openTestDb(t);
  const broken = [
    { version: 1, name: "init", sql: MIGRATIONS[0]!.sql },
    { version: 2, name: "casse", sql: "CREATE TABLE bonne (a TEXT) STRICT; CECI N'EST PAS DU SQL;" },
  ];

  assert.throws(() => migrate(db, undefined, broken), MigrationError);

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'bonne'")
    .all();
  assert.equal(tables.length, 0, "la transaction de migration n'a pas ete annulee");
});

test("rejouer l'insertion d'un contact ne cree pas de doublon", (t) => {
  const db = openTestDb(t);
  seedCommune(db);
  const associationId = seedAssociation(db);

  insertContact(db, { association_id: associationId });
  assert.throws(
    () => insertContact(db, { association_id: associationId, valeur: "autre-casse@exemple.example" }),
    /UNIQUE/i,
    "la valeur normalisee identique aurait du etre rejetee",
  );

  const count = db.prepare("SELECT count(*) AS n FROM contact").get() as { n: number };
  assert.equal(count.n, 1);
});

test("les contacts orphelins d'association sont dedupliques par commune", (t) => {
  const db = openTestDb(t);
  seedCommune(db);

  insertContact(db, { code_insee: "35238" });
  assert.throws(() => insertContact(db, { code_insee: "35238" }), /UNIQUE/i);

  const count = db.prepare("SELECT count(*) AS n FROM contact").get() as { n: number };
  assert.equal(count.n, 1);
});

test("un contact sans provenance ne peut pas entrer en base", (t) => {
  const db = openTestDb(t);
  seedCommune(db);
  const associationId = seedAssociation(db);

  for (const missing of ["source_url", "methode_extraction", "collected_at"] as const) {
    assert.throws(
      () => insertContact(db, { association_id: associationId, [missing]: null }),
      /NOT NULL/i,
      `${missing} devrait etre obligatoire`,
    );
  }

  assert.throws(
    () => insertContact(db, { association_id: associationId, confiance: 1.5 }),
    /CHECK/i,
    "un score de confiance hors bornes devrait etre refuse",
  );
});

test("un contact doit etre rattache a une association ou a une commune", (t) => {
  const db = openTestDb(t);
  assert.throws(() => insertContact(db), /CHECK/i);
});

test("une association peut exister sans rna_id, et rna_id reste unique", (t) => {
  const db = openTestDb(t);
  seedCommune(db);

  const insert = db.prepare(
    `INSERT INTO association (rna_id, code_insee, nom, nom_normalise, source_creation, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run(null, "35238", "Comite des fetes", "comite des fetes", "decouverte", NOW, NOW);
  insert.run(null, "35238", "Amicale laique", "amicale laique", "decouverte", NOW, NOW);
  insert.run("W353000999", "35238", "Club photo", "club photo", "rna", NOW, NOW);

  assert.throws(
    () => insert.run("W353000999", "35238", "Doublon", "doublon", "rna", NOW, NOW),
    /UNIQUE/i,
  );

  const count = db.prepare("SELECT count(*) AS n FROM association").get() as { n: number };
  assert.equal(count.n, 3);
});

test("les cles etrangeres sont actives", (t) => {
  const db = openTestDb(t);
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO association (code_insee, nom, nom_normalise, source_creation, created_at, updated_at)
           VALUES ('99999', 'X', 'x', 'rna', ?, ?)`,
        )
        .run(NOW, NOW),
    /FOREIGN KEY/i,
  );
});

test("transaction annule tout en cas d'echec", (t) => {
  const db = openTestDb(t);

  assert.throws(() =>
    transaction(db, () => {
      seedCommune(db);
      throw new Error("echec en cours de transaction");
    }),
  );

  const count = db.prepare("SELECT count(*) AS n FROM commune").get() as { n: number };
  assert.equal(count.n, 0);
});
