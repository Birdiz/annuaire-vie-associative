import type { Database } from "../db/index.ts";
import { transaction } from "../db/index.ts";
import type { Job, JobQueue } from "./queue.ts";

/**
 * Ce qu'un handler rend au worker.
 *
 * Le travail asynchrone (requete HTTP, lecture de fichier) se fait dans le handler,
 * hors de toute transaction. La persistance du resultat est rendue sous forme de
 * fonction synchrone `commit`, que le worker execute dans la meme transaction que la
 * completion du job. C'est ce qui rend l'effet exactement-une-fois : soit l'effet et
 * la completion sont commites ensemble, soit ni l'un ni l'autre et le job est repris.
 *
 * Le handler ne doit donc jamais ecrire en base lui-meme.
 */
export type JobOutcome =
  | { kind: "done"; commit?: (db: Database) => void }
  | { kind: "skipped"; reason: string };

export type JobContext = {
  /** Annule quand un arret est demande. A propager a tout appel reseau. */
  signal: AbortSignal;
};

export type JobHandler = (job: Job, ctx: JobContext) => Promise<JobOutcome>;

export type WorkerOptions = {
  concurrency: number;
  leaseDurationMs?: number;
  idlePollMs?: number;
  /** Termine quand la file est vide. Vrai pour un run ponctuel, faux pour un service. */
  stopWhenDrained?: boolean;
};

export type WorkerStats = {
  done: number;
  skipped: number;
  failed: number;
  released: number;
};

const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_IDLE_POLL_MS = 250;

export class Worker {
  readonly #queue: JobQueue;
  readonly #handlers: Readonly<Record<string, JobHandler>>;
  /** Types que ce worker sait traiter. La file ne lui proposera rien d'autre. */
  readonly #types: readonly string[];
  readonly #concurrency: number;
  readonly #leaseMs: number;
  readonly #idlePollMs: number;
  readonly #stopWhenDrained: boolean;

  constructor(queue: JobQueue, handlers: Readonly<Record<string, JobHandler>>, options: WorkerOptions) {
    this.#queue = queue;
    this.#handlers = handlers;
    this.#types = Object.keys(handlers);
    this.#concurrency = Math.max(1, options.concurrency);
    this.#leaseMs = options.leaseDurationMs ?? DEFAULT_LEASE_MS;
    this.#idlePollMs = options.idlePollMs ?? DEFAULT_IDLE_POLL_MS;
    this.#stopWhenDrained = options.stopWhenDrained ?? true;
  }

  /**
   * Traite la file jusqu'a epuisement ou jusqu'a l'annulation du signal.
   *
   * A l'arret : on cesse de prendre de nouveaux jobs, on laisse finir ceux en cours.
   * Ceux qui abandonnent parce qu'ils observent le signal sont relaches, pas mis en
   * echec.
   */
  async run(signal: AbortSignal = new AbortController().signal): Promise<WorkerStats> {
    const stats: WorkerStats = { done: 0, skipped: 0, failed: 0, released: 0 };
    const inFlight = new Set<Promise<void>>();

    while (true) {
      let leasedThisTurn = 0;
      while (!signal.aborted && inFlight.size < this.#concurrency) {
        const job = this.#queue.lease(this.#leaseMs, this.#types);
        if (job === undefined) break;
        leasedThisTurn += 1;
        const promise = this.#process(job, signal, stats).finally(() => {
          inFlight.delete(promise);
        });
        inFlight.add(promise);
      }

      if (inFlight.size > 0) {
        await Promise.race(inFlight);
        continue;
      }

      if (signal.aborted) break;
      if (leasedThisTurn === 0) {
        if (this.#stopWhenDrained) break;
        await sleep(this.#idlePollMs, signal);
      }
    }

    await Promise.allSettled(inFlight);
    return stats;
  }

  /** Ne rejette jamais : un job en echec est une donnee, pas une exception du worker. */
  async #process(job: Job, signal: AbortSignal, stats: WorkerStats): Promise<void> {
    const handler = this.#handlers[job.type];
    if (handler === undefined) {
      // Inatteignable depuis `run` : la file filtre desormais sur `#types`. Reste comme
      // garde pour un appelant qui prendrait un job lui-meme, sans passer par le worker.
      this.#queue.fail(job.id, new Error(`Type de job inconnu : ${job.type}`));
      stats.failed += 1;
      return;
    }

    // Un job plus long que son bail serait repris en parallele par un autre worker.
    // Le renouvellement periodique evite ce doublon sans allonger le bail pour tous.
    const renewal = setInterval(() => {
      this.#queue.renew(job.id, this.#leaseMs);
    }, Math.max(1_000, Math.floor(this.#leaseMs / 2)));
    renewal.unref();

    try {
      const outcome = await handler(job, { signal });
      if (outcome.kind === "skipped") {
        this.#queue.skip(job.id, outcome.reason);
        stats.skipped += 1;
      } else {
        transaction(this.#queue.db, () => {
          outcome.commit?.(this.#queue.db);
          this.#queue.complete(job.id);
        });
        stats.done += 1;
      }
    } catch (error) {
      if (signal.aborted && isAbortError(error)) {
        this.#queue.release(job.id);
        stats.released += 1;
      } else {
        this.#queue.fail(job.id, error);
        stats.failed += 1;
      }
    } finally {
      clearInterval(renewal);
    }
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}

/**
 * Arret propre sur SIGINT/SIGTERM. Un second signal force la sortie : sans cela un
 * handler bloque rendrait le process impossible a arreter au clavier.
 */
export function installShutdownHandlers(onFirstSignal?: () => void): AbortController {
  const controller = new AbortController();
  let received = 0;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      received += 1;
      if (received === 1) {
        onFirstSignal?.();
        controller.abort();
        return;
      }
      process.exit(130);
    });
  }
  return controller;
}
