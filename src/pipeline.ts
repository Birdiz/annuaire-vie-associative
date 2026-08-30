/**
 * Orchestration d'un run — les trois passes de l'entonnoir, et rien d'autre.
 *
 * Ce module a ete extrait de `cli.ts` au lot 8, quand l'interface a gagne le droit de
 * lancer un run (ADR-024). Il n'imprime rien et ne lit aucun argument : ses deux
 * appelants — la commande `run` et le pilote de `src/ui/pilote.ts` — se chargent
 * chacun de leur restitution. Ce qui compte est que l'enchainement des passes, lui,
 * n'existe qu'ici : deux copies divergeraient sur la barriere entre l'amorce et la
 * decouverte, qui est une contrainte de correction et non un choix de style.
 */

import { toIso } from "./clock.ts";
import { requireClient, startupPurge } from "./app.ts";
import type { App } from "./app.ts";
import { Worker } from "./jobs/worker.ts";
import type { Logger } from "./log.ts";
import { creerHandlers, cleAnnuaire } from "./seed/index.ts";
import type { ContexteSeed } from "./seed/index.ts";
import { creerHandlersDecouverte, campagneDuJour, cleDecouverte } from "./decouverte/index.ts";
import type { ContexteDecouverte } from "./decouverte/index.ts";
import { PAGES_MAX_PAR_COMMUNE } from "./decouverte/scoring.ts";
import { creerHandlersNormalisation, cleNormalisation } from "./normalisation/index.ts";
import type { ContexteNormalisation } from "./normalisation/index.ts";

export type OptionsDecouverte = { maxPages: number; avecMobiles: boolean };

/**
 * Les trois passes, dans l'ordre ou elles se succedent. Persistees sur la ligne `run`
 * plutot que gardees en memoire : un suivi affiche la meme chose que le run vienne de
 * l'interface ou d'un terminal, et l'information survit au redemarrage de l'interface.
 */
export type PhaseRun = "amorce" | "decouverte" | "normalisation";

/**
 * Les trois passes dans l'ordre, aupres du type dont elles sont l'enumeration — meme
 * raison que `ETATS_JOB` : l'indicateur d'etape de l'interface a besoin de la liste, et
 * une copie la-bas manquerait la passe qu'on ajouterait ici.
 */
export const PHASES_RUN: readonly PhaseRun[] = ["amorce", "decouverte", "normalisation"];

/** La colonne `run.phase` est un TEXT nullable : elle se relit, elle ne se suppose pas. */
export function estPhaseRun(valeur: string | null | undefined): valeur is PhaseRun {
  return valeur !== null && valeur !== undefined && (PHASES_RUN as readonly string[]).includes(valeur);
}

export type OptionsRun = {
  departement: string;
  avecImport: boolean;
  rnaFile: string | undefined;
  sansDecouverte: boolean;
  decouverte: OptionsDecouverte;
};

export type ResultatRun = { runId: number; interrompu: boolean };

/** Departements du droit local, hors du champ du RNA (§ « Licence et donnees »). */
const HORS_CHAMP_RNA = ["57", "67", "68"];

const MOTIF_DEPARTEMENT = /^(\d{2}|\d[AB]|\d{3})$/i;

/**
 * Rend le message a afficher quand le departement ne convient pas, `undefined` quand il
 * convient. Un seul controle pour la CLI et pour l'interface : un departement refuse
 * d'un cote et accepte de l'autre serait un piege.
 */
export function refusDepartement(departement: string | undefined): string | undefined {
  if (!departementBienForme(departement)) return REFUS_DE_FORME;
  if (HORS_CHAMP_RNA.includes(departement)) {
    return (
      `Le département ${departement} est hors du champ du RNA (droit local d'Alsace-Moselle). ` +
      "Aucune amorce n'est disponible pour ce département."
    );
  }
  return undefined;
}

/**
 * Le seul controle de **forme**, pour les commandes qui lisent une base deja amorcee et
 * n'ont donc rien a faire du champ du RNA. Les commandes qui collectent passent, elles,
 * par `refusDepartement` au complet. Le motif vivait en double, et la copie de `cli.ts`
 * avait deja perdu le refus d'Alsace-Moselle.
 */
export function departementBienForme(departement: string | undefined): departement is string {
  return departement !== undefined && MOTIF_DEPARTEMENT.test(departement);
}

/** Le message unique du refus de forme, partage par les deux controles. */
const REFUS_DE_FORME = "Un département est requis, sous la forme 35, 2A ou 971.";

export function optionsDecouvertePardefaut(avecMobiles = false): OptionsDecouverte {
  return { maxPages: PAGES_MAX_PAR_COMMUNE, avecMobiles };
}

function marquerPhase(app: App, runId: number, phase: PhaseRun | null): void {
  app.db.prepare("UPDATE run SET phase = ? WHERE id = ?").run(phase, runId);
}

/**
 * Ouvre un run, draine les trois passes, et clot la ligne `run`.
 *
 * Le signal est celui de l'appelant : `Ctrl+C` pour la CLI, le bouton « Arreter » pour
 * l'interface. Une interruption n'est pas un echec — la file reprend ou elle s'est
 * arretee, c'est l'invariant 9.
 */
export async function executerRun(
  app: App,
  options: OptionsRun,
  signal: AbortSignal,
  onRunId?: (runId: number) => void,
): Promise<ResultatRun> {
  const { departement } = options;
  const client = requireClient(app);
  startupPurge(app);

  const info = app.db
    .prepare("INSERT INTO run (departement, started_at, statut, phase) VALUES (?, ?, 'en_cours', 'amorce')")
    .run(departement, toIso(app.clock.now()));
  const runId = Number(info.lastInsertRowid);
  onRunId?.(runId);
  const logger = app.logger.child({ run_id: runId });
  logger.info("Demarrage du run", { departement });

  const contexte: ContexteSeed = {
    db: app.db,
    client,
    counters: app.counters.forRun(runId),
    clock: app.clock,
    logger,
    queue: app.queue,
    runId,
  };

  // Tout ce qui suit l'ouverture de la ligne est couvert : un echec a l'enfilement
  // laissait la ligne ouverte aussi surement qu'un echec du worker.
  let stats;
  try {
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
    stats = await worker.run(signal);

    // La decouverte est lancee dans une seconde passe, apres que l'amorce soit
    // entierement drainee. Ce n'est pas une precaution de style : le rapprochement
    // d'un contact avec une association lit la table `association`, et la laisser
    // tourner en parallele du second dump RNA (--avec-import) ferait echouer des
    // rattachements que rien ne viendrait corriger ensuite.
    if (!options.sansDecouverte && !signal.aborted) {
      marquerPhase(app, runId, "decouverte");
      await lancerDecouverte(app, runId, logger, departement, options.decouverte, signal);
    }

    // Les etapes [7] et [8] closent le run : sans elles, les contacts sortent du crawl
    // dedupliques a moitie et sans score, donc inexploitables par l'export.
    if (!signal.aborted) {
      marquerPhase(app, runId, "normalisation");
      await lancerNormalisation(app, runId, logger, departement, signal);
    }
  } catch (cause) {
    // Un `kill -9` laisse forcement la ligne ouverte, et l'interface sait le dire. Ici le
    // process est vivant et sait que le run a echoue : le taire serait un choix.
    cloreRun(app, runId, "echec");
    throw cause;
  }

  const interrompu = signal.aborted;
  cloreRun(app, runId, interrompu ? "interrompu" : "termine");

  logger.info("Fin du run", { ...stats, interrompu });
  return { runId, interrompu };
}

/**
 * Ferme la ligne `run` : statut definitif, phase effacee, horodatage de fin.
 *
 * Le cas `echec` n'etait ecrit par personne, alors que le `CHECK` du schema l'accepte
 * depuis toujours. Sans lui, un run qui levait laissait sa ligne en `en_cours` avec une
 * phase non nulle, indefiniment : l'ecran continuait d'afficher « Run #N — phase
 * decouverte » a cote du message d'echec, et la base mentait a un process qui, lui,
 * savait tres bien ce qui s'etait passe.
 */
function cloreRun(app: App, runId: number, statut: "termine" | "interrompu" | "echec"): void {
  app.db
    .prepare("UPDATE run SET finished_at = ?, statut = ?, phase = NULL WHERE id = ?")
    .run(toIso(app.clock.now()), statut, runId);
}

/**
 * Enchaine la decouverte puis la normalisation sur une base deja amorcee.
 *
 * `annuaire decouvrir` en tenait sa propre copie : sa ligne `run` n'ecrivait jamais de
 * phase, si bien qu'un run lance dans un terminal ne s'affichait pas comme un run lance
 * depuis l'interface — la divergence exacte que l'en-tete de ce module dit vouloir
 * eviter, et que la migration 7 dit vouloir eviter aussi.
 */
export async function executerDecouverteSeule(
  app: App,
  options: { departement: string; decouverte: OptionsDecouverte },
  signal: AbortSignal,
): Promise<ResultatRun> {
  const { departement } = options;
  requireClient(app);

  const info = app.db
    .prepare("INSERT INTO run (departement, started_at, statut, phase) VALUES (?, ?, 'en_cours', 'decouverte')")
    .run(departement, toIso(app.clock.now()));
  const runId = Number(info.lastInsertRowid);
  const logger = app.logger.child({ run_id: runId });

  try {
    await lancerDecouverte(app, runId, logger, departement, options.decouverte, signal);

    if (!signal.aborted) {
      marquerPhase(app, runId, "normalisation");
      await lancerNormalisation(app, runId, logger, departement, signal);
    }
  } catch (cause) {
    cloreRun(app, runId, "echec");
    throw cause;
  }

  const interrompu = signal.aborted;
  cloreRun(app, runId, interrompu ? "interrompu" : "termine");
  return { runId, interrompu };
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

/**
 * Enfile les etapes [7] et [8] et draine la file. Lancee apres que la decouverte soit
 * entierement drainee : la deduplication et la notation lisent les contacts que celle-ci
 * produit, et les faire tourner en parallele noterait un corpus encore incomplet.
 */
async function lancerNormalisation(
  app: App,
  runId: number,
  logger: Logger,
  departement: string,
  signal: AbortSignal,
): Promise<void> {
  const contexte: ContexteNormalisation = {
    db: app.db,
    resolveur: app.resolveurMx,
    counters: app.counters.forRun(runId),
    clock: app.clock,
    logger,
    queue: app.queue,
    runId,
  };

  const jour = toIso(app.clock.now()).slice(0, 10);
  app.queue.enqueue(
    "normalisation_departement",
    cleNormalisation(departement, jour),
    { departement, tout: false },
    { runId },
  );

  const worker = new Worker(app.queue, creerHandlersNormalisation(contexte), {
    concurrency: app.config.concurrency,
  });
  const stats = await worker.run(signal);
  logger.info("Fin de la normalisation", stats);
}
