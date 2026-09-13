import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "../src/db/index.ts";
import { MIGRATIONS } from "../src/db/migrations.ts";

/**
 * Migration 12 — detacher les rattachements qu'un bloc-conteneur avait fabriques.
 *
 * Ce qu'on defend ici : le client qui installe la nouvelle version retrouve sa base
 * reparee sans rien taper, et **sans cache** — celui-ci a pu etre purge. Le correctif de
 * `extraction.ts` ne vaut, lui, que pour ce qui sera collecte ensuite.
 */

function baseAuSchema11(t: { after: (f: () => void) => void }): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db, undefined, MIGRATIONS.filter((m) => m.version <= 11));
  db.prepare(
    "INSERT INTO commune (code_insee, nom, departement, created_at, updated_at) " +
      "VALUES ('88001', 'Archettes', '88', 't', 't')",
  ).run();
  db.prepare(
    "INSERT INTO association (id, rna_id, code_insee, nom, nom_normalise, source_creation, created_at, updated_at) " +
      "VALUES (1, 'W881', '88001', 'Societe de chasse', 'societe de chasse', 'rna', 't', 't'), " +
      "       (2, 'W882', '88001', 'Tennis club', 'tennis club', 'rna', 't', 't')",
  ).run();
  return db;
}

function contact(
  db: DatabaseSync,
  valeur: string,
  associationId: number | null,
  url = "https://archettes.example/associations",
): void {
  db.prepare(
    "INSERT INTO contact (association_id, code_insee, kind, valeur, valeur_normalisee, is_generique, " +
      "source_url, methode_extraction, confiance, collected_at) " +
      "VALUES (?, '88001', 'email', ?, ?, 1, ?, 'dom:mailto', 0.9, 't')",
  ).run(associationId, valeur, valeur, url);
}

test("un bloc qui portait vingt contacts ne rattache plus personne", (t) => {
  const db = baseAuSchema11(t);
  for (let i = 0; i < 6; i += 1) contact(db, `c${i}@x.example`, 1);
  // Trois contacts sur une autre page : la fiche d'une structure porte un fixe, un mobile
  // et une adresse. C'est la limite haute de ce qu'on garde.
  for (let i = 0; i < 3; i += 1) contact(db, `t${i}@x.example`, 2, "https://archettes.example/tennis");

  migrate(db, undefined, MIGRATIONS);

  const parAssociation = (
    db
      .prepare("SELECT association_id, count(*) AS n FROM contact GROUP BY association_id ORDER BY 1")
      .all() as unknown as { association_id: number | null; n: number }[]
  ).map((ligne) => ({ association: ligne.association_id, contacts: Number(ligne.n) }));
  assert.deepEqual(parAssociation, [
    { association: null, contacts: 6 },
    { association: 2, contacts: 3 },
  ]);
});

test("le detachement ne perd aucun contact : il ne retire que le rattachement", (t) => {
  const db = baseAuSchema11(t);
  for (let i = 0; i < 4; i += 1) contact(db, `c${i}@x.example`, 1);
  migrate(db, undefined, MIGRATIONS);

  const lignes = db.prepare("SELECT valeur, source_url, confiance FROM contact ORDER BY valeur").all();
  assert.equal(lignes.length, 4, "la provenance de chaque contact reste en base");
  assert.equal(Number((lignes[0] as { confiance: number }).confiance), 0.9);
});

test("le doublon que le detachement ferait apparaitre est resorbe, pas refuse", (t) => {
  const db = baseAuSchema11(t);
  // La meme adresse existe deux fois, legitimement : une fois rattachee, une fois
  // orpheline. Les deux index uniques partiels ne se voient pas l'un l'autre.
  for (let i = 0; i < 4; i += 1) contact(db, `c${i}@x.example`, 1);
  contact(db, "c0@x.example", null, "https://archettes.example/contact");

  // Sans la suppression prealable, la migration echouerait sur l'index des orphelins et
  // la base resterait au schema 11 : pas de reparation du tout.
  migrate(db, undefined, MIGRATIONS);

  const restants = db.prepare("SELECT count(*) AS n FROM contact WHERE valeur = 'c0@x.example'").get();
  assert.equal(Number((restants as { n: number }).n), 1);
});
