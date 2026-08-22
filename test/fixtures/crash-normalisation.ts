/**
 * Normalisation [7]/[8], jetable, utilisee par le test de reprise apres `kill -9`.
 *
 * En mode « crash », le processus s'abat lui-meme a la premiere tranche commitee. C'est
 * le seul instant ou la base est partiellement a jour de facon **certaine** : ni une
 * minuterie ni un signal exterieur ne peuvent viser cet instant de maniere fiable, et
 * sous charge ils tombent avant le premier commit ou apres le dernier — le test ne
 * prouverait alors plus rien.
 *
 * Le resolveur MX est injecte et purement local : ce fixture ne sort pas sur le reseau.
 *
 * Usage : node crash-normalisation.ts <dbFile> <crash|reprise|tout>
 */
import { openDatabase } from "../../src/db/index.ts";
import { systemClock } from "../../src/clock.ts";
import { ResolveurMx } from "../../src/http/dns.ts";
import { normaliser } from "../../src/normalisation/rejeu.ts";

const [, , dbFile, mode] = process.argv;

const db = openDatabase(dbFile as string);
const resolveur = new ResolveurMx({
  resolve: async (domaine) => [{ exchange: `mx.${domaine}`, priority: 10 }],
});

const resultat = await normaliser(db, systemClock, resolveur, {
  departement: "35",
  // « reprise » emprunte le chemin reel d'une relance apres incident : ce que la
  // version courante a deja produit est saute, le reste est traite.
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
