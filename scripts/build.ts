/**
 * Construction du bundle — le seul artefact du lot 7.
 *
 * Un fichier JavaScript unique sert les trois emballages du brief (§2) : `npx`, l'image
 * Docker, et le script principal de l'executable Windows. Il n'existe qu'a l'emballage :
 * le developpement, les tests et `npm run annuaire` executent les sources TypeScript
 * directement (D8).
 *
 * Format **CommonJS**, et ce n'est pas un gout : c'est le `mainFormat` par defaut de
 * l'outillage SEA, celui qui est disponible sur toutes les Node 24. Il impose en retour
 * qu'aucun `await` de premier niveau n'existe dans le graphe bundle — esbuild refuse de
 * le convertir, et un test d'architecture l'interdit donc a la source (ADR-022).
 *
 * Ce module n'ecrit rien hors de la destination qu'on lui donne et ne sort pas sur le
 * reseau : la suite de tests s'en sert telle quelle.
 */
import { build } from "esbuild";
import { copyFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { nomsAssets } from "../src/ui/assets.ts";

export const RACINE = fileURLToPath(new URL("..", import.meta.url));
export const DIST = join(RACINE, "dist");

/** Nom du bundle. Il porte l'extension `.cjs` pour que Node le lise en CommonJS. */
export const NOM_BUNDLE = "annuaire.cjs";

export type Resultat = { fichier: string; octets: number };

export async function construireBundle(destination: string = DIST): Promise<Resultat> {
  mkdirSync(destination, { recursive: true });
  const fichier = join(destination, NOM_BUNDLE);

  await build({
    entryPoints: [join(RACINE, "src", "bin.ts")],
    outfile: fichier,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    minify: true,
    // Les licences des dependances bundlees restent dans le fichier produit.
    legalComments: "eof",
    // Pas de `banner` pour le shebang : esbuild conserve celui de `src/bin.ts`.
    // `import.meta.dirname` est lu dans la branche morte de `src/ui/assets.ts` : en
    // CommonJS, c'est `__dirname` qui repond. Le prevenir evite un avertissement qui
    // ferait douter d'un build par ailleurs sain.
    logOverride: { "empty-import-meta": "silent" },
  });

  copierAssets(destination);
  return { fichier, octets: statSync(fichier).size };
}

/**
 * Les fichiers statiques de l'UI voyagent a cote du bundle, dans `assets/`, la ou
 * `src/ui/assets.ts` va les chercher. La liste vient de ce module et non d'un `readdir` :
 * c'est la meme liste blanche qui est servie a l'execution, et l'executable unique en
 * derivera ses ressources.
 */
export function copierAssets(destination: string): readonly string[] {
  const cible = join(destination, "assets");
  mkdirSync(cible, { recursive: true });
  const source = join(RACINE, "src", "ui", "assets");
  const noms = nomsAssets();
  for (const nom of noms) copyFileSync(join(source, nom), join(cible, nom));
  return noms;
}

export function formaterOctets(valeur: number): string {
  if (valeur < 1024) return `${valeur} o`;
  if (valeur < 1024 * 1024) return `${(valeur / 1024).toFixed(1)} Ko`;
  return `${(valeur / (1024 * 1024)).toFixed(1)} Mo`;
}

if (process.argv[1] !== undefined && import.meta.filename === process.argv[1]) {
  const resultat = await construireBundle();
  process.stdout.write(
    `${resultat.fichier}\n${formaterOctets(resultat.octets)}, plus ${nomsAssets().length} fichiers statiques.\n`,
  );
}
