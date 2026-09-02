/**
 * Nommer une structure d'apres le domaine de son adresse e-mail.
 *
 * Dernier recours de la cascade de nommage (ADR-033), quand ni le RNA ni le bloc de la
 * page n'ont donne de nom. `contact@tennis-club-bruzou.fr` designe presque surement le
 * Tennis Club de Bruzou ; `lespetitesmains@orange.fr` ne designe rien du tout.
 *
 * **Le libelle produit est une inference, pas une lecture.** Il n'a aucune source, et
 * c'est pour cela que la colonne `nom_source` du profil complet le signale. Sans elle,
 * un nom fabrique et un nom venu du RNA seraient indistinguables dans le fichier livre.
 *
 * **Il est sans accents, et il l'est par nature** : un nom de domaine n'en porte pas. On
 * ne restaure pas « Theatre » depuis `theatre-des-landes.fr` sans inventer. C'est une
 * exception assumee a la regle « le texte affiche s'accentue », qui vise l'interface et
 * non une donnee derivee d'une chaine ASCII.
 *
 * Les conditions de forme vivent **aussi** dans le SQL de l'export : `compterLignes` et
 * `lignesCsv` doivent accepter exactement les memes domaines, sans quoi l'ecran
 * annoncerait un nombre de lignes que le fichier ne tient pas.
 */

/** En deca, le libelle n'apprend rien ; au dela, ce n'est plus un nom. */
export const LONGUEUR_MIN_LIBELLE = 4;
export const LONGUEUR_MAX_LIBELLE = 60;

/**
 * Messageries grand public. Une adresse qui s'y trouve dit ou son titulaire releve son
 * courrier, jamais qui il est.
 *
 * Liste en dur plutot que table : elle change au rythme du marche francais des FAI,
 * c'est-a-dire jamais, et un reglage de plus n'aurait fait que deplacer la question.
 */
export const FOURNISSEURS_PUBLICS: readonly string[] = [
  "gmail.com",
  "googlemail.com",
  "orange.fr",
  "wanadoo.fr",
  "pagesperso-orange.fr",
  "free.fr",
  "sfr.fr",
  "neuf.fr",
  "bbox.fr",
  "numericable.fr",
  "laposte.net",
  "hotmail.com",
  "hotmail.fr",
  "outlook.com",
  "outlook.fr",
  "live.fr",
  "live.com",
  "msn.com",
  "yahoo.com",
  "yahoo.fr",
  "aol.com",
  "gmx.fr",
  "gmx.com",
  "icloud.com",
  "me.com",
  "protonmail.com",
  "proton.me",
  // Trouves sur le departement 88 : ils sortaient nommes « Mailo », « Ik », « Mac ».
  "mailo.com",
  "ik.me",
  "mac.com",
  "sfr.net",
  "orange.com",
  "aliceadsl.fr",
  "club-internet.fr",
  "voila.fr",
  "cegetel.net",
  "9online.fr",
  "dbmail.com",
];

/**
 * Les entrees inlinees dans le SQL de l'export. L'absence d'apostrophe dans la liste est
 * verifiee par un test : c'est ce qui rend l'interpolation sure **par construction**, et
 * non par relecture de la personne qui ajoutera la trente-quatrieme entree.
 */
export const SQL_FOURNISSEURS_PUBLICS: string = FOURNISSEURS_PUBLICS.map(
  (domaine) => `'${domaine}'`,
).join(", ");

/**
 * Suffixes de deux etiquettes. Liste courte et volontairement incomplete : on ne
 * embarque pas la Public Suffix List pour cet usage — se tromper coute un libelle un
 * peu long, pas une donnee fausse.
 */
const SUFFIXES_COMPOSES: readonly string[] = [
  "asso.fr",
  "com.fr",
  "org.fr",
  "net.fr",
  "co.uk",
  "org.uk",
  "com.br",
];

/**
 * Plateformes d'hebergement associatif, tres repandues chez les petits clubs francais.
 * Sans cette liste, `tennisbruzou.clubeo.com` et trente de ses voisins sortiraient tous
 * nommes « Clubeo » — c'est le sous-domaine qui porte le nom, pas l'hebergeur.
 */
const HEBERGEURS: readonly string[] = [
  "clubeo",
  "sportsregions",
  "footeo",
  "e-monsite",
  "monsite",
  "wixsite",
  "wix",
  "wordpress",
  "blogspot",
  "over-blog",
  "jimdo",
  "weebly",
  "pagesperso",
  "free",
  "sitew",
  "webnode",
];

/** Etiquettes qui nomment un service de messagerie, pas une structure. */
const ETIQUETTES_TECHNIQUES: readonly string[] = [
  "mail",
  "smtp",
  "imap",
  "pop",
  "webmail",
  "mailo",
  "contact",
  "info",
  "asso",
  "site",
  "www",
];

/**
 * Le domaine d'une adresse deja normalisee. `undefined` si la valeur n'a pas la forme
 * d'une adresse — la validation, elle, vit dans `normalisation/validation.ts`.
 */
export function domaineDuContact(valeurNormalisee: string): string | undefined {
  const arobase = valeurNormalisee.lastIndexOf("@");
  if (arobase <= 0 || arobase === valeurNormalisee.length - 1) return undefined;
  return valeurNormalisee.slice(arobase + 1);
}

/**
 * L'hote d'une URL de mairie, sans schema ni `www.` ni chemin. Rendu en minuscules, ou
 * chaine vide si l'URL est absente ou inexploitable.
 *
 * Ecrit a la main plutot qu'avec `new URL` : la meme transformation doit exister en SQL
 * dans la requete d'export, et deux implementations qui se repondent doivent se
 * ressembler assez pour qu'on puisse les relire ensemble.
 */
export function hoteDeLUrl(url: string | null | undefined): string {
  if (url === null || url === undefined) return "";
  const sansSchema = url.toLowerCase().replace(/^https?:\/\//, "");
  const coupe = sansSchema.split(/[/?#]/)[0] ?? "";
  const sansPort = coupe.split(":")[0] ?? "";
  return sansPort.replace(/^www\./, "");
}

/** Le domaine appartient-il a la mairie, ou a l'un de ses sous-domaines ? */
export function estDomaineDeMairie(domaine: string, hoteMairie: string): boolean {
  if (hoteMairie === "") return false;
  return domaine === hoteMairie || domaine.endsWith(`.${hoteMairie}`);
}

/**
 * Un domaine bien forme : etiquettes en `[a-z0-9-]`, separees par des points.
 *
 * Ce n'est pas une precaution theorique. Un CMS qui masque l'arobase produit des valeurs
 * comme `club[^@]gmail.com`, dont le domaine devient `]gmail.com` : il **echappe a la
 * liste des fournisseurs publics**, qui compare des chaines exactes, et sortait donc
 * nomme « ]gmail » dans le fichier livre. Une adresse cassee ne doit pas se presenter
 * comme une structure.
 *
 * `ADRESSE_MALFORMEE` en SQL fait le meme office dans la requete d'export.
 */
function bienForme(domaine: string): boolean {
  return /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(domaine);
}

/**
 * Un domaine est **specifique** quand il peut porter le nom d'une structure : ni
 * messagerie grand public, ni domaine de la mairie, ni forme degeneree.
 *
 * Le domaine de la **page** ou le contact a ete lu n'entre pas dans ce jugement, et
 * c'est voulu : `contact@tennisbruzou.fr` trouve **sur** `tennisbruzou.fr` est le
 * meilleur cas de tous, pas un cas a ecarter.
 */
export function estDomaineSpecifique(domaine: string, hoteMairie: string): boolean {
  if (!bienForme(domaine)) return false;
  if (domaine.startsWith("xn--") || domaine.includes(".xn--")) return false;
  if (FOURNISSEURS_PUBLICS.includes(domaine)) return false;
  return !estDomaineDeMairie(domaine, hoteMairie);
}

/**
 * Le libelle lisible d'un domaine specifique, ou `undefined` s'il n'en sort rien de
 * presentable. `tennis-club-de-bruzou.fr` rend « Tennis Club De Bruzou ».
 *
 * Ne jamais tronquer : couper fabriquerait un nom qui n'a jamais existe nulle part.
 */
export function libelleDepuisDomaine(domaine: string): string | undefined {
  const etiquettes = domaine.split(".").filter((part) => part !== "");
  if (etiquettes.length < 2) return undefined;

  const composee = SUFFIXES_COMPOSES.includes(etiquettes.slice(-2).join("."));
  const sansSuffixe = etiquettes.slice(0, composee ? -2 : -1);
  if (sansSuffixe.length === 0) return undefined;

  // La derniere etiquette restante est le domaine enregistre. Quand c'est un
  // hebergeur, le nom est un cran a gauche.
  const enregistre = sansSuffixe[sansSuffixe.length - 1] ?? "";
  const retenue = HEBERGEURS.includes(enregistre) ? (sansSuffixe[0] ?? "") : enregistre;
  // Un hebergeur sans sous-domaine ne nomme personne : `clubeo.com` reste `clubeo`
  // apres le repli, et c'est ce test qui l'ecarte.
  if (retenue === "" || HEBERGEURS.includes(retenue)) return undefined;
  if (ETIQUETTES_TECHNIQUES.includes(retenue)) return undefined;
  if (retenue.startsWith("xn--")) return undefined;
  if (!/[a-z]/.test(retenue)) return undefined;

  const libelle = retenue
    .split(/[-_]+/)
    .filter((jeton) => jeton.length > 1)
    .map((jeton) => jeton.charAt(0).toUpperCase() + jeton.slice(1))
    .join(" ");

  if (libelle.length < LONGUEUR_MIN_LIBELLE) return undefined;
  if (libelle.length > LONGUEUR_MAX_LIBELLE) return undefined;
  return libelle;
}
