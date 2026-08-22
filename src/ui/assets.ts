/**
 * Fichiers statiques servis par l'UI.
 *
 * **Aucune ressource distante.** htmx est une copie locale, servie depuis cette machine.
 * Un script charge depuis un CDN ferait sortir l'outil sur le reseau a l'ouverture d'un
 * ecran — ce que le local-first interdit — et laisserait chez un tiers la trace de chaque
 * consultation. La CSP du serveur le refuserait de toute facon, et un test verifie
 * qu'aucun gabarit n'en reference.
 *
 * **Une liste blanche, pas un repertoire.** Les noms servis sont enumeres ici. Deduire le
 * chemin de l'URL ouvrirait la traversee de repertoire sur la machine de l'utilisateur,
 * et un serveur local n'est pas un serveur inoffensif : il tourne avec ses droits a lui.
 *
 * **Lecture disque, pour l'instant.** L'artefact Windows du lot 7 est un executable
 * unique qui n'a pas de fichiers voisins a lire (ADR-001) ; c'est ce module, et lui seul,
 * qui basculera alors sur `sea.getAsset()`. Le contenu est lu une fois et garde en
 * memoire : trois fichiers, cinquante kilo-octets.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export type Asset = { corps: Buffer; type: string };

/**
 * Version figee de htmx et empreinte du fichier vendorise. Un test recalcule cette
 * empreinte : une modification du fichier tiers, accidentelle ou non, fait echouer
 * `npm run check` plutot que de passer inapercue dans une revue de diff minifie.
 */
export const HTMX_VERSION = "2.0.7";
export const HTMX_SHA256 = "60231ae6ba9db3825eb15a261122d5f55921c4d53b66bf637dc18b4ee27c79f9";

const TYPES: Record<string, string> = {
  "htmx.min.js": "text/javascript; charset=utf-8",
  "annuaire.css": "text/css; charset=utf-8",
  "htmx.LICENSE.txt": "text/plain; charset=utf-8",
};

export const REPERTOIRE_ASSETS = join(import.meta.dirname, "assets");

const CACHE = new Map<string, Asset>();

export function lireAsset(nom: string): Asset | undefined {
  const type = TYPES[nom];
  if (type === undefined) return undefined;

  const connu = CACHE.get(nom);
  if (connu !== undefined) return connu;

  const asset: Asset = { corps: readFileSync(join(REPERTOIRE_ASSETS, nom)), type };
  CACHE.set(nom, asset);
  return asset;
}

export function nomsAssets(): readonly string[] {
  return Object.keys(TYPES);
}
