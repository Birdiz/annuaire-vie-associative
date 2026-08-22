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
import type { Logger } from "./log.ts";
import { creerHandlers, cleAnnuaire } from "./seed/index.ts";
import type { ContexteSeed } from "./seed/index.ts";
import { creerHandlersDecouverte, campagneDuJour, cleDecouverte } from "./decouverte/index.ts";
import type { ContexteDecouverte } from "./decouverte/index.ts";
import { PAGES_MAX_PAR_COMMUNE } from "./decouverte/scoring.ts";
import { SEUIL_EXTRACTION, SEUIL_PAR_DEFAUT } from "./decouverte/prefiltre.ts";
import { derniereCampagne, distributionPrefiltre, rejouerPrefiltre } from "./decouverte/rejeu.ts";
import { mesurerDormance } from "./metrics/dormance.ts";

const USAGE = `annuaire ${VERSION} — annuaire de la vie associative locale

Usage : annuaire <commande> [options]

Commandes
  init                    Prepare le repertoire de donnees et la base
  run --departement <dd>  Execute un run complet : amorce, resolution, puis decouverte
  decouvrir --departement <dd>  Rejoue la seule decouverte sur une base deja amorcee
  communes --departement <dd>   Communes du departement et URL de leur mairie
  prefiltrer --departement <dd> Rejoue le pre-filtre [4] depuis le cache, sans reseau
  contacts --departement <dd>   Contacts collectes, avec leur provenance
  pages --departement <dd>      Pages explorees et verdict du pre-filtre
  associations --departement <dd>  Associations amorcees, avec leur commune
  dormance --departement <dd>   Anciennete de declaration des associations
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
  --sans-decouverte       S'arrete apres l'amorce, sans explorer les sites de mairie

Options de decouverte
  --max-pages <n>         Pages explorees au maximum par commune (defaut : ${PAGES_MAX_PAR_COMMUNE})
  --avec-mobiles          RISQUE. Conserve les numeros en 06/07, que le brief exclut
                          par defaut (§4.6) : un mobile associatif est presque toujours
                          la ligne personnelle d'un benevole. A n'activer qu'en
                          connaissance du regime applicable.

Options de pre-filtre
  --seuil <n>             Score a partir duquel une page est retenue (defaut : ${SEUIL_PAR_DEFAUT})
  --campagne <aaaa-mm-jj> Campagne rejouee (defaut : la derniere connue)
  --tout                  Recalcule aussi les verdicts deja a jour
  --verdict <r>           Filtre la liste des pages : retenue ou ecartee

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
        "sans-decouverte": { type: "boolean", default: false },
        "avec-mobiles": { type: "boolean", default: false },
        "max-pages": { type: "string" },
        campagne: { type: "string" },
        seuil: { type: "string" },
        verdict: { type: "string" },
        tout: { type: "boolean", default: false },
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

  const decouverte = lireOptionsDecouverte(values["max-pages"], values["avec-mobiles"] === true);
  if (decouverte === undefined) {
    process.stderr.write(`--max-pages attend un entier positif, recu « ${values["max-pages"]} »\n`);
    return 2;
  }

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
          sansDecouverte: values["sans-decouverte"] === true,
          decouverte,
        });
      case "decouvrir":
        return await commandeDecouvrir(ouvrir, values.departement, decouverte);
      case "prefiltrer":
        return commandePrefiltrer(ouvrir, values.departement, {
          campagne: values.campagne,
          seuil: values.seuil,
          tout: values.tout === true,
          avecMobiles: values["avec-mobiles"] === true,
          json: values.json === true,
        });
      case "contacts":
        return commandeContacts(ouvrir, values.departement, values.json === true, values.limit);
      case "pages":
        return commandePages(ouvrir, values.departement, values.verdict, values.json === true, values.limit);
      case "dormance":
        return commandeDormance(ouvrir, values.departement, values.json === true);
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
  options: {
    avecImport: boolean;
    rnaFile: string | undefined;
    sansDecouverte: boolean;
    decouverte: OptionsDecouverte;
  },
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

    // La decouverte est lancee dans une seconde passe, apres que l'amorce soit
    // entierement drainee. Ce n'est pas une precaution de style : le rapprochement
    // d'un contact avec une association lit la table `association`, et la laisser
    // tourner en parallele du second dump RNA (--avec-import) ferait echouer des
    // rattachements que rien ne viendrait corriger ensuite.
    if (!options.sansDecouverte && !controller.signal.aborted) {
      await lancerDecouverte(app, runId, logger, departement, options.decouverte, controller.signal);
    }

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
export type OptionsDecouverte = { maxPages: number; avecMobiles: boolean };

/** Rend `undefined` sur une valeur invalide : c'est une erreur d'usage, pas d'execution. */
function lireOptionsDecouverte(
  maxPages: string | undefined,
  avecMobiles: boolean,
): OptionsDecouverte | undefined {
  if (maxPages === undefined) return { maxPages: PAGES_MAX_PAR_COMMUNE, avecMobiles };
  const valeur = Number.parseInt(maxPages, 10);
  if (!Number.isInteger(valeur) || valeur < 1 || String(valeur) !== maxPages.trim()) return undefined;
  return { maxPages: valeur, avecMobiles };
}

/**
 * Enfile l'etape [3] et draine la file. Partage par `run`, ou elle suit l'amorce, et
 * par `decouvrir`, ou elle est rejouee seule sur une base deja amorcee — le seed d'un
 * departement coute 40 s, on ne le repaie pas a chaque reglage du scoring.
 */
async function lancerDecouverte(
  app: App,
  runId: number,
  logger: Logger,
  departement: string,
  options: OptionsDecouverte,
  signal: AbortSignal,
): Promise<void> {
  const client = requireClient(app);
  const campagne = campagneDuJour(app.clock.now());
  logger.info("Demarrage de la decouverte", { departement, campagne, ...options });

  const contexte: ContexteDecouverte = {
    db: app.db,
    client,
    counters: app.counters.forRun(runId),
    clock: app.clock,
    logger,
    queue: app.queue,
    runId,
  };

  app.queue.enqueue(
    "decouverte_planifiee",
    cleDecouverte(departement, campagne),
    { departement, campagne, maxPages: options.maxPages, avecMobiles: options.avecMobiles },
    { runId },
  );

  const worker = new Worker(app.queue, creerHandlersDecouverte(contexte), {
    concurrency: app.config.concurrency,
  });
  const stats = await worker.run(signal);
  logger.info("Fin de la decouverte", stats);
}

async function commandeDecouvrir(
  ouvrir: () => App,
  departement: string | undefined,
  options: OptionsDecouverte,
): Promise<number> {
  if (!exigerDepartement(departement, "decouvrir")) return 2;

  const app = ouvrir();
  try {
    requireClient(app);
    startupPurge(app);

    const communes = Number(
      (app.db
        .prepare("SELECT count(*) AS n FROM commune WHERE departement = ? AND url_mairie IS NOT NULL")
        .get(departement) as { n?: number } | undefined)?.n ?? 0,
    );
    if (communes === 0) {
      process.stderr.write(
        `Aucune URL de mairie connue pour le departement ${departement}.\n` +
          `Lancez d'abord l'amorce : annuaire run --departement ${departement}\n`,
      );
      return 2;
    }

    const info = app.db
      .prepare("INSERT INTO run (departement, started_at, statut) VALUES (?, ?, 'en_cours')")
      .run(departement, toIso(app.clock.now()));
    const runId = Number(info.lastInsertRowid);
    const logger = app.logger.child({ run_id: runId });

    const controller = installShutdownHandlers(() => {
      logger.warn("Arret demande : plus aucun job n'est pris, les jobs en cours vont finir");
    });

    await lancerDecouverte(app, runId, logger, departement, options, controller.signal);

    const interrompu = controller.signal.aborted;
    app.db
      .prepare("UPDATE run SET finished_at = ?, statut = ? WHERE id = ?")
      .run(toIso(app.clock.now()), interrompu ? "interrompu" : "termine", runId);

    resumeRun(app, departement);
    return interrompu ? 130 : 0;
  } finally {
    app.close();
  }
}

type LigneContact = {
  commune: string;
  association: string | null;
  kind: string;
  valeur: string;
  is_generique: number | null;
  methode_extraction: string;
  confiance: number;
  source_url: string;
  review_statut: string;
};

function commandeContacts(
  ouvrir: () => App,
  departement: string | undefined,
  json: boolean,
  limite: string | undefined,
): number {
  if (!exigerDepartement(departement, "contacts")) return 2;

  const app = ouvrir();
  try {
    const lignes = app.db
      .prepare(
        `SELECT c.nom AS commune, a.nom AS association, ct.kind, ct.valeur, ct.is_generique,
                ct.methode_extraction, ct.confiance, ct.source_url, ct.review_statut
           FROM contact ct
           JOIN commune c ON c.code_insee = ct.code_insee
           LEFT JOIN association a ON a.id = ct.association_id
          WHERE c.departement = ?
          ORDER BY ct.confiance DESC, c.nom, ct.valeur
          LIMIT ?`,
      )
      .all(departement, lireLimite(limite)) as unknown as LigneContact[];

    if (json) {
      process.stdout.write(`${JSON.stringify(lignes, null, 2)}\n`);
      return 0;
    }

    if (lignes.length === 0) {
      process.stdout.write(
        `Aucun contact pour le departement ${departement}.\n` +
          `Lancez la decouverte : annuaire decouvrir --departement ${departement}\n`,
      );
      return 0;
    }

    for (const ligne of lignes) {
      const regime = ligne.kind !== "email" ? "" : ligne.is_generique === 1 ? " [generique]" : ligne.is_generique === 0 ? " [nominatif]" : " [indetermine]";
      const cible = ligne.association ?? `${ligne.commune} (commune)`;
      process.stdout.write(
        `${ligne.valeur.padEnd(38)} ${ligne.confiance.toFixed(2)} ${ligne.methode_extraction.padEnd(18)}` +
          `${regime}\n    ${cible}\n    source : ${ligne.source_url}\n`,
      );
    }
    return 0;
  } finally {
    app.close();
  }
}

/**
 * Rejeu de l'etape [4]. Ne sort jamais sur le reseau : les corps sont relus dans le
 * cache disque. C'est ce qui permet de regler un seuil en quelques secondes plutot
 * qu'en recrawlant un departement — treize minutes plancher, et autant de requetes
 * vers de vraies mairies pour un resultat qu'on possede deja.
 */
function commandePrefiltrer(
  ouvrir: () => App,
  departement: string | undefined,
  options: {
    campagne: string | undefined;
    seuil: string | undefined;
    tout: boolean;
    avecMobiles: boolean;
    json: boolean;
  },
): number {
  if (!exigerDepartement(departement, "prefiltrer")) return 2;

  const seuil = lireSeuil(options.seuil);
  if (seuil === undefined) {
    process.stderr.write(`--seuil attend un entier, recu « ${options.seuil} »\n`);
    return 2;
  }

  const app = ouvrir();
  try {
    startupPurge(app);

    const campagne = options.campagne ?? derniereCampagne(app.db, departement);
    if (campagne === undefined) {
      process.stderr.write(
        `Aucune page exploree pour le departement ${departement}.\n` +
          `Lancez d'abord la decouverte : annuaire decouvrir --departement ${departement}\n`,
      );
      return 2;
    }

    const resultat = rejouerPrefiltre(app.db, app.cache, app.clock, {
      departement,
      campagne,
      tout: options.tout,
      avecMobiles: options.avecMobiles,
      ...(seuil === null ? {} : { seuil }),
    });
    const distribution = distributionPrefiltre(app.db, departement, campagne);

    if (options.json) {
      process.stdout.write(
        `${JSON.stringify({ departement, seuil: seuil ?? SEUIL_PAR_DEFAUT, rejeu: resultat, distribution }, null, 2)}\n`,
      );
      return 0;
    }

    const part = (n: number): string =>
      distribution.jugees === 0 ? "—" : `${((n / distribution.jugees) * 100).toFixed(1)} %`;

    process.stdout.write(
      `Campagne ${campagne}, seuil ${seuil ?? SEUIL_PAR_DEFAUT}.\n` +
        `${resultat.evaluees} pages evaluees, ${resultat.aJour} deja a jour, ` +
        `${resultat.sansCache} sans corps en cache.\n\n` +
        `${distribution.retenues} pages retenues (${part(distribution.retenues)}), ` +
        `${distribution.ecartees} ecartees (${part(distribution.ecartees)}) sur ${distribution.jugees} jugees.\n` +
        `${distribution.candidatesLlm} atteindraient le fallback [6] : retenues et sous ` +
        `${SEUIL_EXTRACTION} contacts extraits.\n`,
    );

    if (distribution.parMotif.length > 0) {
      process.stdout.write("\nMotif dominant :\n");
      for (const ligne of distribution.parMotif) {
        process.stdout.write(`  ${ligne.motif.padEnd(14)} ${String(ligne.pages).padStart(6)}\n`);
      }
    }

    // L'histogramme est la sortie utile de cette commande : c'est lui, et non une
    // opinion, qui doit fixer le seuil (meme discipline que l'ADR-013 pour la dormance).
    if (distribution.histogramme.length > 0) {
      const maximum = Math.max(...distribution.histogramme.map((ligne) => ligne.pages));
      process.stdout.write("\nDistribution des scores :\n");
      for (const ligne of distribution.histogramme) {
        const barre = "#".repeat(Math.max(1, Math.round((ligne.pages / maximum) * 40)));
        process.stdout.write(
          `  ${String(ligne.borne).padStart(4)} ${String(ligne.pages).padStart(6)}  ${barre}\n`,
        );
      }
    }
    return 0;
  } finally {
    app.close();
  }
}

/** `null` signifie « non precise » ; `undefined`, « valeur invalide ». */
function lireSeuil(brut: string | undefined): number | null | undefined {
  if (brut === undefined) return null;
  const valeur = Number.parseInt(brut, 10);
  if (!Number.isInteger(valeur) || String(valeur) !== brut.trim()) return undefined;
  return valeur;
}

type LignePage = {
  commune: string;
  url: string;
  prefiltre_score: number | null;
  prefiltre_verdict: string | null;
  prefiltre_motif: string | null;
  contacts_extraits: number | null;
  profondeur: number;
};

/** Les pages explorees et ce que le pre-filtre en dit — l'etage [4] de l'entonnoir. */
function commandePages(
  ouvrir: () => App,
  departement: string | undefined,
  verdict: string | undefined,
  json: boolean,
  limite: string | undefined,
): number {
  if (!exigerDepartement(departement, "pages")) return 2;
  if (verdict !== undefined && verdict !== "retenue" && verdict !== "ecartee") {
    process.stderr.write(`--verdict attend « retenue » ou « ecartee », recu « ${verdict} »\n`);
    return 2;
  }

  const app = ouvrir();
  try {
    const filtreVerdict = verdict === undefined ? "" : "AND p.prefiltre_verdict = ? ";
    const params: (string | number)[] = verdict === undefined ? [] : [verdict];

    const lignes = app.db
      .prepare(
        `SELECT c.nom AS commune, p.url, p.prefiltre_score, p.prefiltre_verdict,
                p.prefiltre_motif, p.contacts_extraits, p.profondeur
           FROM page p
           JOIN commune c ON c.code_insee = p.code_insee
          WHERE c.departement = ? AND p.statut = 'visitee' ${filtreVerdict}
          ORDER BY p.prefiltre_score DESC, p.url
          LIMIT ?`,
      )
      .all(departement, ...params, lireLimite(limite)) as unknown as LignePage[];

    if (json) {
      process.stdout.write(`${JSON.stringify({ departement, pages: lignes }, null, 2)}\n`);
      return 0;
    }

    if (lignes.length === 0) {
      process.stdout.write(
        `Aucune page exploree pour le departement ${departement}.\n` +
          `Lancez la decouverte : annuaire decouvrir --departement ${departement}\n`,
      );
      return 0;
    }

    for (const ligne of lignes) {
      const score = ligne.prefiltre_score === null ? "  —  " : ligne.prefiltre_score.toFixed(1).padStart(5);
      const verdictAffiche = (ligne.prefiltre_verdict ?? "non juge").padEnd(9);
      const motif = (ligne.prefiltre_motif ?? "—").padEnd(12);
      process.stdout.write(
        `${score} ${verdictAffiche} ${motif} ${String(ligne.contacts_extraits ?? 0).padStart(3)} contacts\n` +
          `    ${ligne.url}\n`,
      );
    }
    return 0;
  } finally {
    app.close();
  }
}

/**
 * Anciennete de declaration des associations. C'est la mesure que l'ADR-013 reclame
 * avant de pouvoir lire le taux de couverture : le seuil de dormance doit sortir de
 * cette distribution, pas d'une intuition.
 */
function commandeDormance(ouvrir: () => App, departement: string | undefined, json: boolean): number {
  if (!exigerDepartement(departement, "dormance")) return 2;

  const app = ouvrir();
  try {
    const mesure = mesurerDormance(app.db, departement, app.clock.now());

    if (json) {
      process.stdout.write(`${JSON.stringify(mesure, null, 2)}\n`);
      return 0;
    }

    if (mesure.actives === 0) {
      process.stdout.write(
        `Aucune association amorcee pour le departement ${departement}.\n` +
          `Lancez : annuaire run --departement ${departement}\n`,
      );
      return 0;
    }

    const part = (n: number): string => `${((n / mesure.actives) * 100).toFixed(1)} %`;
    process.stdout.write(
      `${mesure.actives} associations actives.\n` +
        `${mesure.nonDormantes} ont declare depuis le ${mesure.borne} (${part(mesure.nonDormantes)}), ` +
        `${mesure.dormantes} avant (${part(mesure.dormantes)}), ` +
        `${mesure.sansDate} sans date de declaration (${part(mesure.sansDate)}).\n` +
        `Seuil applique : ${mesure.seuilAnnees} ans.\n`,
    );

    if (mesure.parAnnee.length > 0) {
      const maximum = Math.max(...mesure.parAnnee.map((ligne) => ligne.associations));
      process.stdout.write("\nDeclarations par annee :\n");
      for (const ligne of mesure.parAnnee) {
        const barre = "#".repeat(Math.max(1, Math.round((ligne.associations / maximum) * 40)));
        process.stdout.write(
          `  ${ligne.annee} ${String(ligne.associations).padStart(6)}  ${barre}\n`,
        );
      }
    }
    return 0;
  } finally {
    app.close();
  }
}

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
    `${communes} communes, dont ${resolues} avec l'URL de leur mairie. ${associations} associations actives.\n`,
  );

  const pagesVisitees = compte(
    "SELECT count(*) AS n FROM page p JOIN commune c ON c.code_insee = p.code_insee " +
      "WHERE c.departement = ? AND p.statut = 'visitee'",
  );
  if (pagesVisitees === 0) {
    process.stdout.write(
      `Aucune page exploree. Detail : annuaire communes --departement ${departement}\n`,
    );
    return;
  }

  // Detaille plutot qu'agrege : « sans collecte possible » melangeait trois causes de
  // nature differente. Un site injoignable est un incident, un site interdit par
  // robots.txt est une limite assumee du produit (§4.2), et une commune non tentee est
  // un run inacheve. Les confondre empeche de savoir s'il faut relancer, corriger, ou
  // ne rien faire.
  const bloquees = compte(
    "SELECT count(*) AS n FROM commune WHERE departement = ? AND crawl_statut = 'interdit_robots'",
  );
  const injoignables = compte(
    "SELECT count(*) AS n FROM commune WHERE departement = ? AND crawl_statut IN ('injoignable','refuse')",
  );
  const nonTentees = compte(
    "SELECT count(*) AS n FROM commune WHERE departement = ? AND url_mairie IS NOT NULL AND crawl_statut = 'non_tente'",
  );
  const contacts = compte(
    "SELECT count(*) AS n FROM contact ct JOIN commune c ON c.code_insee = ct.code_insee " +
      "WHERE c.departement = ?",
  );
  // §8 du brief : le taux de couverture est la metrique qui fera le README. Elle se
  // mesure sur les associations, pas sur les pages : c'est l'annuaire qu'on construit.
  const couvertes = compte(
    "SELECT count(DISTINCT a.id) AS n FROM association a " +
      "JOIN commune c ON c.code_insee = a.code_insee " +
      "JOIN contact ct ON ct.association_id = a.id AND ct.kind = 'email' " +
      "WHERE c.departement = ? AND a.date_dissolution IS NULL",
  );

  // Les deux denominateurs sont affiches ensemble (ADR-013). Ne montrer que le second,
  // plus favorable, reviendrait a ameliorer le chiffre en changeant la question : le
  // taux sur les actives reste donc en premier, et le critere qui produit l'autre est
  // ecrit en toutes lettres.
  const dormance = mesurerDormance(app.db, departement, app.clock.now());
  const couvertesNonDormantes = Number(
    (
      app.db
        .prepare(
          "SELECT count(DISTINCT a.id) AS n FROM association a " +
            "JOIN commune c ON c.code_insee = a.code_insee " +
            "JOIN contact ct ON ct.association_id = a.id AND ct.kind = 'email' " +
            "WHERE c.departement = ? AND a.date_dissolution IS NULL AND a.date_declaration >= ?",
        )
        .get(departement, dormance.borne) as { n?: number } | undefined
    )?.n ?? 0,
  );

  const taux = associations === 0 ? 0 : (couvertes / associations) * 100;
  const tauxQualifie =
    dormance.nonDormantes === 0 ? undefined : (couvertesNonDormantes / dormance.nonDormantes) * 100;

  const reste =
    nonTentees === 0
      ? ""
      : `${nonTentees} communes restent a explorer : relancez la meme commande, rien ne sera refait.\n`;

  process.stdout.write(
    `${pagesVisitees} pages explorees.${resumePrefiltre(app, departement)}\n` +
      `${bloquees} communes interdites par robots.txt, ${injoignables} injoignables.\n` +
      reste +
      `${contacts} contacts collectes. Couverture : ${couvertes} associations avec au moins ` +
      `un email, soit ${taux.toFixed(1)} % des ${associations} actives` +
      (tauxQualifie === undefined
        ? ".\n"
        : ` — ${tauxQualifie.toFixed(1)} % des ${dormance.nonDormantes} ayant declare ` +
          `depuis moins de ${dormance.seuilAnnees} ans.\n`) +
      `Detail : annuaire contacts --departement ${departement}\n`,
  );
}

/**
 * L'etage [4] de l'entonnoir, en une phrase. Le ratio de pages qui atteindraient le
 * fallback LLM est la metrique que le §8 reclame — et ce lot la rend lisible sans
 * qu'une seule ligne d'inference ait ete ecrite.
 */
function resumePrefiltre(app: App, departement: string): string {
  const campagne = derniereCampagne(app.db, departement);
  if (campagne === undefined) return "";
  const d = distributionPrefiltre(app.db, departement, campagne);
  if (d.jugees === 0) return "";
  const part = ((d.retenues / d.jugees) * 100).toFixed(1);
  return (
    `\n${d.retenues} ${pluriel(d.retenues, "page retenue", "pages retenues")} par le pre-filtre ` +
    `(${part} %), ${d.ecartees} ${pluriel(d.ecartees, "ecartee", "ecartees")} ; ` +
    `${d.candidatesLlm} ${pluriel(d.candidatesLlm, "atteindrait", "atteindraient")} le fallback LLM.`
  );
}

/** Zero prend le pluriel en francais, un prend le singulier. */
function pluriel(nombre: number, singulier: string, pluriels: string): string {
  return nombre === 1 ? singulier : pluriels;
}

const estPointDEntree = process.argv[1] !== undefined && import.meta.filename === process.argv[1];
if (estPointDEntree) {
  process.exitCode = await main(process.argv.slice(2));
}
