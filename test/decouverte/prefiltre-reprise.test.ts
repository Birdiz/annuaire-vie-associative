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

type Run = { code: number | null; signal: NodeJS.Signals | null };

/**
 * Lance le rejeu et, si `killApresMs` est positif, l'abat ce delai apres qu'il a
 * annonce « pret ». Le decompte part de l'annonce et non du `spawn` : le demarrage de
 * Node dure plus longtemps que le travail lui-meme, et un delai absolu tomberait
 * systematiquement avant que la premiere page ne soit jugee.
 */
function lancer(
  dbFile: string,
  cacheDir: string,
  killApresMs: number,
  mode: "tout" | "reprise" = "tout",
): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FIXTURE, dbFile, cacheDir, mode], {
      stdio: ["ignore", "pipe", "ignore"],
    });

    if (killApresMs >= 0) {
      child.stdout.once("data", () => {
        setTimeout(() => child.kill("SIGKILL"), killApresMs);
      });
    }
    child.stdout.resume();

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

/**
 * Efface les verdicts entre deux tentatives. Sans cela, un passage qui irait au bout
 * laisserait toutes les pages jugees pour de bon, et les tentatives suivantes ne
 * pourraient plus distinguer « tue en plein travail » de « tue apres la fin ».
 */
function effacerVerdicts(dbFile: string): void {
  const db = openDatabase(dbFile);
  try {
    db.exec(
      "UPDATE page SET prefiltre_score = NULL, prefiltre_verdict = NULL, prefiltre_motif = NULL, " +
        "prefiltre_at = NULL, prefiltre_version = NULL, contacts_extraits = NULL",
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
  const debut = performance.now();
  rejouerPrefiltre(dbReference, new HttpCache(cacheDir), systemClock, {
    departement: "35",
    campagne: CAMPAGNE,
    tout: true,
  });
  // La duree du passage sain calibre les instants de mort : des delais fixes tomberaient
  // tous avant la premiere tranche sur une machine lente, et tous apres la fin sur une
  // machine rapide. Le test resterait vert, sans plus rien prouver.
  const dureeSaine = performance.now() - debut;
  dbReference.close();
  const attendu = verdicts(reference);
  assert.equal(attendu.length, NB_PAGES);

  // On cherche une mort qui tombe *en plein travail*, tranches deja ecrites et travail
  // restant. L'instant se cherche au lieu de se fixer : sous charge, un delai calibre
  // sur une machine au repos tombe avant la premiere tranche, et le test passerait au
  // vert sans avoir rien interrompu.
  let tue = false;
  let juges = 0;
  let delai = Math.max(5, Math.round(dureeSaine * 0.5));

  for (let essai = 0; essai < 12; essai += 1) {
    effacerVerdicts(dbFile);
    const run = await lancer(dbFile, cacheDir, delai);
    if (run.signal === "SIGKILL") tue = true;
    juges = compterJuges(dbFile);
    if (juges > 0 && juges < NB_PAGES) break;
    // Trop tot : aucune tranche n'etait ecrite. Trop tard : tout l'etait.
    delai = juges === 0 ? Math.round(delai * 1.7) + 5 : Math.max(3, Math.round(delai * 0.5));
  }

  assert.ok(tue, "aucun passage n'a ete interrompu : le test serait sans objet");
  assert.ok(
    juges > 0 && juges < NB_PAGES,
    `aucune mort n'est tombee en plein travail (${juges}/${NB_PAGES} juges) : le test ne prouverait rien`,
  );

  // La relance emprunte le chemin reel d'une reprise : elle saute ce qui est deja juge
  // et termine le reste, sans nettoyage prealable ni etat de reprise a lire.
  const dernier = await lancer(dbFile, cacheDir, -1, "reprise");
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
