/**
 * Etape [7] du §6 : donner un type a chaque association, « via codes objet RNA ».
 *
 * Tout ici est pur : une famille, un nom, un verdict. Aucune lecture de base, aucune
 * requete, aucune inference couteuse — le §6 reservait le LLM au seul cas ou le code
 * ne suffirait pas, et l'ADR-018 montre mesures a l'appui qu'il ne suffit pas *pour
 * deux des six types*, mais que la reponse est un motif de nom, pas une inference.
 *
 * **Ce que le code RNA porte.** `objet_social1` est un code hierarchique a six
 * chiffres dont les trois premiers designent la famille. Sur l'Ille-et-Vilaine il est
 * renseigne a 100 % des 36 170 associations, reparties en 31 familles. La table
 * ci-dessous les rabat sur les quatre types du brief que le code permet de distinguer.
 *
 * **Ce qu'il ne porte pas.** Les 252 associations dont le nom contient « comite des
 * fetes » se repartissent sur **six familles differentes** : le code ne les distingue
 * pas, et aucun rabattement de famille ne les trouverait. Deux des six types du brief
 * sont donc reconnus sur le nom, et le nom l'emporte sur le code. Voir ADR-018.
 */

import { normaliserNom } from "../texte.ts";

/**
 * Incrementee des que la table de correspondance ou les motifs changent. Ecrite sur
 * chaque ligne : sans elle, un ajustement laisserait en base un melange indiscernable
 * d'anciens et de nouveaux verdicts. Meme discipline que `VERSION_PREFILTRE`.
 */
export const VERSION_CLASSIFICATION = 1;

/** Les six types du §6.7. Union de litteraux : le projet n'utilise pas d'`enum`. */
export type TypeAssociation =
  | "sportive"
  | "culturelle"
  | "diverses"
  | "sociale"
  | "comite_des_fetes"
  | "centre_de_loisirs";

export type Classification = {
  type: TypeAssociation;
  /** Regle appliquee : `rna:011`, `nom:comite_des_fetes`, `defaut`. */
  source: string;
};

/**
 * Familles RNA rabattues sur les quatre types que le code permet de distinguer. La
 * semantique de chaque famille a ete lue sur le vocabulaire distinctif des noms qu'elle
 * porte, faute de referentiel embarquable — la methode et ses limites sont dans
 * l'ADR-018.
 *
 * Toute famille absente tombe dans `diverses`. Ce n'est pas un trou a boucher : le
 * brief ne prevoit pas de type pour l'education, l'environnement, l'agriculture, le
 * culte ou les anciens combattants, et inventer des categories qu'il ne demande pas
 * serait pire qu'un fourre-tout assume.
 */
const FAMILLES: ReadonlyMap<string, TypeAssociation> = new Map([
  // Sport
  ["011", "sportive"],

  // Culture, arts, spectacle, medias, patrimoine
  ["005", "culturelle"], // radio, edition, informatique, productions
  ["006", "culturelle"], // theatre, musique, compagnies
  ["010", "culturelle"], // patrimoine, memoire, histoire locale

  // Action sociale, entraide, sante, solidarite
  ["003", "sociale"], // collectifs citoyens, droits, solidarite
  ["009", "sociale"], // vie sociale locale : fetes, jumelages, aines ruraux
  ["017", "sociale"], // sante, don du sang, soins
  ["018", "sociale"], // handicap, accompagnement des personnes
  ["019", "sociale"], // familles, aide a domicile, ADMR
  ["020", "sociale"], // humanitaire, solidarite internationale
  ["021", "sociale"], // petite enfance, assistantes maternelles
  ["030", "sociale"], // emploi, quartiers, economie solidaire
  ["036", "sociale"], // secourisme, sapeurs-pompiers
  ["038", "sociale"], // anciens combattants, entraide et memoire
]);

/**
 * Motifs de nom, cherches sur limites de mots dans le nom normalise. Ils l'emportent
 * sur la famille parce que la famille ne les porte pas : sur les 252 « comite des
 * fetes » du departement, 172 sont en famille 009, 58 en 007, et le reste sur quatre
 * autres familles encore.
 *
 * `normaliserNom` supprime les apostrophes sans separer les mots : « comite
 * d'animation » devient « comite danimation », d'ou la forme collee ci-dessous. Les
 * deux graphies sont presentes dans le RNA, les deux sont donc listees.
 *
 * Exportee parce qu'elle dit plus que le type : elle dit **« ce texte nomme une
 * structure »**. `nom-pressenti.ts` s'en sert comme laissez-passer, et un test verifie
 * qu'aucun de ces motifs n'est rejete par son filtre de mobilier de page — c'est ainsi
 * qu'« Accueil de loisirs » cesse d'etre confondu avec un lien « Accueil ».
 */
export const MOTIFS_NOM: readonly (readonly [string, TypeAssociation, string])[] = [
  ["comite des fetes", "comite_des_fetes", "nom:comite_des_fetes"],
  ["comite de fetes", "comite_des_fetes", "nom:comite_des_fetes"],
  ["comite danimation", "comite_des_fetes", "nom:comite_danimation"],
  ["comite d animation", "comite_des_fetes", "nom:comite_danimation"],
  ["centre de loisirs", "centre_de_loisirs", "nom:centre_de_loisirs"],
  ["accueil de loisirs", "centre_de_loisirs", "nom:accueil_de_loisirs"],
  ["centre aere", "centre_de_loisirs", "nom:centre_aere"],
  ["alsh", "centre_de_loisirs", "nom:alsh"],
];

/** Famille d'un code objet social : ses trois premiers chiffres, completes a gauche. */
export function familleDe(codeObjetSocial: string | null | undefined): string | undefined {
  if (codeObjetSocial === null || codeObjetSocial === undefined) return undefined;
  const chiffres = codeObjetSocial.trim();
  if (!/^\d+$/.test(chiffres)) return undefined;
  // Le RNA ecrit tantot « 011000 », tantot « 11000 ». Sans recalage, la seconde forme
  // donnerait la famille « 110 », qui n'existe pas, et l'association tomberait
  // silencieusement dans le fourre-tout.
  return chiffres.padStart(6, "0").slice(0, 3);
}

/**
 * Type d'une association. Le nom est examine en premier : il porte les deux categories
 * que le code ignore, et quand il les porte il est plus sur que la famille.
 */
export function classer(
  codeObjetSocial: string | null | undefined,
  nom: string,
): Classification {
  const normalise = ` ${normaliserNom(nom)} `;
  for (const [motif, type, source] of MOTIFS_NOM) {
    if (normalise.includes(` ${motif} `)) return { type, source };
  }

  const famille = familleDe(codeObjetSocial);
  if (famille !== undefined) {
    const type = FAMILLES.get(famille);
    if (type !== undefined) return { type, source: `rna:${famille}` };
    return { type: "diverses", source: `rna:${famille}` };
  }

  return { type: "diverses", source: "defaut" };
}
