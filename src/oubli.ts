/**
 * Droit d'opposition et d'effacement (art. 17 et 21 du RGPD).
 *
 * L'outil produit un fichier de donnees personnelles collectees **indirectement** : son
 * utilisateur est responsable de traitement, et devra repondre a des personnes qui
 * demandent a en sortir. Jusqu'au lot 9 il ne le pouvait pas — « rejeter » en revue
 * n'ecrivait qu'un statut, que l'export savait remettre, et le run suivant recollectait
 * l'adresse.
 *
 * Oublier fait donc trois choses, et les trois comptent :
 *
 * 1. **inscrire l'exclusion**, pour que la campagne suivante ne recollecte pas ;
 * 2. **supprimer les lignes** deja en base ;
 * 3. **supprimer les copies en cache** des pages qui portaient la donnee — le cache
 *    contient le HTML brut, donc l'adresse elle-meme.
 *
 * Ce que cela ne fait pas, et qu'il faut savoir : le site tiers, lui, publie toujours
 * l'adresse. Un nouveau crawl la remettra dans le cache HTTP, ou la purge a trois ans
 * l'emportera. Ce qui est garanti est qu'elle ne rentrera plus dans l'annuaire, c'est-a-
 * dire dans ce qui est exporte et transmis.
 */

import { transaction } from "./db/index.ts";
import { toIso } from "./clock.ts";
import type { Clock } from "./clock.ts";
import type { Database } from "./db/index.ts";
import type { Counters } from "./metrics/counters.ts";
import { ETAPE } from "./metrics/counters.ts";

export type Portee = "contact" | "domaine" | "commune";

export type DemandeOubli = {
  portee: Portee;
  valeur: string;
  motif: string;
  origine: "cli" | "revue";
};

export type ResultatOubli = {
  portee: Portee;
  valeur: string;
  contactsSupprimes: number;
  entreesCacheSupprimees: number;
  /** Faux quand l'exclusion existait deja : l'operation reste idempotente. */
  nouvelle: boolean;
};

/**
 * Vrai si un contact tombe sous une exclusion. Consulte a chaque ecriture, d'ou l'index
 * de la migration 10 : c'est le prix a payer pour que l'opposition survive au run suivant.
 */
export const SQL_EST_EXCLU = `
  SELECT 1 FROM exclusion
   WHERE (portee = 'contact' AND valeur = ?1)
      OR (portee = 'domaine' AND ?1 LIKE '%@' || valeur)
      OR (portee = 'commune' AND valeur = ?2)
   LIMIT 1
`;

const SQL_CONTACTS_VISES = `
  SELECT id, source_url, code_insee FROM contact
   WHERE (?1 = 'contact' AND valeur_normalisee = ?2)
      OR (?1 = 'domaine' AND valeur_normalisee LIKE '%@' || ?2)
      OR (?1 = 'commune' AND code_insee = ?2)
`;

/** Normalise la valeur selon la portee, pour que la comparaison soit celle de la base. */
export function normaliserValeur(portee: Portee, brut: string): string {
  const valeur = brut.trim().toLowerCase();
  // Une portee « domaine » saisie sous forme d'adresse est une erreur courante : on
  // retient ce qui suit l'arobase plutot que de ne rien trouver.
  if (portee === "domaine" && valeur.includes("@")) return valeur.slice(valeur.indexOf("@") + 1);
  return valeur;
}

/**
 * Inscrit l'exclusion, supprime ce qu'elle vise, et rend compte.
 *
 * Tout se passe dans une transaction : une opposition a moitie honoree — la ligne
 * supprimee mais l'exclusion absente — serait pire que rien, puisque le run suivant
 * remettrait la donnee sans que personne ne s'en apercoive.
 */
export function oublier(
  db: Database,
  clock: Clock,
  counters: Counters,
  demande: DemandeOubli,
  supprimerCache?: (cheminRelatif: string) => boolean,
): ResultatOubli {
  const valeur = normaliserValeur(demande.portee, demande.valeur);
  if (valeur === "") throw new Error("Une valeur est requise pour oublier quelque chose.");
  if (demande.motif.trim() === "") throw new Error("Un motif est requis : il fait la preuve de la demande honoree.");

  return transaction(db, () => {
    const maintenant = toIso(clock.now());
    const inscription = db
      .prepare(
        `INSERT OR IGNORE INTO exclusion (portee, valeur, motif, origine, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(demande.portee, valeur, demande.motif.trim(), demande.origine, maintenant);

    const vises = db.prepare(SQL_CONTACTS_VISES).all(demande.portee, valeur) as unknown as {
      id: number;
      source_url: string;
      code_insee: string | null;
    }[];

    let entreesCacheSupprimees = 0;
    if (supprimerCache !== undefined) {
      // Les pages qui portaient la donnee gardent son HTML brut. Les laisser reviendrait
      // a effacer d'une main ce qu'on conserve de l'autre.
      const pages = new Set(vises.map((ligne) => ligne.source_url));
      for (const url of pages) {
        const chemin = db
          .prepare("SELECT cache_path FROM page WHERE coalesce(final_url, url) = ? AND cache_path IS NOT NULL")
          .get(url) as { cache_path?: string } | undefined;
        if (chemin?.cache_path !== undefined && supprimerCache(chemin.cache_path)) entreesCacheSupprimees += 1;
      }
    }

    const supprimes = db
      .prepare(
        `DELETE FROM contact
          WHERE (?1 = 'contact' AND valeur_normalisee = ?2)
             OR (?1 = 'domaine' AND valeur_normalisee LIKE '%@' || ?2)
             OR (?1 = 'commune' AND code_insee = ?2)`,
      )
      .run(demande.portee, valeur).changes;

    counters.inc(ETAPE.purge, "contacts_oublies", Number(supprimes));
    if (entreesCacheSupprimees > 0) {
      counters.inc(ETAPE.purge, "entrees_cache_oubliees", entreesCacheSupprimees);
    }

    return {
      portee: demande.portee,
      valeur,
      contactsSupprimes: Number(supprimes),
      entreesCacheSupprimees,
      nouvelle: Number(inscription.changes) > 0,
    };
  });
}

/** Les exclusions inscrites, la plus recente d'abord. */
export function exclusions(db: Database, limite = 50): readonly {
  portee: Portee;
  valeur: string;
  motif: string;
  origine: string;
  created_at: string;
}[] {
  return db
    .prepare("SELECT portee, valeur, motif, origine, created_at FROM exclusion ORDER BY id DESC LIMIT ?")
    .all(limite) as unknown as {
    portee: Portee;
    valeur: string;
    motif: string;
    origine: string;
    created_at: string;
  }[];
}
