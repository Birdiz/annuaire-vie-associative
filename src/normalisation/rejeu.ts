/**
 * Orchestration des etapes [7] et [8] sur un departement deja collecte.
 *
 * Quatre passes, dans cet ordre et pas dans un autre :
 *
 * 1. **deduplication** — elle supprime des lignes, donc tout ce qui suit doit la voir
 *    faite pour ne pas noter des contacts qui n'existeront plus ;
 * 2. **classification** des associations, purement locale ;
 * 3. **verdicts MX** des domaines encore inconnus, seule passe qui sorte sur le reseau ;
 * 4. **notation** des contacts, qui lit les verdicts de la passe precedente.
 *
 * **Reprise.** Les passes 2 et 4 sont des recalculs purs et deterministes, ecrits par
 * tranches : un `kill -9` laisse une tranche partiellement a jour que la relance refait
 * a l'identique. La passe 1 est idempotente par construction (`dedup.ts`), et la passe 3
 * persiste chaque verdict des qu'il tombe, si bien qu'une interruption ne fait jamais
 * repayer une requete DNS deja emise. Il n'y a donc aucun etat de reprise a tenir.
 *
 * **Compteurs.** Comme pour le rejeu du pre-filtre, les passes de recalcul n'incrementent
 * aucun compteur cumulatif : rejouer dix reglages gonflerait les premiers de dix fois le
 * corpus. Seuls les evenements — une ligne supprimee, une requete DNS emise — sont
 * comptes. Les etats se lisent dans les tables, par `distributionNormalisation`.
 */

import { toIso } from "../clock.ts";
import { transaction } from "../db/index.ts";
import { dedupliquer } from "./dedup.ts";
import { classer, VERSION_CLASSIFICATION } from "./classification.ts";
import { lireVerdicts, verifierDomaines } from "./mx.ts";
import { noter, VERSION_SCORE } from "./score.ts";
import { valider } from "./validation.ts";
import { domaineDeLAdresse } from "../http/dns.ts";
import type { ResultatMx } from "./mx.ts";
import type { ResolveurMx } from "../http/dns.ts";
import type { Clock } from "../clock.ts";
import type { Counters } from "../metrics/counters.ts";
import type { Database } from "../db/index.ts";

/**
 * Lignes ecrites par transaction.
 *
 * Plus haute qu'en decouverte (200) : ici chaque ligne est un calcul en memoire, sans
 * lecture disque, et la tranche se remplit en quelques millisecondes. Le cout par
 * transaction domine, d'ou l'interet de l'amortir davantage.
 */
const TAILLE_TRANCHE = 500;

const SQL_ASSOCIATIONS = `
  SELECT a.id, a.nom, a.code_objet_social, a.classification_version
    FROM association a
    JOIN commune c ON c.code_insee = a.code_insee
   WHERE c.departement = ?
   ORDER BY a.id
`;

const SQL_CLASSER = `
  UPDATE association
     SET type_classifie = ?, source_classification = ?,
         classification_at = ?, classification_version = ?
   WHERE id = ?
`;

/**
 * Le verdict du pre-filtre vient de la page source du contact. La sous-requete prend la
 * campagne la plus recente : une meme URL revisitee a deux campagnes a deux lignes, et
 * c'est le dernier jugement qui vaut.
 *
 * Le rapprochement passe par `coalesce(final_url, url)` : la provenance d'un contact
 * nomme la page **atteinte**, alors que `page.url` reste la page **demandee** — c'est
 * elle qui porte la cle de planification. Sans ce `coalesce`, tout contact venu d'une
 * page redirigee perdrait son verdict de pre-filtre, donc une part de son score, sans
 * que rien ne le signale.
 */
const SQL_CONTACTS = `
  SELECT ct.id, ct.kind, ct.confiance, ct.is_generique, ct.association_id,
         ct.valeur_normalisee, ct.score_version,
         (ct.valeur_corrigee IS NOT NULL) AS corrige,
         (SELECT p.prefiltre_verdict
            FROM page p
           WHERE coalesce(p.final_url, p.url) = ct.source_url AND p.code_insee = ct.code_insee
           ORDER BY p.campagne DESC
           LIMIT 1) AS prefiltre_verdict
    FROM contact ct
    JOIN commune c ON c.code_insee = ct.code_insee
   WHERE c.departement = ?
   ORDER BY ct.id
`;

const SQL_NOTER = `
  UPDATE contact
     SET score = ?, score_motifs = ?, score_version = ?, score_at = ?
   WHERE id = ?
`;

export type ResultatNormalisation = {
  departement: string;
  doublonsSupprimes: number;
  associationsClassees: number;
  associationsAJour: number;
  mx: ResultatMx;
  contactsNotes: number;
  contactsAJour: number;
  /** Contacts dont la valeur n'a pas la forme d'une adresse ou d'un numero. */
  contactsInvalides: number;
};

export type OptionsNormalisation = {
  departement: string;
  /** Recalcule aussi ce que la version courante a deja produit. */
  tout?: boolean | undefined;
  counters?: Counters | undefined;
  signal?: AbortSignal | undefined;
  /**
   * Appele apres chaque tranche commitee, avec le nom de la passe et le nombre de
   * lignes ecrites depuis son debut. C'est le seul instant ou l'etat en base est
   * partiel de facon **observable**, donc le point ou le test de reprise peut provoquer
   * un `kill -9` reellement en plein travail.
   */
  onTranche?: ((passe: string, ecrites: number) => void) | undefined;
};

export async function normaliser(
  db: Database,
  clock: Clock,
  resolveur: ResolveurMx,
  options: OptionsNormalisation,
): Promise<ResultatNormalisation> {
  const doublonsSupprimes = dedupliquer(db, options.departement, options.counters);
  const classification = classerAssociations(db, clock, options);
  const mx = await verifierDomaines(db, resolveur, clock, {
    departement: options.departement,
    counters: options.counters,
    tout: options.tout,
    signal: options.signal,
  });
  const notation = noterContacts(db, clock, options);

  return {
    departement: options.departement,
    doublonsSupprimes,
    associationsClassees: classification.ecrites,
    associationsAJour: classification.aJour,
    mx,
    contactsNotes: notation.ecrites,
    contactsAJour: notation.aJour,
    contactsInvalides: notation.invalides,
  };
}

type LigneAssociation = {
  id: number;
  nom: string;
  code_objet_social: string | null;
  classification_version: number | null;
};

function classerAssociations(
  db: Database,
  clock: Clock,
  options: OptionsNormalisation,
): { ecrites: number; aJour: number } {
  const lignes = db.prepare(SQL_ASSOCIATIONS).all(options.departement) as unknown as LigneAssociation[];
  const maintenant = toIso(clock.now());

  let ecrites = 0;
  let aJour = 0;
  let tranche: (readonly [string, string, string, number, number])[] = [];

  const ecrire = (): void => {
    if (tranche.length === 0) return;
    const lot = tranche;
    tranche = [];
    transaction(db, () => {
      const requete = db.prepare(SQL_CLASSER);
      for (const ligne of lot) requete.run(...ligne);
    });
    ecrites += lot.length;
    options.onTranche?.("classification", ecrites);
  };

  for (const ligne of lignes) {
    if (options.tout !== true && ligne.classification_version === VERSION_CLASSIFICATION) {
      aJour += 1;
      continue;
    }
    const { type, source } = classer(ligne.code_objet_social, ligne.nom);
    tranche.push([type, source, maintenant, VERSION_CLASSIFICATION, ligne.id]);
    if (tranche.length >= TAILLE_TRANCHE) ecrire();
  }
  ecrire();

  return { ecrites, aJour };
}

type LigneContact = {
  id: number;
  kind: string;
  confiance: number;
  is_generique: number | null;
  association_id: number | null;
  valeur_normalisee: string;
  score_version: number | null;
  corrige: number;
  prefiltre_verdict: string | null;
};

function noterContacts(
  db: Database,
  clock: Clock,
  options: OptionsNormalisation,
): { ecrites: number; aJour: number; invalides: number } {
  const lignes = db.prepare(SQL_CONTACTS).all(options.departement) as unknown as LigneContact[];
  const verdicts = lireVerdicts(db);
  const maintenant = toIso(clock.now());

  let ecrites = 0;
  let aJour = 0;
  let invalides = 0;
  let tranche: (readonly [number, string, number, string, number])[] = [];

  const ecrire = (): void => {
    if (tranche.length === 0) return;
    const lot = tranche;
    tranche = [];
    transaction(db, () => {
      const requete = db.prepare(SQL_NOTER);
      for (const ligne of lot) requete.run(...ligne);
    });
    ecrites += lot.length;
    options.onTranche?.("notation", ecrites);
  };

  for (const ligne of lignes) {
    if (options.tout !== true && ligne.score_version === VERSION_SCORE) {
      aJour += 1;
      continue;
    }
    const kind = ligne.kind === "phone" ? "phone" : "email";
    const validation = valider(kind, ligne.valeur_normalisee);
    if (!validation.valide) invalides += 1;

    const domaine =
      kind === "email" && validation.valide ? domaineDeLAdresse(ligne.valeur_normalisee) : undefined;
    // Un domaine absent de la table n'a pas ete verifie : c'est un `null`, comme un
    // echec de resolution. Les deux disent « on ne sait pas », et se traitent pareil.
    const mx = domaine === undefined ? null : (verdicts.get(domaine) ?? null);

    const { score, motifs } = noter({
      kind,
      syntaxeValide: validation.valide,
      confiance: ligne.confiance,
      isGenerique: ligne.is_generique === null ? null : ligne.is_generique === 1 ? 1 : 0,
      rattache: ligne.association_id !== null,
      mx,
      prefiltreVerdict:
        ligne.prefiltre_verdict === "retenue" || ligne.prefiltre_verdict === "ecartee"
          ? ligne.prefiltre_verdict
          : null,
      // La revue a deja recopie la correction dans `valeur_normalisee` : la syntaxe et
      // le MX ci-dessus portent donc sur la valeur corrigee, pas sur celle qui a ete lue.
      corrigeEnRevue: ligne.corrige === 1,
    });

    tranche.push([score, JSON.stringify(motifs), VERSION_SCORE, maintenant, ligne.id]);
    if (tranche.length >= TAILLE_TRANCHE) ecrire();
  }
  ecrire();

  return { ecrites, aJour, invalides };
}

export type DistributionNormalisation = {
  associations: number;
  parType: readonly { type: string; associations: number }[];
  contacts: number;
  notes: number;
  /** Notes a zero : la valeur n'a pas la forme d'une adresse ou d'un numero. */
  invalides: number;
  emailsAvecMx: number;
  emailsSansMx: number;
  emailsMxInconnu: number;
  histogramme: readonly { borne: number; contacts: number }[];
};

/**
 * Ce que disent les tables apres normalisation. Lu et non accumule, pour la raison
 * ecrite en tete de ce module.
 */
export function distributionNormalisation(db: Database, departement: string): DistributionNormalisation {
  const un = (sql: string, ...params: (string | number)[]): number =>
    Number((db.prepare(sql).get(...params) as { n?: number } | undefined)?.n ?? 0);

  const associations = un(
    "SELECT count(*) AS n FROM association a JOIN commune c ON c.code_insee = a.code_insee " +
      "WHERE c.departement = ? AND a.date_dissolution IS NULL",
    departement,
  );

  const parType = db
    .prepare(
      "SELECT a.type_classifie AS type, count(*) AS associations " +
        "FROM association a JOIN commune c ON c.code_insee = a.code_insee " +
        "WHERE c.departement = ? AND a.date_dissolution IS NULL AND a.type_classifie IS NOT NULL " +
        "GROUP BY a.type_classifie ORDER BY associations DESC",
    )
    .all(departement) as unknown as { type: string; associations: number }[];

  const contacts = un(
    "SELECT count(*) AS n FROM contact ct JOIN commune c ON c.code_insee = ct.code_insee " +
      "WHERE c.departement = ?",
    departement,
  );
  const notes = un(
    "SELECT count(*) AS n FROM contact ct JOIN commune c ON c.code_insee = ct.code_insee " +
      "WHERE c.departement = ? AND ct.score IS NOT NULL",
    departement,
  );
  const invalides = un(
    "SELECT count(*) AS n FROM contact ct JOIN commune c ON c.code_insee = ct.code_insee " +
      "WHERE c.departement = ? AND ct.score = 0",
    departement,
  );

  // Les adresses syntaxiquement fausses sont exclues du decompte MX : leur domaine n'a
  // jamais ete interroge, et les ranger parmi les « indetermines » melangerait « le DNS
  // n'a pas su repondre » et « ce n'etait pas une adresse ».
  const parMx = (condition: string): number =>
    un(
      "SELECT count(*) AS n FROM contact ct JOIN commune c ON c.code_insee = ct.code_insee " +
        "LEFT JOIN domaine_mail d ON d.domaine = substr(ct.valeur_normalisee, instr(ct.valeur_normalisee, '@') + 1) " +
        `WHERE c.departement = ? AND ct.kind = 'email' AND coalesce(ct.score, 1) > 0 AND ${condition}`,
      departement,
    );

  const histogramme = db
    .prepare(
      "SELECT cast(ct.score * 10 AS INTEGER) AS borne, count(*) AS contacts " +
        "FROM contact ct JOIN commune c ON c.code_insee = ct.code_insee " +
        "WHERE c.departement = ? AND ct.score IS NOT NULL " +
        "GROUP BY borne ORDER BY borne",
    )
    .all(departement) as unknown as { borne: number; contacts: number }[];

  return {
    associations,
    parType,
    contacts,
    notes,
    invalides,
    emailsAvecMx: parMx("d.mx = 1"),
    emailsSansMx: parMx("d.mx = 0"),
    emailsMxInconnu: parMx("d.mx IS NULL"),
    histogramme,
  };
}
