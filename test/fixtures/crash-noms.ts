/**
 * Passe de nommage, jetable, utilisee par le test de reprise apres `kill -9`.
 *
 * En mode « crash », elle s'abat elle-meme a la premiere tranche commitee. C'est le seul
 * instant ou la base est partiellement a jour de facon **certaine** : la passe etant
 * entierement synchrone, ni une minuterie interne ni un signal exterieur ne peuvent viser
 * cet instant de maniere fiable — sous charge, ils tombent avant le premier commit ou
 * apres le dernier, et le test ne prouve alors plus rien.
 *
 * Usage : node crash-noms.ts <dbFile> <cacheDir> <crash|reprise|tout>
 */
import { openDatabase } from "../../src/db/index.ts";
import { HttpCache } from "../../src/http/cache.ts";
import { systemClock } from "../../src/clock.ts";
import { remplirNoms } from "../../src/decouverte/noms.ts";

const [, , dbFile, cacheDir, mode] = process.argv;

const db = openDatabase(dbFile as string);
const cache = new HttpCache(cacheDir as string);

const resultat = remplirNoms(db, cache, systemClock, {
  departement: "35",
  // « reprise » emprunte le chemin reel d'une relance apres incident : les contacts deja
  // evalues par la version courante sont sautes, seuls les autres sont traites.
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
