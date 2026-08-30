import { test } from "node:test";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { openDatabase } from "../../src/db/index.ts";
import type { Database } from "../../src/db/index.ts";
import { startServer, text } from "../helpers/server.ts";
import type { Handler, TestServer } from "../helpers/server.ts";
import { makeTempDir } from "../helpers/tmp.ts";
import { assertTueBrutalement } from "../helpers/plateforme.ts";

const WORKER = fileURLToPath(new URL("../fixtures/crawl-worker.ts", import.meta.url));
// Une URL `file://`, et non un chemin : `--import` traite son argument comme un
// specifieur de module, et sous Windows un chemin absolu commence par `D:\\`, que
// Node lit comme un schema d'URL inconnu — ERR_UNSUPPORTED_ESM_URL_SCHEME.
const GARDE_RESEAU = new URL("../helpers/pas-de-reseau.ts", import.meta.url).href;
const LEASE_MS = 800;
const CAMPAGNE = "2026-08-18";

function html(corps: string): Handler {
  return text(corps, 200, { "content-type": "text/html; charset=utf-8" });
}

/**
 * Faux site de mairie. Chaque contact n'apparait que sur une seule page : c'est ce qui
 * rend les compteurs comparables au contenu de la base, et donc capable de reveler un
 * effet rejoue — les index uniques de `contact`, eux, masqueraient un doublon.
 */
function routes(): Record<string, Handler> {
  const table: Record<string, Handler> = {
    "/robots.txt": text("User-agent: *\nDisallow:\n"),
    "/": html(
      `<html><body><nav>` +
        `<a href="/vie-associative">Vie associative</a>` +
        `<a href="/annuaire-des-associations">Annuaire des associations</a>` +
        `<a href="/sport">Sports et loisirs</a>` +
        `<a href="/culture">Culture</a>` +
        `</nav><p><a href="mailto:mairie@bruz.example">mairie@bruz.example</a></p></body></html>`,
    ),
  };
  const rubriques: readonly [string, string][] = [
    ["vie-associative", "club"],
    ["annuaire-des-associations", "amicale"],
    ["sport", "tennis"],
    ["culture", "theatre"],
  ];
  for (const [chemin, nom] of rubriques) {
    table[`/${chemin}`] = html(
      `<html><body><ul><li>Association ${nom} de Bruz ` +
        `<a href="mailto:${nom}@asso.example">ecrire</a></li></ul>` +
        `<a href="/${chemin}/detail">Detail des associations</a></body></html>`,
    );
    table[`/${chemin}/detail`] = html(
      `<html><body><p>Contact du secretariat : ${nom}.secretariat@asso.example</p></body></html>`,
    );
  }
  return table;
}

/** Prepare une base fichier au meme etat que la sortie du lot 2. */
function preparer(t: TestContext, server: TestServer): { dbFile: string; cacheDir: string } {
  const dir = makeTempDir(t);
  const dbFile = join(dir, "reprise.sqlite");
  const db = openDatabase(dbFile);

  db.prepare(
    `INSERT INTO commune (code_insee, nom, departement, url_mairie, statut_resolution,
       resolution_source_url, resolution_collected_at, source_resolution, resolution_confiance,
       created_at, updated_at)
     VALUES ('35047', 'Bruz', '35', ?, 'resolue', 'https://exemple.example/dump', ?, 'annuaire', 0.9, ?, ?)`,
  ).run(`${server.origin}/`, "2026-08-18T00:00:00.000Z", "2026-08-18T00:00:00.000Z", "2026-08-18T00:00:00.000Z");

  const inserer = db.prepare(
    `INSERT INTO association (rna_id, code_insee, nom, nom_normalise, source_creation, created_at, updated_at)
     VALUES (?, '35047', ?, ?, 'rna', '2026-08-18T00:00:00.000Z', '2026-08-18T00:00:00.000Z')`,
  );
  ["club", "amicale", "tennis", "theatre"].forEach((nom, i) => {
    inserer.run(`W3510000${i}`, `Association ${nom} de Bruz`, `association ${nom} de bruz`);
  });

  // Fermee avant tout spawn : deux processus ne doivent pas se disputer le WAL pendant
  // que l'un d'eux se fait tuer.
  db.close();
  return { dbFile, cacheDir: join(dir, "cache") };
}

type Sortie = { code: number | null; signal: string | null; stderr: string };

function lancerWorker(
  dbFile: string,
  cacheDir: string,
  origine: string,
  killApres: number,
  killApresMs: number,
): Promise<Sortie> {
  return new Promise((resolve) => {
    const enfant = spawn(
      process.execPath,
      [
        "--import",
        GARDE_RESEAU,
        WORKER,
        dbFile,
        cacheDir,
        origine,
        String(killApres),
        String(killApresMs),
        String(LEASE_MS),
        "4",
        CAMPAGNE,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    enfant.stderr.on("data", (morceau) => {
      stderr += String(morceau);
    });
    enfant.stdout.resume();
    enfant.on("close", (code, signal) => resolve({ code, signal, stderr }));
  });
}

type Etat = {
  pages: { url: string; statut: string; profondeur: number }[];
  contacts: { valeur_normalisee: string; kind: string; association_id: number | null; confiance: number }[];
  compteurs: Record<string, Record<string, number>>;
  jobsNonTermines: { type: string; state: string }[];
};

function lireEtat(dbFile: string): Etat {
  const db = openDatabase(dbFile);
  try {
    return {
      pages: db
        .prepare("SELECT url, statut, profondeur FROM page ORDER BY url")
        .all() as unknown as Etat["pages"],
      contacts: db
        .prepare(
          "SELECT valeur_normalisee, kind, association_id, confiance FROM contact ORDER BY kind, valeur_normalisee",
        )
        .all() as unknown as Etat["contacts"],
      compteurs: instantane(db),
      jobsNonTermines: db
        .prepare("SELECT type, state FROM job WHERE state NOT IN ('done','skipped') ORDER BY id")
        .all() as unknown as Etat["jobsNonTermines"],
    };
  } finally {
    db.close();
  }
}

function instantane(db: Database): Record<string, Record<string, number>> {
  const lignes = db
    .prepare("SELECT etape, nom, valeur FROM metric WHERE etape IN ('decouverte','extraction') ORDER BY etape, nom")
    .all() as unknown as { etape: string; nom: string; valeur: number }[];
  const sortie: Record<string, Record<string, number>> = {};
  for (const ligne of lignes) (sortie[ligne.etape] ??= {})[ligne.nom] = ligne.valeur;
  return sortie;
}

/**
 * L'oracle. Les contraintes d'unicite de `contact` masqueraient un rejeu : ce sont les
 * compteurs, seul effet non idempotent du commit, qui le revelent. Ils doivent donc
 * concorder avec ce que la base contient reellement.
 */
function assertExactementUneFois(etat: Etat): void {
  assert.deepEqual(etat.jobsNonTermines, [], "des jobs ne sont pas termines");
  assert.deepEqual(
    etat.pages.filter((page) => page.statut === "a_visiter"),
    [],
    "des pages sont restees a visiter alors que la file est drainee",
  );

  const visitees = etat.pages.filter((page) => page.statut === "visitee").length;
  assert.equal(
    etat.compteurs["decouverte"]?.["pages_visitees"],
    visitees,
    "le compteur de pages visitees ne correspond pas aux pages en base : un effet a ete perdu ou rejoue",
  );
  assert.equal(
    etat.compteurs["extraction"]?.["contacts_ecrits"],
    etat.contacts.length,
    "le compteur de contacts ne correspond pas aux contacts en base : un effet a ete perdu ou rejoue",
  );
}

async function attendreExpirationDuBail(): Promise<void> {
  // Rien n'est perdu, mais les baux des jobs en vol doivent expirer avant reprise :
  // c'est le prix de l'absence d'etat « running » (ADR-002).
  await new Promise((resolve) => setTimeout(resolve, LEASE_MS + 200));
}

test("une decouverte complete sert de reference", { timeout: 60_000 }, async (t) => {
  const server = await startServer(t, routes());
  const { dbFile, cacheDir } = preparer(t, server);

  const sortie = await lancerWorker(dbFile, cacheDir, server.origin, -1, -1);
  assert.equal(sortie.code, 0, sortie.stderr);

  const etat = lireEtat(dbFile);
  assertExactementUneFois(etat);
  assert.ok(etat.contacts.length >= 5, `la reference doit collecter des contacts, vu ${etat.contacts.length}`);
  assert.ok(etat.pages.length >= 5, `la reference doit explorer des pages, vu ${etat.pages.length}`);
});

test("reprise apres kill -9 entre le travail et la persistance", { timeout: 60_000 }, async (t) => {
  const server = await startServer(t, routes());

  // Reference : le meme crawl mene a son terme sans incident.
  const reference = preparer(t, server);
  const sortieReference = await lancerWorker(reference.dbFile, reference.cacheDir, server.origin, -1, -1);
  assert.equal(sortieReference.code, 0, sortieReference.stderr);
  const attendu = lireEtat(reference.dbFile);

  // Puis le meme crawl, tue en plein vol et repris.
  const { dbFile, cacheDir } = preparer(t, server);
  const tue = await lancerWorker(dbFile, cacheDir, server.origin, 3, -1);
  assertTueBrutalement(tue, "le worker aurait du etre tue brutalement");

  await attendreExpirationDuBail();

  const reprise = await lancerWorker(dbFile, cacheDir, server.origin, -1, -1);
  assert.equal(reprise.code, 0, reprise.stderr);

  const obtenu = lireEtat(dbFile);
  assertExactementUneFois(obtenu);
  assert.deepEqual(obtenu.pages, attendu.pages, "l'etat des pages doit etre celui d'un run sans incident");
  assert.deepEqual(obtenu.contacts, attendu.contacts, "les contacts doivent etre ceux d'un run sans incident");
});

test("reprise apres kill -9 a un instant arbitraire", { timeout: 60_000 }, async (t) => {
  const server = await startServer(t, routes());

  const reference = preparer(t, server);
  const sortieReference = await lancerWorker(reference.dbFile, reference.cacheDir, server.origin, -1, -1);
  assert.equal(sortieReference.code, 0, sortieReference.stderr);
  const attendu = lireEtat(reference.dbFile);

  const { dbFile, cacheDir } = preparer(t, server);
  // 25 ms : le crawl est en cours, la mort peut tomber pendant une transaction SQLite.
  const tue = await lancerWorker(dbFile, cacheDir, server.origin, -1, 25);
  assertTueBrutalement(tue, "le worker aurait du etre tue brutalement");

  await attendreExpirationDuBail();

  const reprise = await lancerWorker(dbFile, cacheDir, server.origin, -1, -1);
  assert.equal(reprise.code, 0, reprise.stderr);

  const obtenu = lireEtat(dbFile);
  assertExactementUneFois(obtenu);
  assert.deepEqual(obtenu.contacts, attendu.contacts, "les contacts doivent etre ceux d'un run sans incident");
});

test("relancer une decouverte deja drainee ne refait rien", { timeout: 60_000 }, async (t) => {
  const server = await startServer(t, routes());
  const { dbFile, cacheDir } = preparer(t, server);

  const premier = await lancerWorker(dbFile, cacheDir, server.origin, -1, -1);
  assert.equal(premier.code, 0, premier.stderr);
  const apresPremier = lireEtat(dbFile);

  const second = await lancerWorker(dbFile, cacheDir, server.origin, -1, -1);
  assert.equal(second.code, 0, second.stderr);
  const apresSecond = lireEtat(dbFile);

  assert.deepEqual(apresSecond.pages, apresPremier.pages, "aucune page ne doit etre ajoutee");
  assert.deepEqual(apresSecond.contacts, apresPremier.contacts, "aucun contact ne doit etre ajoute");
  assert.deepEqual(
    apresSecond.compteurs,
    apresPremier.compteurs,
    "les compteurs ne doivent pas bouger : la campagne est deja faite",
  );
});
