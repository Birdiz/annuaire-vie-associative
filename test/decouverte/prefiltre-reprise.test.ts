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
import { rejouerPrefiltre } from "../../src/decouverte/rejeu.ts";
import { normaliserNom } from "../../src/texte.ts";
import { makeTempDir } from "../helpers/tmp.ts";
import { assertTueBrutalement } from "../helpers/plateforme.ts";

/**
 * §10 du brief : une etape n'est terminee que si elle est reprenable apres `kill -9`
 * sans doublon ni perte. Le rejeu du pre-filtre ne tient aucun etat de reprise — c'est
 * un recalcul pur, ecrit par tranches — et ce test verifie que cela suffit : tue a un
 * instant arbitraire, y compris au milieu d'une transaction, il rend apres relance
 * exactement l'etat qu'un passage sans incident aurait produit.
 *
 * Rien ne sort ici non plus : les corps sont deposes directement dans le cache disque.
 */

const FIXTURE = fileURLToPath(new URL("../fixtures/crash-prefiltre.ts", import.meta.url));
const CAMPAGNE = "2026-08-21";
const NB_PAGES = 600;

const ASSOCIATIONS: readonly string[] = [
  "Club de Bruz",
  "Amicale laique de Bruz",
  "Tennis club bruzois",
  "Comite des fetes de Bruz",
];

/** Pages synthetiques : une sur trois est un annuaire, les autres du remplissage. */
function corps(i: number): string {
  const bavardage = "La commune informe ses habitants des services ouverts cette semaine. ".repeat(6);
  if (i % 3 === 0) {
    const lignes = ASSOCIATIONS.map(
      (nom, j) => `<tr><td>${nom}</td><td><a href="mailto:asso${j}@exemple.example">ecrire</a></td></tr>`,
    ).join("");
    return `<html><body><p>${bavardage}</p><table>${lignes}</table></body></html>`;
  }
  return `<html><body><p>${bavardage}</p><p>${bavardage}</p></body></html>`;
}

function preparer(t: TestContext): { dbFile: string; cacheDir: string; urls: string[] } {
  const racine = makeTempDir(t);
  const dbFile = join(racine, "reprise.sqlite");
  const cacheDir = join(racine, "cache");
  const cache = new HttpCache(cacheDir);

  const db = openDatabase(dbFile);
  db.prepare(
    "INSERT INTO commune (code_insee, nom, departement, created_at, updated_at) " +
      "VALUES ('35047', 'Bruz', '35', 't', 't')",
  ).run();

  const insererAssociation = db.prepare(
    "INSERT INTO association (rna_id, code_insee, nom, nom_normalise, source_creation, created_at, updated_at) " +
      "VALUES (?, '35047', ?, ?, 'rna', 't', 't')",
  );
  ASSOCIATIONS.forEach((nom, i) => insererAssociation.run(`W3510000${i}`, nom, normaliserNom(nom)));

  const insererPage = db.prepare(
    "INSERT INTO page (url_hash, campagne, url, domaine, code_insee, statut, fetched_at, profondeur) " +
      "VALUES (?, ?, ?, 'bruz.example', '35047', 'visitee', 't', 1)",
  );

  const urls: string[] = [];
  for (let i = 0; i < NB_PAGES; i += 1) {
    const url = `https://bruz.example/page-${i}`;
    urls.push(url);
    insererPage.run(hashPage(CAMPAGNE, "35047", url), CAMPAGNE, url);
    cache.set(
      url,
      {
        finalUrl: url,
        status: 200,
        etag: null,
        lastModified: null,
        contentType: "text/html; charset=utf-8",
        fetchedAt: "2026-08-21T00:00:00.000Z",
      },
      Buffer.from(corps(i), "utf8"),
    );
  }
  db.close();

  return { dbFile, cacheDir, urls };
}

// Le garde-fou anti-reseau vit dans le processus de test ; ce sous-processus doit le
// precharger a son tour. La fixture lit le cache disque et n'emet rien — mais elle
// importe `src/http/cache.ts` et vit a cote du crawl : la frontiere est celle
// d'aujourd'hui, pas une garantie.
// Une URL `file://`, et non un chemin : `--import` traite son argument comme un
// specifieur de module, et sous Windows un chemin absolu commence par `D:\\`, que
// Node lit comme un schema d'URL inconnu — ERR_UNSUPPORTED_ESM_URL_SCHEME.
const GARDE_RESEAU = new URL("../helpers/pas-de-reseau.ts", import.meta.url).href;

type Run = { code: number | null; signal: NodeJS.Signals | null };

/** Lance le rejeu dans un sous-processus. En mode « crash », il s'abat tout seul. */
function lancer(dbFile: string, cacheDir: string, mode: "crash" | "reprise" | "tout"): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", GARDE_RESEAU, FIXTURE, dbFile, cacheDir, mode], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
}

type Verdict = Record<string, unknown>;

function verdicts(dbFile: string): Verdict[] {
  const db = openDatabase(dbFile);
  try {
    // `prefiltre_at` est volontairement exclu : deux passages n'ont pas la meme heure,
    // et c'est le verdict qui doit etre stable, pas l'instant ou il a ete ecrit.
    return db
      .prepare(
        "SELECT url, prefiltre_score, prefiltre_verdict, prefiltre_motif, prefiltre_version, " +
          "contacts_extraits FROM page ORDER BY url",
      )
      .all() as unknown as Verdict[];
  } finally {
    db.close();
  }
}

function compterJuges(dbFile: string): number {
  const db = openDatabase(dbFile);
  try {
    return Number(
      (db.prepare("SELECT count(*) AS n FROM page WHERE prefiltre_verdict IS NOT NULL").get() as { n: number }).n,
    );
  } finally {
    db.close();
  }
}

test("tue en plein rejeu, le pre-filtre se relance et retombe sur le meme etat", async (t) => {
  const { dbFile, cacheDir } = preparer(t);

  // Reference : ce qu'un passage sans incident produit, calcule sur une copie.
  const reference = join(makeTempDir(t), "reference.sqlite");
  copyFileSync(dbFile, reference);
  const dbReference = openDatabase(reference);
  rejouerPrefiltre(dbReference, new HttpCache(cacheDir), systemClock, {
    departement: "35",
    campagne: CAMPAGNE,
    tout: true,
  });
  dbReference.close();
  const attendu = verdicts(reference);
  assert.equal(attendu.length, NB_PAGES);

  // Mort a la premiere tranche commitee : le seul instant ou l'etat en base est
  // partiel de facon certaine. Aucun chronometre, donc aucune dependance a la charge
  // de la machine — ce test ne peut pas devenir vert par accident.
  const crash = await lancer(dbFile, cacheDir, "crash");
  assertTueBrutalement(crash, "le rejeu devait s'abattre en plein travail");

  const juges = compterJuges(dbFile);
  assert.ok(
    juges > 0 && juges < NB_PAGES,
    `l'interruption doit laisser un etat partiel, recu ${juges}/${NB_PAGES}`,
  );

  // La relance emprunte le chemin reel d'une reprise : elle saute ce qui est deja juge
  // et termine le reste, sans nettoyage prealable ni etat de reprise a lire.
  const dernier = await lancer(dbFile, cacheDir, "reprise");
  assert.equal(dernier.signal, null);
  assert.equal(dernier.code, 0);

  assert.deepEqual(
    verdicts(dbFile),
    attendu,
    "apres reprise, l'etat doit etre celui d'un passage sans incident",
  );

  const inacheves = openDatabase(dbFile);
  try {
    const restants = inacheves
      .prepare("SELECT count(*) AS n FROM page WHERE statut = 'visitee' AND prefiltre_verdict IS NULL")
      .get() as { n: number };
    assert.equal(Number(restants.n), 0, "aucune page ne doit rester sans verdict");
  } finally {
    inacheves.close();
  }
});
