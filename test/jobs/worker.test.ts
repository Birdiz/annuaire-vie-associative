import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { openDatabase } from "../../src/db/index.ts";
import { JobQueue, backoffMs } from "../../src/jobs/queue.ts";
import { Worker } from "../../src/jobs/worker.ts";
import type { JobOutcome } from "../../src/jobs/worker.ts";
import { fixedClock } from "../../src/clock.ts";
import { makeTempDir } from "../helpers/tmp.ts";

const T0 = Date.parse("2026-08-17T10:00:00.000Z");

function setup(t: TestContext) {
  const db = openDatabase(join(makeTempDir(t), "test.sqlite"));
  t.after(() => db.close());
  db.exec("CREATE TABLE effet (id INTEGER PRIMARY KEY, cle TEXT NOT NULL UNIQUE) STRICT");
  const clock = fixedClock(T0);
  return { db, clock, queue: new JobQueue(db, clock) };
}

test("le worker draine la file et persiste les effets", async (t) => {
  const { db, queue } = setup(t);
  for (let i = 0; i < 5; i += 1) queue.enqueue("travail", `j${i}`, { cle: `cle-${i}` });

  const worker = new Worker(
    queue,
    {
      async travail(job): Promise<JobOutcome> {
        const cle = (job.payload as { cle: string }).cle;
        return {
          kind: "done",
          commit: (database) => {
            database.prepare("INSERT INTO effet (cle) VALUES (?)").run(cle);
          },
        };
      },
    },
    { concurrency: 2 },
  );

  const stats = await worker.run();

  assert.deepEqual(stats, { done: 5, skipped: 0, failed: 0, released: 0 });
  assert.equal((db.prepare("SELECT count(*) AS n FROM effet").get() as { n: number }).n, 5);
  assert.equal(queue.counts().done, 5);
});

test("un handler qui echoue laisse l'effet non ecrit", async (t) => {
  const { db, queue, clock } = setup(t);
  queue.enqueue("travail", "j", { cle: "unique" }, { maxAttempts: 2 });

  const worker = new Worker(
    queue,
    {
      travail(): Promise<JobOutcome> {
        return Promise.reject(new Error("le site ne repond pas"));
      },
    },
    { concurrency: 1 },
  );

  assert.equal((await worker.run()).failed, 1);
  assert.equal((db.prepare("SELECT count(*) AS n FROM effet").get() as { n: number }).n, 0);
  assert.equal(queue.counts().pending, 1);

  clock.advance(backoffMs(1));
  assert.equal((await worker.run()).failed, 1);

  assert.equal(queue.counts().dead, 1);
  assert.match(queue.list("dead")[0]?.lastError ?? "", /ne repond pas/);
});

test("un type de job sans handler est laisse en attente, pas mis en echec", async (t) => {
  const { queue } = setup(t);
  queue.enqueue("inconnu", "j", null, { maxAttempts: 1 });

  const stats = await new Worker(queue, {}, { concurrency: 1 }).run();

  // Ce test disait l'inverse jusqu'au lot 4, et c'etait une erreur. Le raisonnement
  // — « un job que personne ne sait traiter ne doit pas dormir dans la file » — ne
  // tient pas dans une conception ou la file est deliberement partagee par deux
  // passes aux handlers distincts : l'amorce, puis la decouverte. Mettre en echec ce
  // qu'on ne reconnait pas revenait a faire tuer les jobs de l'autre passe.
  assert.equal(stats.failed, 0);
  assert.equal(queue.counts().dead, 0);
  assert.equal(queue.counts().pending, 1);

  // Un job qu'aucun worker ne reclame reste visible dans `annuaire status` et
  // `annuaire jobs --state pending`. C'est une anomalie qu'on constate, plutot qu'une
  // disparition silencieuse qu'on ne constate jamais.
  assert.equal(queue.list("pending")[0]?.attempts, 0);
});

test("un resultat ecarte enregistre son motif sans effet", async (t) => {
  const { db, queue } = setup(t);
  queue.enqueue("travail", "j", null);

  const stats = await new Worker(
    queue,
    { travail: () => Promise.resolve<JobOutcome>({ kind: "skipped", reason: "robots.txt" }) },
    { concurrency: 1 },
  ).run();

  assert.equal(stats.skipped, 1);
  assert.equal((db.prepare("SELECT count(*) AS n FROM effet").get() as { n: number }).n, 0);
  assert.equal(queue.list("skipped")[0]?.reason, "robots.txt");
});

test("a l'arret, les jobs en vol sont relaches sans consommer de tentative", async (t) => {
  const { queue } = setup(t);
  queue.enqueue("travail", "j", null);

  const controller = new AbortController();
  const worker = new Worker(
    queue,
    {
      travail(_job, ctx): Promise<JobOutcome> {
        return new Promise((_resolve, reject) => {
          ctx.signal.addEventListener(
            "abort",
            () => {
              const error = new Error("interrompu");
              error.name = "AbortError";
              reject(error);
            },
            { once: true },
          );
          queueMicrotask(() => controller.abort());
        });
      },
    },
    { concurrency: 1 },
  );

  const stats = await worker.run(controller.signal);

  assert.deepEqual(stats, { done: 0, skipped: 0, failed: 0, released: 1 });
  assert.equal(queue.counts().pending, 1);
  assert.equal(queue.list("pending")[0]?.attempts, 0, "la tentative doit avoir ete rendue");
});

test("l'effet et la completion sont commites ensemble", async (t) => {
  const { db, queue } = setup(t);
  queue.enqueue("travail", "j", null, { maxAttempts: 1 });

  // L'ecriture de l'effet echoue au moment du commit : ni l'effet, ni la completion.
  const stats = await new Worker(
    queue,
    {
      travail: () =>
        Promise.resolve<JobOutcome>({
          kind: "done",
          commit: (database) => {
            database.prepare("INSERT INTO effet (cle) VALUES (?)").run("doublon");
            database.prepare("INSERT INTO effet (cle) VALUES (?)").run("doublon");
          },
        }),
    },
    { concurrency: 1 },
  ).run();

  assert.equal(stats.failed, 1);
  assert.equal((db.prepare("SELECT count(*) AS n FROM effet").get() as { n: number }).n, 0);
  assert.equal(queue.counts().done, 0);
  assert.equal(queue.counts().dead, 1);
});

test("un worker ne touche pas aux jobs qu'il ne sait pas traiter", async (t) => {
  const { db, queue } = setup(t);
  queue.enqueue("amorce", "amorce:35", { cle: "amorce" });
  // Ce que la decouverte interrompue avait laisse derriere elle.
  queue.enqueue("page_crawl", "page:1", { cle: "p1" });
  queue.enqueue("page_crawl", "page:2", { cle: "p2" });

  const worker = new Worker(
    queue,
    {
      async amorce(job): Promise<JobOutcome> {
        const cle = (job.payload as { cle: string }).cle;
        return {
          kind: "done",
          commit: (database) => {
            database.prepare("INSERT INTO effet (cle) VALUES (?)").run(cle);
          },
        };
      },
    },
    { concurrency: 2 },
  );

  const stats = await worker.run();
  assert.equal(stats.done, 1);
  assert.equal(stats.failed, 0, "les jobs d'un autre type ne sont pas des echecs");

  // `attempts` est incremente a la prise : un worker qui les prendrait avant de
  // constater qu'il n'a pas de handler aurait deja consomme une vie. C'est ainsi que
  // relancer l'amorce tuait, en cinq passages, les pages restant a explorer.
  const restants = (
    db
      .prepare("SELECT dedup_key, state, attempts FROM job WHERE type = 'page_crawl' ORDER BY dedup_key")
      .all() as unknown as { dedup_key: string; state: string; attempts: number }[]
  ).map((ligne) => ({ dedup_key: ligne.dedup_key, state: ligne.state, attempts: Number(ligne.attempts) }));
  assert.deepEqual(restants, [
    { dedup_key: "page:1", state: "pending", attempts: 0 },
    { dedup_key: "page:2", state: "pending", attempts: 0 },
  ]);
});
