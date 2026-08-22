/**
 * Etape [4] du §6 : decider, sur des signaux bon marche, si une page merite le cout
 * d'une inference.
 *
 * Trois proprietes gouvernent ce module.
 *
 * **Il ne coute rien.** Le DOM, l'index des associations et les contacts sont deja
 * calcules par le handler de crawl quand cette fonction est appelee. Elle ne reparse
 * rien, ne relit pas la base, et n'emet aucune requete. Un pre-filtre plus cher que ce
 * qu'il economise n'aurait aucun sens.
 *
 * **Il est consultatif.** Le verdict n'ecarte aucune page de l'extraction [5] et ne
 * change pas le suivi des liens [3]. Le §9 demande l'etape [4] « mesuree : montrer le
 * volume ecarte avant d'ajouter le LLM » — or un filtre qui modifie le corpus qu'il
 * mesure n'est plus mesurable. Tant que l'etape [6] n'existe pas, il n'a rien a couper.
 *
 * **Il se justifie.** Chaque verdict porte le signal dominant qui l'a emporte. Un
 * « ecartee » sans raison ne serait ni discutable en revue, ni reglable : c'est le
 * motif, pas le score, qui dit ou l'heuristique se trompe.
 */

import { compterNomsConnus, rattacher } from "./rattachement.ts";
import { scorerLien } from "./scoring.ts";
import type { ContactExtrait } from "./extraction.ts";
import type { DocumentAnalyse } from "../parse/html.ts";
import type { IndexAssociations } from "./rattachement.ts";

/**
 * Incrementee des que les poids, le seuil ou les signaux changent. Elle est ecrite sur
 * chaque ligne `page` : sans elle, un reglage de seuil laisserait en base un melange
 * indiscernable d'anciens et de nouveaux verdicts, et le rejeu ne saurait pas quoi
 * recalculer.
 */
export const VERSION_PREFILTRE = 1;

/**
 * Seuil de retention. **Provisoire** : il sera fige apres lecture de la distribution
 * reelle des scores sur l'Ille-et-Vilaine, pas avant. C'est la meme discipline que
 * l'ADR-013 impose au seuil de dormance — un seuil choisi a priori n'est qu'une
 * opinion, et il n'a pas sa place dans un lot dont l'objet est la mesure.
 */
export const SEUIL_PAR_DEFAUT = 8;

/**
 * En deca de ce nombre de contacts, une page retenue est consideree sous-extraite,
 * donc candidate au fallback [6]. Le §6 ouvre ce fallback « UNIQUEMENT si pre-filtre
 * positif ET extraction DOM sous seuil » : c'est la seconde condition.
 */
export const SEUIL_EXTRACTION = 2;

/**
 * En deca, une page n'a pas assez de texte pour qu'un quelconque signal ait du sens :
 * une page de menu, un cadre vide, un site rendu par du JavaScript que l'invariant §4.1
 * nous interdit d'executer.
 */
const LONGUEUR_MIN_PAGE = 200;

/**
 * Longueur de reference de la densite. Elle est un **plancher**, pas un diviseur : sans
 * lui, une page de trois lignes portant une seule adresse afficherait une densite de
 * sept contacts pour mille caracteres, soit davantage qu'un vrai annuaire. La brievete
 * ne doit pas se lire comme de la richesse.
 */
const LONGUEUR_DE_REFERENCE = 1000;

/**
 * Plafonds : au-dela, un signal n'apprend plus rien. Une page qui nomme quarante
 * associations n'est pas dix fois plus interessante que celle qui en nomme quatre, et
 * sans plafond elle ecraserait tout classement par score — donc toute lecture de la
 * distribution, qui est l'objet meme de ce lot.
 */
const PLAFOND_NOMS = 12;
const PLAFOND_RATTACHES = 12;
const PLAFOND_CONTACTS = 6;
const PLAFOND_DENSITE = 4;
const PLAFOND_VOCABULAIRE = 4;

const POIDS_NOM = 3;
const POIDS_RATTACHE = 4;
const POIDS_CONTACT = 2;

export type MotifPrefiltre =
  | "noms"
  | "liste"
  | "contacts"
  | "vocabulaire"
  | "vide"
  | "negatif"
  | "insuffisant";

export type SignauxPrefiltre = {
  /** Associations de la commune dont le nom apparait dans la page (jointure RNA). */
  nomsConnus: number;
  /** Contacts dont le bloc porteur nomme une association connue : forme d'un annuaire. */
  contactsRattaches: number;
  contacts: number;
  /** Contacts pour mille caracteres de texte, une page courte comptant pour mille. */
  densiteContacts: number;
  /** Vocabulaire du §6 lu sur le chemin de l'URL. */
  vocabulaire: number;
  longueurTexte: number;
};

export type VerdictPrefiltre = {
  score: number;
  verdict: "retenue" | "ecartee";
  /** Signal qui a emporte la decision — dans un sens comme dans l'autre. */
  motif: MotifPrefiltre;
  signaux: SignauxPrefiltre;
  version: number;
  /** Verdict positif *et* extraction sous seuil : le portillon a deux conditions du §6. */
  candidateLlm: boolean;
};

export type EntreePrefiltre = {
  url: string;
  doc: DocumentAnalyse;
  index: IndexAssociations;
  contacts: readonly ContactExtrait[];
  /**
   * Nombre de contacts deja rattaches a une association par l'appelant. Le crawl le
   * connait — il vient de le calculer pour ecrire ses lignes — et le passe plutot que
   * de le faire recalculer. Absent, il est recalcule : la fonction reste utilisable
   * seule, notamment en test.
   */
  contactsRattaches?: number | undefined;
  seuil?: number | undefined;
};

export function evaluerPage(entree: EntreePrefiltre): VerdictPrefiltre {
  const seuil = entree.seuil ?? SEUIL_PAR_DEFAUT;
  const texte = entree.doc.texte;
  const longueurTexte = texte.length;

  const nomsConnus = compterNomsConnus(entree.index, texte);
  const contacts = entree.contacts.length;
  const contactsRattaches =
    entree.contactsRattaches ??
    entree.contacts.filter((contact) => rattacher(entree.index, contact.contextes) !== undefined).length;
  const densiteContacts = (contacts * LONGUEUR_DE_REFERENCE) / Math.max(longueurTexte, LONGUEUR_DE_REFERENCE);
  const vocabulaire = vocabulaireDeLUrl(entree.url);

  const signaux: SignauxPrefiltre = {
    nomsConnus,
    contactsRattaches,
    contacts,
    densiteContacts: arrondir(densiteContacts),
    vocabulaire,
    longueurTexte,
  };

  // Une page sans texte exploitable ne se juge pas : ses signaux seraient nuls par
  // absence de matiere, pas par absence de vie associative. Les distinguer evite de
  // lire un site rendu en JavaScript comme un site sans associations.
  if (longueurTexte < LONGUEUR_MIN_PAGE && contacts === 0) {
    return { score: 0, verdict: "ecartee", motif: "vide", signaux, version: VERSION_PREFILTRE, candidateLlm: false };
  }

  const parts = {
    noms: Math.min(PLAFOND_NOMS, POIDS_NOM * nomsConnus),
    liste: Math.min(PLAFOND_RATTACHES, POIDS_RATTACHE * contactsRattaches),
    contacts: Math.min(PLAFOND_CONTACTS, POIDS_CONTACT * contacts),
    densite: Math.min(PLAFOND_DENSITE, Math.round(densiteContacts * 2)),
    vocabulaire,
  };

  const score = parts.noms + parts.liste + parts.contacts + parts.densite + parts.vocabulaire;
  const retenue = score >= seuil;

  return {
    score: arrondir(score),
    verdict: retenue ? "retenue" : "ecartee",
    motif: motifDominant(parts, retenue),
    signaux,
    version: VERSION_PREFILTRE,
    // L'asymetrie est le point : une page riche en noms connus mais pauvre en contacts
    // est precisement la cible du fallback — un annuaire rendu d'une facon que le DOM
    // ne sait pas lire. Une page sans noms et sans contacts est du bruit. Les deux sont
    // vides, ils ne se valent pas.
    candidateLlm: retenue && contacts < SEUIL_EXTRACTION,
  };
}

type Parts = { noms: number; liste: number; contacts: number; densite: number; vocabulaire: number };

/**
 * Ce qui a emporte la decision. Sur un verdict positif, la plus forte contribution ;
 * sur un verdict negatif, ce qui manquait — un vocabulaire franchement administratif
 * n'est pas la meme chose qu'une page simplement pauvre.
 */
function motifDominant(parts: Parts, retenue: boolean): MotifPrefiltre {
  if (!retenue) return parts.vocabulaire < 0 ? "negatif" : "insuffisant";
  const classement: readonly (readonly [MotifPrefiltre, number])[] = [
    ["liste", parts.liste],
    ["noms", parts.noms],
    ["contacts", parts.contacts + parts.densite],
    ["vocabulaire", parts.vocabulaire],
  ];
  let meilleur: MotifPrefiltre = "contacts";
  let valeur = -Infinity;
  for (const [motif, poids] of classement) {
    if (poids > valeur) {
      meilleur = motif;
      valeur = poids;
    }
  }
  return meilleur;
}

/**
 * Le vocabulaire du §6 est lu sur le chemin de l'URL, pas sur le texte de la page : le
 * texte inclut la navigation du site, donc les rubriques de toutes les autres pages.
 * « Sport » et « associations » y figurent sur a peu pres chaque page de mairie, ce qui
 * ferait de ce signal un bruit constant. Le chemin, lui, ne parle que de cette page.
 *
 * `scorerLien` est reemployee telle quelle : ce sont les termes du brief, et en tenir
 * une seconde liste les ferait diverger.
 */
function vocabulaireDeLUrl(url: string): number {
  let brut: number;
  try {
    brut = scorerLien(new URL(url), "");
  } catch {
    return 0;
  }
  return Math.max(-PLAFOND_VOCABULAIRE, Math.min(PLAFOND_VOCABULAIRE, brut));
}

function arrondir(valeur: number): number {
  return Math.round(valeur * 100) / 100;
}
