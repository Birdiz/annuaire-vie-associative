/**
 * Lectures de l'UI.
 *
 * Regroupees ici pour que les gabarits ne portent pas de SQL et que les vues restent
 * testables sans base. Rien n'est recalcule : les distributions des lots 4 et 5
 * (`distributionPrefiltre`, `distributionNormalisation`, `mesurerDormance`,
 * `mesurerCouverture`) sont reutilisees telles quelles. L'ecran de synthese est une vue
 * sur des chiffres deja produits, pas une seconde source.
 */

import type { Database } from "../db/index.ts";

export type LigneRun = {
  id: number;
  departement: string;
  started_at: string;
  finished_at: string | null;
  statut: string;
};

export function runsRecents(db: Database, limite = 5): LigneRun[] {
  return db
    .prepare(
      "SELECT id, departement, started_at, finished_at, statut FROM run ORDER BY id DESC LIMIT ?",
    )
    .all(limite) as unknown as LigneRun[];
}

export function departementsConnus(db: Database): string[] {
  const lignes = db
    .prepare("SELECT DISTINCT departement FROM commune ORDER BY departement")
    .all() as unknown as { departement: string }[];
  return lignes.map((ligne) => ligne.departement);
}

/**
 * Departement affiche a defaut de demande explicite : celui du dernier run, sinon le
 * premier connu de la base. Une UI qui s'ouvre sur un ecran vide alors que la base est
 * pleine passerait pour cassee.
 */
export function departementParDefaut(db: Database, demande: string | null, secours: string): string {
  if (demande !== null && demande !== "") return demande;
  const run = db.prepare("SELECT departement FROM run ORDER BY id DESC LIMIT 1").get() as
    | { departement?: string }
    | undefined;
  if (run?.departement !== undefined) return run.departement;
  return departementsConnus(db)[0] ?? secours;
}

export type DistributionRevue = {
  aRevoir: number;
  valides: number;
  rejetes: number;
  corriges: number;
  /** A revoir mais pas encore note : l'etape [8] n'est pas passee sur ces lignes. */
  nonNotes: number;
  /** Corriges dont la note n'a pas encore ete refaite sur la valeur corrigee. */
  correctionsANoter: number;
  /** Arbitres, quel que soit le verdict. Denominateur du taux de correction. */
  arbitres: number;
};

export function distributionRevue(db: Database, departement: string): DistributionRevue {
  const lignes = db
    .prepare(
      "SELECT ct.review_statut AS statut, count(*) AS n FROM contact ct " +
        "JOIN commune c ON c.code_insee = ct.code_insee " +
        "WHERE c.departement = ? GROUP BY ct.review_statut",
    )
    .all(departement) as unknown as { statut: string; n: number }[];

  const par = new Map(lignes.map((ligne) => [ligne.statut, Number(ligne.n)]));
  const compte = (statut: string): number => par.get(statut) ?? 0;

  const compter = (condition: string): number =>
    Number(
      (
        db
          .prepare(
            "SELECT count(*) AS n FROM contact ct JOIN commune c ON c.code_insee = ct.code_insee " +
              `WHERE c.departement = ? AND ${condition}`,
          )
          .get(departement) as { n?: number } | undefined
      )?.n ?? 0,
    );

  const nonNotes = compter("ct.review_statut = 'a_revoir' AND ct.score IS NULL");
  // Une correction remet `score_version` a NULL : la ligne attend que la normalisation
  // repasse. Le dire evite qu'un export sorte des corrections encore notees a l'ancienne.
  const correctionsANoter = compter("ct.review_statut = 'corrige' AND ct.score_version IS NULL");

  const valides = compte("valide");
  const rejetes = compte("rejete");
  const corriges = compte("corrige");

  return {
    aRevoir: compte("a_revoir"),
    valides,
    rejetes,
    corriges,
    nonNotes,
    correctionsANoter,
    arbitres: valides + rejetes + corriges,
  };
}

export type ContactARevoir = {
  id: number;
  kind: string;
  valeur: string;
  valeur_corrigee: string | null;
  is_generique: number | null;
  score: number | null;
  score_motifs: string | null;
  confiance: number;
  methode_extraction: string;
  source_url: string;
  collected_at: string;
  commune: string;
  association: string | null;
};

/**
 * La file d'arbitrage, **les moins surs d'abord** : c'est la qu'un humain apporte quelque
 * chose, et l'index partiel `idx_contact_a_revoir` a ete cree pour cet ordre.
 *
 * Les contacts non notes en sont exclus. Arbitrer avant que l'etape [8] soit passee
 * reviendrait a juger sans le seul element que l'outil apporte — leur nombre est affiche
 * a part, avec la commande qui les note.
 */
export function fileRevue(db: Database, departement: string, limite: number): ContactARevoir[] {
  return db
    .prepare(
      `SELECT ct.id, ct.kind, ct.valeur, ct.valeur_corrigee, ct.is_generique, ct.score,
              ct.score_motifs, ct.confiance, ct.methode_extraction, ct.source_url,
              ct.collected_at, c.nom AS commune, a.nom AS association
         FROM contact ct
         JOIN commune c ON c.code_insee = ct.code_insee
         LEFT JOIN association a ON a.id = ct.association_id
        WHERE c.departement = ? AND ct.review_statut = 'a_revoir' AND ct.score IS NOT NULL
        ORDER BY ct.score, ct.id
        LIMIT ?`,
    )
    .all(departement, limite) as unknown as ContactARevoir[];
}
