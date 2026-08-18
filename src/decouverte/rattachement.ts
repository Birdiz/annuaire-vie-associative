/**
 * Rapprochement d'un contact avec une association de la commune, par son nom.
 *
 * C'est une inference, la seule du lot 3, et elle est deliberement pauvre : une
 * occurrence exacte du nom normalise, sur limites de mots, dans le bloc DOM qui porte
 * le contact. Pas de distance d'edition, pas de score. Un rapprochement approximatif
 * produirait des rattachements faux que personne ne saurait defaire en revue, alors
 * qu'un contact non rattache reste exploitable au niveau de la commune.
 *
 * Les noms trop courts sont ecartes : « ACCA », « AS » ou « FCPE » apparaissent dans
 * n'importe quel texte et rattacheraient a peu pres tout a n'importe quoi.
 */

import { normaliserNom } from "../texte.ts";

export type AssociationConnue = { id: number; nomNormalise: string };

export type IndexAssociations = readonly AssociationConnue[];

export type Rattachement = { associationId: number; nomNormalise: string };

/**
 * En deca, un nom n'identifie plus rien. Le seuil porte sur le nom normalise, donc
 * sur les seuls caracteres significatifs.
 */
export const LONGUEUR_MIN_NOM = 8;

/**
 * Prepare la liste des associations d'une commune. Les noms trop courts sont retires
 * ici plutot qu'a chaque appel, et les plus longs passent devant : a texte egal, le
 * nom le plus specifique doit gagner.
 */
export function indexerAssociations(associations: readonly AssociationConnue[]): IndexAssociations {
  return associations
    .filter((association) => association.nomNormalise.length >= LONGUEUR_MIN_NOM)
    .sort((a, b) => b.nomNormalise.length - a.nomNormalise.length);
}

/**
 * Parcourt les blocs du plus etroit au plus large et rend le premier rattachement
 * trouve. L'ordre compte : dans un tableau, la cellule ne porte que l'adresse, c'est
 * la ligne qui porte aussi le nom — mais si la cellule suffit, elle est plus sure que
 * la page entiere.
 */
export function rattacher(index: IndexAssociations, contextes: readonly string[]): Rattachement | undefined {
  for (const contexte of contextes) {
    const texte = ` ${normaliserNom(contexte)} `;
    for (const association of index) {
      if (texte.includes(` ${association.nomNormalise} `)) {
        return { associationId: association.id, nomNormalise: association.nomNormalise };
      }
    }
  }
  return undefined;
}
