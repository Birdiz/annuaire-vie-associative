/**
 * Messageries grand public. Une adresse qui s'y trouve dit ou son titulaire releve son
 * courrier, jamais qui il est.
 *
 * Deux usages, d'ou ce module a part : l'export ne nomme pas une structure d'apres une
 * messagerie (ADR-033), et l'extraction decolle une adresse que le CMS a soudee au mot
 * suivant (`decollerEmail`). L'extraction n'a pas a dependre de l'export pour cela.
 *
 * Liste en dur plutot que table : elle change au rythme du marche des FAI, c'est-a-dire
 * jamais, et un reglage de plus n'aurait fait que deplacer la question.
 */

/**
 * Domaines reconnus **exactement**. Ceux dont l'etiquette seule serait trop ambigue pour
 * valoir quel que soit le suffixe — `me`, `mac`, `ik` — ne vivent qu'ici.
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
 * Etiquettes de messagerie, reconnues **quel que soit le suffixe**.
 *
 * La liste exacte ne suffisait pas. Sur l'Ain et la Haute-Loire, le fichier livre portait
 * des lignes « Gmail », « Hotmail », « Orange », « Laposte », « Ymail », « Protonmail »,
 * « Riseup » : `gmail.fr`, `hotmail.be`, `yahoo.co.uk`, `protonmail.ch`… et surtout les
 * adresses collees au mot suivant, `gmail.comhttps`. Une seule d'entre elles reunissait
 * onze adresses sans rapport sous le nom « Gmail » — une ligne fausse, pas seulement
 * inutile.
 *
 * Testee en prefixe `etiquette.` : `gmail.fr` en releve, `orange-sport.fr` non.
 */
export const ETIQUETTES_DE_MESSAGERIE: readonly string[] = [
  "gmail",
  "googlemail",
  "hotmail",
  "outlook",
  "live",
  "msn",
  "yahoo",
  "ymail",
  "rocketmail",
  "aol",
  "gmx",
  "icloud",
  "protonmail",
  "proton",
  "tutanota",
  "tuta",
  "posteo",
  "zoho",
  "yandex",
  "riseup",
  "laposte",
  "orange",
  "wanadoo",
  "pagesperso-orange",
  "free",
  "sfr",
  "neuf",
  "bbox",
  "numericable",
  "netcourrier",
  "caramail",
  "mailo",
  "cegetel",
  "aliceadsl",
  "club-internet",
  "libertysurf",
  "voila",
  "9online",
  "dbmail",
  "bluewin",
];

/** Le domaine est-il celui d'une messagerie grand public ? */
export function estMessagerie(domaine: string): boolean {
  const bas = domaine.toLowerCase();
  if (FOURNISSEURS_PUBLICS.includes(bas)) return true;
  return ETIQUETTES_DE_MESSAGERIE.some((etiquette) => bas.startsWith(`${etiquette}.`));
}

/**
 * L'etiquette est-elle celle d'une messagerie ? Sert a decoller : dans
 * `gmail.comhbcbrioude.clubeo.com`, c'est la premiere etiquette qui dit ou l'adresse
 * s'arrete — une messagerie n'a pas de sous-domaine a son nom.
 */
export function estEtiquetteDeMessagerie(etiquette: string): boolean {
  const bas = etiquette.toLowerCase();
  if (ETIQUETTES_DE_MESSAGERIE.includes(bas)) return true;
  return FOURNISSEURS_PUBLICS.some((fournisseur) => fournisseur.split(".")[0] === bas);
}

/**
 * Le miroir SQL d'`estMessagerie`, inline dans la requete d'export : `compterLignes` et
 * `lignesCsv` doivent accepter exactement les memes domaines.
 *
 * `substr` et non `LIKE` : `_` y serait un joker. L'absence d'apostrophe dans les deux
 * listes est verifiee par un test, ce qui rend l'interpolation sure **par construction**,
 * et non par relecture de la personne qui ajoutera la quarantieme entree.
 */
export const SQL_NON_MESSAGERIE: string = [
  `domaine NOT IN (${FOURNISSEURS_PUBLICS.map((domaine) => `'${domaine}'`).join(", ")})`,
  ...ETIQUETTES_DE_MESSAGERIE.map(
    (etiquette) => `substr(domaine, 1, ${etiquette.length + 1}) <> '${etiquette}.'`,
  ),
].join("\n   AND ");
