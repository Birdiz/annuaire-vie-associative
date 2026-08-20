/**
 * Etape [3] du §6 : choisir, sur une page de mairie, les liens qui valent une visite.
 *
 * Le scoring est l'entree de l'entonnoir de cout. Il n'a pas besoin d'etre juste, il
 * a besoin d'etre bon marche et de ne pas dilapider le budget de pages dans les
 * rubriques administratives — c'est l'etape [4] du lot suivant qui mesurera ce qui
 * passe. Tout ici est pur et testable sans reseau.
 */

import { canonicalizeUrl } from "../http/cache.ts";
import { normaliserNom } from "../texte.ts";
import type { Lien } from "../parse/html.ts";

/** Le brief fixe la profondeur a 2 : la page de mairie, puis deux sauts. */
export const PROFONDEUR_MAX = 2;

/**
 * Budget par commune, pilotable par `--max-pages`.
 *
 * Passe de 10 a 20 apres la premiere mesure reelle sur l'Ille-et-Vilaine : 115 des
 * 332 communes avaient sature le plafond de 10, donc celui-ci mordait sur un tiers du
 * departement et bornait la recolte autant que la richesse des sites. Le doublement
 * est un pas mesurable, pas un reglage definitif : c'est le rapport entre ce budget
 * et le taux de couverture qui dira ou le placer.
 *
 * Le cout n'est pas proportionnel. Le plancher de duree d'un run tient au /24 le plus
 * charge, pas au nombre total de pages : doubler le budget ne double le temps que si
 * les pages supplementaires tombent sur les sous-reseaux deja saturants.
 */
export const PAGES_MAX_PAR_COMMUNE = 20;

/** Au-dela, une page de menu ferait entrer tout un site d'un coup. */
export const LIENS_MAX_PAR_PAGE = 8;

/**
 * Termes du §6 du brief, ponderes. Cherches dans le chemin de l'URL *et* dans le
 * texte d'ancre : un lien dont les deux concordent est un meilleur pari, et la somme
 * le traduit sans qu'il faille une regle supplementaire.
 */
const TERMES_POSITIFS: readonly (readonly [string, number])[] = [
  ["vie associative", 6],
  ["associ", 4],
  ["annuaire", 3],
  ["vie locale", 2],
  ["benevol", 2],
  ["club", 2],
  ["sport", 2],
  ["loisir", 2],
  ["culture", 2],
  ["forum", 1],
  ["jeunesse", 1],
  ["contact", 1],
];

/**
 * Rubriques presentes sur presque tous les sites de mairie et sans association :
 * les ecarter n'est pas un raffinement, c'est ce qui empeche le budget de partir
 * dans l'etat civil et les marches publics.
 *
 * Les termes sont cherches par inclusion sur du texte normalise, donc le pluriel doit
 * etre ecrit quand il ne contient pas le singulier : « marches publics » ne contient
 * pas « marche public ».
 */
const TERMES_NEGATIFS: readonly string[] = [
  "actualite", "agenda", "urbanisme", "etat civil", "mentions legales",
  "marche public", "marches publics", "compte rendu", "comptes rendus",
  "plan du site", "politique de confidentialite", "cookie", "connexion", "mon compte",
  "newsletter", "recherche", "deces", "naissance", "cimetiere", "cadastre",
  "permis de construire", "conseil municipal", "arrete", "dechet", "assainissement",
];

const POIDS_NEGATIF = -4;

/** Ce qui n'est pas une page : le fetch le decouvrirait, autant l'eviter avant. */
const EXTENSIONS_REJETEES = new Set([
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "rtf", "csv",
  "jpg", "jpeg", "png", "gif", "webp", "svg", "ico", "bmp", "tif", "tiff",
  "zip", "rar", "7z", "gz", "tar", "mp3", "mp4", "avi", "mov", "wmv", "wav", "ogg",
  "css", "js", "json", "xml", "rss", "atom", "exe", "dmg", "apk",
]);

/**
 * §5 du brief : aucun scraping de reseaux sociaux, « ne pas l'implementer meme si
 * demande plus tard ». La restriction a l'hote de la mairie l'interdit deja, mais pas
 * dans tous les cas : une petite commune dont l'Annuaire declare une page Facebook
 * comme site officiel, ou une redirection sortante, nous y menerait sans que rien ne
 * s'y oppose. Le refus est donc explicite et verifie separement, sur l'hote final.
 */
const RESEAUX_SOCIAUX: readonly string[] = [
  "facebook", "fb", "messenger", "instagram", "linkedin", "twitter", "tiktok",
  "snapchat", "pinterest", "threads", "youtube", "youtu", "whatsapp", "telegram",
];

/** Vrai si l'hote appartient a un reseau social, quel que soit son domaine de tete. */
export function estReseauSocial(hostname: string): boolean {
  const etiquettes = hostname.toLowerCase().split(".");
  // On regarde le domaine enregistrable, pas n'importe quelle etiquette : un
  // « facebook.mairie-x.fr » reste un site de mairie.
  const domaine = etiquettes.length >= 2 ? etiquettes[etiquettes.length - 2] : etiquettes[0];
  if (domaine !== undefined && RESEAUX_SOCIAUX.includes(domaine)) return true;
  // x.com, twitter.com : le domaine « x » est trop court pour etre distingue autrement.
  return hostname.toLowerCase() === "x.com" || hostname.toLowerCase().endsWith(".x.com");
}

export type LienScore = { url: string; ancre: string; score: number };

export type Selection = {
  retenus: readonly LienScore[];
  /** Liens vers un autre site : comptes, jamais suivis (§2, on reste chez la commune). */
  horsDomaine: number;
  /** Liens ecartes avant scoring : schema, extension, ancre vide. */
  ignores: number;
  /** Liens de score nul ou negatif. */
  ecartes: number;
};

/**
 * Vrai si `url` appartient au meme site que `base`. La seule tolerance est le prefixe
 * `www.` : un sous-domaine peut appartenir a un tiers, et suivre un lien hors du site
 * de la mairie ferait sortir du perimetre que l'utilisateur a autorise.
 */
export function memeSite(url: URL, base: URL): boolean {
  return sansWww(url.hostname) === sansWww(base.hostname);
}

function sansWww(hote: string): string {
  return hote.startsWith("www.") ? hote.slice(4) : hote;
}

/** Score d'un lien, sur le chemin de l'URL et sur le texte d'ancre. */
export function scorerLien(url: URL, ancre: string): number {
  const chemin = normaliserNom(decodeChemin(url));
  const texte = normaliserNom(ancre);
  let score = 0;
  for (const [terme, poids] of TERMES_POSITIFS) {
    if (chemin.includes(terme)) score += poids;
    if (texte.includes(terme)) score += poids;
  }
  for (const terme of TERMES_NEGATIFS) {
    if (chemin.includes(terme) || texte.includes(terme)) score += POIDS_NEGATIF;
  }
  return score;
}

function decodeChemin(url: URL): string {
  const brut = `${url.pathname}${url.search}`;
  try {
    return decodeURIComponent(brut);
  } catch {
    return brut;
  }
}

/**
 * Trie les liens d'une page et rend les meilleurs, dedupliques par URL canonicalisee
 * — la meme page apparait souvent dans le menu et dans le corps.
 */
export function selectionner(liens: readonly Lien[], base: string, maxLiens = LIENS_MAX_PAR_PAGE): Selection {
  const origine = new URL(base);
  const origineCanonique = canonicalizeUrl(origine);
  const meilleurs = new Map<string, LienScore>();
  let horsDomaine = 0;
  let ignores = 0;
  let ecartes = 0;

  for (const lien of liens) {
    let url: URL;
    try {
      url = new URL(lien.href);
    } catch {
      ignores += 1;
      continue;
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      ignores += 1;
      continue;
    }
    if (estReseauSocial(url.hostname) || !memeSite(url, origine)) {
      horsDomaine += 1;
      continue;
    }
    if (extensionRejetee(url.pathname)) {
      ignores += 1;
      continue;
    }

    // `bruz.fr/x` et `www.bruz.fr/x` sont la meme page. Sans ce recalage, elles
    // seraient retenues toutes les deux et consommeraient deux fois le budget de la
    // commune. On aligne sur l'hote de la page d'ou vient le lien.
    if (url.hostname !== origine.hostname) url.hostname = origine.hostname;

    const canonique = canonicalizeUrl(url);
    if (canonique === origineCanonique) continue;

    const score = scorerLien(url, lien.ancre);
    if (score <= 0) {
      ecartes += 1;
      continue;
    }

    const connu = meilleurs.get(canonique);
    if (connu === undefined || score > connu.score) {
      meilleurs.set(canonique, { url: canonique, ancre: lien.ancre, score });
    }
  }

  // A score egal, l'URL la plus courte d'abord : elle designe en general la rubrique
  // plutot qu'une de ses fiches, donc plus de liens au saut suivant.
  const retenus = [...meilleurs.values()]
    .sort((a, b) => b.score - a.score || a.url.length - b.url.length || a.url.localeCompare(b.url))
    .slice(0, maxLiens);

  return { retenus, horsDomaine, ignores, ecartes };
}

function extensionRejetee(pathname: string): boolean {
  const dernier = pathname.slice(pathname.lastIndexOf("/") + 1);
  const point = dernier.lastIndexOf(".");
  if (point <= 0) return false;
  return EXTENSIONS_REJETEES.has(dernier.slice(point + 1).toLowerCase());
}
