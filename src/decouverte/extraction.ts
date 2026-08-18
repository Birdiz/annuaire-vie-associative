/**
 * Etape [5] du §6 : tirer les contacts du DOM, sans aucune inference couteuse.
 *
 * Deux invariants du brief s'appliquent ici et nulle part ailleurs :
 *
 * - §4.6 les mobiles 06/07 sont ecartes par defaut. Le drapeau qui les rappelle
 *   voyage dans le payload du job et non dans la configuration : il est ainsi
 *   persiste avec le travail auquel il s'applique, et une reprise le retrouve.
 * - §4.7 un email generique et un email nominatif ne relevent pas du meme regime
 *   juridique. La distinction est donc portee par le modele, pas deduite a l'export.
 *
 * La confiance n'est pas decorative : c'est elle qui alimentera l'ecran de revue de
 * l'etape [8]. Un lien `mailto:` est une declaration de l'auteur de la page ; un
 * motif trouve dans du texte libre est une lecture de notre part ; une forme
 * desobfusquee est une reconstruction. Les trois ne se valent pas.
 */

import { MOBILE_PREFIXES } from "../invariants.ts";
import type { Bloc, DocumentAnalyse } from "../parse/html.ts";

export type KindContact = "email" | "phone";

export type ContactExtrait = {
  kind: KindContact;
  valeur: string;
  valeurNormalisee: string;
  /** §4.7 — 1 generique, 0 nominatif, null indetermine. */
  isGenerique: 0 | 1 | null;
  methode: string;
  confiance: number;
  /**
   * Textes des blocs qui portent le contact, du plus etroit au plus large. Le
   * rattachement les parcourt dans cet ordre : la cellule d'un tableau ne contient
   * que l'adresse, c'est la ligne qui porte aussi le nom de l'association.
   */
  contextes: readonly string[];
};

export type ResultatExtraction = {
  contacts: readonly ContactExtrait[];
  mobilesExclus: number;
};

const CONFIANCE_DOM = 0.9;
const CONFIANCE_MOTIF = 0.6;
const CONFIANCE_OBFUSQUE = 0.45;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

/**
 * Formes obfusquees courantes sur les sites de mairie : « nom [at] domaine [dot] fr ».
 * Reconstruire une adresse est une inference, d'ou la confiance la plus basse.
 */
const EMAIL_OBFUSQUE =
  /([A-Za-z0-9._%+-]+)\s*(?:\[|\()?\s*(?:at|arobase|chez)\s*(?:\]|\))?\s*([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*?)\s*(?:\[|\()?\s*(?:dot|point)\s*(?:\]|\))?\s*([A-Za-z]{2,})/gi;

/** Fixe francais ou mobile, avec les separateurs usuels, ou forme internationale. */
const TELEPHONE = /(?:\+33[\s.-]?|\b0)[1-9](?:[\s.-]?\d{2}){4}\b/g;

/**
 * Parties locales qui designent une fonction et non une personne. La liste est
 * cherchee par inclusion : « vie.associative » porte « associ », « contact-mairie »
 * porte « contact ».
 */
const RACINES_GENERIQUES: readonly string[] = [
  "contact", "mairie", "secretariat", "secretaire", "accueil", "info", "communication",
  "associ", "club", "sport", "culture", "jeunesse", "service", "direction",
  "administration", "courrier", "webmaster", "bureau", "president", "tresorier",
  "inscription", "reservation", "ecole", "cantine", "commune", "ville", "hoteldeville",
  "noreply", "nepasrepondre", "postmaster", "abuse",
];

/** Faux positifs frequents : un nom de fichier lu comme une adresse. */
const EXTENSIONS_IMAGE = /\.(?:png|jpe?g|gif|webp|svg|css|js)$/i;

export function extraireContacts(
  doc: DocumentAnalyse,
  options: { avecMobiles: boolean },
): ResultatExtraction {
  const trouves: ContactExtrait[] = [];
  let mobilesExclus = 0;

  const ajouterEmail = (brut: string, methode: string, confiance: number, empreinte: string): void => {
    const valeur = nettoyerEmail(brut);
    if (valeur === undefined) return;
    trouves.push({
      kind: "email",
      valeur,
      valeurNormalisee: valeur.toLowerCase(),
      isGenerique: classerEmail(valeur),
      methode,
      confiance,
      contextes: contextesDe(doc.blocs, empreinte),
    });
  };

  const ajouterTelephone = (brut: string, methode: string, confiance: number, empreinte: string): void => {
    const normalise = normaliserTelephone(brut);
    if (normalise === undefined) return;
    if (!options.avecMobiles && estMobile(normalise)) {
      mobilesExclus += 1;
      return;
    }
    trouves.push({
      kind: "phone",
      valeur: brut.trim(),
      valeurNormalisee: normalise,
      isGenerique: null,
      methode,
      confiance,
      contextes: contextesDe(doc.blocs, empreinte),
    });
  };

  // 1. Ce que la page declare elle-meme.
  for (const lien of doc.liens) {
    const bas = lien.href.toLowerCase();
    if (bas.startsWith("mailto:")) {
      const adresse = decoderSansEchec(lien.href.slice("mailto:".length)).split("?")[0] ?? "";
      for (const part of adresse.split(",")) ajouterEmail(part, "dom:mailto", CONFIANCE_DOM, lien.href);
    } else if (bas.startsWith("tel:")) {
      ajouterTelephone(decoderSansEchec(lien.href.slice("tel:".length)), "dom:tel", CONFIANCE_DOM, lien.href);
    }
  }

  // 2. Ce qu'on lit dans le texte.
  for (const trouve of doc.texte.matchAll(EMAIL)) {
    ajouterEmail(trouve[0], "texte:motif", CONFIANCE_MOTIF, trouve[0]);
  }
  for (const trouve of doc.texte.matchAll(TELEPHONE)) {
    ajouterTelephone(trouve[0], "texte:motif", CONFIANCE_MOTIF, trouve[0]);
  }

  // 3. Ce qu'on reconstruit.
  for (const trouve of doc.texte.matchAll(EMAIL_OBFUSQUE)) {
    const entier = trouve[0];
    const local = trouve[1];
    const domaine = trouve[2];
    const tld = trouve[3];
    if (local === undefined || domaine === undefined || tld === undefined) continue;
    ajouterEmail(`${local}@${domaine}.${tld}`, "texte:obfusque", CONFIANCE_OBFUSQUE, entier);
  }

  return { contacts: dedupliquer(trouves), mobilesExclus };
}

/**
 * Un meme contact est presque toujours vu plusieurs fois : dans un `mailto:` et dans
 * le texte du lien. On garde la lecture la plus sure, et a confiance egale le
 * contexte le plus etroit — c'est lui qui portera le nom de l'association.
 */
function dedupliquer(contacts: readonly ContactExtrait[]): ContactExtrait[] {
  const parCle = new Map<string, ContactExtrait>();
  for (const contact of contacts) {
    const cle = `${contact.kind} ${contact.valeurNormalisee}`;
    const connu = parCle.get(cle);
    if (connu === undefined) {
      parCle.set(cle, contact);
      continue;
    }
    const meilleur =
      contact.confiance > connu.confiance ||
      (contact.confiance === connu.confiance && contexteUtile(contact, connu));
    if (meilleur) parCle.set(cle, contact);
  }
  return [...parCle.values()];
}

function contexteUtile(candidat: ContactExtrait, connu: ContactExtrait): boolean {
  return candidat.contextes.length > connu.contextes.length;
}

/**
 * Tous les blocs qui portent l'empreinte, du plus etroit au plus large. On ne peut
 * pas trancher ici : le bon niveau est celui qui contiendra un nom d'association, et
 * seul le rattachement le sait.
 */
function contextesDe(blocs: readonly Bloc[], empreinte: string): readonly string[] {
  if (empreinte === "") return [];
  const portants: string[] = [];
  for (const bloc of blocs) {
    if (bloc.texte.includes(empreinte) || bloc.liens.some((lien) => lien.href === empreinte)) {
      portants.push(bloc.texte);
    }
  }
  return portants.sort((a, b) => a.length - b.length);
}

function decoderSansEchec(valeur: string): string {
  try {
    return decodeURIComponent(valeur);
  } catch {
    return valeur;
  }
}

function nettoyerEmail(brut: string): string | undefined {
  const valeur = brut.trim().replace(/^[<("']+/, "").replace(/[>)"',.;]+$/, "");
  if (!/^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(valeur)) return undefined;
  if (EXTENSIONS_IMAGE.test(valeur)) return undefined;
  if (valeur.length > 254) return undefined;
  return valeur;
}

/** §4.7 — 1 generique, 0 nominatif, null quand la forme ne tranche pas. */
export function classerEmail(adresse: string): 0 | 1 | null {
  const local = (adresse.split("@")[0] ?? "").toLowerCase();
  const compact = local.replace(/[^a-z0-9]/g, "");
  if (RACINES_GENERIQUES.some((racine) => compact.includes(racine))) return 1;
  // « marie.dupont », mais aussi « j.dupont » : l'initiale suivie du patronyme est une
  // forme nominative courante. Dans le doute on ne tranche pas — mais quand la forme
  // designe une personne, le regime le plus strict doit s'appliquer.
  if (/^[a-z]+[.\-_][a-z]{2,}$/.test(local)) return 0;
  return null;
}

/** Rend la forme internationale `+33XXXXXXXXX`, ou `undefined` si ce n'est pas un numero. */
export function normaliserTelephone(brut: string): string | undefined {
  const chiffres = brut.replace(/[^\d+]/g, "");
  let national: string;
  if (chiffres.startsWith("+33")) national = `0${chiffres.slice(3)}`;
  else if (chiffres.startsWith("0033")) national = `0${chiffres.slice(4)}`;
  else if (chiffres.startsWith("0")) national = chiffres;
  else return undefined;
  if (!/^0[1-9]\d{8}$/.test(national)) return undefined;
  return `+33${national.slice(1)}`;
}

/** §4.6 — les prefixes viennent de `invariants.ts`, ils ne sont pas reglables. */
export function estMobile(normalise: string): boolean {
  const national = `0${normalise.slice(3)}`;
  return MOBILE_PREFIXES.some((prefixe) => national.startsWith(prefixe));
}
