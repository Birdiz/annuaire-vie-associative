import { RETENTION_YEARS } from "./invariants.ts";
import type { Database } from "./db/index.ts";
import { transaction } from "./db/index.ts";
import type { Clock } from "./clock.ts";
import { systemClock, toIso } from "./clock.ts";
import { Counters, ETAPE } from "./metrics/counters.ts";
import type { HttpCache } from "./http/cache.ts";

/**
 * Purge des donnees de plus de trois ans (§4.8), executee au demarrage.
 *
 * Aucune option ne permet de la sauter : il n'y a ni drapeau `--no-purge`, ni cle de
 * configuration. C'est ce qui la rend fiable.
 *
 * Ce qui est purge : les contacts et les pages, c'est-a-dire ce que l'outil a
 * collecte, ainsi que le HTML brut correspondant dans le cache — ce dernier contient
 * exactement les memes donnees personnelles que la base, et le laisser derriere
 * viderait la purge de son sens. Les runs anciens partent avec, entrainant leurs jobs
 * et leurs metriques.
 *
 * Ce qui n'est pas purge : `commune` et `association`, qui proviennent de donnees
 * ouvertes (RNA, Annuaire de l'administration) et ne sont pas des donnees collectees.
 * Elles sont rafraichies en rejouant l'amorce.
 */

export type PurgeResult = {
  contacts: number;
  pages: number;
  runs: number;
  entreesCache: number;
  cutoff: string;
};

export function cutoffFor(nowMs: number, years: number = RETENTION_YEARS): number {
  const date = new Date(nowMs);
  date.setUTCFullYear(date.getUTCFullYear() - years);
  return date.getTime();
}

export function purge(
  db: Database,
  cache: HttpCache | undefined,
  clock: Clock = systemClock,
  counters: Counters = new Counters(db, null),
): PurgeResult {
  const cutoffMs = cutoffFor(clock.now());
  const cutoff = toIso(cutoffMs);

  const result = transaction(db, () => {
    const contacts = db.prepare("DELETE FROM contact WHERE collected_at < ?").run(cutoff).changes;
    // Une page planifiee mais jamais visitee n'a pas de fetched_at : s'en tenir a
    // cette colonne la rendrait immortelle, et elle consommerait le budget de sa
    // commune pour toujours apres un arret brutal.
    const pages = db
      .prepare(
        "DELETE FROM page WHERE coalesce(fetched_at, planifiee_at) IS NOT NULL" +
          " AND coalesce(fetched_at, planifiee_at) < ?",
      )
      .run(cutoff).changes;
    const runs = db.prepare("DELETE FROM run WHERE started_at < ?").run(cutoff).changes;

    counters.inc(ETAPE.purge, "contacts_supprimes", Number(contacts));
    counters.inc(ETAPE.purge, "pages_supprimees", Number(pages));
    counters.inc(ETAPE.purge, "runs_supprimes", Number(runs));

    return { contacts: Number(contacts), pages: Number(pages), runs: Number(runs) };
  });

  // Le nettoyage du cache est un effet de systeme de fichiers : il ne peut pas tenir
  // dans la transaction ci-dessus. En cas d'interruption entre les deux, la purge du
  // demarrage suivant reprend le travail — elle est idempotente par construction.
  let entreesCache = 0;
  if (cache !== undefined) {
    entreesCache = cache.pruneOlderThan(cutoffMs);
    if (entreesCache > 0) {
      transaction(db, () => {
        counters.inc(ETAPE.purge, "entrees_cache_supprimees", entreesCache);
      });
    }
  }

  return { ...result, entreesCache, cutoff };
}
