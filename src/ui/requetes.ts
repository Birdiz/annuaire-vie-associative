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
  /** Passe en cours, ecrite par `executerRun` ; nulle des que le run est clos. */
  phase: string | null;
};

export function runsRecents(db: Database, limite = 5): LigneRun[] {
  return db
    .prepare(
      "SELECT id, departement, started_at, finished_at, statut, phase FROM run ORDER BY id DESC LIMIT ?",
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

/**
 * Ce qu'il reste a faire sur la passe en cours, pour la barre de progression.
 *
 * **L'unite est la commune, pas la page.** Le lot de communes est fige : la planification
 * de l'etape [3] insere toutes les pages racines dans une seule transaction, et rien n'en
 * ajoute ensuite. Le denominateur ne bouge donc plus de tout le run. Les pages, elles,
 * apparaissent au fil du crawl — jusqu'a `maxPages` par commune — et une barre assise sur
 * elles reculerait a chaque lien decouvert, ce qui est pire que pas de barre du tout.
 *
 * Le compte de pages reste rendu a cote, en chiffre : il dit le travail fourni sans
 * pretendre dire le travail restant.
 */
export type ProgressionDecouverte = {
  communes: number;
  /** Communes dont plus aucune page n'attend d'etre visitee. */
  explorees: number;
  pages: number;
  pagesVisitees: number;
};

const SQL_PROGRESSION_DECOUVERTE = `
  SELECT count(*) AS communes,
         coalesce(sum(CASE WHEN restantes = 0 THEN 1 ELSE 0 END), 0) AS explorees,
         coalesce(sum(pages), 0) AS pages,
         coalesce(sum(pages - restantes), 0) AS visitees
    FROM (SELECT count(*) AS pages,
                 sum(CASE WHEN p.statut = 'a_visiter' THEN 1 ELSE 0 END) AS restantes
            FROM page p
            JOIN commune c ON c.code_insee = p.code_insee
           WHERE c.departement = ? AND p.campagne = ?
           GROUP BY p.code_insee)
`;

export function progressionDecouverte(
  db: Database,
  departement: string,
  campagne: string,
): ProgressionDecouverte | undefined {
  const ligne = db.prepare(SQL_PROGRESSION_DECOUVERTE).get(departement, campagne) as
    | { communes: number; explorees: number; pages: number; visitees: number }
    | undefined;
  // Aucune commune planifiee : la campagne n'est pas encore ouverte, et une barre a
  // 0 sur 0 laisserait croire a un run bloque plutot qu'a un run qui n'en est pas la.
  if (ligne === undefined || Number(ligne.communes) === 0) return undefined;
  return {
    communes: Number(ligne.communes),
    explorees: Number(ligne.explorees),
    pages: Number(ligne.pages),
    pagesVisitees: Number(ligne.visitees),
  };
}

/**
 * Avancement de l'etape [8]. Le critere est celui du travail lui-meme — `score_version`
 * a la version courante — et non « un score existe » : un contact note par une version
 * anterieure du bareme sera renote, et le compter comme fait ferait stagner la barre a
 * 100 % pendant toute la passe.
 */
export type ProgressionNotation = { contacts: number; notes: number };

const SQL_PROGRESSION_NOTATION = `
  SELECT count(*) AS contacts,
         coalesce(sum(CASE WHEN ct.score_version = ? THEN 1 ELSE 0 END), 0) AS notes
    FROM contact ct
    JOIN commune c ON c.code_insee = ct.code_insee
   WHERE c.departement = ?
`;

export function progressionNotation(
  db: Database,
  departement: string,
  version: number,
): ProgressionNotation | undefined {
  const ligne = db.prepare(SQL_PROGRESSION_NOTATION).get(version, departement) as
    | { contacts: number; notes: number }
    | undefined;
  if (ligne === undefined || Number(ligne.contacts) === 0) return undefined;
  return { contacts: Number(ligne.contacts), notes: Number(ligne.notes) };
}
