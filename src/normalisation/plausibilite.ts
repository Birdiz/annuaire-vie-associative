/**
 * Ce qui ressemble a une structure associative, et ce qui n'en est visiblement pas une.
 *
 * Deux listes de vocabulaire, appelees des **deux bouts de la chaine** : le nommage au
 * crawl (`decouverte/nom-pressenti.ts`) et le filtre du profil simple (`export/csv.ts`).
 * C'est la meme discipline que `scorerLien`, reemployee par le pre-filtre : deux listes
 * qui doivent s'accorder finissent toujours par diverger.
 *
 * Ce module ne juge que du **texte**. Il ne sait rien de la page d'ou vient le contact ni
 * du RNA : le faisceau d'indices, lui, vit dans l'export, ou ces autres signaux existent.
 *
 * **Les motifs se cherchent sur limites de mots, jamais en sous-chaine.** « AUTOUR DU
 * LIVRE » contient « auto », « MAISON DES JEUNES » contient « son ». Un filtre en
 * sous-chaine emporterait des associations reelles, et personne ne saurait pourquoi.
 */

import { MOTIFS_NOM } from "./classification.ts";
import { normaliserNom } from "../texte.ts";

/**
 * Le vocabulaire qui annonce une structure collective. Il ne dit pas le type — c'est le
 * role de `classification.ts` — il dit seulement : ce texte nomme un groupement.
 *
 * Volontairement large sur les formes juridiques et les objets les plus repandus dans le
 * RNA, et volontairement muet sur ce qui ne discrimine pas (« maison », « centre »,
 * « espace » nomment autant un service municipal qu'une association).
 */
export const MOTS_DE_STRUCTURE: readonly string[] = [
  "association", "associations", "asso", "amicale", "amicales", "club", "clubs",
  "comite", "comites", "union", "federation", "confederation", "fnaca", "acca",
  "societe", "cercle", "collectif", "groupement", "syndicat", "foyer", "fanfare",
  "harmonie", "chorale", "choeur", "orchestre", "troupe", "compagnie", "ensemble",
  "jumelage", "sou des ecoles", "sou de lecole", "parents deleves", "parents d eleves",
  "anciens combattants", "donneurs de sang", "secours populaire", "secours catholique",
  "croix rouge", "restos du coeur", "scouts", "scoutisme", "judo", "karate", "tennis",
  "football", "basket", "handball", "volley", "rugby", "petanque", "boule", "boules",
  "gymnastique", "randonnee", "cyclo", "athletisme", "natation", "escalade", "peche",
  "chasse", "aikido", "twirling", "majorettes", "bibliotheque pour tous", "admr",
  "ufc", "apel", "ape", "fcpe", "peep", "mjc", "alsh", "ehpad",
];

/**
 * Le vocabulaire qui denonce une entreprise, un commerce ou une exploitation agricole.
 *
 * Tire des lignes que le client a refusees sur la Loire : « Garage Pupier »,
 * « Boulangerie Vericel-Guyot », « CIC Lyonnaise de banque », « Efficity Immobilier »,
 * « GAEC Jacquet Elevage », « Vaches laitieres ».
 *
 * Une association peut porter l'un de ces mots — « Les Amis du Vieux Garage » existe
 * quelque part. C'est pourquoi `evoqueUneStructure` l'emporte : un texte qui nomme les
 * deux nomme une association.
 */
export const MOTS_DE_COMMERCE: readonly string[] = [
  "garage", "carrosserie", "concessionnaire", "auto ecole", "taxi", "vtc",
  "boulangerie", "patisserie", "boucherie", "charcuterie", "epicerie", "primeur",
  "coiffure", "coiffeur", "esthetique", "institut de beaute", "fleuriste",
  "banque", "assurance", "assurances", "mutuelle", "immobilier", "immobiliere",
  "notaire", "avocat", "expert comptable", "pharmacie", "opticien", "veterinaire",
  "restaurant", "brasserie", "pizzeria", "traiteur", "hotel", "camping", "gite",
  "chambres dhotes", "plomberie", "menuiserie", "macon", "maconnerie", "electricite",
  "terrassement", "paysagiste", "elagage", "sarl", "sas", "sasu", "eurl", "sci",
  "gaec", "earl", "scea", "ets", "eirl", "producteur", "producteurs", "maraicher",
  "maraichere", "apiculteur", "elevage", "eleveur", "vaches", "laitieres",
  "allaitantes", "exploitation agricole",
];

/** Le texte porte-t-il un mot de l'une des listes, sur limites de mots ? */
function porte(normalise: string, mots: readonly string[]): boolean {
  const borne = ` ${normalise} `;
  return mots.some((mot) => borne.includes(` ${mot} `));
}

/**
 * Le texte nomme-t-il un groupement ? Les motifs de `classification.ts` comptent aussi :
 * ils affirment deja « ce texte nomme une structure », et en tenir une seconde liste les
 * ferait diverger.
 */
export function evoqueUneStructure(nom: string): boolean {
  const normalise = normaliserNom(nom);
  if (porte(normalise, MOTS_DE_STRUCTURE)) return true;
  return MOTIFS_NOM.some(([motif]) => ` ${normalise} `.includes(` ${motif} `));
}

/**
 * Le texte nomme-t-il un commerce, une entreprise ou une exploitation ? Faux des qu'il
 * nomme aussi une structure : « Amicale des Boulangers » est une amicale.
 */
export function evoqueUnCommerce(nom: string): boolean {
  const normalise = normaliserNom(nom);
  if (evoqueUneStructure(nom)) return false;
  return porte(normalise, MOTS_DE_COMMERCE);
}

/**
 * Ce que l'export sait d'une structure au moment de decider si elle sort.
 *
 * Le texte ne suffit pas : « Les Traives » ne dit rien par lui-meme, et c'est la page qui
 * le porte — un annuaire d'associations ou une liste de commercants — qui tranche.
 */
export type IndicesStructure = {
  /** Le RNA connait la structure : le registre a deja repondu. */
  rattacheeAuRna: boolean;
  /** Le libelle rendu dans le fichier. */
  nom: string;
  /** Le nom est **deduit** d'un domaine e-mail, et non lu quelque part. */
  nomInfere: boolean;
  /** L'URL de la page porte le vocabulaire associatif (`scorerLien` > 0). */
  pageAssociative: boolean;
  /**
   * Le nom designe une personne (`personne.ts`). Calcule par l'appelant, qui connait la
   * branche du nom : un nom du RNA n'est jamais juge ainsi.
   */
  personne?: boolean | undefined;
};

/**
 * Faisceau d'indices : la structure merite-t-elle une ligne du profil simple ?
 *
 * Le profil simple ne porte ni provenance ni regime juridique (ADR-032) : une ligne y
 * **affirme** qu'il s'agit d'une structure de la vie associative. Elle doit donc reposer
 * sur au moins un indice, et le fichier livre sur la Loire montrait ce qu'il en coute
 * sinon — 87 % de lignes sans correspondance RNA, garages et exploitations comprises.
 *
 * L'ordre compte. Le RNA passe avant tout : c'est un registre, pas une heuristique. Le
 * vocabulaire commercial passe ensuite, y compris contre une page associative — une liste
 * de commercants publiee sous `/vie-locale/` reste une liste de commercants. Un nom
 * **deduit** exige un indice de page : sans lui, une inference se presenterait comme un
 * fait.
 */
export function estStructurePlausible(indices: IndicesStructure): boolean {
  if (indices.rattacheeAuRna) return true;
  // Une personne n'est pas une structure (ADR-036), quelle que soit la page qui la cite.
  if (indices.personne === true) return false;
  if (evoqueUnCommerce(indices.nom)) return false;
  if (indices.nomInfere) return indices.pageAssociative;
  return evoqueUneStructure(indices.nom) || indices.pageAssociative;
}
