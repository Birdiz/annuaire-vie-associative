#!/usr/bin/env node
/**
 * Point d'entree du programme, et rien d'autre.
 *
 * Ce fichier est separe de `cli.ts` parce qu'il est le seul point commun aux trois
 * emballages du lot 7 : execution directe des sources en developpement, bundle CJS
 * servi par `npx` et par l'image Docker, script principal de l'executable unique.
 *
 * D'ou les deux restrictions qu'il s'impose :
 *
 * - **aucun `await` de premier niveau.** Le SEA execute son script principal comme un
 *   module CommonJS, et esbuild refuse de convertir un `await` de premier niveau vers
 *   ce format (ADR-022). Un `.then()` fait le meme travail et se bundle.
 * - **aucun `import.meta`.** Il n'existe pas en CommonJS. La detection « suis-je le
 *   point d'entree ? » qui vivait ici n'a plus lieu d'etre : ce fichier n'est jamais
 *   importe, il est toujours lance.
 */
import { main } from "./cli.ts";

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (erreur: unknown) => {
    process.stderr.write(`Echec : ${(erreur as Error).message}\n`);
    process.exitCode = 1;
  },
);
