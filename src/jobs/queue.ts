import type { Database } from "../db/index.ts";
import { transaction } from "../db/index.ts";
import type { Clock } from "../clock.ts";
import { systemClock, toIso } from "../clock.ts";
import { Counters, ETAPE } from "../metrics/counters.ts";

export type JobState = "pending" | "leased" | "done" | "failed" | "dead" | "skipped";

export type Job = {
  id: number;
  runId: number | null;
  type: string;
  dedupKey: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
};

export type EnqueueOptions = {
  runId?: number | null;
  priority?: number;
  maxAttempts?: number;
  /** Retarde la premiere prise. Sert au replanification manuelle, pas au backoff. */
  availableAtMs?: number;
};

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_PRIORITY = 100;

/** Backoff exponentiel plafonne, sans alea : un backoff deterministe est testable. */
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 5 * 60_000;

export function backoffMs(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(BACKOFF_BASE_MS * 2 ** exponent, BACKOFF_MAX_MS);
}

type JobRow = {
  id: number;
  run_id: number | null;
  type: string;
  dedup_key: string;
  payload: string;
  attempts: number;
  max_attempts: number;
};

/**
 * File de jobs persistee dans SQLite.
 *
 * Le point de conception central : il n'existe pas d'etat « running ». Un job pris est
 * `leased` avec une date d'expiration. Apres un `kill -9`, le bail expire de lui-meme
 * et le job redevient eligible — aucun nettoyage au demarrage, aucune intervention.
 * Voir ADR-002.
 */
export class JobQueue {
  readonly #db: Database;
  readonly #clock: Clock;
  readonly #counters: Counters;

  constructor(db: Database, clock: Clock = systemClock, counters?: Counters) {
    this.#db = db;
    this.#clock = clock;
    this.#counters = counters ?? new Counters(db, null);
  }

  get db(): Database {
    return this.#db;
  }

  /**
   * Renvoie `true` si le job a ete cree, `false` s'il existait deja.
   *
   * `dedup_key` est UNIQUE et l'insertion est un `INSERT OR IGNORE` : reenqueuer est
   * sans effet. C'est ce qui autorise les etapes amont a reemettre librement leurs
   * jobs apres une reprise, sans tenir elles-memes le compte de ce qu'elles ont deja
   * produit.
   */
  enqueue(type: string, dedupKey: string, payload: unknown, options: EnqueueOptions = {}): boolean {
    const now = this.#clock.now();
    const nowIso = toIso(now);
    const info = this.#db
      .prepare(
        `INSERT OR IGNORE INTO job
           (run_id, type, dedup_key, payload, state, priority, attempts, max_attempts,
            available_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', ?, 0, ?, ?, ?, ?)`,
      )
      .run(
        options.runId ?? null,
        type,
        dedupKey,
        JSON.stringify(payload ?? null),
        options.priority ?? DEFAULT_PRIORITY,
        options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
        toIso(options.availableAtMs ?? now),
        nowIso,
        nowIso,
      );
    const created = info.changes > 0;
    if (created) this.#counters.inc(ETAPE.jobs, "enqueued");
    return created;
  }

  /**
   * Prend le prochain job eligible et pose un bail dessus.
   *
   * La selection et la prise sont une seule instruction : deux workers ne peuvent pas
   * obtenir le meme job, meme si l'un d'eux est interrompu entre les deux.
   *
   * `attempts` est incremente a la prise, pas a l'echec. Un job qui fait tomber le
   * process consomme donc une tentative : sans cela, un job qui provoque un crash
   * serait repris indefiniment et bloquerait la file a chaque redemarrage.
   *
   * C'est aussi pourquoi `types` existe. La file est partagee par des workers qui
   * n'ont pas les memes handlers — l'amorce et la decouverte tournent en deux passes
   * distinctes (cf. `commandeRun`). Un worker qui prendrait un job d'un type qu'il ne
   * sait pas traiter aurait deja consomme une tentative au moment de s'en apercevoir :
   * relancer l'amorce tuait ainsi, par tranches de cinq passages, les pages qu'une
   * decouverte interrompue avait laissees en attente. Le filtre est donc pose ici, a
   * la prise, et non dans le worker : c'est le seul endroit ou il arrive a temps.
   */
  lease(leaseDurationMs: number, types?: readonly string[]): Job | undefined {
    // Un worker sans handler ne peut rien prendre. `IN ()` n'est pas du SQL valide,
    // et le cas se produit des qu'on instancie un worker vide.
    if (types !== undefined && types.length === 0) return undefined;

    const now = this.#clock.now();
    const nowIso = toIso(now);

    this.#reapExhausted(nowIso);

    const filtreType = types === undefined ? "" : `AND type IN (${types.map(() => "?").join(", ")})`;

    const row = this.#db
      .prepare(
        `UPDATE job
            SET state = 'leased',
                lease_expires_at = ?,
                attempts = attempts + 1,
                updated_at = ?
          WHERE id = (
            SELECT id FROM job
             WHERE ((state = 'pending' AND available_at <= ?)
                 OR (state = 'leased' AND lease_expires_at <= ?))
               AND attempts < max_attempts
               ${filtreType}
             ORDER BY priority, id
             LIMIT 1
          )
      RETURNING id, run_id, type, dedup_key, payload, attempts, max_attempts`,
      )
      .get(toIso(now + leaseDurationMs), nowIso, nowIso, nowIso, ...(types ?? [])) as JobRow | undefined;

    if (row === undefined) return undefined;
    return toJob(row);
  }

  /** A appeler pour un job long, sans quoi son bail expire et il est repris en double. */
  renew(jobId: number, leaseDurationMs: number): boolean {
    const now = this.#clock.now();
    const info = this.#db
      .prepare(
        "UPDATE job SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND state = 'leased'",
      )
      .run(toIso(now + leaseDurationMs), toIso(now), jobId);
    return info.changes > 0;
  }

  /**
   * Marque le job termine. Destine a etre appele dans la meme transaction que la
   * persistance de son effet — c'est cette atomicite qui donne l'exactement-une-fois.
   */
  complete(jobId: number): void {
    this.#db
      .prepare(
        "UPDATE job SET state = 'done', lease_expires_at = NULL, updated_at = ? WHERE id = ?",
      )
      .run(toIso(this.#clock.now()), jobId);
    this.#counters.inc(ETAPE.jobs, "done");
  }

  /** Ecarte volontairement (robots.txt, hors perimetre). Le motif est conserve. */
  skip(jobId: number, reason: string): void {
    this.#db
      .prepare(
        "UPDATE job SET state = 'skipped', reason = ?, lease_expires_at = NULL, updated_at = ? WHERE id = ?",
      )
      .run(reason, toIso(this.#clock.now()), jobId);
    this.#counters.inc(ETAPE.jobs, "skipped");
  }

  /**
   * Replanifie apres echec, ou classe le job mort si les tentatives sont epuisees.
   * Un job mort reste visible dans les metriques : un echec ne disparait jamais.
   */
  fail(jobId: number, error: unknown): void {
    const now = this.#clock.now();
    const row = this.#db
      .prepare("SELECT attempts, max_attempts FROM job WHERE id = ?")
      .get(jobId) as { attempts: number; max_attempts: number } | undefined;
    if (row === undefined) return;

    const message = error instanceof Error ? error.message : String(error);

    if (row.attempts >= row.max_attempts) {
      this.#db
        .prepare(
          "UPDATE job SET state = 'dead', last_error = ?, lease_expires_at = NULL, updated_at = ? WHERE id = ?",
        )
        .run(message, toIso(now), jobId);
      this.#counters.inc(ETAPE.jobs, "dead");
      return;
    }

    this.#db
      .prepare(
        `UPDATE job SET state = 'pending', last_error = ?, available_at = ?,
                        lease_expires_at = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(message, toIso(now + backoffMs(row.attempts)), toIso(now), jobId);
    this.#counters.inc(ETAPE.jobs, "retried");
  }

  /**
   * Relache immediatement un bail, pour un arret propre plutot qu'une expiration.
   *
   * La tentative consommee a la prise est rendue : un arret demande par l'utilisateur
   * n'est pas un echec du job, et ne doit pas le rapprocher de l'etat mort.
   */
  release(jobId: number): void {
    this.#db
      .prepare(
        `UPDATE job SET state = 'pending', lease_expires_at = NULL,
                        attempts = max(0, attempts - 1), updated_at = ?
          WHERE id = ? AND state = 'leased'`,
      )
      .run(toIso(this.#clock.now()), jobId);
    this.#counters.inc(ETAPE.jobs, "released");
  }

  /**
   * Remet en attente un job deja termine, ecarte ou mort.
   *
   * Les cles de deduplication portent une periode — le jour pour l'Annuaire, le mois
   * pour le RNA — et `enqueue` est un `INSERT OR IGNORE`. C'est ce qui empeche de
   * retelecharger un dump inchange, et c'est voulu. Mais la cle raisonne sur la
   * **source**, jamais sur le **lecteur** : quand une migration ajoute des colonnes
   * lues dans le meme fichier, la source n'a pas bouge et le travail est pourtant a
   * refaire. De meme, un job `skipped` sur une indisponibilite passagere reste ecarte
   * jusqu'a la fin de sa periode, alors que le reessai serait legitime des la minute
   * suivante.
   *
   * Sans cette methode, le seul recours etait d'ouvrir la base au SQL. La deduplication
   * a raison sur les donnees et tort sur l'intention : il faut donc pouvoir dire
   * l'intention, pas contourner la regle.
   *
   * Un job `pending` est deja en file et un job `leased` est en vol : ni l'un ni l'autre
   * n'est concerne, les toucher dupliquerait un travail en cours.
   */
  requeue(selecteur: { id: number } | { dedupKey: string } | { state: JobState }): number {
    const nowIso = toIso(this.#clock.now());

    const [condition, valeur] =
      "id" in selecteur
        ? ["id = ?", selecteur.id]
        : "dedupKey" in selecteur
          ? ["dedup_key = ?", selecteur.dedupKey]
          : ["state = ?", selecteur.state];

    const info = this.#db
      .prepare(
        `UPDATE job
            SET state = 'pending',
                attempts = 0,
                last_error = NULL,
                reason = NULL,
                lease_expires_at = NULL,
                available_at = ?,
                updated_at = ?
          WHERE state IN ('done', 'failed', 'dead', 'skipped')
            AND ${condition}`,
      )
      .run(nowIso, nowIso, valeur);

    return Number(info.changes);
  }

  counts(): Record<JobState, number> {
    const rows = this.#db.prepare("SELECT state, count(*) AS n FROM job GROUP BY state").all() as {
      state: JobState;
      n: number;
    }[];
    const out: Record<JobState, number> = {
      pending: 0,
      leased: 0,
      done: 0,
      failed: 0,
      dead: 0,
      skipped: 0,
    };
    for (const row of rows) out[row.state] = row.n;
    return out;
  }

  list(state: JobState, limit = 50): (Job & { lastError: string | null; reason: string | null })[] {
    const rows = this.#db
      .prepare(
        `SELECT id, run_id, type, dedup_key, payload, attempts, max_attempts, last_error, reason
           FROM job WHERE state = ? ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(state, limit) as (JobRow & { last_error: string | null; reason: string | null })[];
    return rows.map((row) => ({
      ...toJob(row),
      lastError: row.last_error,
      reason: row.reason,
    }));
  }

  /**
   * Un job dont les tentatives sont epuisees et dont le bail a expire ne sera jamais
   * repris : sans ce balayage il resterait `leased` pour toujours, invisible dans les
   * compteurs d'echec.
   */
  #reapExhausted(nowIso: string): void {
    const info = this.#db
      .prepare(
        `UPDATE job
            SET state = 'dead',
                lease_expires_at = NULL,
                last_error = coalesce(last_error, 'tentatives epuisees'),
                updated_at = ?
          WHERE ((state = 'pending' AND available_at <= ?)
              OR (state = 'leased' AND lease_expires_at <= ?))
            AND attempts >= max_attempts`,
      )
      .run(nowIso, nowIso, nowIso);
    if (info.changes > 0) this.#counters.inc(ETAPE.jobs, "dead", Number(info.changes));
  }
}

function toJob(row: JobRow): Job {
  return {
    id: row.id,
    runId: row.run_id,
    type: row.type,
    dedupKey: row.dedup_key,
    payload: JSON.parse(row.payload) as unknown,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
  };
}

/** Raccourci : persister l'effet d'un job et sa completion dans une seule transaction. */
export function commitJob(queue: JobQueue, jobId: number, effect: () => void): void {
  transaction(queue.db, () => {
    effect();
    queue.complete(jobId);
  });
}
