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
 * **Trois provenances, un seul point de lecture.** Le lot 7 emballe le meme code de trois
 * facons, et chacune range ces fichiers ailleurs : a cote des sources en developpement, a
 * cote du bundle pour `npx` et pour Docker, et *dans* l'executable unique — qui n'a aucun
 * fichier voisin a lire (ADR-001, ADR-022). C'est ce module, et lui seul, qui connait la
 * difference. Le contenu est lu une fois et garde en memoire : une centaine de
 * kilo-octets.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import sea from "node:sea";

export type Asset = { corps: Buffer; type: string };

/**
 * Version figee de htmx et empreinte du fichier vendorise. Un test recalcule cette
 * empreinte : une modification du fichier tiers, accidentelle ou non, fait echouer
 * `npm run check` plutot que de passer inapercue dans une revue de diff minifie.
 */
export const HTMX_VERSION = "2.0.7";
export const HTMX_SHA256 = "60231ae6ba9db3825eb15a261122d5f55921c4d53b66bf637dc18b4ee27c79f9";

/**
 * La police de l'interface (ADR-041) : Atkinson Hyperlegible Next, dessinee pour la basse
 * vision — 0 et O, 1, l et I ne se confondent pas, ce qui compte sur un ecran ou l'on
 * relit des adresses et des numeros. Licence SIL OFL 1.1, voyageant avec le fichier.
 *
 * Une **police variable**, sous-ensemble latin, telle que Google Fonts la distribue : un
 * seul fichier couvre le 400 et le 700. Recuperee une fois, a la main — l'adresse exacte
 * est dans l'ADR-041, aucune URL n'ayant sa place dans `src/` ; aucune requete ne part vers
 * Google a l'execution. Meme discipline que htmx : une empreinte, verifiee par un test.
 */
export const ATKINSON_SOURCE = "Google Fonts, Atkinson Hyperlegible Next v7, police variable, sous-ensemble latin";
export const ATKINSON_SHA256 = "1e4cea71d75ec427581d6259fc07148a2e60d60d16cabf4b4f5360487b3f9dc3";

const TYPES: Record<string, string> = {
  "htmx.min.js": "text/javascript; charset=utf-8",
  "annuaire.css": "text/css; charset=utf-8",
  "htmx.LICENSE.txt": "text/plain; charset=utf-8",
  "atkinson-hyperlegible-next.woff2": "font/woff2",
  "atkinson-hyperlegible-next.OFL.txt": "text/plain; charset=utf-8",
  "logo.svg": "image/svg+xml",
  "etabli.js": "text/javascript; charset=utf-8",
};

/**
 * Repertoire ou vivent les fichiers, quand il y en a un.
 *
 * `__dirname` n'existe qu'en CommonJS, `import.meta.dirname` qu'en module ES : le premier
 * designe le bundle emballe, le second les sources executees directement. La branche morte
 * est eliminee a la construction, et aucune des deux formes n'a besoin de savoir laquelle
 * des trois provenances a servi.
 */
function repertoireAssets(): string {
  return join(typeof __dirname === "string" ? __dirname : import.meta.dirname, "assets");
}

export const REPERTOIRE_ASSETS = repertoireAssets();

const CACHE = new Map<string, Asset>();

/**
 * Dans l'executable unique, les fichiers sont des ressources du binaire : `sea.getAsset`
 * les rend depuis la memoire, sous les memes noms que ceux enumeres par `TYPES` — c'est
 * `scripts/sea.ts` qui construit sa configuration a partir de `nomsAssets()`, et un test
 * verifie que les deux listes restent egales.
 */
function corps(nom: string): Buffer {
  if (sea.isSea()) return Buffer.from(sea.getAsset(nom));
  return readFileSync(join(REPERTOIRE_ASSETS, nom));
}

export function lireAsset(nom: string): Asset | undefined {
  // `Object.hasOwn` et pas une simple lecture : `TYPES["constructor"]` rend la fonction
  // `Object`, pas `undefined`. `GET /assets/constructor` partait donc lire un fichier
  // inexistant et remontait en 500 au lieu du 404 prevu — pas une faille, le `join` reste
  // dans le repertoire, mais un chemin d'exception non prevu dans la porte d'entree.
  if (!Object.hasOwn(TYPES, nom)) return undefined;
  const type = TYPES[nom];
  if (type === undefined) return undefined;

  const connu = CACHE.get(nom);
  if (connu !== undefined) return connu;

  const asset: Asset = { corps: corps(nom), type };
  CACHE.set(nom, asset);
  return asset;
}

export function nomsAssets(): readonly string[] {
  return Object.keys(TYPES);
}
