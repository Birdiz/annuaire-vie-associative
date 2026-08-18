/**
 * Horloge injectable.
 *
 * Tout ce qui depend du temps (bail de job, backoff, TTL de cache, purge a 3 ans)
 * passe par une horloge explicite. Sans cela, ces comportements ne sont testables
 * qu'en faisant attendre la suite de tests, ou pas testables du tout aux bornes.
 */

export type Clock = {
  /** Millisecondes depuis l'epoch. */
  now(): number;
};

export const systemClock: Clock = {
  now: () => Date.now(),
};

/** Horloge de test : avance uniquement sur commande. */
export function fixedClock(startMs: number): Clock & { advance(ms: number): void } {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

/**
 * Format d'horodatage retenu partout en base : ISO-8601 en UTC.
 * Comparable lexicographiquement, ce qui permet les filtres de purge et de bail
 * directement en SQL, et reste lisible a l'oeil dans le fichier SQLite.
 */
export function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

export function fromIso(iso: string): number {
  return Date.parse(iso);
}
