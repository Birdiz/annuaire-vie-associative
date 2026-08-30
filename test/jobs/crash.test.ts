import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import { openDatabase } from "../../src/db/index.ts";
import { JobQueue } from "../../src/jobs/queue.ts";
import { makeTempDir } from "../helpers/tmp.ts";

const WORKER = fileURLToPath(new URL("../fixtures/crash-worker.ts", import.meta.url));
const NB_JOBS = 20;
const LEASE_MS = 800;
// Le garde-fou anti-reseau vit dans le processus de test ; celui-ci s'execute a part, il
// doit donc le precharger a son tour. La fixture ne sort pas sur le reseau aujourd'hui,
// mais c'est une propriete du moment : rien ne l'empeche d'evoluer, et l'exception
// n'etait ecrite nulle part ou elle aurait ete tenue.
// Une URL `file://`, et non un chemin : `--import` traite son argument comme un
// specifieur de module, et sous Windows un chemin absolu commence par `D:\\`, que
// Node lit comme un schema d'URL inconnu — ERR_UNSUPPORTED_ESM_URL_SCHEME.
const GARDE_RESEAU = new URL("../helpers/pas-de-reseau.ts", import.meta.url).href;

type Run = { code: number | null; signal: NodeJS.Signals | null; stderr: string };

function runWorker(dbFile: string, killAfterJobs: number, killAfterMs: number): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", GARDE_RESEAU, WORKER, dbFile, String(killAfterJobs), String(killAfterMs), String(LEASE_MS), "4"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({ code, signal, stderr });
    });
  });
}

function prepare(t: TestContext): string {
  const dbFile = join(makeTempDir(t), "crash.sqlite");
  const db = openDatabase(dbFile);
  db.exec("CREATE TABLE IF NOT EXISTS effet (id INTEGER PRIMARY KEY, cle TEXT NOT NULL) STRICT");

  const queue = new JobQueue(db);
  for (let i = 0; i < NB_JOBS; i += 1) {
    queue.enqueue("travail", `travail:${i}`, { cle: `cle-${i}` }, { maxAttempts: 20 });
  }
  db.close();
  return dbFile;
}

/** Verifie que chaque job a produit son effet exactement une fois. */
function assertExactementUneFois(dbFile: string): void {
  const db = openDatabase(dbFile);
  try {
    const doublons = db
      .prepare("SELECT cle, count(*) AS n FROM effet GROUP BY cle HAVING n > 1")
      .all() as { cle: string; n: number }[];
    assert.deepEqual(doublons, [], "des effets ont ete rejoues");

    const distincts = db.prepare("SELECT count(DISTINCT cle) AS n FROM effet").get() as { n: number };
    assert.equal(distincts.n, NB_JOBS, "des effets ont ete perdus");

    const restants = db
      .prepare("SELECT state, count(*) AS n FROM job WHERE state <> 'done' GROUP BY state")
      .all();
    assert.deepEqual(restants, [], "des jobs ne sont pas termines");
  } finally {
    db.close();
  }
}

test("reprise apres kill -9 entre le travail et la persistance", { timeout: 60_000 }, async (t) => {
  const dbFile = prepare(t);

  const tue = await runWorker(dbFile, 3, -1);
  assert.equal(tue.signal, "SIGKILL", `le worker aurait du etre tue brutalement : ${tue.stderr}`);

  // Rien n'est perdu, mais les baux des jobs en vol doivent expirer avant reprise :
  // c'est le prix de l'absence d'etat « running » (ADR-002).
  await new Promise((resolve) => setTimeout(resolve, LEASE_MS + 200));

  const reprise = await runWorker(dbFile, -1, -1);
  assert.equal(reprise.code, 0, reprise.stderr);

  assertExactementUneFois(dbFile);
});

test("reprise apres kill -9 a un instant arbitraire", { timeout: 60_000 }, async (t) => {
  const dbFile = prepare(t);

  const tue = await runWorker(dbFile, -1, 25);
  assert.equal(tue.signal, "SIGKILL", `le worker aurait du etre tue brutalement : ${tue.stderr}`);

  await new Promise((resolve) => setTimeout(resolve, LEASE_MS + 200));

  const reprise = await runWorker(dbFile, -1, -1);
  assert.equal(reprise.code, 0, reprise.stderr);

  assertExactementUneFois(dbFile);
});

test("relancer un worker sur une file deja drainee ne refait rien", { timeout: 60_000 }, async (t) => {
  const dbFile = prepare(t);

  assert.equal((await runWorker(dbFile, -1, -1)).code, 0);
  assertExactementUneFois(dbFile);

  assert.equal((await runWorker(dbFile, -1, -1)).code, 0);
  assertExactementUneFois(dbFile);
});
