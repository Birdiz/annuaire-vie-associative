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
import { normaliserNom } from "../texte.ts";
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

/**
 * **Les quantificateurs sont bornes, et ce n'est pas de la coquetterie.**
 *
 * Un `+` gourmand sur une classe large, ancre par un caractere qui n'arrive jamais dans
 * du texte ordinaire, coute O(reste) a chaque position de depart : le balayage devient
 * quadratique. Mesure sur du texte sans aucune adresse, avant bornage — 20 000
 * caracteres : 1,5 s ; 40 000 : 6 s ; 160 000 : 97 s. Or `MAX_RESPONSE_BYTES` vaut 5 Mo
 * et `estHtml(null)` rend `true` : une page de mairie verbeuse suffisait a bloquer
 * l'event loop plusieurs minutes, une page hostile plusieurs heures — et depuis
 * l'ADR-024 le worker tourne dans le process de l'interface, qui gele avec lui.
 *
 * Les bornes ne sont pas arbitraires : RFC 5321 §4.5.3.1 fixe la partie locale a 64
 * octets et chaque label de domaine a 63. Apres bornage, un million de caracteres se
 * balaient en 227 ms.
 */
const EMAIL = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,24}/g;

/**
 * Formes obfusquees courantes sur les sites de mairie : « nom [at] domaine [dot] fr ».
 * Reconstruire une adresse est une inference, d'ou la confiance la plus basse.
 *
 * Memes bornes que `EMAIL`, et pour la meme raison : ce motif-ci coutait 4,7 s sur
 * 40 000 caracteres.
 */
const EMAIL_OBFUSQUE =
  /([A-Za-z0-9._%+-]{1,64})\s{0,8}(?:\[|\()?\s{0,8}(?:at|arobase|chez)\s{0,8}(?:\]|\))?\s{0,8}([A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})*?)\s{0,8}(?:\[|\()?\s{0,8}(?:dot|point)\s{0,8}(?:\]|\))?\s{0,8}([A-Za-z]{2,24})/gi;

/** Fixe francais ou mobile, avec les separateurs usuels, ou forme internationale. */
const TELEPHONE = /(?:\+33[\s.-]?|\b0)[1-9](?:[\s.-]?\d{2}){4}\b/g;

/**
 * Parties locales qui designent une fonction et non une personne.
 *
 * La liste est comparee aux **jetons** de la partie locale — les segments separes par
 * `.`, `-` ou `_` — et non a la chaine compactee. La recherche par inclusion classait
 * « p.deville » en generique parce que « pdeville » porte « ville », et « m.lecole »
 * parce qu'il porte « ecole » : des adresses nominatives rangees sous le regime le plus
 * permissif, soit exactement le risque que l'invariant 7 existe pour ecarter.
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

/**
 * Exportee au lot 6 : la revue humaine doit nettoyer une adresse saisie a la main
 * exactement comme l'extraction nettoie une adresse lue. Deux regles de forme
 * differentes produiraient deux populations de contacts que rien ne distinguerait en
 * base.
 */
export function nettoyerEmail(brut: string): string | undefined {
  const valeur = brut.trim().replace(/^[<("']+/, "").replace(/[>)"',.;]+$/, "");
  if (!/^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(valeur)) return undefined;
  if (EXTENSIONS_IMAGE.test(valeur)) return undefined;
  if (valeur.length > 254) return undefined;
  return valeur;
}

/**
 * §4.7 — 1 generique, 0 nominatif, null quand la forme ne tranche pas.
 *
 * L'ordre des tests est le sujet de cette fonction. L'ADR-012 pose que « quand la forme
 * designe une personne, c'est le regime le plus strict qui s'applique » ; le code faisait
 * l'inverse, en cherchant d'abord une racine de fonction. Quatre regles, dans cet ordre :
 *
 * 1. **Initiale puis patronyme** — « p.deville », « j.dupont ». La forme designe une
 *    personne, et rien ne la deloge : c'est le cas que l'ADR nomme.
 * 2. **Mot de fonction en tete** — « contact », « secretariat.mairie ». C'est ainsi que
 *    s'ecrit une adresse de service.
 * 3. **Mot de fonction ailleurs**, mais *derive* — « vie.associative » porte
 *    « associative », qui prolonge la racine « associ ». Un derive ne se rencontre pas
 *    comme patronyme : generique.
 * 4. **Mot de fonction ailleurs, et mot exact** — « jean.bureau ». « Bureau » est un
 *    patronyme francais courant autant qu'un mot de fonction. On ne tranche pas :
 *    `null`, ce que l'export rend par « indetermine ». Mieux vaut avouer le doute que
 *    ranger une personne sous le regime des adresses de service.
 *
 * La partie locale passe par `normaliserNom` : sans cela « emilie.dupont » et
 * « francois.martin » — qui entrent bel et bien en base, `nettoyerEmail` les accepte et
 * un `mailto:` percent-encode est decode en UTF-8 avant — tombaient en indetermine.
 */
export function classerEmail(adresse: string): 0 | 1 | null {
  const jetons = normaliserNom(adresse.split("@")[0] ?? "")
    .split(" ")
    .filter((jeton) => jeton !== "");
  if (jetons.length === 0) return null;

  if ((jetons[0] ?? "").length === 1 && jetons.length >= 2) return 0;

  const fonctions = jetons.map((jeton) => RACINES_GENERIQUES.some((racine) => jeton.startsWith(racine)));
  if (fonctions[0] === true) return 1;

  const indexFonction = fonctions.indexOf(true);
  if (indexFonction !== -1) {
    const jeton = jetons[indexFonction] ?? "";
    return RACINES_GENERIQUES.includes(jeton) ? null : 1;
  }

  return jetons.length >= 2 ? 0 : null;
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
