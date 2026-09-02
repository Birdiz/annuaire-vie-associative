import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase, migrate } from "../src/db/index.ts";
import { MIGRATIONS } from "../src/db/migrations.ts";
import { makeTempDir } from "./helpers/tmp.ts";
import type { TestContext } from "node:test";

/**
 * La migration 11 — le nom lu dans le bloc.
 *
 * Ce qu'on defend ici : que ces colonnes soient une **derivee** et se comportent comme
 * telle. Elles ne portent aucune contrainte de provenance, et elles ne doivent reveiller
 * aucun des triggers poses sur `contact` par les migrations precedentes.
 */

const NOW = "2026-09-01T10:00:00.000Z";

function base(t: TestContext): ReturnType<typeof openDatabase> {
  const db = openDatabase(join(makeTempDir(t), "test.sqlite"));
  t.after(() => db.close());
  db.prepare(
    "INSERT INTO commune (code_insee, nom, departement, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run("35238", "Rennes", "35", NOW, NOW);
  return db;
}

function insererContact(db: ReturnType<typeof openDatabase>, valeur: string): number {
  const info = db
    .prepare(
      "INSERT INTO contact (code_insee, kind, valeur, valeur_normalisee, is_generique, source_url, " +
        "methode_extraction, confiance, collected_at) " +
        "VALUES ('35238', 'email', ?, ?, 1, 'https://x.example', 'dom:mailto', 0.9, ?)",
    )
    .run(valeur, valeur, NOW);
  return Number(info.lastInsertRowid);
}

test("les cinq colonnes existent et sont facultatives", (t) => {
  const db = base(t);
  // Un contact parfaitement valide n'a pas de nom pressenti, et doit s'inserer sans.
  const id = insererContact(db, "contact@club.example");

  const ligne = db
    .prepare(
      "SELECT nom_pressenti, nom_pressenti_normalise, nom_pressenti_source, " +
        "nom_pressenti_at, nom_pressenti_version FROM contact WHERE id = ?",
    )
    .get(id) as Record<string, unknown>;

  for (const [colonne, valeur] of Object.entries(ligne)) {
    assert.equal(valeur, null, `${colonne} devrait etre nulle : c'est une derivee, pas une provenance`);
  }
});

test("ecrire un nom pressenti ne reveille pas le trigger de correction en revue", (t) => {
  const db = base(t);
  const id = insererContact(db, "contact@club.example");
  db.prepare("UPDATE contact SET review_statut = 'corrige', valeur_corrigee = ? WHERE id = ?").run(
    "corrige@club.example",
    id,
  );

  // Le trigger de la migration 6 est `BEFORE UPDATE OF review_statut, valeur_corrigee`.
  // Ecrire ailleurs ne doit rien declencher — sinon nommer un contact deja corrige en
  // revue echouerait, et personne ne comprendrait pourquoi.
  assert.doesNotThrow(() => {
    db.prepare(
      "UPDATE contact SET nom_pressenti = ?, nom_pressenti_normalise = ?, " +
        "nom_pressenti_source = 'bloc:avant', nom_pressenti_at = ?, nom_pressenti_version = 1 " +
        "WHERE id = ?",
    ).run("Club de Tir", "club de tir", NOW, id);
  });

  const nom = db.prepare("SELECT nom_pressenti FROM contact WHERE id = ?").get(id) as {
    nom_pressenti?: string;
  };
  assert.equal(nom.nom_pressenti, "Club de Tir");
});

test("le trigger de correction en revue, lui, mord toujours", (t) => {
  const db = base(t);
  const id = insererContact(db, "contact@club.example");
  // Verrou de non-regression : la migration 11 ne doit pas avoir desarme la migration 6.
  assert.throws(
    () => db.prepare("UPDATE contact SET review_statut = 'corrige' WHERE id = ?").run(id),
    /corrige/,
  );
});

test("une base au schema precedent se migre sans perdre une ligne", (t) => {
  const fichier = join(makeTempDir(t), "ancienne.sqlite");

  // On amene la base a la version 10, puis on la peuple : c'est l'etat d'un poste
  // client au moment ou il recoit ce lot.
  const avant = new DatabaseSync(fichier);
  avant.exec("PRAGMA foreign_keys = ON");
  migrate(avant, undefined, MIGRATIONS.slice(0, 10));
  avant
    .prepare(
      "INSERT INTO commune (code_insee, nom, departement, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run("35238", "Rennes", "35", NOW, NOW);
  insererContact(avant, "avant@club.example");
  const versionAvant = avant.prepare("SELECT max(version) AS v FROM schema_migrations").get() as {
    v?: number;
  };
  avant.close();
  assert.equal(versionAvant.v, 10);

  const apres = openDatabase(fichier);
  t.after(() => apres.close());
  const total = apres.prepare("SELECT count(*) AS n FROM contact").get() as { n?: number };
  const version = apres.prepare("SELECT max(version) AS v FROM schema_migrations").get() as {
    v?: number;
  };
  assert.equal(total.n, 1, "la migration 11 est additive : elle ne touche aucune ligne");
  assert.equal(version.v, MIGRATIONS[MIGRATIONS.length - 1]?.version);
});

test("l'index de rattrapage ne couvre que le travail restant", (t) => {
  const db = base(t);
  const index = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_contact_a_nommer'")
    .get() as { sql?: string } | undefined;

  assert.ok(index?.sql !== undefined, "l'index de la migration 11 manque");
  // Partiel a dessein : il retrecit a mesure que la passe avance, et disparait quand
  // tout est evalue. Un index plein couterait a chaque ecriture de contact.
  assert.match(index.sql, /WHERE association_id IS NULL AND nom_pressenti_version IS NULL/);
  assert.equal(migrate(db), 0, "tout est deja applique");
});
