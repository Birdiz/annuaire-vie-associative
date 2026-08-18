/**
 * Point d'enregistrement des jobs de decouverte, sur le modele de `src/seed/index.ts`.
 * Un type de job n'existe que par son entree dans cette table : il n'y a pas de
 * registre global, et l'ordre d'execution decoule du graphe des enfilements.
 */

import type { JobHandler } from "../jobs/worker.ts";
import type { ContexteDecouverte } from "./contexte.ts";
import { handlerDecouverte } from "./planification.ts";
import { handlerPageCrawl } from "./crawl.ts";

export function creerHandlersDecouverte(ctx: ContexteDecouverte): Record<string, JobHandler> {
  return {
    decouverte_planifiee: handlerDecouverte(ctx),
    page_crawl: handlerPageCrawl(ctx),
  };
}

export { campagneDuJour, cleDecouverte, clePage, hashPage } from "./contexte.ts";
export type { ContexteDecouverte } from "./contexte.ts";
