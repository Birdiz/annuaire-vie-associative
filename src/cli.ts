#!/usr/bin/env node
import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import { openApp, requireClient, startupPurge } from "./app.ts";
import type { App } from "./app.ts";
import { writeConfigTemplate, ConfigError } from "./config.ts";
import { Worker, installShutdownHandlers } from "./jobs/worker.ts";
import type { JobState } from "./jobs/queue.ts";
import { MIGRATIONS } from "./db/migrations.ts";
import { toIso } from "./clock.ts";
import { VERSION } from "./version.ts";
import { creerHandlers, cleAnnuaire } from "./seed/index.ts";
import type { ContexteSeed } from "./seed/index.ts";

const USAGE = `annuaire ${VERSION} — annuaire de la vie associative locale

Usage : annuaire <commande> [options]

Commandes
  init                    Prepare le repertoire de donnees et la base
  run --departement <dd>  Execute un run : amorce RNA et resolution des URL de mairie
  communes --departement <dd>   Communes du departement et URL de leur mairie
  associations --departement <dd>  Associations amorcees, avec leur commune
  dumps                   Etat des dumps ouverts et de leur reprise
  status                  Etat de l'installation et de la file de jobs
  metrics [--json]        Compteurs du §8
  jobs [--state <etat>]   Liste les jobs d'un etat donne (defaut : dead)
  purge                   Force la purge des donnees de plus de trois ans
  fetch <url>             Recupere une URL via le client conforme (diagnostic)

Options de run
  --avec-import           Ajoute l'extraction RNA « import » (associations sans
                          mouvement declare depuis 2009, souvent dormantes)
  --rna-file <chemin>     Lit un ZIP RNA officiel telecharge a la main plutot que le
                          miroir agrege : 6,5 Mo au lieu de 1,25 Go pour un departement

Options communes
  --data-dir <chemin>     Repertoire de donnees (defaut : emplacement systeme)
  --limit <n>             Nombre de lignes listees (defaut : 50)
  --verbose               Journalisation detaillee
  --help, --version

Les invariants — respect de robots.txt, delai de 2 s par domaine, purge a trois ans —
ne sont pas configurables et n'ont donc pas d'option.
`;

const ETATS: readonly JobState[] = ["pending", "leased", "done", "failed", "dead", "skipped"];

export async function main(argv: readonly string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        "data-dir": { type: "string" },
        departement: { type: "string" },
        state: { type: "string" },
        "rna-file": { type: "string" },
        "avec-import": { type: "boolean", default: false },
        limit: { type: "string" },
        json: { type: "boolean", default: false },
        verbose: { type: "boolean", default: false },
        help: { type: "boolean", default: false },
        version: { type: "boolean", default: false },
      },
    });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }

  const { values, positionals } = parsed;
  if (values.version === true) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const commande = positionals[0];
  if (values.help === true || commande === undefined || commande === "help") {
    process.stdout.write(USAGE);
    return commande === undefined && values.help !== true ? 2 : 0;
  }

  const ouvrir = (): App =>
    openApp({
      dataDir: values["data-dir"],
      logLevel: values.verbose === true ? "debug" : "info",
      // En sortie JSON, le journal ne doit pas polluer stdout.
      console: !(values.json === true),
    });

  try {
    switch (commande) {
      case "init":
        return commandeInit(ouvrir, values["data-dir"]);
      case "status":
        return commandeStatus(ouvrir);
      case "metrics":
        return commandeMetrics(ouvrir, values.json === true);
      case "jobs":
        return commandeJobs(ouvrir, values.state);
      case "purge":
        return commandePurge(ouvrir);
      case "run":
        return await commandeRun(ouvrir, values.departement, {
          avecImport: values["avec-import"] === true,
          rnaFile: values["rna-file"],
        });
      case "communes":
        return commandeCommunes(ouvrir, values.departement, values.json === true, values.limit);
      case "associations":
        return commandeAssociations(ouvrir, values.departement, values.json === true, values.limit);
      case "dumps":
        return commandeDumps(ouvrir, values.json === true);
      case "fetch":
        return await commandeFetch(ouvrir, positionals[1]);
      default:
        process.stderr.write(`Commande inconnue : ${commande}\n\n${USAGE}`);
        return 2;
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      return 78; // EX_CONFIG
    }
    process.stderr.write(`Echec : ${(error as Error).message}\n`);
    return 1;
  }
}

function commandeInit(ouvrir: () => App, dataDir: string | undefined): number {
  const app = ouvrir();
  try {
    const cree = writeConfigTemplate(app.paths.configFile);
    process.stdout.write(
      [
        `Repertoire de donnees : ${app.paths.dataDir}`,
        `Base                  : ${app.paths.dbFile}`,
        `Schema                : version ${MIGRATIONS.length}`,
        `Configuration         : ${app.paths.configFile}${cree ? " (creee)" : " (existante)"}`,
        "",
        app.config.contactUrl === undefined
          ? "Renseignez contactUrl dans la configuration avant toute collecte : le\n" +
            "User-Agent doit inclure une URL permettant a un webmestre de vous joindre.\n"
          : `URL de contact        : ${app.config.contactUrl}\n`,
      ].join("\n"),
    );
    return 0;
  } finally {
    app.close();
    void dataDir;
  }
}

function commandeStatus(ouvrir: () => App): number {
  const app = ouvrir();
  try {
    const counts = app.queue.counts();
    const runs = app.db
      .prepare("SELECT id, departement, started_at, finished_at, statut FROM run ORDER BY id DESC LIMIT 5")
      .all() as { id: number; departement: string; started_at: string; finished_at: string | null; statut: string }[];

    const lignes = [
      `Repertoire   : ${app.paths.dataDir}`,
      `Schema       : version ${MIGRATIONS.length}`,
      `Contact      : ${app.config.contactUrl ?? "non configure — collecte impossible"}`,
      `LLM          : ${app.config.llm.provider}`,
      "",
      `Jobs         : ${ETATS.map((etat) => `${etat}=${counts[etat]}`).join("  ")}`,
      "",
      runs.length === 0 ? "Aucun run enregistre." : "Derniers runs :",
      ...runs.map(
        (run) =>
          `  #${run.id}  dept ${run.departement}  ${run.statut}  debut ${run.started_at}` +
          `${run.finished_at === null ? "" : `  fin ${run.finished_at}`}`,
      ),
    ];
    process.stdout.write(`${lignes.join("\n")}\n`);
    return counts.dead > 0 ? 1 : 0;
  } finally {
    app.close();
  }
}

function commandeMetrics(ouvrir: () => App, json: boolean): number {
  const app = ouvrir();
  try {
    const globales = app.counters.snapshot();
    const runs = app.db.prepare("SELECT id, departement FROM run ORDER BY id").all() as {
      id: number;
      departement: string;
    }[];

    const parRun = runs.map((run) => ({
      run: run.id,
      departement: run.departement,
      metriques: app.counters.forRun(run.id).snapshot(),
    }));

    if (json) {
      process.stdout.write(`${JSON.stringify({ version: VERSION, globales, runs: parRun }, null, 2)}\n`);
      return 0;
    }

    process.stdout.write(`${formatMetrics("Global", globales)}\n`);
    for (const entree of parRun) {
      process.stdout.write(`${formatMetrics(`Run #${entree.run} (dept ${entree.departement})`, entree.metriques)}\n`);
    }
    return 0;
  } finally {
    app.close();
  }
}

function formatMetrics(titre: string, metriques: Record<string, Record<string, number>>): string {
  const etapes = Object.entries(metriques);
  if (etapes.length === 0) return `${titre}\n  (aucun compteur)`;
  return [
    titre,
    ...etapes.flatMap(([etape, valeurs]) => [
      `  ${etape}`,
      ...Object.entries(valeurs).map(([nom, valeur]) => `    ${nom.padEnd(28)} ${valeur}`),
    ]),
  ].join("\n");
}

function commandeJobs(ouvrir: () => App, etatDemande: string | undefined): number {
  const etat = (etatDemande ?? "dead") as JobState;
  if (!ETATS.includes(etat)) {
    process.stderr.write(`Etat inconnu : ${etat} (attendu : ${ETATS.join(", ")})\n`);
    return 2;
  }

  const app = ouvrir();
  try {
    const jobs = app.queue.list(etat);
    if (jobs.length === 0) {
      process.stdout.write(`Aucun job dans l'etat ${etat}.\n`);
      return 0;
    }
    for (const job of jobs) {
      const detail = job.lastError ?? job.reason ?? "";
      process.stdout.write(
        `#${job.id}  ${job.type}  ${job.dedupKey}  tentatives ${job.attempts}/${job.maxAttempts}` +
          `${detail === "" ? "" : `\n      ${detail}`}\n`,
      );
    }
    return 0;
  } finally {
    app.close();
  }
}

function commandePurge(ouvrir: () => App): number {
  const app = ouvrir();
  try {
    const resultat = startupPurge(app);
    process.stdout.write(
      `Purge jusqu'au ${resultat.cutoff} : ${resultat.contacts} contacts, ${resultat.pages} pages, ` +
        `${resultat.runs} runs, ${resultat.entreesCache} entrees de cache.\n`,
    );
    return 0;
  } finally {
    app.close();
  }
}

async function commandeRun(
  ouvrir: () => App,
  departement: string | undefined,
  options: { avecImport: boolean; rnaFile: string | undefined },
): Promise<number> {
  if (departement === undefined || !/^(\d{2}|\d[AB]|\d{3})$/i.test(departement)) {
    process.stderr.write("Un departement est requis : annuaire run --departement 35\n");
    return 2;
  }
  if (["57", "67", "68"].includes(departement)) {
    process.stderr.write(
      `Le departement ${departement} est hors du champ du RNA (droit local d'Alsace-Moselle).\n` +
        "Aucune amorce n'est disponible pour ce departement.\n",
    );
    return 2;
  }

  if (options.rnaFile !== undefined && !existsSync(options.rnaFile)) {
    process.stderr.write(`Fichier RNA introuvable : ${options.rnaFile}\n`);
    return 2;
  }

  const app = ouvrir();
  try {
    const client = requireClient(app);
    startupPurge(app);

    const info = app.db
      .prepare("INSERT INTO run (departement, started_at, statut) VALUES (?, ?, 'en_cours')")
      .run(departement, toIso(app.clock.now()));
    const runId = Number(info.lastInsertRowid);
    const logger = app.logger.child({ run_id: runId });
    logger.info("Demarrage du run", { departement });

    const controller = installShutdownHandlers(() => {
      logger.warn("Arret demande : plus aucun job n'est pris, les jobs en cours vont finir");
    });

    const contexte: ContexteSeed = {
      db: app.db,
      client,
      counters: app.counters.forRun(runId),
      clock: app.clock,
      logger,
      queue: app.queue,
      runId,
    };

    // Seule l'etape [2] est enfilee : elle enchaine elle-meme sur l'amorce RNA, qui a
    // besoin des communes pour rattacher les associations. Le dump de l'Annuaire est
    // regenere chaque jour, d'ou une cle de deduplication a la journee.
    const jour = toIso(app.clock.now()).slice(0, 10);
    app.queue.enqueue(
      "annuaire_dump",
      cleAnnuaire(departement, jour),
      {
        departement,
        avecImport: options.avecImport,
        ...(options.rnaFile === undefined ? {} : { rnaFile: options.rnaFile }),
      },
      { runId },
    );

    const worker = new Worker(app.queue, creerHandlers(contexte), { concurrency: app.config.concurrency });
    const stats = await worker.run(controller.signal);

    const interrompu = controller.signal.aborted;
    app.db
      .prepare("UPDATE run SET finished_at = ?, statut = ? WHERE id = ?")
      .run(toIso(app.clock.now()), interrompu ? "interrompu" : "termine", runId);

    logger.info("Fin du run", { ...stats, interrompu });

    resumeRun(app, departement);
    return interrompu ? 130 : 0;
  } finally {
    app.close();
  }
}

/**
 * Diagnostic : passe une URL par le client conforme et rend compte de ce qui s'est
 * applique. Sert a verifier une installation sans attendre le lot 2.
 */
async function commandeFetch(ouvrir: () => App, url: string | undefined): Promise<number> {
  if (url === undefined) {
    process.stderr.write("Une URL est requise : annuaire fetch https://exemple.fr/associations\n");
    return 2;
  }

  const app = ouvrir();
  try {
    const client = requireClient(app);
    const resultat = await client.fetch(url);

    switch (resultat.kind) {
      case "blocked":
        process.stdout.write(`Ecarte : ${resultat.reason}\n`);
        return 0;
      case "status":
        process.stdout.write(`Statut ${resultat.status} sur ${resultat.finalUrl}\n`);
        return 1;
      case "ok":
        process.stdout.write(
          [
            `Source        : ${resultat.source}`,
            `Statut        : ${resultat.meta.status}`,
            `URL finale    : ${resultat.meta.finalUrl}`,
            `Type          : ${resultat.meta.contentType ?? "inconnu"}`,
            `Taille        : ${resultat.meta.size} octets`,
            `Recupere le   : ${resultat.meta.fetchedAt}`,
            `Cache         : ${client.cachePathFor(url)}`,
            "",
          ].join("\n"),
        );
        return 0;
    }
  } finally {
    app.close();
  }
}

/** Nombre de lignes listees par defaut, pour ne pas noyer un terminal. */
const LIMITE_PAR_DEFAUT = 50;

function lireLimite(brut: string | undefined): number {
  if (brut === undefined) return LIMITE_PAR_DEFAUT;
  const valeur = Number(brut);
  return Number.isInteger(valeur) && valeur > 0 ? valeur : LIMITE_PAR_DEFAUT;
}

function exigerDepartement(departement: string | undefined, commande: string): departement is string {
  if (departement !== undefined && /^(\d{2}|\d[AB]|\d{3})$/i.test(departement)) return true;
  process.stderr.write(`Un departement est requis : annuaire ${commande} --departement 35\n`);
  return false;
}

/**
 * Le jalon du lot 2 : les communes d'un departement avec l'URL de leur mairie.
 */
function commandeCommunes(
  ouvrir: () => App,
  departement: string | undefined,
  json: boolean,
  limite: string | undefined,
): number {
  if (!exigerDepartement(departement, "communes")) return 2;
  const app = ouvrir();
  try {
    const lignes = app.db
      .prepare(
        "SELECT code_insee, nom, url_mairie, statut_resolution, resolution_source_url " +
          "FROM commune WHERE departement = ? ORDER BY code_insee LIMIT ?",
      )
      .all(departement, lireLimite(limite));

    const total = Number(
      (app.db.prepare("SELECT count(*) AS n FROM commune WHERE departement = ?").get(departement) as { n?: number })
        ?.n ?? 0,
    );
    const resolues = Number(
      (
        app.db
          .prepare("SELECT count(*) AS n FROM commune WHERE departement = ? AND statut_resolution = 'resolue'")
          .get(departement) as { n?: number }
      )?.n ?? 0,
    );

    if (json) {
      process.stdout.write(`${JSON.stringify({ departement, total, resolues, communes: lignes }, null, 2)}\n`);
      return 0;
    }

    if (total === 0) {
      process.stdout.write(`Aucune commune connue pour le departement ${departement}.\n` +
        `Lancez : annuaire run --departement ${departement}\n`);
      return 0;
    }

    for (const ligne of lignes) {
      const url = ligne.url_mairie === null ? "—" : String(ligne.url_mairie);
      process.stdout.write(`${String(ligne.code_insee).padEnd(6)} ${String(ligne.nom).padEnd(32)} ${url}\n`);
    }
    const taux = total === 0 ? 0 : Math.round((resolues / total) * 100);
    process.stdout.write(`\n${resolues}/${total} communes avec une URL de mairie (${taux} %).\n`);
    return 0;
  } finally {
    app.close();
  }
}

/** Les associations amorcees, rattachees a leur commune. */
function commandeAssociations(
  ouvrir: () => App,
  departement: string | undefined,
  json: boolean,
  limite: string | undefined,
): number {
  if (!exigerDepartement(departement, "associations")) return 2;
  const app = ouvrir();
  try {
    // Les associations dissoutes restent en base pour que leur disparition soit tracee,
    // mais un annuaire de la vie associative ne les presente pas.
    const filtre =
      "FROM association a JOIN commune c ON c.code_insee = a.code_insee " +
      "WHERE c.departement = ? AND a.date_dissolution IS NULL";
    const lignes = app.db
      .prepare(`SELECT a.rna_id, a.nom, c.nom AS commune, c.url_mairie ${filtre} ORDER BY c.nom, a.nom LIMIT ?`)
      .all(departement, lireLimite(limite));
    const total = Number(
      (app.db.prepare(`SELECT count(*) AS n ${filtre}`).get(departement) as { n?: number })?.n ?? 0,
    );
    const rattachees = Number(
      (
        app.db
          .prepare(
            "SELECT count(*) AS n FROM association a JOIN commune c ON c.code_insee = a.code_insee " +
              "WHERE c.departement = ? AND a.date_dissolution IS NULL AND c.url_mairie IS NOT NULL",
          )
          .get(departement) as { n?: number }
      )?.n ?? 0,
    );

    if (json) {
      process.stdout.write(
        `${JSON.stringify({ departement, total, avecUrlMairie: rattachees, associations: lignes }, null, 2)}\n`,
      );
      return 0;
    }

    if (total === 0) {
      process.stdout.write(`Aucune association amorcee pour le departement ${departement}.\n` +
        `Lancez : annuaire run --departement ${departement}\n`);
      return 0;
    }

    for (const ligne of lignes) {
      process.stdout.write(
        `${String(ligne.rna_id).padEnd(11)} ${String(ligne.nom).slice(0, 44).padEnd(46)} ${String(ligne.commune)}\n`,
      );
    }
    process.stdout.write(`\n${total} associations actives, dont ${rattachees} dans une commune dont l'URL est connue.\n`);
    return 0;
  } finally {
    app.close();
  }
}

/** Etat des dumps ouverts : ce qui a ete consomme, et ou une reprise repartirait. */
function commandeDumps(ouvrir: () => App, json: boolean): number {
  const app = ouvrir();
  try {
    const lignes = app.db
      .prepare(
        "SELECT source, statut, consumed_bytes, total_bytes, etag, started_at, finished_at, derniere_erreur " +
          "FROM dump ORDER BY started_at DESC, id DESC LIMIT 20",
      )
      .all();

    if (json) {
      process.stdout.write(`${JSON.stringify({ dumps: lignes }, null, 2)}\n`);
      return 0;
    }
    if (lignes.length === 0) {
      process.stdout.write("Aucun dump n'a encore ete lu.\n");
      return 0;
    }
    for (const ligne of lignes) {
      const total = ligne.total_bytes === null ? "?" : formaterOctets(Number(ligne.total_bytes));
      const lu = formaterOctets(Number(ligne.consumed_bytes ?? 0));
      process.stdout.write(
        `${String(ligne.source).padEnd(16)} ${String(ligne.statut).padEnd(9)} ${lu} / ${total}\n`,
      );
      if (ligne.derniere_erreur !== null) {
        process.stdout.write(`  ${String(ligne.derniere_erreur)}\n`);
      }
    }
    return 0;
  } finally {
    app.close();
  }
}

function formaterOctets(valeur: number): string {
  if (valeur < 1024) return `${valeur} o`;
  if (valeur < 1024 * 1024) return `${(valeur / 1024).toFixed(1)} Ko`;
  if (valeur < 1024 * 1024 * 1024) return `${(valeur / (1024 * 1024)).toFixed(1)} Mo`;
  return `${(valeur / (1024 * 1024 * 1024)).toFixed(2)} Go`;
}

/** Resume ce que le run a produit, pour que le jalon soit lisible sans autre commande. */
function resumeRun(app: App, departement: string): void {
  const compte = (sql: string): number =>
    Number((app.db.prepare(sql).get(departement) as { n?: number })?.n ?? 0);

  const communes = compte("SELECT count(*) AS n FROM commune WHERE departement = ?");
  if (communes === 0) {
    process.stdout.write("Aucune commune n'a ete resolue : verifiez l'acces reseau avec annuaire dumps.\n");
    return;
  }
  const resolues = compte(
    "SELECT count(*) AS n FROM commune WHERE departement = ? AND statut_resolution = 'resolue'",
  );
  const associations = compte(
    "SELECT count(*) AS n FROM association a JOIN commune c ON c.code_insee = a.code_insee " +
      "WHERE c.departement = ? AND a.date_dissolution IS NULL",
  );
  process.stdout.write(
    `${communes} communes, dont ${resolues} avec l'URL de leur mairie. ${associations} associations actives.\n` +
      `Detail : annuaire communes --departement ${departement}\n`,
  );
}

const estPointDEntree = process.argv[1] !== undefined && import.meta.filename === process.argv[1];
if (estPointDEntree) {
  process.exitCode = await main(process.argv.slice(2));
}
