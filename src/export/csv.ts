/**
 * Export CSV de l'annuaire.
 *
 * **La provenance voyage avec la donnee.** Chaque ligne porte son URL source, sa date
 * de collecte, sa methode d'extraction et son score. Un export qui les laisserait
 * derriere reproduirait exactement le probleme que l'outil pretend resoudre : un
 * tableur d'adresses dont personne ne peut plus dire d'ou elles viennent ni quand elles
 * ont ete vues. L'invariant §4.5 ne s'arrete pas a la porte de la base.
 *
 * **Ecrit a la main, sans dependance.** Le projet a une seule dependance runtime, entree
 * au lot 3 apres mesure (ADR-011) ; ce seuil ne se franchit pas pour un serialiseur de
 * trente lignes.
 *
 * Le rendu vise le tableur : separateur `;`, BOM UTF-8, fins de ligne CRLF. C'est ce qui
 * fait qu'un fichier ouvert d'un double-clic en France affiche ses accents et ses
 * colonnes, plutot qu'une seule colonne de mojibake.
 */

import type { Database } from "../db/index.ts";

export const SEPARATEUR = ";";
const FIN_DE_LIGNE = "\r\n";
/** Sans lui, Excel lit un CSV UTF-8 en ANSI et massacre le premier accent venu. */
export const BOM = "﻿";

const COLONNES: readonly string[] = [
  "code_insee",
  "commune",
  "rna_id",
  "association",
  "type",
  "kind",
  "valeur",
  "valeur_corrigee",
  "valeur_publiable",
  "regime",
  "score",
  "confiance",
  "methode_extraction",
  "source_url",
  "collected_at",
  "review_statut",
];

/**
 * Un contact `rejete` ne sort pas : c'est le seul filtre de cette requete qu'un humain a
 * pose lui-meme, ligne par ligne. Le rendre optionnel dans l'autre sens — sortir les
 * rejetes sauf demande — ferait du travail de revue une decoration.
 */
const FILTRE_REVUE = "(? = 1 OR ct.review_statut <> 'rejete')";

const SQL_CONTACTS = `
  SELECT ct.code_insee, c.nom AS commune, a.rna_id, a.nom AS association,
         a.type_classifie, ct.kind, ct.valeur, ct.valeur_corrigee, ct.is_generique,
         ct.score, ct.confiance, ct.methode_extraction, ct.source_url, ct.collected_at,
         ct.review_statut
    FROM contact ct
    JOIN commune c ON c.code_insee = ct.code_insee
    LEFT JOIN association a ON a.id = ct.association_id
   WHERE c.departement = ?
     AND (? IS NULL OR (ct.score IS NOT NULL AND ct.score >= ?))
     AND ${FILTRE_REVUE}
   ORDER BY c.nom, a.nom, ct.kind, ct.valeur
`;

type LigneExport = {
  code_insee: string;
  commune: string;
  rna_id: string | null;
  association: string | null;
  type_classifie: string | null;
  kind: string;
  valeur: string;
  valeur_corrigee: string | null;
  is_generique: number | null;
  score: number | null;
  confiance: number;
  methode_extraction: string;
  source_url: string;
  collected_at: string;
  review_statut: string;
};

export type OptionsExport = {
  departement: string;
  /** Ne retient que les contacts notes au moins a cette valeur. */
  scoreMin?: number | undefined;
  /** Sort aussi les contacts qu'un humain a rejetes en revue. Faux par defaut. */
  avecRejetes?: boolean | undefined;
};

/**
 * Rend les lignes du fichier, en-tete comprise, une par une. Un generateur plutot qu'une
 * chaine : un departement entier tient largement en memoire, la France entiere non, et
 * le §1 du brief demande que le pipeline reste correct a cette echelle.
 *
 * La lecture est un **curseur** (`iterate`) et non un `all()`. Avec `all()`, la promesse
 * de l'alinea precedent n'etait tenue qu'a moitie : la retro-pression fonctionnait cote
 * ecriture, mais l'integralite du resultat etait chargee avant la premiere ligne rendue.
 * Contrepartie assumee : la lecture reste ouverte pendant tout le telechargement, ce qui
 * ne gene pas — SQLite en WAL laisse un lecteur et un ecrivain coexister.
 */
export function* lignesCsv(db: Database, options: OptionsExport): Generator<string> {
  yield `${BOM}${COLONNES.join(SEPARATEUR)}${FIN_DE_LIGNE}`;

  const seuil = options.scoreMin ?? null;
  const lignes = db
    .prepare(SQL_CONTACTS)
    .iterate(options.departement, seuil, seuil, options.avecRejetes === true ? 1 : 0) as unknown as Iterable<LigneExport>;

  for (const ligne of lignes) {
    yield `${[
      ligne.code_insee,
      ligne.commune,
      ligne.rna_id ?? "",
      ligne.association ?? "",
      ligne.type_classifie ?? "",
      ligne.kind,
      ligne.valeur,
      ligne.valeur_corrigee ?? "",
      ligne.valeur_corrigee ?? ligne.valeur,
      regime(ligne),
      ligne.score === null ? "" : ligne.score.toFixed(2),
      ligne.confiance.toFixed(2),
      ligne.methode_extraction,
      ligne.source_url,
      ligne.collected_at,
      ligne.review_statut,
    ]
      .map(echapper)
      .join(SEPARATEUR)}${FIN_DE_LIGNE}`;
  }
}

/** Nombre de lignes qu'un export produirait, en-tete exclue. */
export function compterLignes(db: Database, options: OptionsExport): number {
  const seuil = options.scoreMin ?? null;
  const ligne = db
    .prepare(
      "SELECT count(*) AS n FROM contact ct JOIN commune c ON c.code_insee = ct.code_insee " +
        "WHERE c.departement = ? AND (? IS NULL OR (ct.score IS NOT NULL AND ct.score >= ?)) " +
        `AND ${FILTRE_REVUE}`,
    )
    .get(options.departement, seuil, seuil, options.avecRejetes === true ? 1 : 0) as
    | { n?: number }
    | undefined;
  return Number(ligne?.n ?? 0);
}

/**
 * §4.7 — le regime juridique est une colonne a part entiere, pas une deduction laissee
 * au lecteur du fichier. Un telephone n'en a pas.
 */
function regime(ligne: LigneExport): string {
  if (ligne.kind !== "email") return "";
  if (ligne.is_generique === 1) return "generique";
  if (ligne.is_generique === 0) return "nominatif";
  return "indetermine";
}

/**
 * RFC 4180. Le guillemet interne se double, et la valeur se guillemette des qu'elle
 * contient un separateur, un guillemet ou un saut de ligne.
 *
 * Une precaution de plus, absente de la RFC : une valeur commencant par `=`, `+`, `-` ou
 * `@` est prefixee d'une apostrophe. Un tableur y verrait sinon une formule, et un nom
 * d'association venu d'une page web est une donnee dont on ne controle pas la forme.
 */
export function echapper(valeur: string): string {
  const desamorce = /^[=+\-@\t\r]/.test(valeur) ? `'${valeur}` : valeur;
  if (!/[";\r\n]/.test(desamorce)) return desamorce;
  return `"${desamorce.replace(/"/g, '""')}"`;
}
