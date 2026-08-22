import type { Database } from "../db/index.ts";

/**
 * Compteurs du §8.
 *
 * `inc` est deliberement synchrone et sans transaction propre : l'appelant doit
 * l'invoquer a l'interieur de la transaction qui persiste l'effet mesure. Un compteur
 * commite separement de son effet ment des le premier crash, et ces compteurs sont ce
 * qui fera le README — ils n'ont de valeur que s'ils sont exacts apres reprise.
 */
export class Counters {
  readonly #db: Database;
  readonly #runId: number | null;

  constructor(db: Database, runId: number | null = null) {
    this.#db = db;
    this.#runId = runId;
  }

  /** Compteurs rattaches a un run donne (ou globaux si le run est nul). */
  forRun(runId: number | null): Counters {
    return new Counters(this.#db, runId);
  }

  inc(etape: string, nom: string, delta = 1): void {
    if (delta === 0) return;
    if (this.#runId === null) {
      this.#db
        .prepare(
          `INSERT INTO metric (run_id, etape, nom, valeur) VALUES (NULL, ?, ?, ?)
           ON CONFLICT (etape, nom) WHERE run_id IS NULL
           DO UPDATE SET valeur = valeur + excluded.valeur`,
        )
        .run(etape, nom, delta);
      return;
    }
    this.#db
      .prepare(
        `INSERT INTO metric (run_id, etape, nom, valeur) VALUES (?, ?, ?, ?)
         ON CONFLICT (run_id, etape, nom) WHERE run_id IS NOT NULL
         DO UPDATE SET valeur = valeur + excluded.valeur`,
      )
      .run(this.#runId, etape, nom, delta);
  }

  get(etape: string, nom: string): number {
    const row =
      this.#runId === null
        ? (this.#db
            .prepare("SELECT valeur FROM metric WHERE run_id IS NULL AND etape = ? AND nom = ?")
            .get(etape, nom) as { valeur: number } | undefined)
        : (this.#db
            .prepare("SELECT valeur FROM metric WHERE run_id = ? AND etape = ? AND nom = ?")
            .get(this.#runId, etape, nom) as { valeur: number } | undefined);
    return row?.valeur ?? 0;
  }

  /** Vue arborescente `{ etape: { nom: valeur } }`, format de l'export JSON du §8. */
  snapshot(): Record<string, Record<string, number>> {
    const rows = (
      this.#runId === null
        ? this.#db
            .prepare("SELECT etape, nom, valeur FROM metric WHERE run_id IS NULL ORDER BY etape, nom")
            .all()
        : this.#db
            .prepare("SELECT etape, nom, valeur FROM metric WHERE run_id = ? ORDER BY etape, nom")
            .all(this.#runId)
    ) as { etape: string; nom: string; valeur: number }[];

    const out: Record<string, Record<string, number>> = {};
    for (const row of rows) {
      (out[row.etape] ??= {})[row.nom] = row.valeur;
    }
    return out;
  }
}

/** Noms d'etapes. Alignes sur l'entonnoir du §6, plus l'infrastructure du lot 1. */
export const ETAPE = {
  http: "http",
  jobs: "jobs",
  purge: "purge",
  /** Telechargement des dumps ouverts, en octets et en reprises. */
  dump: "dump",
  /** Etape [2] : resolution de l'URL de mairie. */
  annuaire: "annuaire",
  /** Etape [1] : amorce des associations. */
  rna: "rna",
  /** Etape [3] : parcours des sites de mairie et selection des pages candidates. */
  decouverte: "decouverte",
  /** Etape [4] : verdict du pre-filtre, avant tout cout d'inference. */
  prefiltre: "prefiltre",
  /** Etape [5] : contacts tires du DOM. */
  extraction: "extraction",
  /**
   * Etapes [7] et [8] : deduplication, classification, verdict MX et score de revue.
   *
   * Seuls des **evenements** y sont comptes — une ligne supprimee, une requete DNS
   * emise. Le nombre d'associations d'un type donne ou de contacts notes n'y figure
   * pas : ce sont des etats recalculables, et les rejouer a dix reglages differents
   * gonflerait le total de dix fois le corpus. Ils se lisent dans les tables, par
   * `distributionNormalisation`.
   */
  normalisation: "normalisation",
} as const;
