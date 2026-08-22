/**
 * Persistance des verdicts MX (ADR-017).
 *
 * Ce module fait le pont entre la porte de sortie `src/http/dns.ts`, qui ne sait
 * qu'interroger le resolveur, et la table `domaine_mail`, qui se souvient. La
 * separation n'est pas decorative : elle garde `src/http/` ignorant de la base, comme
 * `src/http/cache.ts` ignore tout du schema.
 *
 * Deux proprietes tiennent la reprise :
 *
 * - **un verdict est ecrit des qu'il tombe**, pas a la fin du lot. Apres un `kill -9`,
 *   les requetes deja payees ne sont pas a refaire ;
 * - **un domaine deja connu et frais n'est jamais reinterroge**. Sur un departement,
 *   les quelques milliers d'adresses collectees se ramenent a quelques centaines de
 *   domaines distincts, et la plupart reviennent d'une campagne a l'autre.
 *
 * Un verdict en echec (`mx IS NULL`) est traite comme perime, toujours. Une panne de
 * resolveur ne doit pas se figer en jugement definitif sur un domaine valide.
 */

import { transaction } from "../db/index.ts";
import { toIso } from "../clock.ts";
import { ETAPE } from "../metrics/counters.ts";
import { domaineDeLAdresse } from "../http/dns.ts";
import { validerEmail } from "./validation.ts";
import type { ResolveurMx, VerdictMx } from "../http/dns.ts";
import type { Clock } from "../clock.ts";
import type { Counters } from "../metrics/counters.ts";
import type { Database } from "../db/index.ts";

/**
 * Un verdict MX vieillit : un domaine expire, une messagerie demenage. Trente jours est
 * du meme ordre que l'intervalle entre deux campagnes sur un departement — assez court
 * pour que l'annuaire ne mente pas, assez long pour qu'une seconde campagne ne repaie
 * pas la totalite des resolutions.
 */
export const FRAICHEUR_MX_JOURS = 30;

const SQL_DOMAINES_DU_DEPARTEMENT = `
  SELECT DISTINCT ct.valeur_normalisee AS adresse
    FROM contact ct
    JOIN commune c ON c.code_insee = ct.code_insee
   WHERE c.departement = ? AND ct.kind = 'email'
`;

const SQL_VERDICTS_CONNUS = `
  SELECT domaine, mx, verifie_at FROM domaine_mail WHERE mx IS NOT NULL AND verifie_at >= ?
`;

const SQL_TOUS_VERDICTS = `SELECT domaine, mx FROM domaine_mail`;

const SQL_ECRIRE_VERDICT = `
INSERT INTO domaine_mail (domaine, mx, mx_hotes, methode, verifie_at, erreur)
VALUES (?, ?, ?, 'dns:mx', ?, ?)
ON CONFLICT (domaine) DO UPDATE SET
  mx = excluded.mx,
  mx_hotes = excluded.mx_hotes,
  methode = excluded.methode,
  verifie_at = excluded.verifie_at,
  erreur = excluded.erreur
`;

export type ResultatMx = {
  /** Domaines distincts vus dans les contacts du departement. */
  distincts: number;
  /** Verdicts deja connus et encore frais : aucune requete emise. */
  deja: number;
  /** Requetes reellement emises vers le resolveur. */
  verifies: number;
};

/** Domaines distincts des emails collectes sur un departement. */
export function domainesDuDepartement(db: Database, departement: string): string[] {
  const lignes = db.prepare(SQL_DOMAINES_DU_DEPARTEMENT).all(departement) as unknown as {
    adresse: string;
  }[];
  const domaines = new Set<string>();
  for (const ligne of lignes) {
    // Une adresse syntaxiquement fausse n'a pas de domaine a interroger. Sans ce
    // filtre, l'Ille-et-Vilaine partait avec 41 requetes vouees a un EBADNAME, pour
    // des chaines dont on savait deja qu'elles n'etaient pas des adresses.
    if (!validerEmail(ligne.adresse).valide) continue;
    const domaine = domaineDeLAdresse(ligne.adresse);
    if (domaine !== undefined) domaines.add(domaine);
  }
  return [...domaines].sort();
}

/** Tous les verdicts en base, sous la forme attendue par la notation. */
export function lireVerdicts(db: Database): Map<string, 0 | 1 | null> {
  const lignes = db.prepare(SQL_TOUS_VERDICTS).all() as unknown as {
    domaine: string;
    mx: number | null;
  }[];
  const verdicts = new Map<string, 0 | 1 | null>();
  for (const ligne of lignes) {
    verdicts.set(ligne.domaine, ligne.mx === null ? null : ligne.mx === 1 ? 1 : 0);
  }
  return verdicts;
}

function borneDeFraicheur(clock: Clock): string {
  return toIso(clock.now() - FRAICHEUR_MX_JOURS * 86_400_000);
}

/**
 * Verifie les domaines encore inconnus ou perimes d'un departement. Ne leve jamais sur
 * un echec de resolution : l'echec est un verdict, il s'ecrit et se rejouera.
 */
export async function verifierDomaines(
  db: Database,
  resolveur: ResolveurMx,
  clock: Clock,
  options: {
    departement: string;
    counters?: Counters | undefined;
    /** Reinterroge meme les verdicts frais. */
    tout?: boolean | undefined;
    signal?: AbortSignal | undefined;
  },
): Promise<ResultatMx> {
  const distincts = domainesDuDepartement(db, options.departement);

  const frais = new Set<string>();
  if (options.tout !== true) {
    const lignes = db.prepare(SQL_VERDICTS_CONNUS).all(borneDeFraicheur(clock)) as unknown as {
      domaine: string;
    }[];
    for (const ligne of lignes) frais.add(ligne.domaine);
  }

  const aVerifier = distincts.filter((domaine) => !frais.has(domaine));
  const verifies = await resolveur.verifierTous(
    aVerifier,
    (verdict) => ecrireVerdict(db, clock, verdict, options.counters),
    options.signal,
  );

  return { distincts: distincts.length, deja: distincts.length - aVerifier.length, verifies };
}

/**
 * Ecrit un verdict, et incremente les compteurs de flux qui lui correspondent. Ce sont
 * des evenements — une requete emise, un domaine trouve sans MX — et non des etats
 * recalculables : les compter cumulativement a un sens, contrairement au nombre
 * d'associations d'un type donne, qui se lit dans la table.
 */
export function ecrireVerdict(
  db: Database,
  clock: Clock,
  verdict: VerdictMx,
  counters?: Counters,
): void {
  transaction(db, () => {
    db.prepare(SQL_ECRIRE_VERDICT).run(
      verdict.domaine,
      verdict.mx,
      verdict.hotes === undefined ? null : verdict.hotes.join(" "),
      toIso(clock.now()),
      verdict.erreur ?? null,
    );
    counters?.inc(ETAPE.normalisation, "domaines_verifies", 1);
    if (verdict.mx === 0) counters?.inc(ETAPE.normalisation, "domaines_sans_mx", 1);
    if (verdict.mx === null) counters?.inc(ETAPE.normalisation, "domaines_non_resolus", 1);
  });
}
