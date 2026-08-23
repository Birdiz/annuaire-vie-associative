/**
 * Worker de decouverte jetable, utilise par le test de reprise apres `kill -9`.
 *
 * Il vise le serveur local du test parent, dont l'origine est passee en argument. Le
 * garde-fou `test/helpers/pas-de-reseau.ts` doit etre precharge par l'appelant :
 * contrairement a `crash-worker.ts`, ce worker fait de vraies requetes, et l'interdit
 * « la suite de tests ne sort jamais sur Internet » doit tenir dans le sous-processus
 * aussi.
 *
 * Usage :
 *   node crawl-worker.ts <dbFile> <cacheDir> <origine> <killApresNPages|-1>
 *                        <killApresMs|-1> <leaseMs> <concurrence> <campagne>
 */
import { openDatabase } from "../../src/db/index.ts";
import { JobQueue } from "../../src/jobs/queue.ts";
import { Worker } from "../../src/jobs/worker.ts";
import type { JobHandler } from "../../src/jobs/worker.ts";
import { Counters } from "../../src/metrics/counters.ts";
import { HttpCache } from "../../src/http/cache.ts";
import { DomainThrottle } from "../../src/http/throttle.ts";
import { HttpClient, buildUserAgent } from "../../src/http/client.ts";
import { Logger } from "../../src/log.ts";
import { creerHandlersDecouverte } from "../../src/decouverte/index.ts";
import { cleDecouverte } from "../../src/decouverte/contexte.ts";
import type { ContexteDecouverte } from "../../src/decouverte/contexte.ts";

const [, , dbFile, cacheDir, origine, killApresRaw, killApresMsRaw, leaseMsRaw, concurrenceRaw, campagne] =
  process.argv;

const killApres = Number(killApresRaw ?? "-1");
const killApresMs = Number(killApresMsRaw ?? "-1");
const leaseMs = Number(leaseMsRaw ?? "1000");
const concurrence = Number(concurrenceRaw ?? "4");

const db = openDatabase(dbFile as string);
const counters = new Counters(db);
const queue = new JobQueue(db, undefined, counters);

const ctx: ContexteDecouverte = {
  db,
  client: new HttpClient({
    cache: new HttpCache(cacheDir as string),
    // Le plancher reel de 2 s est couvert par test/http/throttle.test.ts. L'imposer ici
    // rendrait le test de reprise plus long qu'un run reel, pour la meme garantie.
    throttle: new DomainThrottle({ minDelayMs: 1, lookup: async () => ({ address: "127.0.0.1", family: 4 }) }),
    counters,
    userAgent: buildUserAgent("0.1.0", "https://exemple.example/contact"),
    cacheTtlMs: 3_600_000,
  }),
  counters,
  clock: { now: () => Date.now() },
  logger: new Logger({ console: false }),
  queue,
  runId: null,
};

const handlers = creerHandlersDecouverte(ctx);
let pagesTraitees = 0;

/**
 * Enveloppe le handler de page pour mourir entre le travail asynchrone et la
 * persistance : c'est la fenetre ou un effet peut etre perdu ou rejoue.
 */
const pageAvecMort: JobHandler = async (job, jobCtx) => {
  const resultat = await (handlers["page_crawl"] as JobHandler)(job, jobCtx);
  pagesTraitees += 1;
  if (killApres >= 0 && pagesTraitees >= killApres) {
    process.kill(process.pid, "SIGKILL");
    await new Promise(() => {});
  }
  return resultat;
};

queue.enqueue("decouverte_planifiee", cleDecouverte("35", campagne as string), {
  departement: "35",
  campagne,
  maxPages: 10,
  avecMobiles: false,
});

const worker = new Worker(
  queue,
  { ...handlers, page_crawl: pageAvecMort },
  { concurrency: concurrence, leaseDurationMs: leaseMs, stopWhenDrained: true },
);

if (killApresMs >= 0) {
  // Mort a un instant arbitraire : tombe n'importe ou, transaction SQLite comprise.
  setTimeout(() => {
    process.kill(process.pid, "SIGKILL");
  }, killApresMs).unref();
}

const stats = await worker.run();
db.close();
process.stdout.write(`${JSON.stringify(stats)}\n`);

// L'origine est reprise ici pour qu'une fixture lancee sans serveur echoue vite et
// clairement, plutot que de crawler une URL vide.
if (origine === undefined || origine === "") process.exitCode = 3;
