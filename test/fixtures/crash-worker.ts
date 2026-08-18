/**
 * Worker jetable utilise par le test de reprise apres `kill -9`.
 *
 * Il traite des jobs `travail` dont l'effet est une ligne dans la table `effet`, sans
 * contrainte d'unicite : c'est l'atomicite « effet + completion dans une transaction »
 * qui doit garantir l'exactement-une-fois, pas la base. Un doublon dans `effet` est
 * donc un vrai echec, pas une erreur d'insertion.
 *
 * Usage : node crash-worker.ts <dbFile> <killApresNJobs|-1> <killApresMs|-1> <leaseMs> <concurrence>
 */
import { openDatabase } from "../../src/db/index.ts";
import { JobQueue } from "../../src/jobs/queue.ts";
import { Worker } from "../../src/jobs/worker.ts";
import type { JobOutcome } from "../../src/jobs/worker.ts";

const [, , dbFile, killAfterJobsRaw, killAfterMsRaw, leaseMsRaw, concurrencyRaw] = process.argv;

const killAfterJobs = Number(killAfterJobsRaw ?? "-1");
const killAfterMs = Number(killAfterMsRaw ?? "-1");
const leaseMs = Number(leaseMsRaw ?? "1000");
const concurrency = Number(concurrencyRaw ?? "4");

const db = openDatabase(dbFile as string);
db.exec("CREATE TABLE IF NOT EXISTS effet (id INTEGER PRIMARY KEY, cle TEXT NOT NULL) STRICT");

const queue = new JobQueue(db);

let handled = 0;

const worker = new Worker(
  queue,
  {
    async travail(job): Promise<JobOutcome> {
      // Un peu de travail asynchrone, comme le ferait une requete HTTP.
      await new Promise((resolve) => setTimeout(resolve, 5));

      handled += 1;
      if (killAfterJobs >= 0 && handled >= killAfterJobs) {
        // Mort brutale entre le travail et la persistance : la fenetre la plus
        // dangereuse. L'effet ne doit pas exister et le job doit etre repris.
        process.kill(process.pid, "SIGKILL");
        await new Promise(() => {});
      }

      const cle = (job.payload as { cle: string }).cle;
      return {
        kind: "done",
        commit: (database) => {
          database.prepare("INSERT INTO effet (cle) VALUES (?)").run(cle);
        },
      };
    },
  },
  { concurrency, leaseDurationMs: leaseMs, stopWhenDrained: true },
);

if (killAfterMs >= 0) {
  // Mort a un instant arbitraire : tombe n'importe ou, y compris pendant une
  // transaction SQLite.
  setTimeout(() => {
    process.kill(process.pid, "SIGKILL");
  }, killAfterMs).unref();
}

const stats = await worker.run();
db.close();
process.stdout.write(`${JSON.stringify(stats)}\n`);
