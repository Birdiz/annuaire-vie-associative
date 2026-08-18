import type { Database } from "../db/index.ts";
import type { HttpClient } from "../http/client.ts";
import type { Counters } from "../metrics/counters.ts";
import type { Clock } from "../clock.ts";
import type { Logger } from "../log.ts";
import type { JobQueue } from "../jobs/queue.ts";

/** Ce dont une etape de collecte a besoin, sans dependre de la composition complete. */
export type ContexteSeed = {
  db: Database;
  client: HttpClient;
  counters: Counters;
  clock: Clock;
  logger: Logger;
  queue: JobQueue;
  runId: number | null;
  /**
   * Injecte par les tests, qui visent un serveur local jetable : la suite ne sort
   * jamais sur Internet. En production, les valeurs de `src/sources.ts` s'appliquent.
   */
  sources?: {
    annuaireListing?: string | undefined;
    rnaWaldec?: string | undefined;
    rnaImport?: string | undefined;
  } | undefined;
};

/** Nombre de lignes accumulees avant d'ecrire une tranche en base. */
export const TAILLE_TRANCHE = 2_000;

export function lireDepartement(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const valeur = (payload as { departement?: unknown }).departement;
  return typeof valeur === "string" && valeur.length > 0 ? valeur : undefined;
}
