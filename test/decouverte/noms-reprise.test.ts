import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";

import { openDatabase } from "../../src/db/index.ts";
import { HttpCache } from "../../src/http/cache.ts";
import { systemClock } from "../../src/clock.ts";
import { hashPage } from "../../src/decouverte/contexte.ts";
import { remplirNoms } from "../../src/decouverte/noms.ts";
import { makeTempDir } from "../helpers/tmp.ts";
import { assertTueBrutalement } from "../helpers/plateforme.ts";

/**
 * §10 du brief : une etape n'est terminee que si elle est reprenable apres `kill -9`
 * sans doublon ni perte.
 *
 * La passe de nommage ne tient **aucun** etat de reprise — c'est un recalcul pur, ecrit
 * par tranches, dont `nom_pressenti_version` est le seul marqueur. Ce test verifie que
 * cela suffit : tuee au milieu d'une transaction, elle rend apres relance exactement
 * l'etat qu'un passage sans incident aurait produit.
 *
 * Rien ne sort ici : les corps sont deposes directement dans le cache disque.
 */

const FIXTURE = fileURLToPath(new URL("../fixtures/crash-noms.ts", import.meta.url));
// Une URL `file://`, et non un chemin : `--import` traite son argument comme un
// specifieur de module, et sous Windows un chemin absolu commence par `D:\`, que Node lit
// comme un schema d'URL inconnu — ERR_UNSUPPORTED_ESM_URL_SCHEME.
const GARDE_RESEAU = new URL("../helpers/pas-de-reseau.ts", import.meta.url).href;
const CAMPAGNE = "2026-08-22";
const INSEE = "35047";
/** Au-dela de la taille de tranche du module, sans quoi il n'y aurait rien a couper. */
const NB = 600;

/** Une page par contact, chacune portant un nom distinct dans la cellule voisine. */
function corps(i: number): string {
  return `<html><body><table><tr>
    <td>Club numero ${i} de Bruz</td><td>asso${i}@exemple.example</td>
  </tr></table></body></html>`;
}

function preparer(t: TestContext): { dbFile: string; cacheDir: string } {
  const racine = makeTempDir(t);
  const dbFile = join(racine, "reprise.sqlite");
  const cacheDir = join(racine, "cache");
  const cache = new HttpCache(cacheDir);

  const db = openDatabase(dbFile);
  db.prepare(
    "INSERT INTO commune (code_insee, nom, departement, created_at, updated_at) " +
      "VALUES (?, 'Bruz', '35', 't', 't')",
  ).run(INSEE);

  const insererPage = db.prepare(
    "INSERT INTO page (url_hash, campagne, url, domaine, code_insee, statut, fetched_at, profondeur) " +
      "VALUES (?, ?, ?, 'bruz.example', ?, 'visitee', 't', 1)",
  );
  const insererContact = db.prepare(
    "INSERT INTO contact (association_id, code_insee, kind, valeur, valeur_normalisee, is_generique, " +
      "source_url, methode_extraction, confiance, collected_at) " +
      "VALUES (NULL, ?, 'email', ?, ?, 1, ?, 'texte:motif', 0.6, 't')",
  );

  for (let i = 0; i < NB; i += 1) {
    const url = `https://bruz.example/page-${i}`;
    insererPage.run(hashPage(CAMPAGNE, INSEE, url), CAMPAGNE, url, INSEE);
    cache.set(
      url,
      {
        finalUrl: url,
        status: 200,
        etag: null,
        lastModified: null,
        contentType: "text/html; charset=utf-8",
        fetchedAt: "2026-08-22T00:00:00.000Z",
      },
      Buffer.from(corps(i), "utf8"),
    );
    insererContact.run(INSEE, `asso${i}@exemple.example`, `asso${i}@exemple.example`, url);
  }
  db.close();

  return { dbFile, cacheDir };
}

type Run = { code: number | null; signal: NodeJS.Signals | null };

function lancer(dbFile: string, cacheDir: string, mode: "crash" | "reprise"): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", GARDE_RESEAU, FIXTURE, dbFile, cacheDir, mode], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
}

function etat(dbFile: string): { v: string; n: string | null; s: string | null }[] {
  const db = openDatabase(dbFile);
  try {
    // `nom_pressenti_at` est volontairement exclu : deux passages n'ont pas la meme
    // heure, et c'est le nom qui doit etre stable, pas l'instant ou il a ete ecrit.
    return db
      .prepare(
        "SELECT valeur_normalisee AS v, nom_pressenti AS n, nom_pressenti_source AS s " +
          "FROM contact ORDER BY valeur_normalisee",
      )
      .all() as unknown as { v: string; n: string | null; s: string | null }[];
  } finally {
    db.close();
  }
}

function compterNommes(dbFile: string): number {
  const db = openDatabase(dbFile);
  try {
    return Number(
      (db.prepare("SELECT count(*) AS n FROM contact WHERE nom_pressenti IS NOT NULL").get() as { n: number }).n,
    );
  } finally {
    db.close();
  }
}

test("tuee en plein travail, la passe de nommage se relance et retombe sur le meme etat", async (t) => {
  const { dbFile, cacheDir } = preparer(t);

  // Reference : ce qu'un passage sans incident produit, calcule sur une copie.
  const reference = join(makeTempDir(t), "reference.sqlite");
  copyFileSync(dbFile, reference);
  const dbReference = openDatabase(reference);
  remplirNoms(dbReference, new HttpCache(cacheDir), systemClock, { departement: "35" });
  dbReference.close();
  const attendu = etat(reference);
  assert.equal(attendu.length, NB);
  assert.equal(compterNommes(reference), NB, "toutes les pages portent un nom lisible");

  // Mort a la premiere tranche commitee : le seul instant ou l'etat en base est partiel
  // de facon certaine. Aucun chronometre, donc aucune dependance a la charge de la
  // machine — ce test ne peut pas devenir vert par accident.
  const crash = await lancer(dbFile, cacheDir, "crash");
  assertTueBrutalement(crash, "la passe devait s'abattre en plein travail");

  const partiels = compterNommes(dbFile);
  assert.ok(
    partiels > 0 && partiels < NB,
    `l'interruption doit laisser un etat partiel, recu ${partiels}/${NB}`,
  );

  // La relance emprunte le chemin reel : sans `--tout`, elle saute ce qui porte deja la
  // version courante et ne reprend que le reste.
  const reprise = await lancer(dbFile, cacheDir, "reprise");
  assert.equal(reprise.code, 0, "la relance doit aboutir");

  assert.deepEqual(etat(dbFile), attendu, "l'etat final doit etre celui d'un passage sans incident");
});
