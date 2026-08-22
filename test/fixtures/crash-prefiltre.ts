/**
 * Rejeu du pre-filtre, jetable, utilise par le test de reprise apres `kill -9`.
 *
 * Il annonce « pret » puis appelle `rejouerPrefiltre`, et c'est le test qui l'abat
 * depuis l'exterieur. Le rejeu etant entierement synchrone, une minuterie interne ne
 * pourrait jamais se declencher pendant son execution : le signal doit venir d'ailleurs.
 *
 * Usage : node crash-prefiltre.ts <dbFile> <cacheDir> <tout|reprise>
 */
import { openDatabase } from "../../src/db/index.ts";
import { HttpCache } from "../../src/http/cache.ts";
import { systemClock } from "../../src/clock.ts";
import { rejouerPrefiltre } from "../../src/decouverte/rejeu.ts";

const [, , dbFile, cacheDir, mode] = process.argv;

const db = openDatabase(dbFile as string);
const cache = new HttpCache(cacheDir as string);

process.stdout.write("pret\n");

const resultat = rejouerPrefiltre(db, cache, systemClock, {
  departement: "35",
  campagne: "2026-08-21",
  // « reprise » emprunte le chemin reel d'une relance apres incident : les pages deja
  // jugees par la version courante sont sautees, seules les autres sont traitees.
  tout: mode !== "reprise",
});
db.close();
process.stdout.write(`${JSON.stringify(resultat)}\n`);
