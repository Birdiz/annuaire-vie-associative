/**
 * Contexte et payload du job de normalisation.
 *
 * Le resolveur MX y figure au meme titre que le client HTTP dans les autres contextes :
 * c'est la seconde porte de sortie reseau du projet, et elle s'injecte pour la meme
 * raison — la suite de tests ne sort jamais sur Internet.
 */

import type { Clock } from "../clock.ts";
import type { Database } from "../db/index.ts";
import type { ResolveurMx } from "../http/dns.ts";
import type { JobQueue } from "../jobs/queue.ts";
import type { Logger } from "../log.ts";
import type { Counters } from "../metrics/counters.ts";

export type ContexteNormalisation = {
  db: Database;
  resolveur: ResolveurMx;
  counters: Counters;
  clock: Clock;
  logger: Logger;
  queue: JobQueue;
  runId: number | null;
};

export type PayloadNormalisation = {
  departement: string;
  tout: boolean;
};

/**
 * Cle de deduplication a la journee, comme celle de la decouverte. Deux normalisations
 * du meme departement le meme jour sont le meme travail : la seconde n'a rien a
 * recalculer que la premiere n'ait deja ecrit.
 */
export function cleNormalisation(departement: string, jour: string): string {
  return `normalisation:${departement}:${jour}`;
}

/** Meme discipline que les autres payloads : un job mal forme est ecarte, pas devine. */
export function lirePayloadNormalisation(payload: unknown): PayloadNormalisation | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const brut = payload as Record<string, unknown>;
  const departement = brut["departement"];
  if (typeof departement !== "string" || departement === "") return undefined;
  return { departement, tout: brut["tout"] === true };
}
