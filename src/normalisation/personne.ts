/**
 * Un texte nomme-t-il une personne ?
 *
 * Le lot 10 avait choisi de garder, en colonne « nom » du profil simple, les personnes que
 * la page citait a cote d'une adresse — « le president est souvent le bon interlocuteur »
 * (ADR-032). Le client a refuse ce choix, et les chiffres lui donnent raison : sur l'Ain et
 * la Haute-Loire, **un quart** des lignes livrees nommaient une personne — « Prenom NOM »,
 * « NOM Prenom », « X preside cette association » —, soit une donnee personnelle presentee
 * comme une structure, dans un fichier qui ne porte pas le regime juridique. Une personne
 * n'est donc jamais un nom de structure (ADR-036).
 *
 * **Deux questions distinctes**, parce que leur ordre face au laissez-passer des motifs de
 * structure n'est pas le meme :
 *
 * - `porteUnePersonne` repere ce qui **contamine** n'importe quel nom : « preside », une
 *   civilite suivie d'un nom, une fonction entre parentheses. « Mme DUPONT Accueil de
 *   loisirs » nomme une structure *et* une personne ; elle n'est pas livrable pour autant.
 * - `estUnNomDePersonne` reconnait la **forme** d'un nom de personne, sur le coeur du
 *   segment — sans la fonction ni le libelle qui le terminent. Le coeur ne sert qu'a
 *   decider : on ne tronque jamais le nom retenu.
 *
 * La forme exige un **prenom connu** (`prenoms.ts`). La casse seule ne suffit pas : elle
 * condamnerait « SPA Haute-Loire » ou « APEL Saint-Joseph », et ne separerait jamais
 * « Christophe Durand » de « Trail Urbain ».
 *
 * Module pur, sans base : le nommage au crawl, la reparation au demarrage et l'export
 * l'appellent a l'identique.
 */

import { PRENOMS } from "./prenoms.ts";
import { MOTS_DE_COMMERCE, MOTS_DE_STRUCTURE } from "./plausibilite.ts";
import { normaliserNom } from "../texte.ts";

const PRENOMS_CONNUS: ReadonlySet<string> = new Set(PRENOMS.split(" "));

/**
 * Mots qui interdisent de lire une personne : un nom qui les porte nomme une structure, un
 * lieu ou une activite, meme s'il commence par un prenom — « Club Leo Lagrange », « Ecole
 * Jules Ferry », « Espace Simone Veil », « Jean Moulin Competition ».
 */
const BLOQUANTS: ReadonlySet<string> = new Set([
  ...MOTS_DE_STRUCTURE.filter((mot) => !mot.includes(" ")),
  ...MOTS_DE_COMMERCE.filter((mot) => !mot.includes(" ")),
  // Institutions et equipements : ils portent volontiers le nom d'une personne celebre.
  "ecole", "ecoles", "college", "lycee", "universite", "espace", "maison", "centre", "salle",
  "stade", "gymnase", "piscine", "mediatheque", "bibliotheque", "ludotheque", "musee",
  "theatre", "cinema", "eglise", "chapelle", "paroisse", "basilique", "abbaye", "mairie",
  "commune", "ville", "village", "hameau", "saint", "sainte", "st", "ste", "place", "rue",
  "avenue", "square", "parc", "jardin", "jardins", "residence", "creche", "halte",
  "garderie", "cantine", "relais", "mam", "pole", "service", "services", "office", "agence",
  "institut", "fondation", "ligue", "section", "sections", "equipe", "team", "racing",
  "competition", "sport", "sports", "sportif", "sportive", "danse", "musique", "chant",
  "yoga", "gym", "fitness", "moto", "velo", "rando", "trail", "tir", "ski", "golf",
  "kayak", "canoe", "voile", "aviron", "equitation", "poney", "atelier", "ateliers",
  "festival", "fete", "fetes", "marche", "foire", "salon", "concours", "rallye", "cup",
  "open", "trophee", "challenge", "memorial", "souvenir", "amis", "anciens", "veterans",
  "jeunes", "jeunesse", "aines", "retraites", "parents", "familles", "habitants", "quartier",
  // Ce qui se produit ou se joue sous le nom d'une personne : « Sofia Prod », « Jade
  // Production », « Georges Travel ». Releves sur les noms du RNA.
  "prod", "production", "productions", "diffusion", "label", "spectacle", "spectacles",
  "organisation", "projet", "reseau", "mission", "cafe", "tribe", "teams", "dancers",
  "country", "travel", "raid", "event", "events", "show", "cie", "crew", "band", "groupe",
  "duo", "trio", "quartet", "quatuor", "studio", "lab", "fablab", "factory", "records",
  "music", "dance", "cirque", "animation", "animations", "concert", "concerts", "creation",
  "creations", "aventure", "aventures", "orchestra", "quintet", "blues", "jazz", "rock",
  "sailing", "fishing", "garden", "sanctuary", "development", "workout", "lights", "tour",
  "friends", "tarot", "biathlon", "sauvetage", "offroad", "boxe", "capoeira", "cross",
  "sprint", "assoc",
]);

/**
 * Mots-outils : une personne ne s'ecrit pas « Rose des Vents ». Les particules d'un nom de
 * famille en sont retirees — voir `PARTICULES`.
 */
const MOTS_OUTILS: ReadonlySet<string> = new Set([
  "le", "la", "les", "l", "de", "du", "des", "d", "un", "une", "au", "aux", "a", "en", "et",
  "ou", "pour", "par", "sur", "sous", "avec", "sans", "dans", "chez", "vers", "the", "of",
  "and",
]);

/**
 * Particules admises **entre** un prenom et un nom, et seulement dans un texte en casse
 * mixte : « Henri de Martinot », « Delphine DE DURANDEL ». En capitales partout, « ROSE DE
 * PICARDIE » reste un nom de chorale.
 */
const PARTICULES: ReadonlySet<string> = new Set(["de", "du", "di", "da", "van", "von", "le", "la"]);

/**
 * Fonctions et libelles de champ qui terminent un nom de personne dans un bloc de contact :
 * « DURANDEL Nadine Tresoriere », « Julien Martinot Tel », « … - Responsable local ». On les
 * retire pour juger le coeur ; le nom retenu, lui, n'est jamais tronque.
 */
const FONCTIONS: ReadonlySet<string> = new Set([
  "president", "presidente", "vice", "tresorier", "tresoriere", "secretaire", "responsable",
  "directeur", "directrice", "coordonnees", "coordinateur", "coordinatrice", "animateur",
  "animatrice", "entraineur", "entraineuse", "referent", "referente", "fondateur",
  "fondatrice", "gerant", "gerante", "correspondant", "correspondante", "delegue",
  "deleguee", "benevole", "membre", "adjoint", "adjointe", "general", "generale", "local",
  "locale", "tel", "telephone", "mail", "email", "e mail", "courriel", "portable", "fixe",
  "contact", "mob", "port", "au", "a", "par",
]);

/**
 * Prenoms qui sont aussi des lieux : « Nancy », « Lorraine », « Malo » (de Saint-Malo). Ils
 * gardent leur place dans la liste — « Nancy DUPONT » est une personne —, mais ne suffisent
 * pas seuls, ni devant un simple mot capitalise : « Lorraine Patrimoine », « Malo Capoeira ».
 */
const PRENOMS_DE_LIEU: ReadonlySet<string> = new Set([
  "nancy", "lorraine", "florence", "lourdes", "valence", "vienne", "malo", "marin", "albin",
  "sion", "adil",
]);

/** Civilites. Seules, en tete de segment, elles suffisent : c'etait deja la regle. */
const CIVILITES: ReadonlySet<string> = new Set([
  "m", "mr", "mme", "mlle", "monsieur", "madame", "mademoiselle", "dr", "docteur",
]);

/** Titres qui annoncent une personne quand un prenom ou un nom les suit : « Pere Jean ». */
const TITRES: ReadonlySet<string> = new Set([
  "pere", "abbe", "frere", "soeur", "pasteur", "mgr", "monseigneur", "chanoine",
]);

/**
 * Le segment porte-t-il une personne, quelle que soit la structure qu'il nomme par
 * ailleurs ? Rejete **avant** le laissez-passer des motifs de structure.
 */
export function porteUnePersonne(segment: string): boolean {
  const normalise = normaliserNom(segment);
  // « Agnes X preside cette association », « presidee par ». Aucun nom du RNA ne porte ce
  // verbe : mesure sur les 49 118 noms de la base de developpement.
  if (/\bpresidee?\b/.test(normalise)) return true;
  // « (responsable) », « (directeur general) », « (tresoriere) ».
  if (/\((?:[^)]*\s)?(?:pr[ée]sidente?|tr[ée]sori[èe]re?|secr[ée]taire|responsable|directeur|directrice|coordinat(?:eur|rice)|entra[iî]neur|r[ée]f[ée]rente?)\b[^)]*\)/iu.test(segment)) {
    return true;
  }

  const jetons = segment.split(/[\s,;]+/).filter((jeton) => jeton !== "");
  const premier = normaliserNom(jetons[0] ?? "");
  const second = jetons[1] ?? "";
  // Une civilite en tete, suivie d'un nom : « Mr Michel X », « Mme DUPONT Accueil de
  // loisirs ». C'etait deja la regle ; elle passe desormais avant le laissez-passer.
  if (CIVILITES.has(premier) && (designeUnIndividu(second) || estUnMotDeNom(second))) return true;
  // Un titre en tete, suivi d'un prenom ou d'un nom en capitales : « Pere Jean Louis X ».
  if (TITRES.has(premier) && designeUnIndividu(second)) return true;
  // Une civilite au milieu, suivie d'un **prenom** : « Entraineur M Christophe X ». Un nom
  // en capitales ne suffit pas ici — « … DES T. D. M. DILLE ET VILAINE » est un sigle.
  for (let rang = 1; rang < jetons.length - 1; rang += 1) {
    if (CIVILITES.has(normaliserNom(jetons[rang] ?? "")) && estUnPrenom(jetons[rang + 1] ?? "")) return true;
  }
  return false;
}

/** Un prenom connu, ou un nom de famille ecrit en capitales. */
function designeUnIndividu(jeton: string): boolean {
  const normalise = normaliserNom(jeton);
  if (MOTS_OUTILS.has(normalise) || BLOQUANTS.has(normalise)) return false;
  return estUnPrenom(jeton) || estEnCapitales(jeton);
}

/** Un mot capitalise qui peut etre un nom : ni mot-outil, ni vocabulaire de structure. */
function estUnMotDeNom(jeton: string): boolean {
  const normalise = normaliserNom(jeton);
  if (MOTS_OUTILS.has(normalise) || BLOQUANTS.has(normalise)) return false;
  return /^\p{Lu}[\p{L}'’.-]*$/u.test(jeton);
}

/**
 * Le segment a-t-il la forme d'un nom de personne — ou de plusieurs, joints par « et »,
 * « & », « ou », un tiret espace ?
 *
 * Il suffit qu'**une** des parties soit une personne : « Tennis Club - Jean DUPONT » porte
 * un nom de personne, et le livrer l'exposerait autant que s'il etait seul.
 */
export function estUnNomDePersonne(segment: string): boolean {
  const preuves = preuvesDePersonne(segment);
  // Une preuve forte suffit : « Tennis Club - Jean DUPONT » expose une personne autant que
  // si elle etait seule. Les preuves faibles ne valent que si **toutes** les parties en
  // portent : « Karate Club - St - Gregoire » n'est personne, « Denise et Michelle » si.
  if (preuves.includes("forte")) return true;
  return preuves.length > 0 && preuves.every((preuve) => preuve !== "aucune");
}

export type Preuve = "forte" | "faible" | "aucune";

/** Ce que chaque partie du segment dit d'elle-meme. Exportee pour la mesure et les tests. */
export function preuvesDePersonne(segment: string): Preuve[] {
  const parties = segment
    .replace(/\([^)]*\)/g, " ")
    .split(/\s+(?:et|ou|&)\s+|\s+[-–—/]\s+|\s*[,;]\s*/i)
    .map((partie) => partie.trim())
    .filter((partie) => partie !== "");
  const casseMixte = /\p{Ll}/u.test(segment) && /\p{Lu}/u.test(segment);
  return parties.map((partie) => preuveDePersonne(partie, casseMixte));
}

/** Les deux questions a la fois : l'export n'a pas a savoir laquelle a repondu. */
export function designeUnePersonne(segment: string): boolean {
  return porteUnePersonne(segment) || estUnNomDePersonne(segment);
}

/**
 * Ce qu'une partie du segment dit d'elle-meme.
 *
 * - **forte** : la casse le confirme, en texte mixte — un nom de famille en capitales a
 *   cote d'un prenom : « Annie DUPONT », « DURAND Gerard » ;
 * - **faible** : un prenom seul, ou « Prenom Nom » en casse mixte sans capitales ;
 * - **aucune** sinon.
 *
 * En capitales partout, seule la forme du prenom seul compte. « RESEAU LILAS », « PAGE
 * BLANCHE », « PIERRE ANGULAIRE » sont des noms du RNA : sans la casse, « NOM Prenom » et
 * « MOT Prenom » ne se separent pas.
 */
function preuveDePersonne(partie: string, casseMixte: boolean): Preuve {
  const jetons = partie
    .split(/\s+/)
    // La ponctuation qui colle a un nom n'en fait pas partie : « -Gaetan », « DURANDEL (».
    .map((jeton) => jeton.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}.'’]+$/gu, ""))
    .filter((jeton) => jeton !== "");
  // Le coeur : sans les fonctions, les libelles, les mots-outils ni les chiffres qui
  // l'entourent — « Lucien X Lieu d' », « Veronique X au 06 98 ».
  const bord = (jeton: string): boolean => {
    const normalise = normaliserNom(jeton);
    return FONCTIONS.has(normalise) || MOTS_OUTILS.has(normalise) || !/\p{L}/u.test(jeton) || /^[dl]['’]$/i.test(jeton);
  };
  while (jetons.length > 0 && bord(jetons[jetons.length - 1] ?? "")) jetons.pop();
  while (jetons.length > 0 && FONCTIONS.has(normaliserNom(jetons[0] ?? ""))) jetons.shift();
  if (jetons.length === 0 || jetons.length > 4) return "aucune";

  const normalises = jetons.map((jeton) => normaliserNom(jeton));
  if (normalises.some((normalise) => normalise.split(" ").some((mot) => BLOQUANTS.has(mot)))) return "aucune";
  // Un numero d'ordre ne suit pas un nom de personne, sauf celui d'un pape : « Jean-Paul II »
  // nomme une ecole.
  if (jetons.some((jeton) => /^[IVXLC]+$/.test(jeton))) return "aucune";

  let particule = false;
  for (let rang = 0; rang < jetons.length; rang += 1) {
    const jeton = jetons[rang] ?? "";
    const normalise = normalises[rang] ?? "";
    const interieur = rang > 0 && rang < jetons.length - 1;
    if (casseMixte && interieur && PARTICULES.has(normalise)) {
      // « Le » et « La » capitalises ouvrent un nom breton — « Katy Le Sant » — et non une
      // tournure : ils ne retirent rien a la preuve.
      if (!/^L[ae]$/.test(jeton)) particule = true;
      continue;
    }
    if (MOTS_OUTILS.has(normalise)) return "aucune";
    if (!/^\p{Lu}[\p{L}'’.-]*$/u.test(jeton)) return "aucune";
  }

  const premier = jetons[0] ?? "";
  const dernier = jetons[jetons.length - 1] ?? "";
  const enCapitales = jetons.map((jeton) => estEnCapitales(jeton));
  // Un prenom seul, ecrit comme un prenom : « Pierre ». En capitales, « ADIL » ou « SARA »
  // sont aussi des sigles et des noms d'associations du RNA.
  if (jetons.length === 1) {
    return estUnPrenom(premier) && !enCapitales[0] && !PRENOMS_DE_LIEU.has(normaliserNom(premier)) ? "faible" : "aucune";
  }
  if (!casseMixte) return "aucune";

  // « Prenom NOM », « Prenom Prenom NOM » : la casse confirme. « Prenom Nom » : elle ne
  // confirme rien, d'ou une preuve faible — et aucune devant une particule ou un lieu,
  // « Fleur de Lotus », « Lorraine Patrimoine ».
  if (estUnPrenom(premier) && !enCapitales[0]) {
    if (enCapitales.slice(1).some(Boolean)) return "forte";
    return particule || PRENOMS_DE_LIEU.has(normaliserNom(premier)) ? "aucune" : "faible";
  }
  // « Nom Jean-Luc » : un prenom compose ne se rencontre pas comme mot ordinaire, il suffit a
  // designer une personne meme sans capitales.
  if (dernier.includes("-") && estUnPrenom(dernier) && !enCapitales[jetons.length - 1] && jetons.length === 2) {
    return "faible";
  }
  // « NOM Prenom », « NOM Prenom Prenom » : le nom de famille en capitales, devant.
  if (!estUnPrenom(dernier) || enCapitales[jetons.length - 1]) return "aucune";
  let debutPrenoms = jetons.length - 1;
  if (debutPrenoms >= 2 && estUnPrenom(jetons[debutPrenoms - 1] ?? "") && !enCapitales[debutPrenoms - 1]) {
    debutPrenoms -= 1;
  }
  const devant = jetons.slice(0, debutPrenoms);
  const nomDeFamille = devant.every((jeton) => estEnCapitales(jeton) || PARTICULES.has(normaliserNom(jeton)));
  return nomDeFamille && devant.some((jeton) => estEnCapitales(jeton)) ? "forte" : "aucune";
}

/**
 * Le jeton est-il un prenom connu ? Un prenom compose l'est si chacune de ses parties l'est :
 * « Jean-Pierre » oui, « Saint-Pierre » non.
 */
export function estUnPrenom(jeton: string): boolean {
  const normalise = normaliserNom(jeton);
  if (normalise === "") return false;
  return normalise.split(" ").every((partie) => PRENOMS_CONNUS.has(partie));
}

/** Deux lettres au moins, toutes capitales : la convention du nom de famille. */
function estEnCapitales(jeton: string): boolean {
  return /^\p{Lu}[\p{Lu}'’-]+$/u.test(jeton);
}
