/**
 * Rejeu du pre-filtre, jetable, utilise par le test de reprise apres `kill -9`.
 *
 * En mode « crash », il s'abat lui-meme a la premiere tranche commitee. C'est le seul
 * instant ou la base est partiellement a jour de facon **certaine** : le rejeu etant
 * entierement synchrone, ni une minuterie interne ni un signal exterieur ne peuvent
 * viser cet instant de maniere fiable — sous charge, ils tombent avant le premier
 * commit ou apres le dernier, et le test ne prouve alors plus rien.
 *
 * Usage : node crash-prefiltre.ts <dbFile> <cacheDir> <crash|reprise|tout>
 */
import { openDatabase } from "../../src/db/index.ts";
import { HttpCache } from "../../src/http/cache.ts";
import { systemClock } from "../../src/clock.ts";
import { rejouerPrefiltre } from "../../src/decouverte/rejeu.ts";

const [, , dbFile, cacheDir, mode] = process.argv;

const db = openDatabase(dbFile as string);
const cache = new HttpCache(cacheDir as string);

const resultat = rejouerPrefiltre(db, cache, systemClock, {
  departement: "35",
  campagne: "2026-08-21",
  // « reprise » emprunte le chemin reel d'une relance apres incident : les pages deja
  // jugees par la version courante sont sautees, seules les autres sont traitees.
  tout: mode !== "reprise",
  ...(mode === "crash"
    ? {
        onTranche: (): void => {
          process.kill(process.pid, "SIGKILL");
        },
      }
    : {}),
});
db.close();
process.stdout.write(`${JSON.stringify(resultat)}\n`);
