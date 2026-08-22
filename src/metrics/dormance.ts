/**
 * Qualification de la dormance des associations, et denominateurs du taux de couverture.
 *
 * L'ADR-013 laisse le taux de couverture du §8 ininterpretable : ses 1,5 % portent sur
 * toutes les associations non dissoutes du RNA, dont une part inconnue n'a plus donne
 * signe de vie depuis des annees. Une association dissoute se declare ; une association
 * dormante, non — elle cesse simplement de declarer. `date_decla`, la date de derniere
 * declaration en prefecture, est le seul signal disponible.
 *
 * Deux precautions tiennent ce module honnete.
 *
 * Les associations **sans date** ne sont comptees ni comme dormantes ni comme vivantes :
 * elles sont rendues a part. Les verser d'un cote ou de l'autre trancherait par defaut
 * une question sur laquelle la source ne dit rien.
 *
 * Le seuil est **un parametre, pas une verite**. L'ADR-013 exige qu'il soit « choisi sur
 * la distribution observee de `date_decla` plutot que fixe a priori » : la valeur
 * ci-dessous est provisoire, et c'est l'histogramme rendu par ce meme module qui doit la
 * fixer. Elle apparait dans les sorties pour que personne ne lise un pourcentage sans
 * voir le critere qui l'a produit.
 */

import { cutoffFor } from "../purge.ts";
import { toIso } from "../clock.ts";
import type { Database } from "../db/index.ts";

/** Provisoire — a figer sur la distribution reelle (ADR-013). */
export const SEUIL_DORMANCE_ANNEES = 5;

export type Dormance = {
  departement: string;
  seuilAnnees: number;
  /** Date de declaration en deca de laquelle une association est dite dormante. */
  borne: string;
  /** Associations non dissoutes : le denominateur historique. */
  actives: number;
  /** Actives ayant declare depuis la borne : le denominateur qualifie. */
  nonDormantes: number;
  /** Actives dont la declaration est anterieure a la borne. */
  dormantes: number;
  /** Actives sans date de declaration : ni l'un ni l'autre, et il faut le dire. */
  sansDate: number;
  parAnnee: readonly { annee: string; associations: number }[];
};

const FILTRE_ACTIVES =
  "FROM association a JOIN commune c ON c.code_insee = a.code_insee " +
  "WHERE c.departement = ? AND a.date_dissolution IS NULL";

export function mesurerDormance(
  db: Database,
  departement: string,
  nowMs: number,
  seuilAnnees: number = SEUIL_DORMANCE_ANNEES,
): Dormance {
  // La borne est une date seule : `date_decla` l'est aussi, et comparer une date a un
  // horodatage complet ferait perdre le jour de la borne par simple ordre lexical.
  const borne = toIso(cutoffFor(nowMs, seuilAnnees)).slice(0, 10);

  const compte = (condition: string, ...params: readonly string[]): number =>
    Number(
      (db.prepare(`SELECT count(*) AS n ${FILTRE_ACTIVES} ${condition}`).get(departement, ...params) as
        | { n?: number }
        | undefined)?.n ?? 0,
    );

  const actives = compte("");
  const sansDate = compte("AND a.date_declaration IS NULL");
  const nonDormantes = compte("AND a.date_declaration >= ?", borne);
  const dormantes = actives - sansDate - nonDormantes;

  const parAnnee = db
    .prepare(
      `SELECT substr(a.date_declaration, 1, 4) AS annee, count(*) AS associations ${FILTRE_ACTIVES} ` +
        "AND a.date_declaration IS NOT NULL GROUP BY annee ORDER BY annee",
    )
    .all(departement) as unknown as { annee: string; associations: number }[];

  return { departement, seuilAnnees, borne, actives, nonDormantes, dormantes, sansDate, parAnnee };
}
