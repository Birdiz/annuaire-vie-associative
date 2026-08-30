import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";

import { openDatabase } from "../../src/db/index.ts";
import { systemClock } from "../../src/clock.ts";
import { ResolveurMx } from "../../src/http/dns.ts";
import { normaliser } from "../../src/normalisation/rejeu.ts";
import { hashPage } from "../../src/decouverte/contexte.ts";
import { normaliserNom } from "../../src/texte.ts";
import { makeTempDir } from "../helpers/tmp.ts";
import { assertTueBrutalement } from "../helpers/plateforme.ts";

/**
 * §10 du brief : une etape n'est terminee que si elle est reprenable apres `kill -9`
 * sans doublon ni perte.
 *
 * Les etapes [7] et [8] ne tiennent **aucun** etat de reprise : la deduplication est
 * une requete rejouable, la classification et la notation sont des recalculs purs
 * ecrits par tranches, et chaque verdict MX est persiste des qu'il tombe. Ce test
 * verifie que cela suffit — tue au milieu d'une tranche, le traitement rend apres
 * relance exactement l'etat qu'un passage sans incident aurait produit.
 */

const FIXTURE = fileURLToPath(new URL("../fixtures/crash-normalisation.ts", import.meta.url));
// Une URL `file://`, et non un chemin : `--import` traite son argument comme un
// specifieur de module, et sous Windows un chemin absolu commence par `D:\\`, que
// Node lit comme un schema d'URL inconnu — ERR_UNSUPPORTED_ESM_URL_SCHEME.
const GARDE_RESEAU = new URL("../helpers/pas-de-reseau.ts", import.meta.url).href;
const CAMPAGNE = "2026-08-22";
/** Au-dela de la taille de tranche du module, sans quoi il n'y aurait rien a couper. */
const NB = 1200;

function resolveurLocal(): ResolveurMx {
  return new ResolveurMx({
    resolve: async (domaine) => [{ exchange: `mx.${domaine}`, priority: 10 }],
  });
}

/**
 * Corpus synthetique : une commune, NB associations, NB contacts dont un sur cinq est
 * un doublon au niveau commune que l'etape [7] doit resorber.
 */
function preparer(t: TestContext): string {
  const dbFile = join(makeTempDir(t), "reprise.sqlite");
  const db = openDatabase(dbFile);

  db.prepare(
    "INSERT INTO commune (code_insee, nom, departement, created_at, updated_at) " +
      "VALUES ('35047', 'Bruzou', '35', 't', 't')",
  ).run();

  const url = "https://bruzou.example/associations";
  db.prepare(
    "INSERT INTO page (url_hash, campagne, url, domaine, code_insee, statut, fetched_at, " +
      "profondeur, prefiltre_verdict, prefiltre_version) " +
      "VALUES (?, ?, ?, 'bruzou.example', '35047', 'visitee', 't', 1, 'retenue', 1)",
  ).run(hashPage(CAMPAGNE, "35047", url), CAMPAGNE, url);

  const insererAssociation = db.prepare(
    "INSERT INTO association (rna_id, code_insee, nom, nom_normalise, code_objet_social, " +
      "source_creation, created_at, updated_at) VALUES (?, '35047', ?, ?, ?, 'rna', 't', 't')",
  );
  const insererContact = db.prepare(
    "INSERT INTO contact (association_id, code_insee, kind, valeur, valeur_normalisee, " +
      "is_generique, source_url, methode_extraction, confiance, collected_at) " +
      "VALUES (?, '35047', 'email', ?, ?, ?, ?, 'dom:mailto', 0.9, 't')",
  );

  db.exec("BEGIN IMMEDIATE");
  const familles: readonly string[] = ["011000", "006030", "024000", "007000"];
  for (let i = 0; i < NB; i += 1) {
    // Un nom sur sept est un comite des fetes : le motif de nom doit l'emporter sur la
    // famille, y compris apres reprise.
    const nom = i % 7 === 0 ? `Comite des fetes de Bourg${i}` : `Association Bourg${i}`;
    insererAssociation.run(
      `W35${String(i).padStart(6, "0")}`,
      nom,
      normaliserNom(nom),
      familles[i % 4] ?? "011000",
    );
    const adresse = `contact${i}@asso${i % 40}.example`;
    insererContact.run(i + 1, adresse, adresse, 1, url);
    if (i % 5 === 0) {
      // Meme adresse, sans rattachement : le doublon que [7] doit supprimer.
      insererContact.run(null, adresse, adresse, 1, url);
    }
  }
  db.exec("COMMIT");
  db.close();

  return dbFile;
}

type Run = { code: number | null; signal: NodeJS.Signals | null };

function lancer(dbFile: string, mode: "crash" | "reprise" | "tout"): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", GARDE_RESEAU, FIXTURE, dbFile, mode], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
}

type Etat = { associations: unknown[]; contacts: unknown[]; domaines: unknown[] };

function etat(dbFile: string): Etat {
  const db = openDatabase(dbFile);
  try {
    // Les horodatages sont exclus : deux passages n'ont pas la meme heure, et c'est le
    // verdict qui doit etre stable, pas l'instant ou il a ete ecrit.
    return {
      associations: db
        .prepare(
          "SELECT rna_id, type_classifie, source_classification, classification_version " +
            "FROM association ORDER BY rna_id",
        )
        .all() as unknown[],
      contacts: db
        .prepare(
          "SELECT association_id, valeur_normalisee, score, score_motifs, score_version " +
            "FROM contact ORDER BY id",
        )
        .all() as unknown[],
      domaines: db.prepare("SELECT domaine, mx, mx_hotes, methode FROM domaine_mail ORDER BY domaine").all() as unknown[],
    };
  } finally {
    db.close();
  }
}

function compter(dbFile: string, sql: string): number {
  const db = openDatabase(dbFile);
  try {
    return Number((db.prepare(sql).get() as { n: number }).n);
  } finally {
    db.close();
  }
}

test("tue en pleine normalisation, le traitement se relance et retombe sur le meme etat", async (t) => {
  const dbFile = preparer(t);

  // Reference : ce qu'un passage sans incident produit, calcule sur une copie.
  const reference = join(makeTempDir(t), "reference.sqlite");
  copyFileSync(dbFile, reference);
  const dbReference = openDatabase(reference);
  await normaliser(dbReference, systemClock, resolveurLocal(), { departement: "35", tout: true });
  dbReference.close();
  const attendu = etat(reference);
  assert.equal(attendu.associations.length, NB);
  assert.equal(attendu.contacts.length, NB, "les doublons de commune doivent avoir disparu");

  // Mort a la premiere tranche commitee.
  const crash = await lancer(dbFile, "crash");
  assertTueBrutalement(crash, "la normalisation devait s'abattre en plein travail");

  const classees = compter(dbFile, "SELECT count(*) AS n FROM association WHERE type_classifie IS NOT NULL");
  assert.ok(classees > 0 && classees < NB, `l'interruption doit laisser un etat partiel, recu ${classees}/${NB}`);

  // La deduplication, elle, a deja ete commitee : elle precede toute tranche.
  assert.equal(
    compter(dbFile, "SELECT count(*) AS n FROM contact WHERE association_id IS NULL"),
    0,
    "la premiere passe est atomique et deja acquise",
  );

  // La relance emprunte le chemin reel d'une reprise : elle saute ce qui est deja fait.
  const dernier = await lancer(dbFile, "reprise");
  assert.equal(dernier.signal, null);
  assert.equal(dernier.code, 0);

  assert.deepEqual(etat(dbFile), attendu, "apres reprise, l'etat doit etre celui d'un passage sans incident");
});

test("relancer une normalisation deja faite ne change rien et ne recree aucun doublon", async (t) => {
  const dbFile = preparer(t);

  assert.equal((await lancer(dbFile, "tout")).code, 0);
  const apres = etat(dbFile);

  assert.equal((await lancer(dbFile, "reprise")).code, 0);
  assert.equal((await lancer(dbFile, "tout")).code, 0);

  assert.deepEqual(etat(dbFile), apres);
  assert.equal(compter(dbFile, "SELECT count(*) AS n FROM contact"), NB);
});
