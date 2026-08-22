import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { openDatabase } from "../../src/db/index.ts";
import { JobQueue, backoffMs } from "../../src/jobs/queue.ts";
import { Counters, ETAPE } from "../../src/metrics/counters.ts";
import { fixedClock } from "../../src/clock.ts";
import { makeTempDir } from "../helpers/tmp.ts";

const T0 = Date.parse("2026-08-17T10:00:00.000Z");
const LEASE_MS = 30_000;

function setup(t: TestContext) {
  const db = openDatabase(join(makeTempDir(t), "test.sqlite"));
  t.after(() => db.close());
  const clock = fixedClock(T0);
  const counters = new Counters(db, null);
  return { db, clock, counters, queue: new JobQueue(db, clock, counters) };
}

test("reenqueuer la meme cle de dedup est sans effet", (t) => {
  const { queue } = setup(t);

  assert.equal(queue.enqueue("fetch", "url:a", { url: "a" }), true);
  assert.equal(queue.enqueue("fetch", "url:a", { url: "a" }), false);
  assert.equal(queue.enqueue("fetch", "url:b", { url: "b" }), true);

  assert.equal(queue.counts().pending, 2);
});

test("la prise respecte la priorite puis l'ordre d'insertion", (t) => {
  const { queue } = setup(t);
  queue.enqueue("t", "normal", 1, { priority: 100 });
  queue.enqueue("t", "urgent", 2, { priority: 10 });
  queue.enqueue("t", "normal-2", 3, { priority: 100 });

  assert.equal(queue.lease(LEASE_MS)?.dedupKey, "urgent");
  assert.equal(queue.lease(LEASE_MS)?.dedupKey, "normal");
  assert.equal(queue.lease(LEASE_MS)?.dedupKey, "normal-2");
  assert.equal(queue.lease(LEASE_MS), undefined);
});

test("un job n'est jamais remis deux fois tant que son bail court", (t) => {
  const { queue, clock } = setup(t);
  queue.enqueue("t", "unique", null);

  const first = queue.lease(LEASE_MS);
  assert.ok(first);
  assert.equal(queue.lease(LEASE_MS), undefined);

  clock.advance(LEASE_MS - 1);
  assert.equal(queue.lease(LEASE_MS), undefined, "le bail court encore");
});

test("un bail expire rend le job eligible sans intervention", (t) => {
  const { queue, clock } = setup(t);
  queue.enqueue("t", "unique", null);

  const first = queue.lease(LEASE_MS);
  assert.equal(first?.attempts, 1);

  clock.advance(LEASE_MS + 1);
  const second = queue.lease(LEASE_MS);
  assert.equal(second?.id, first?.id);
  assert.equal(second?.attempts, 2, "la tentative interrompue est comptee");
});

test("renouveler le bail empeche la reprise d'un job long", (t) => {
  const { queue, clock } = setup(t);
  queue.enqueue("t", "long", null);
  const job = queue.lease(LEASE_MS);
  assert.ok(job);

  clock.advance(LEASE_MS - 1);
  assert.equal(queue.renew(job.id, LEASE_MS), true);

  clock.advance(LEASE_MS - 1);
  assert.equal(queue.lease(LEASE_MS), undefined, "le bail renouvele court toujours");
});

test("un echec replanifie avec un backoff croissant", (t) => {
  const { queue, clock } = setup(t);
  queue.enqueue("t", "instable", null, { maxAttempts: 5 });

  const job = queue.lease(LEASE_MS);
  assert.ok(job);
  queue.fail(job.id, new Error("panne reseau"));

  assert.equal(queue.counts().pending, 1);
  assert.equal(queue.lease(LEASE_MS), undefined, "le backoff n'est pas ecoule");

  clock.advance(backoffMs(1));
  assert.equal(queue.lease(LEASE_MS)?.id, job.id);
});

test("le backoff est plafonne", () => {
  assert.equal(backoffMs(1), 1_000);
  assert.equal(backoffMs(2), 2_000);
  assert.equal(backoffMs(3), 4_000);
  assert.equal(backoffMs(50), 5 * 60_000);
});

test("les tentatives epuisees classent le job mort et le comptent", (t) => {
  const { queue, counters } = setup(t);
  queue.enqueue("t", "condamne", null, { maxAttempts: 1 });

  const job = queue.lease(LEASE_MS);
  assert.ok(job);
  queue.fail(job.id, new Error("definitif"));

  assert.equal(queue.counts().dead, 1);
  assert.equal(counters.get(ETAPE.jobs, "dead"), 1);
  assert.equal(queue.list("dead")[0]?.lastError, "definitif");
});

test("un job qui fait tomber le process finit mort, il ne boucle pas", (t) => {
  const { queue, clock } = setup(t);
  queue.enqueue("t", "tueur", null, { maxAttempts: 2 });

  // Deux prises sans completion ni echec : le process disparait a chaque fois.
  for (let i = 0; i < 2; i += 1) {
    assert.ok(queue.lease(LEASE_MS), `prise ${i + 1}`);
    clock.advance(LEASE_MS + 1);
  }

  assert.equal(queue.lease(LEASE_MS), undefined, "la file ne doit plus le proposer");
  assert.equal(queue.counts().dead, 1);
});

test("relacher un bail rend la tentative consommee", (t) => {
  const { queue, counters } = setup(t);
  queue.enqueue("t", "interrompu", null);

  const job = queue.lease(LEASE_MS);
  assert.ok(job);
  assert.equal(job.attempts, 1);

  queue.release(job.id);

  assert.equal(queue.counts().pending, 1);
  assert.equal(counters.get(ETAPE.jobs, "released"), 1);
  assert.equal(queue.lease(LEASE_MS)?.attempts, 1, "l'arret demande n'est pas une tentative");
});

test("un job ecarte conserve son motif", (t) => {
  const { queue } = setup(t);
  queue.enqueue("fetch", "interdit", null);
  const job = queue.lease(LEASE_MS);
  assert.ok(job);

  queue.skip(job.id, "robots.txt: Disallow /associations");

  assert.equal(queue.counts().skipped, 1);
  assert.match(queue.list("skipped")[0]?.reason ?? "", /robots\.txt/);
});

test("un job planifie dans le futur n'est pas pris avant l'heure", (t) => {
  const { queue, clock } = setup(t);
  queue.enqueue("t", "differe", null, { availableAtMs: T0 + 10_000 });

  assert.equal(queue.lease(LEASE_MS), undefined);
  clock.advance(10_000);
  assert.equal(queue.lease(LEASE_MS)?.dedupKey, "differe");
});

test("le payload fait l'aller-retour intact", (t) => {
  const { queue } = setup(t);
  const payload = { url: "https://exemple.fr/a?b=1", profondeur: 2, tags: ["associ", "sport"] };
  queue.enqueue("fetch", "payload", payload);
  assert.deepEqual(queue.lease(LEASE_MS)?.payload, payload);
});

test("la prise peut se restreindre aux types qu'un worker sait traiter", (t) => {
  const { queue } = setup(t);
  queue.enqueue("page_crawl", "page:1", {}, { priority: 1 });
  queue.enqueue("amorce", "amorce:35", {}, { priority: 2 });

  // `page_crawl` est prioritaire, et pourtant il n'est pas propose : la file ne rend
  // que ce que l'appelant a declare savoir traiter.
  assert.equal(queue.lease(LEASE_MS, ["amorce"])?.dedupKey, "amorce:35");
  assert.equal(queue.lease(LEASE_MS, ["amorce"]), undefined);

  // Le job ecarte est intact : ni pris, ni penalise.
  assert.equal(queue.lease(LEASE_MS, ["page_crawl"])?.dedupKey, "page:1");
});

test("un worker sans aucun handler ne prend rien", (t) => {
  const { queue } = setup(t);
  queue.enqueue("travail", "j1", {});
  assert.equal(queue.lease(LEASE_MS, []), undefined);
  assert.equal(queue.lease(LEASE_MS)?.dedupKey, "j1", "et le job reste disponible");
});

test("un job termine se reenfile, ce que la deduplication interdisait", (t) => {
  const { queue } = setup(t);
  queue.enqueue("rna_seed", "rna_waldec:35:2026-08", { departement: "35" });
  const job = queue.lease(LEASE_MS);
  queue.complete(job!.id);

  // La cle porte le mois : reenfiler ne fait rien, et c'est voulu tant que la source
  // n'a pas change. Mais quand c'est le lecteur qui a change — une migration qui lit
  // de nouvelles colonnes du meme fichier — il faut pouvoir dire l'intention.
  assert.equal(queue.enqueue("rna_seed", "rna_waldec:35:2026-08", { departement: "35" }), false);
  assert.equal(queue.lease(LEASE_MS), undefined);

  assert.equal(queue.requeue({ dedupKey: "rna_waldec:35:2026-08" }), 1);
  const repris = queue.lease(LEASE_MS);
  assert.equal(repris?.dedupKey, "rna_waldec:35:2026-08");
  assert.deepEqual(repris?.payload, { departement: "35" }, "le payload d'origine est conserve");
  assert.equal(repris?.attempts, 1, "les tentatives repartent de zero");
});

test("le reenfilement remet a zero les tentatives d'un job mort", (t) => {
  const { queue } = setup(t);
  queue.enqueue("travail", "j", null, { maxAttempts: 1 });
  const job = queue.lease(LEASE_MS);
  queue.fail(job!.id, new Error("panne"));
  assert.equal(queue.counts().dead, 1);

  assert.equal(queue.requeue({ state: "dead" }), 1);
  assert.equal(queue.counts().dead, 0);
  const repris = queue.lease(LEASE_MS);
  assert.equal(repris?.attempts, 1, "sans remise a zero, un job mort le resterait");
  assert.equal(queue.list("pending").length, 0);
});

test("un job en attente ou en vol n'est pas reenfilable", (t) => {
  const { queue } = setup(t);
  queue.enqueue("travail", "attente", null);
  queue.enqueue("travail", "en-vol", null);
  const enVol = queue.lease(LEASE_MS);

  // Doubler un job en vol le ferait executer deux fois ; un job en attente y est deja.
  assert.equal(queue.requeue({ state: "pending" }), 0);
  assert.equal(queue.requeue({ id: enVol!.id }), 0);
  assert.equal(queue.counts().leased, 1);
});

test("le reenfilement d'un job inexistant ne fait rien", (t) => {
  const { queue } = setup(t);
  assert.equal(queue.requeue({ id: 4242 }), 0);
  assert.equal(queue.requeue({ dedupKey: "jamais-vue" }), 0);
});
