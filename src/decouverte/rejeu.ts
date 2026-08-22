/**
 * Rejeu de l'etape [4] sur les pages deja visitees, sans reseau.
 *
 * Le seuil du pre-filtre ne se choisit qu'en le mesurant sur un vrai corpus, et
 * recrawler un departement coute treize minutes plancher (ADR-013) plus autant de
 * requetes vers de vraies mairies. Ce module relit les corps depuis le cache disque —
 * `HttpCache.get`, pas `client.fetch` : c'est une lecture de fichier, elle ne passe
 * donc pas par la porte de sortie reseau et n'a pas besoin d'URL de contact.
 *
 * **Reprise** : le rejeu est un recalcul pur et deterministe, ecrit par tranches. Un
 * `kill -9` laisse une tranche partiellement a jour que la relance refait a
 * l'identique. Il n'y a aucun etat de reprise a tenir, et rien ne peut etre compte
 * deux fois.
 *
 * **Aucun compteur cumulatif n'est incremente ici.** Les compteurs du §8 disent ce qui
 * s'est passe pendant les runs ; le rejeu, lui, repond a « que dit le filtre actuel de
 * ce corpus ». Rejouer dix reglages gonflerait les premiers de dix fois le corpus. La
 * distribution se lit donc dans la table, apres coup.
 */

import { toIso } from "../clock.ts";
import { transaction } from "../db/index.ts";
import { analyser, decoder, estHtml } from "../parse/html.ts";
import { extraireContacts } from "./extraction.ts";
import { evaluerPage, SEUIL_EXTRACTION, VERSION_PREFILTRE } from "./prefiltre.ts";
import { indexerAssociations } from "./rattachement.ts";
import type { Clock } from "../clock.ts";
import type { Database } from "../db/index.ts";
import type { HttpCache } from "../http/cache.ts";
import type { IndexAssociations } from "./rattachement.ts";

/** Pages ecrites par transaction. Assez pour amortir, assez peu pour ne pas tenir la base. */
const TAILLE_TRANCHE = 200;

const SQL_PAGES = `
  SELECT p.url_hash, p.url, p.code_insee, p.prefiltre_version
    FROM page p
    JOIN commune c ON c.code_insee = p.code_insee
   WHERE c.departement = ? AND p.campagne = ? AND p.statut = 'visitee'
   ORDER BY p.code_insee, p.url_hash
`;

const SQL_ASSOCIATIONS = `
  SELECT id, nom_normalise
    FROM association
   WHERE code_insee = ? AND date_dissolution IS NULL
`;

const SQL_MAJ = `
  UPDATE page
     SET prefiltre_score = ?, prefiltre_verdict = ?, prefiltre_motif = ?,
         prefiltre_at = ?, prefiltre_version = ?, contacts_extraits = ?
   WHERE url_hash = ?
`;

/** Derniere campagne connue du departement, celle sur laquelle on regle par defaut. */
export function derniereCampagne(db: Database, departement: string): string | undefined {
  const ligne = db
    .prepare(
      "SELECT max(p.campagne) AS campagne FROM page p JOIN commune c ON c.code_insee = p.code_insee " +
        "WHERE c.departement = ?",
    )
    .get(departement) as { campagne: string | null } | undefined;
  return ligne?.campagne ?? undefined;
}

export type ResultatRejeu = {
  campagne: string;
  evaluees: number;
  /** Corps absent du cache : purge, ou page visitee avant l'existence du cache. */
  sansCache: number;
  /** Verdict deja calcule par la version courante du filtre. */
  aJour: number;
};

export type OptionsRejeu = {
  departement: string;
  campagne: string;
  seuil?: number | undefined;
  avecMobiles?: boolean | undefined;
  /** Recalcule meme les verdicts deja produits par la version courante. */
  tout?: boolean | undefined;
  /**
   * Appele apres chaque tranche commitee, avec le nombre de pages ecrites depuis le
   * debut. Un rejeu de plusieurs milliers de pages est muet pendant une dizaine de
   * secondes ; c'est ce qui alimente le journal detaille.
   *
   * C'est aussi le seul instant ou l'etat en base est partiel de facon **observable**,
   * donc le point ou le test de reprise peut provoquer un `kill -9` reellement en plein
   * travail, plutot que d'esperer qu'un delai tombe au bon endroit.
   */
  onTranche?: ((ecrites: number) => void) | undefined;
};

type LignePage = {
  url_hash: string;
  url: string;
  code_insee: string;
  prefiltre_version: number | null;
};

type Ecriture = readonly [number, string, string, string, number, number, string];

export function rejouerPrefiltre(
  db: Database,
  cache: HttpCache,
  clock: Clock,
  options: OptionsRejeu,
): ResultatRejeu {
  const pages = db.prepare(SQL_PAGES).all(options.departement, options.campagne) as unknown as LignePage[];

  let evaluees = 0;
  let sansCache = 0;
  let aJour = 0;

  // L'index des associations est construit une fois par commune, pas une fois par
  // page : les pages sont triees par code INSEE precisement pour cela.
  let communeCourante: string | undefined;
  let index: IndexAssociations = [];
  let tranche: Ecriture[] = [];

  const vider = (): void => {
    if (tranche.length === 0) return;
    const lot = tranche;
    tranche = [];
    transaction(db, () => {
      const maj = db.prepare(SQL_MAJ);
      for (const ligne of lot) maj.run(...ligne);
    });
    options.onTranche?.(evaluees);
  };

  for (const page of pages) {
    if (!(options.tout ?? false) && page.prefiltre_version === VERSION_PREFILTRE) {
      aJour += 1;
      continue;
    }

    if (page.code_insee !== communeCourante) {
      communeCourante = page.code_insee;
      index = chargerIndex(db, page.code_insee);
    }

    const verdict = evaluerDepuisCache(cache, page.url, index, options);
    if (verdict === undefined) {
      sansCache += 1;
      continue;
    }

    tranche.push([
      verdict.score,
      verdict.verdict,
      verdict.motif,
      toIso(clock.now()),
      verdict.version,
      verdict.signaux.contacts,
      page.url_hash,
    ]);
    evaluees += 1;
    if (tranche.length >= TAILLE_TRANCHE) vider();
  }

  vider();
  return { campagne: options.campagne, evaluees, sansCache, aJour };
}

function chargerIndex(db: Database, codeInsee: string): IndexAssociations {
  const lignes = db.prepare(SQL_ASSOCIATIONS).all(codeInsee) as unknown as {
    id: number;
    nom_normalise: string;
  }[];
  return indexerAssociations(lignes.map((ligne) => ({ id: ligne.id, nomNormalise: ligne.nom_normalise })));
}

function evaluerDepuisCache(
  cache: HttpCache,
  url: string,
  index: IndexAssociations,
  options: OptionsRejeu,
): ReturnType<typeof evaluerPage> | undefined {
  const entree = cache.get(url);
  if (entree === undefined) return undefined;
  if (!estHtml(entree.meta.contentType)) return undefined;

  const doc = analyser(decoder(entree.body, entree.meta.contentType), entree.meta.finalUrl);
  const extraction = extraireContacts(doc, { avecMobiles: options.avecMobiles ?? false });

  return evaluerPage({
    url: entree.meta.finalUrl,
    doc,
    index,
    contacts: extraction.contacts,
    ...(options.seuil === undefined ? {} : { seuil: options.seuil }),
  });
}

export type DistributionPrefiltre = {
  total: number;
  jugees: number;
  retenues: number;
  ecartees: number;
  candidatesLlm: number;
  parMotif: readonly { motif: string; pages: number }[];
  /** Bornes de score, par tranche de 4, pour poser le seuil sur une distribution reelle. */
  histogramme: readonly { borne: number; pages: number }[];
};

/**
 * Ce que le filtre dit du corpus, lu dans la table plutot que compte au passage. C'est
 * cette lecture qui sert a poser le seuil : un histogramme, pas une opinion.
 */
export function distributionPrefiltre(
  db: Database,
  departement: string,
  campagne: string,
): DistributionPrefiltre {
  const filtre =
    "FROM page p JOIN commune c ON c.code_insee = p.code_insee " +
    "WHERE c.departement = ? AND p.campagne = ? AND p.statut = 'visitee'";

  const compte = (sql: string): number =>
    Number((db.prepare(sql).get(departement, campagne) as { n?: number } | undefined)?.n ?? 0);

  const total = compte(`SELECT count(*) AS n ${filtre}`);
  const jugees = compte(`SELECT count(*) AS n ${filtre} AND p.prefiltre_verdict IS NOT NULL`);
  const retenues = compte(`SELECT count(*) AS n ${filtre} AND p.prefiltre_verdict = 'retenue'`);
  const ecartees = compte(`SELECT count(*) AS n ${filtre} AND p.prefiltre_verdict = 'ecartee'`);
  const candidatesLlm = compte(
    `SELECT count(*) AS n ${filtre} AND p.prefiltre_verdict = 'retenue' ` +
      `AND coalesce(p.contacts_extraits, 0) < ${SEUIL_EXTRACTION}`,
  );

  const parMotif = db
    .prepare(
      `SELECT p.prefiltre_motif AS motif, count(*) AS pages ${filtre} ` +
        "AND p.prefiltre_motif IS NOT NULL GROUP BY p.prefiltre_motif ORDER BY pages DESC",
    )
    .all(departement, campagne) as unknown as { motif: string; pages: number }[];

  const histogramme = db
    .prepare(
      `SELECT cast(p.prefiltre_score / 4 AS INTEGER) * 4 AS borne, count(*) AS pages ${filtre} ` +
        "AND p.prefiltre_score IS NOT NULL GROUP BY borne ORDER BY borne",
    )
    .all(departement, campagne) as unknown as { borne: number; pages: number }[];

  return { total, jugees, retenues, ecartees, candidatesLlm, parMotif, histogramme };
}
