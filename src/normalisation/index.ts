/**
 * Point d'enregistrement du job de normalisation, sur le modele de
 * `src/decouverte/index.ts`. Un type de job n'existe que par son entree ici.
 */

import { normaliser } from "./rejeu.ts";
import { lirePayloadNormalisation } from "./contexte.ts";
import type { JobHandler } from "../jobs/worker.ts";
import type { ContexteNormalisation } from "./contexte.ts";

/**
 * Ce handler ecrit en base pendant son execution, par tranches. C'est l'entorse au
 * contrat de l'ADR-002 que l'ADR-008 autorise pour les jobs de longue haleine, et elle
 * est compensee de la meme facon : chaque passe est idempotente, une tranche rejouee
 * ecrit exactement les memes valeurs, et une interruption ne laisse jamais un compteur
 * en avance sur son effet.
 */
export function handlerNormalisation(ctx: ContexteNormalisation): JobHandler {
  return async (job, jobCtx) => {
    const payload = lirePayloadNormalisation(job.payload);
    if (payload === undefined) return { kind: "skipped", reason: "payload sans departement" };

    const resultat = await normaliser(ctx.db, ctx.clock, ctx.resolveur, {
      departement: payload.departement,
      tout: payload.tout,
      counters: ctx.counters,
      signal: jobCtx.signal,
      onTranche: (passe, ecrites) => ctx.logger.debug("Tranche de normalisation ecrite", { passe, ecrites }),
    });

    ctx.logger.info("Normalisation terminee", {
      departement: resultat.departement,
      doublons_supprimes: resultat.doublonsSupprimes,
      associations_classees: resultat.associationsClassees,
      domaines_verifies: resultat.mx.verifies,
      contacts_notes: resultat.contactsNotes,
    });

    // Aucun `commit` : les quatre passes ont deja ecrit, chacune dans ses propres
    // transactions. En rendre un vide serait plus honnete qu'y glisser un effet, et
    // c'est exactement ce que fait l'absence de la cle.
    return { kind: "done" };
  };
}

export function creerHandlersNormalisation(ctx: ContexteNormalisation): Record<string, JobHandler> {
  return { normalisation_departement: handlerNormalisation(ctx) };
}

export { cleNormalisation } from "./contexte.ts";
export type { ContexteNormalisation, PayloadNormalisation } from "./contexte.ts";
