import type { JobHandler } from "../jobs/worker.ts";
import type { ContexteSeed } from "./contexte.ts";
import { handlerAnnuaire } from "./annuaire.ts";
import { handlerRna } from "./rna.ts";

export type { ContexteSeed } from "./contexte.ts";

/**
 * Les etapes de collecte enregistrees aupres du worker.
 *
 * L'ordre d'execution n'est pas decrit ici : il decoule du graphe des jobs. Seul
 * `annuaire_dump` est enfile au demarrage d'un run ; il enfile lui-meme l'amorce RNA
 * une fois les communes connues.
 */
export function creerHandlers(ctx: ContexteSeed): Record<string, JobHandler> {
  return {
    annuaire_dump: handlerAnnuaire(ctx),
    rna_seed: handlerRna(ctx),
  };
}

/** Cle de deduplication du premier job d'un run : un dump de l'Annuaire par jour. */
export function cleAnnuaire(departement: string, jour: string): string {
  return `annuaire_local:${departement}:${jour}`;
}
