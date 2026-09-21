import { test } from "node:test";
import assert from "node:assert/strict";

import { openDatabase } from "../../src/db/index.ts";
import { SEPARATEUR, compterEcartes, compterLignes, lignesCsv } from "../../src/export/csv.ts";
import { CODE_INSEE, DEPARTEMENT, preparerCorpus } from "../helpers/corpus.ts";
import type { OptionsExport } from "../../src/export/csv.ts";
import type { TestContext } from "node:test";

/**
 * Lot 12 — une commune nouvelle ne se livre pas en N exemplaires.
 *
 * Une commune nouvelle garde les codes INSEE de ses communes deleguees, et le seed leur donne
 * le meme nom et le meme site : le crawl traite ce site une fois par code, chaque code garde sa
 * copie des contacts, et le fichier de l'Ain portait 26 lignes identiques en trop — la meme
 * structure quatre fois.
 */

const SIMPLE: OptionsExport = { departement: DEPARTEMENT, profil: "simple" };

function ouvrir(t: TestContext): ReturnType<typeof openDatabase> {
  const { dbFile } = preparerCorpus(t);
  const db = openDatabase(dbFile);
  t.after(() => db.close());
  return db;
}

function commune(db: ReturnType<typeof openDatabase>, code: string, nom: string, url: string | null): void {
  db.prepare(
    "INSERT INTO commune (code_insee, nom, departement, url_mairie, created_at, updated_at) VALUES (?, ?, ?, ?, 't', 't')",
  ).run(code, nom, DEPARTEMENT, url);
}

function orphelin(db: ReturnType<typeof openDatabase>, code: string, valeur: string, nom: string | null): void {
  db.prepare(
    "INSERT INTO contact (code_insee, kind, valeur, valeur_normalisee, is_generique, source_url, " +
      "methode_extraction, confiance, collected_at, nom_pressenti, nom_pressenti_normalise, nom_pressenti_version) " +
      "VALUES (?, 'email', ?, ?, 1, 'https://bruzou.example/vie-associative', 'dom:mailto', 0.8, 't', ?, ?, 1)",
  ).run(code, valeur, valeur, nom, nom === null ? null : nom.toLowerCase());
}

function lignes(db: ReturnType<typeof openDatabase>): string[] {
  return [...lignesCsv(db, SIMPLE)].slice(1).map((ligne) => ligne.trimEnd());
}

test("les codes freres d'une commune nouvelle font une seule ligne par structure", (t) => {
  const db = ouvrir(t);
  // Meme nom, meme hote : le `/` final ne fait pas une autre commune.
  commune(db, "35998", "Bruzou", "https://bruzou.example/");
  for (const code of [CODE_INSEE, "35998"]) {
    orphelin(db, code, "club@moulin-du-ru.example", "Amicale du Moulin");
    orphelin(db, code, "periscolaire@bruzou.example", null);
  }

  const toutes = lignes(db);
  assert.equal(toutes.filter((ligne) => ligne.includes("Amicale du Moulin")).length, 1);
  assert.equal(
    toutes.filter((ligne) => ligne.includes("periscolaire@bruzou.example")).length,
    1,
    "la ligne « Mairie de » aussi",
  );
  assert.equal(new Set(toutes).size, toutes.length, "aucune ligne identique");
  assert.equal(compterLignes(db, SIMPLE), toutes.length, "le compte annonce est celui du fichier");
  assert.equal(compterEcartes(db, SIMPLE).sansNom, 0, "une copie fondue n'est pas un contact sans nom");
});

test("des homonymes sans site commun restent deux communes", (t) => {
  const db = ouvrir(t);
  commune(db, "35997", "Bruzou", "https://autre-bruzou.example");
  commune(db, "35996", "Bruzou", null);
  for (const code of [CODE_INSEE, "35997", "35996"]) orphelin(db, code, "club@moulin-du-ru.example", "Amicale du Moulin");

  assert.equal(lignes(db).filter((ligne) => ligne.includes("Amicale du Moulin")).length, 3);
});

test("une copie orpheline s'efface devant sa jumelle rattachee sous un code frere", (t) => {
  const db = ouvrir(t);
  commune(db, "35998", "Bruzou", "https://bruzou.example");
  const association = db.prepare("SELECT id, nom FROM association LIMIT 1").get() as { id: number; nom: string };
  db.prepare(
    "INSERT INTO contact (association_id, code_insee, kind, valeur, valeur_normalisee, is_generique, source_url, " +
      "methode_extraction, confiance, collected_at) " +
      "VALUES (?, ?, 'email', 'jumelle@asso-ru.example', 'jumelle@asso-ru.example', 1, 'https://bruzou.example/a', 'dom:mailto', 0.9, 't')",
  ).run(association.id, CODE_INSEE);
  orphelin(db, "35998", "jumelle@asso-ru.example", "Asso du Ru");

  const avecJumelle = lignes(db).filter((ligne) => ligne.includes("jumelle@asso-ru.example"));
  assert.equal(avecJumelle.length, 1);
  assert.equal(avecJumelle[0]?.split(SEPARATEUR)[2], association.nom, "c'est le RNA qui nomme");
});
