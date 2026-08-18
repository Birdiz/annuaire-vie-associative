#!/usr/bin/env node
import { parseArgs } from "node:util";
import { openApp, requireClient, startupPurge } from "./app.ts";
import type { App } from "./app.ts";
import { writeConfigTemplate, ConfigError } from "./config.ts";
import { Worker, installShutdownHandlers } from "./jobs/worker.ts";
import type { JobState } from "./jobs/queue.ts";
import { MIGRATIONS } from "./db/migrations.ts";
import { toIso } from "./clock.ts";
import { VERSION } from "./version.ts";

const USAGE = `annuaire ${VERSION} — annuaire de la vie associative locale

Usage : annuaire <commande> [options]

Commandes
  init                    Prepare le repertoire de donnees et la base
  run --departement <dd>  Execute un run (purge, puis traitement de la file)
  status                  Etat de l'installation et de la file de jobs
  metrics [--json]        Compteurs du §8
  jobs [--state <etat>]   Liste les jobs d'un etat donne (defaut : dead)
  purge                   Force la purge des donnees de plus de trois ans
  fetch <url>             Recupere une URL via le client conforme (diagnostic)

Options communes
  --data-dir <chemin>     Repertoire de donnees (defaut : emplacement systeme)
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
        return await commandeRun(ouvrir, values.departement);
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

async function commandeRun(ouvrir: () => App, departement: string | undefined): Promise<number> {
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

  const app = ouvrir();
  try {
    requireClient(app);
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

    // Les etapes de collecte s'enregistreront ici a partir du lot 2. Le socle draine
    // deja la file : un run sur une file vide se termine proprement.
    const worker = new Worker(app.queue, {}, { concurrency: app.config.concurrency });
    const stats = await worker.run(controller.signal);

    const interrompu = controller.signal.aborted;
    app.db
      .prepare("UPDATE run SET finished_at = ?, statut = ? WHERE id = ?")
      .run(toIso(app.clock.now()), interrompu ? "interrompu" : "termine", runId);

    logger.info("Fin du run", { ...stats, interrompu });

    if (app.queue.counts().pending === 0 && stats.done === 0 && stats.skipped === 0) {
      process.stdout.write(
        "Aucune etape de collecte n'est encore enregistree : le lot 1 ne fournit que le\n" +
          "socle (base, file de jobs, cache et client HTTP). L'amorce RNA arrive au lot 2.\n",
      );
    }
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

const estPointDEntree = process.argv[1] !== undefined && import.meta.filename === process.argv[1];
if (estPointDEntree) {
  process.exitCode = await main(process.argv.slice(2));
}
