import { test } from "node:test";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { migrate, openDatabase } from "../src/db/index.ts";
import { MIGRATIONS } from "../src/db/migrations.ts";

/**
 * Migration du lot 5 : le score de revue sur `contact`, la tracabilite de la
 * classification sur `association`, et la table des verdicts MX.
 */

function base(t: TestContext): DatabaseSync {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  return db;
}

function peupler(db: DatabaseSync): void {
  db.prepare(
    "INSERT INTO commune (code_insee, nom, departement, created_at, updated_at) " +
      "VALUES ('35047', 'Bruzou', '35', 't', 't')",
  ).run();
  db.prepare(
    "INSERT INTO association (rna_id, code_insee, nom, nom_normalise, source_creation, created_at, updated_at) " +
      "VALUES ('W3510001', '35047', 'Club de Bruzou', 'club de bruzou', 'rna', 't', 't')",
  ).run();
  db.prepare(
    "INSERT INTO contact (association_id, code_insee, kind, valeur, valeur_normalisee, " +
      "is_generique, source_url, methode_extraction, confiance, collected_at) " +
      "VALUES (1, '35047', 'email', 'contact@bruzou.example', 'contact@bruzou.example', 1, " +
      "'https://bruzou.example/a', 'dom:mailto', 0.9, 't')",
  ).run();
}

test("la migration 5 est appliquee au demarrage", (t) => {
  const db = base(t);
  const versions = (
    db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as { version: number }[]
  ).map((ligne) => Number(ligne.version));
  assert.deepEqual(versions, MIGRATIONS.map((m) => m.version));
  assert.ok(MIGRATIONS.some((m) => m.version === 5), "la migration 5 doit exister");
});

test("une base au schema 4 se migre sans perdre ses lignes", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("PRAGMA foreign_keys = ON");

  migrate(db, undefined, MIGRATIONS.filter((m) => m.version <= 4));
  peupler(db);

  assert.equal(migrate(db, undefined, MIGRATIONS), MIGRATIONS.length - 4);

  const contact = db
    .prepare("SELECT valeur, score, score_version FROM contact WHERE id = 1")
    .get() as { valeur: string; score: number | null; score_version: number | null };
  assert.equal(contact.valeur, "contact@bruzou.example");
  assert.equal(contact.score, null, "un contact anterieur au bareme n'a pas de score");
  assert.equal(contact.score_version, null);

  const association = db
    .prepare("SELECT nom, type_classifie, classification_version FROM association WHERE rna_id = 'W3510001'")
    .get() as { nom: string; type_classifie: string | null; classification_version: number | null };
  assert.equal(association.nom, "Club de Bruzou");
  assert.equal(association.type_classifie, null);
  assert.equal(association.classification_version, null);
});

test("la base refuse un score hors de [0, 1]", (t) => {
  const db = base(t);
  peupler(db);

  db.prepare("UPDATE contact SET score = 0.0 WHERE id = 1").run();
  db.prepare("UPDATE contact SET score = 1.0 WHERE id = 1").run();
  assert.throws(() => db.prepare("UPDATE contact SET score = 1.5 WHERE id = 1").run());
  assert.throws(() => db.prepare("UPDATE contact SET score = -0.1 WHERE id = 1").run());
});

test("le score et ses motifs survivent a un aller-retour", (t) => {
  const db = base(t);
  peupler(db);

  const motifs = JSON.stringify({ base: 0.9, signaux: [{ signal: "mx", facteur: 0.3, detail: "sans MX" }] });
  db.prepare("UPDATE contact SET score = 0.27, score_motifs = ?, score_version = 1, score_at = 't' WHERE id = 1").run(
    motifs,
  );

  const ligne = db.prepare("SELECT score, score_motifs FROM contact WHERE id = 1").get() as {
    score: number;
    score_motifs: string;
  };
  assert.equal(ligne.score, 0.27);
  assert.deepEqual(JSON.parse(ligne.score_motifs), JSON.parse(motifs));
});

test("un verdict MX porte sa provenance, et n'accepte que trois etats", (t) => {
  const db = base(t);

  const inserer = db.prepare(
    "INSERT INTO domaine_mail (domaine, mx, mx_hotes, methode, verifie_at, erreur) VALUES (?, ?, ?, ?, ?, ?)",
  );
  inserer.run("avec.example", 1, "mx1.avec.example", "dns:mx", "2026-08-22T00:00:00.000Z", null);
  inserer.run("sans.example", 0, null, "dns:mx", "2026-08-22T00:00:00.000Z", null);
  inserer.run("panne.example", null, null, "dns:mx", "2026-08-22T00:00:00.000Z", "ESERVFAIL");

  // Invariant 5 : une donnee collectee sans provenance ne doit pas pouvoir entrer.
  assert.throws(
    () => inserer.run("x.example", 1, null, null, "2026-08-22T00:00:00.000Z", null),
    "la methode est obligatoire",
  );
  assert.throws(
    () => inserer.run("y.example", 1, null, "dns:mx", null, null),
    "l'horodatage est obligatoire",
  );
  // Un quatrieme etat n'aurait pas de sens : present, absent, ou pas su.
  assert.throws(() => inserer.run("z.example", 2, null, "dns:mx", "t", null));

  const compte = db.prepare("SELECT count(*) AS n FROM domaine_mail").get() as { n: number };
  assert.equal(Number(compte.n), 3);
});

test("le domaine est la cle : une seconde verification remplace la premiere", (t) => {
  const db = base(t);
  const sql =
    "INSERT INTO domaine_mail (domaine, mx, mx_hotes, methode, verifie_at, erreur) VALUES (?, ?, ?, 'dns:mx', ?, ?) " +
    "ON CONFLICT (domaine) DO UPDATE SET mx = excluded.mx, verifie_at = excluded.verifie_at, erreur = excluded.erreur";
  db.prepare(sql).run("a.example", null, null, "2026-08-01T00:00:00.000Z", "ETIMEOUT");
  db.prepare(sql).run("a.example", 1, "mx.a.example", "2026-08-22T00:00:00.000Z", null);

  const ligne = db.prepare("SELECT mx, erreur FROM domaine_mail WHERE domaine = 'a.example'").get() as {
    mx: number;
    erreur: string | null;
  };
  assert.equal(ligne.mx, 1);
  assert.equal(ligne.erreur, null, "un echec resolu ne doit pas laisser sa trace d'erreur");
});
