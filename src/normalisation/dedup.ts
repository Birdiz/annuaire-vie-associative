/**
 * Etape [7] du §6 : la deduplication que le README annoncait comme limite connue.
 *
 * L'ADR-012 impose que `code_insee` soit toujours renseigne, meme quand l'association
 * l'est. Le schema porte donc deux index uniques partiels — un par association, un par
 * commune pour les contacts orphelins — et ils ne se voient pas l'un l'autre. La meme
 * adresse lue une fois dans un bloc qui nommait une association et une fois dans un bloc
 * qui n'en nommait aucune produit ainsi deux lignes, toutes deux legitimes au regard des
 * contraintes.
 *
 * **La ligne rattachee l'emporte, la ligne commune disparait.** Elle ne porte
 * strictement rien de plus : meme valeur, meme commune, et une provenance qui est celle
 * d'une lecture moins precise du meme fait. La conserver en la masquant aurait laisse
 * une table qui ne se lit plus sans filtre, et un export qui doit se souvenir de la
 * regle — deux endroits ou l'oublier.
 *
 * La regle est une requete SQL, pas une boucle applicative : c'est ce qui la rend
 * rejouable a l'identique, donc idempotente au sens du §4.9.
 */

import { transaction } from "../db/index.ts";
import { ETAPE } from "../metrics/counters.ts";
import type { Counters } from "../metrics/counters.ts";
import type { Database } from "../db/index.ts";

/**
 * `EXISTS` plutot qu'une jointure : on ne veut supprimer chaque ligne qu'une fois,
 * quel que soit le nombre d'associations de la commune qui portent la meme adresse.
 */
const SQL_DEDUP = `
DELETE FROM contact
 WHERE association_id IS NULL
   AND code_insee IN (SELECT code_insee FROM commune WHERE departement = ?)
   AND EXISTS (
     SELECT 1 FROM contact rattache
      WHERE rattache.association_id IS NOT NULL
        AND rattache.code_insee = contact.code_insee
        AND rattache.kind = contact.kind
        AND rattache.valeur_normalisee = contact.valeur_normalisee
   )
`;

/**
 * Supprime les doublons commune d'un departement. Rend le nombre de lignes retirees —
 * zero au second passage, ce qui est la preuve que la regle est rejouable.
 */
export function dedupliquer(db: Database, departement: string, counters?: Counters): number {
  return transaction(db, () => {
    const supprimes = Number(db.prepare(SQL_DEDUP).run(departement).changes);
    // Compteur cumulatif legitime : une suppression est un evenement, pas un recalcul.
    // Un second passage en compte zero, il ne peut donc pas gonfler le total.
    counters?.inc(ETAPE.normalisation, "doublons_supprimes", supprimes);
    return supprimes;
  });
}
