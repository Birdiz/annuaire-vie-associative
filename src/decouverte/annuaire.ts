/**
 * Suivre un annuaire d'associations jusqu'au bout (ADR-038).
 *
 * L'exploration ordinaire ne sait pas ce qu'est un annuaire : elle garde huit liens par
 * page, s'arrete a deux sauts de l'accueil et vingt pages par commune. Un annuaire de
 * trente-quatre pages de six cartes, chacune avec sa fiche, n'y laissait que sa premiere
 * page — et la moitie de ses liens retenus etaient des fiches, qui prenaient la place des
 * rubriques.
 *
 * Ce module reconnait la **liste** d'un annuaire a sa forme, et rend ses deux sortes de
 * liens : la **pagination**, qui se suit et s'etend a son tour, et les **fiches**, qui sont
 * des feuilles. Ils ont leur propre budget, a part de celui de l'exploration.
 *
 * Tout ici est pur, sans base ni reseau : le crawl et la passe de nommage relisent la meme
 * page de la meme facon.
 */

import { canonicalizeUrl } from "../http/cache.ts";
import { normaliserNom } from "../texte.ts";
import type { DocumentAnalyse, Lien } from "../parse/html.ts";
import type { ContactExtrait, EstUneFiche } from "./extraction.ts";
import { nomLu, nomPressentiDuContact } from "./nom-pressenti.ts";
import type { ContexteCommune, NomPressenti } from "./nom-pressenti.ts";
import {
  estReseauSocial,
  extensionRejetee,
  memeSite,
  porteUnTermeNegatif,
  scorerLien,
} from "./scoring.ts";
import type { LienScore } from "./scoring.ts";

/**
 * Ce qu'une page est pour le crawl. `exploration` : trouvee en suivant les rubriques, avec
 * le budget ordinaire. `pagination` : une page de la liste d'un annuaire. `fiche` : la page
 * d'une structure, atteinte depuis cette liste.
 */
export type RolePage = "exploration" | "pagination" | "fiche";

export const ROLES_PAGE: readonly RolePage[] = ["exploration", "pagination", "fiche"];

/**
 * Pages d'annuaire au plus, par commune, en plus du budget d'exploration.
 *
 * Trois cents, arbitre avec le client sur Rillieux-la-Pape : 34 pages de liste et 203
 * fiches. Au `Crawl-delay: 5` que ce site demande, c'est une vingtaine de minutes pour
 * cette seule commune — acceptable parce que les pages d'annuaire passent apres toute
 * l'exploration du departement (`prioriteAnnuaire`).
 */
export const PAGES_MAX_ANNUAIRE = 300;

/**
 * Fiches distinctes au moins, sur une page, pour la reconnaitre comme la liste d'un
 * annuaire. Une rubrique « Associations » a trois sous-pages n'en est pas une ; une liste
 * paginee a six cartes par page, si. Sur une page deja atteinte par la pagination, une seule
 * suffit : la derniere page d'une liste n'a souvent que quelques cartes.
 */
export const FICHES_MIN = 5;

/**
 * Contacts distincts au plus, hors gabarit, pour qu'une fiche nomme ce qu'elle porte par
 * son titre. La page d'une structure en porte peu — un fixe, un mobile, un courriel, parfois
 * le double ; au-dela, c'est une page de rubrique atteinte par un lien qui ressemblait a une
 * fiche, et son titre (« Associations sportives ») ne nomme aucun des contacts qu'elle
 * range. Meme logique que `CONTACTS_MAX_PAR_BLOC` (ADR-035), a l'echelle de la page ; le
 * chiffre est a mesurer, comme l'a ete celui-la.
 */
export const CONTACTS_MAX_PAR_FICHE = 6;

/**
 * Parametres de query qui numerotent une page : `?page=2`, `?p=2`, `?paged=2`,
 * `?tx_paginate[currentPage]=2` (TYPO3), `?start=20`. Compares au dernier segment du nom,
 * crochets compris.
 */
const PARAMETRE_DE_PAGE = /(?:^|[[_-])(?:page|p|paged|pg|currentpage|start|offset|debut)\]?$/i;

/**
 * Ce qu'une liste nomme quand elle n'est pas celle des associations, meme rangee sous la vie
 * associative : `culture-sport-et-associations/annuaire-des-equipements`. Mesure sur le
 * Rhone : suivis, ces annuaires livraient des gymnases, des cardiologues et des entreprises
 * de transport — sous l'indice associatif que leur URL leur donnait a l'export (ADR-034).
 * Juge sur le seul dernier segment : `solidarite-sante-et-social/associations` reste une
 * liste d'associations.
 */
const AUTRES_ANNUAIRES: readonly string[] = [
  "professionnel", "entrepris", "commerc", "artisan", "economi", "sante", "medical",
  "equipement", "service", "saison", "agenda", "actualite",
];

/**
 * Ce qu'un bouton ajoute a l'ancre quand toute la carte est un seul lien — « ASMC Yoga Fiche
 * annuaire » —, et que certains CMS glissent aussi dans le `<h1>` de la fiche. Retire en fin
 * de texte seulement, jamais au milieu d'un nom.
 */
const APPEL_A_CLIQUER =
  /[\s\-–—|›»>:]*(?:fiche annuaire|voir la fiche|voir le detail|en savoir plus|lire la suite|plus d['’]infos?|d[ée]couvrir|consulter)[\s.›»>]*$/i;

/** L'ancre d'une carte ou le titre d'une fiche, sans le bouton qui le termine. */
export function nettoyerLibelle(libelle: string): string {
  return libelle.replace(APPEL_A_CLIQUER, "").trim();
}

/** `…/page/2` ou `…/page/2/`, la forme de WordPress. */
const SEGMENT_DE_PAGE = /\/page\/\d+\/?$/;

export type Annuaire = {
  pagination: readonly LienScore[];
  fiches: readonly LienScore[];
};

/**
 * La page est-elle la liste d'un annuaire ? Rend ses liens de pagination et de fiches, ou
 * `undefined`.
 *
 * Trois conditions, jugees sur le **chemin** de la page et jamais sur sa query — une page de
 * pagination garde le chemin de la premiere :
 *
 * 1. le chemin annonce des associations (« associ ») et aucun terme de rubrique
 *    administrative ou hors sujet, et la liste elle-meme ne nomme pas un autre annuaire —
 *    ce qui ecarte les actualites de la vie associative, l'annuaire general de la mairie,
 *    celui des professionnels et celui des equipements ;
 * 2. la page lie au moins `FICHES_MIN` enfants directs de son chemin : les fiches ;
 *
 * Une page atteinte comme fiche peut elle-meme etre une liste : un annuaire range par
 * categories — `/associations/sport`, puis ses clubs — se reconnait ainsi a chaque niveau,
 * au lieu de s'arreter aux categories.
 */
export function reconnaitreAnnuaire(liens: readonly Lien[], base: string, role: RolePage): Annuaire | undefined {
  const origine = new URL(base);
  const racine = racineDeListe(origine.pathname);
  if (racine === "") return undefined;

  const chemin = normaliserNom(decoder(racine));
  if (!chemin.includes("associ")) return undefined;
  if (porteUnTermeNegatif(chemin)) return undefined;
  const nomDeLaListe = normaliserNom(decoder(racine.slice(racine.lastIndexOf("/") + 1)));
  if (AUTRES_ANNUAIRES.some((terme) => nomDeLaListe.includes(terme))) return undefined;
  if (scorerLien(new URL(racine, origine), "") <= 0) return undefined;

  const pagination = new Map<string, LienScore>();
  const fiches = new Map<string, LienScore>();
  const soi = canonicalizeUrl(origine);

  for (const lien of liens) {
    const url = urlSuivable(lien.href, origine);
    if (url === undefined) continue;
    const canonique = canonicalizeUrl(url);
    if (canonique === soi) continue;
    const score = scorerLien(url, lien.ancre);
    const entree: LienScore = { url: canonique, urlRequete: url.href, ancre: lien.ancre, score };

    if (estUnePage(url, racine)) {
      if (!pagination.has(canonique)) pagination.set(canonique, entree);
    } else if (estUneFiche(url, racine) && score >= 0 && !porteUnTermeNegatif(lien.ancre)) {
      const connue = fiches.get(canonique);
      if (connue === undefined || lien.ancre.length > connue.ancre.length) fiches.set(canonique, entree);
    }
  }

  if (fiches.size < (role === "pagination" ? 1 : FICHES_MIN)) return undefined;
  return { pagination: [...pagination.values()], fiches: [...fiches.values()] };
}

/**
 * Reconnait les liens de fiche d'un annuaire, sous la forme qu'ils ont dans le DOM — resolus,
 * mais ni recales sur l'hote ni canonicalises.
 */
export function predicatFiche(annuaire: Annuaire | undefined, base: string): EstUneFiche | undefined {
  if (annuaire === undefined || annuaire.fiches.length === 0) return undefined;
  const origine = new URL(base);
  const fiches = new Set(annuaire.fiches.map((fiche) => fiche.url));
  return (href) => {
    const url = urlSuivable(href, origine);
    return url !== undefined && fiches.has(canonicalizeUrl(url));
  };
}

/** Les liens d'exploration, une fois ceux de l'annuaire retires : ils ont leur budget. */
export function horsAnnuaire(liens: readonly Lien[], annuaire: Annuaire | undefined, base: string): readonly Lien[] {
  if (annuaire === undefined) return liens;
  const origine = new URL(base);
  const siens = new Set([...annuaire.pagination, ...annuaire.fiches].map((lien) => lien.url));
  return liens.filter((lien) => {
    const url = urlSuivable(lien.href, origine);
    return url === undefined || !siens.has(canonicalizeUrl(url));
  });
}

/**
 * Le nom d'un contact, selon ce qu'est sa page.
 *
 * - Sur une **fiche**, tout contact hors gabarit appartient a la structure de la page, et
 *   c'est son `<h1>` qui la nomme. Le bloc ne dit souvent que « Courriel » ou « Tel. ».
 * - Sur la **liste** d'un annuaire, la carte nomme sa structure par l'ancre du lien vers sa
 *   fiche. Le bloc, lui, porte aussi la categorie (« Culture du monde ») et l'adresse
 *   (« Chez M. … ») : lu seul, il en tirait un nom faux.
 *
 * Dans les deux cas, le nom passe par le meme filtre que tout nom lu (`nomLu`), et le bloc
 * reste le recours quand il est refuse.
 */
export function nommerDansLaPage(
  contact: ContactExtrait,
  page: PageLue,
  commune: ContexteCommune | string | undefined,
): NomPressenti | undefined {
  const { doc } = page;
  if (titreNomme(page) && !contact.gabarit && doc.enTete !== undefined) {
    const parLeTitre = nomLu(nettoyerLibelle(doc.enTete.titre), "fiche:titre", commune);
    if (parLeTitre !== undefined) return parLeTitre;
  }
  if (contact.ancreDeFiche !== undefined && !contact.gabarit) {
    const parLAncre = nomLu(nettoyerLibelle(contact.ancreDeFiche), "annuaire:ancre", commune);
    if (parLAncre !== undefined) return parLAncre;
  }
  return nomPressentiDuContact(contact, commune);
}

/**
 * Les textes ou chercher un nom du RNA pour le rattachement : le titre de la fiche, sa
 * forme longue, puis l'ancre de la carte, avant les blocs. « ACPR » ne se trouve pas au
 * RNA ; « Association culturelle portugaise de … », peut-etre.
 */
export function contextesDeRattachement(contact: ContactExtrait, page: PageLue): readonly string[] {
  const { doc } = page;
  const devant: string[] = [];
  if (titreNomme(page) && !contact.gabarit && doc.enTete !== undefined) {
    if (doc.enTete.sousTitre !== undefined) devant.push(doc.enTete.sousTitre);
    devant.push(nettoyerLibelle(doc.enTete.titre));
  }
  if (contact.ancreDeFiche !== undefined && !contact.gabarit) devant.push(nettoyerLibelle(contact.ancreDeFiche));
  return devant.length === 0 ? contact.contextes : [...devant, ...contact.contextes];
}

/** Ce que le nommage doit savoir d'une page, au crawl comme a la relecture du cache. */
export type PageLue = {
  doc: DocumentAnalyse;
  role: RolePage;
  annuaire: Annuaire | undefined;
  contactsHorsGabarit: number;
};

/** Le titre de la page nomme-t-il ses contacts ? Seulement sur une vraie fiche. */
function titreNomme(page: PageLue): boolean {
  return page.role === "fiche" && page.annuaire === undefined && page.contactsHorsGabarit <= CONTACTS_MAX_PAR_FICHE;
}

/**
 * Le chemin de la liste, sans sa pagination WordPress ni sa barre finale. Vide pour la
 * racine du site : un accueil n'est pas un annuaire, meme quand il lie cinq rubriques.
 */
function racineDeListe(pathname: string): string {
  const sansPage = pathname.replace(SEGMENT_DE_PAGE, "");
  return sansPage.replace(/\/+$/, "");
}

function estUnePage(url: URL, racine: string): boolean {
  const chemin = url.pathname.replace(/\/+$/, "");
  if (SEGMENT_DE_PAGE.test(url.pathname) && racineDeListe(url.pathname) === racine) return true;
  if (chemin !== racine) return false;
  for (const [cle, valeur] of url.searchParams) {
    if (PARAMETRE_DE_PAGE.test(cle) && /^\d{1,5}$/.test(valeur)) return true;
  }
  return false;
}

/**
 * Enfant direct du chemin de la liste, sans query : `/annuaire/acpr`, `/annuaire/acpr/`,
 * `/annuaire/acpr.html`. Une fiche adressee par `?id=` n'est pas reconnue : la meme forme
 * sert aux filtres, aux tris et aux agendas.
 */
function estUneFiche(url: URL, racine: string): boolean {
  if (url.search !== "") return false;
  const chemin = url.pathname.replace(/\/+$/, "");
  if (!chemin.startsWith(`${racine}/`)) return false;
  const reste = decoder(chemin.slice(racine.length + 1));
  if (reste === "" || reste.includes("/")) return false;
  if (UTILITAIRES.has(reste.toLowerCase())) return false;
  // Un lien que le site a ecrit sans schema — `href="www.club.fr"` — ou sans `mailto:` se
  // resout en relatif, comme dans un navigateur : c'est une adresse, pas une fiche, et le
  // serveur repond 404. Mesure sur le Rhone : 27 fiches sur 2 400.
  if (reste.includes("@")) return false;
  const point = reste.lastIndexOf(".");
  return point === -1 || EXTENSIONS_DE_PAGE.has(reste.slice(point + 1).toLowerCase());
}

/**
 * Enfants d'une liste qui n'en sont pas des fiches : l'export PDF de la page, son flux, sa
 * version imprimable. Sur le Rhone, `…/annuaire-des-associations/pdf` repondait 500, et se
 * retentait cinq fois.
 */
const UTILITAIRES = new Set([
  "page", "pdf", "feed", "rss", "atom", "print", "imprimer", "impression", "export", "exporter",
  "partager", "share", "embed", "amp", "trackback", "comments", "commentaires", "plan-du-site",
]);

/** Ce qui peut suivre un point dans le nom d'une fiche ; tout autre suffixe est un domaine. */
const EXTENSIONS_DE_PAGE = new Set(["html", "htm", "php", "asp", "aspx", "jsp", "shtml"]);

/** Le lien, s'il pourrait etre suivi : meme site, HTTP, pas un fichier ni un reseau social. */
function urlSuivable(href: string, origine: URL): URL | undefined {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (estReseauSocial(url.hostname) || !memeSite(url, origine)) return undefined;
  if (extensionRejetee(url.pathname)) return undefined;
  if (url.hostname !== origine.hostname) url.hostname = origine.hostname;
  url.hash = "";
  return url;
}

function decoder(chemin: string): string {
  try {
    return decodeURIComponent(chemin);
  } catch {
    return chemin;
  }
}
