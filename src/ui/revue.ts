/**
 * Ecritures de la revue humaine (etape [8] du §6, ecran de revue).
 *
 * Trois verbes seulement — valider, rejeter, corriger — et aucune logique de score : le
 * serveur HTTP n'a pas a savoir comment on note. Une correction remet `score_version` a
 * `NULL`, ce qui est le mecanisme de peremption deja utilise par le lot 5 ; c'est
 * `annuaire normaliser` qui revalidera la syntaxe, resoudra le MX du nouveau domaine et
 * renotera la ligne. La revue dit ce qu'un humain a vu, pas ce que ca vaut.
 *
 * `valeur` n'est jamais reecrite : c'est ce qui a ete lu sur la page, donc de la
 * provenance au sens de l'invariant 5. La saisie humaine vit dans `valeur_corrigee`, et
 * `valeur_normalisee` — la seule que le MX et la notation lisent — suit la correction.
 */

import { transaction } from "../db/index.ts";
import type { Database } from "../db/index.ts";
import { toIso } from "../clock.ts";
import type { Clock } from "../clock.ts";
import { Counters, ETAPE } from "../metrics/counters.ts";
import { nettoyerEmail, classerEmail, normaliserTelephone, estMobile } from "../decouverte/extraction.ts";

export type ActionRevue = "valide" | "rejete" | "corrige";

const ACTIONS: readonly string[] = ["valide", "rejete", "corrige"];

export function estActionRevue(valeur: string): valeur is ActionRevue {
  return ACTIONS.includes(valeur);
}

export type ResultatRevue =
  | { kind: "ok"; action: ActionRevue }
  | { kind: "introuvable" }
  /** L'arbitrage est refuse, et la raison est destinee a etre lue par la personne. */
  | { kind: "refus"; message: string };

export type OrdreRevue = {
  id: number;
  action: ActionRevue;
  /** Requise pour « corriger », ignoree sinon. */
  valeur?: string | undefined;
  note?: string | undefined;
};

type LigneContact = { id: number; kind: string; valeur_normalisee: string };

export function arbitrer(
  db: Database,
  clock: Clock,
  counters: Counters,
  ordre: OrdreRevue,
): ResultatRevue {
  const contact = db.prepare("SELECT id, kind, valeur_normalisee FROM contact WHERE id = ?").get(ordre.id) as
    | LigneContact
    | undefined;
  if (contact === undefined) return { kind: "introuvable" };

  const maintenant = toIso(clock.now());
  const note = ordre.note === undefined || ordre.note.trim() === "" ? null : ordre.note.trim().slice(0, 500);

  if (ordre.action !== "corrige") {
    transaction(db, () => {
      db.prepare(
        "UPDATE contact SET review_statut = ?, review_note = ?, review_at = ? WHERE id = ?",
      ).run(ordre.action, note, maintenant, ordre.id);
      counters.inc(ETAPE.revue, ordre.action === "valide" ? "valides" : "rejetes");
    });
    return { kind: "ok", action: ordre.action };
  }

  const kind = contact.kind === "phone" ? "phone" : "email";
  const normalisee = normaliserSaisie(kind, ordre.valeur ?? "");
  if (normalisee.kind === "refus") return normalisee;

  if (normalisee.valeurNormalisee === contact.valeur_normalisee) {
    return {
      kind: "refus",
      message: "La valeur saisie est identique a celle qui a ete lue : validez-la plutot que de la corriger.",
    };
  }

  try {
    transaction(db, () => {
      db.prepare(
        `UPDATE contact
            SET valeur_corrigee = ?, valeur_normalisee = ?, is_generique = ?,
                review_statut = 'corrige', review_note = ?, review_at = ?,
                score_version = NULL
          WHERE id = ?`,
      ).run(
        normalisee.valeur,
        normalisee.valeurNormalisee,
        normalisee.isGenerique,
        note,
        maintenant,
        ordre.id,
      );
      counters.inc(ETAPE.revue, "corriges");
    });
  } catch (cause) {
    // La contrainte d'unicite du lot 1 vient de dire que cette valeur existe deja sur
    // cette association. C'est une information, pas une panne : l'ecraser silencieusement
    // ferait disparaitre un contact, et le doublon est justement ce que la base empeche.
    const message = (cause as Error).message;
    if (message.includes("UNIQUE constraint failed")) {
      return {
        kind: "refus",
        message: "Cette valeur existe deja pour ce rattachement : le contact en double ne peut pas etre cree.",
      };
    }
    throw cause;
  }

  return { kind: "ok", action: "corrige" };
}

type SaisieNormalisee = {
  kind: "ok";
  valeur: string;
  valeurNormalisee: string;
  isGenerique: 0 | 1 | null;
};

/**
 * La saisie humaine passe par les memes regles de forme que l'extraction : deux
 * normalisations differentes produiraient deux populations de contacts que rien ne
 * distinguerait ensuite en base.
 */
export function normaliserSaisie(
  kind: "email" | "phone",
  brut: string,
): SaisieNormalisee | { kind: "refus"; message: string } {
  const saisie = brut.trim();
  if (saisie === "") return { kind: "refus", message: "Aucune valeur saisie." };

  if (kind === "email") {
    const valeur = nettoyerEmail(saisie);
    if (valeur === undefined) {
      return { kind: "refus", message: `« ${saisie} » n'a pas la forme d'une adresse electronique.` };
    }
    return { kind: "ok", valeur, valeurNormalisee: valeur.toLowerCase(), isGenerique: classerEmail(valeur) };
  }

  const normalise = normaliserTelephone(saisie);
  if (normalise === undefined) {
    return { kind: "refus", message: `« ${saisie} » n'a pas la forme d'un numero francais.` };
  }
  // §4.6 : les mobiles sont exclus par defaut, derriere un flag explicite que l'UI n'a
  // pas. Les laisser entrer par la revue contournerait l'invariant par une porte que
  // personne n'a ouverte — un mobile associatif est presque toujours la ligne
  // personnelle d'un benevole.
  if (estMobile(normalise)) {
    return {
      kind: "refus",
      message:
        "Les numeros mobiles (06/07) sont exclus par defaut (§4.6) : ils ne peuvent pas entrer par la revue.",
    };
  }
  return { kind: "ok", valeur: saisie, valeurNormalisee: normalise, isGenerique: null };
}
