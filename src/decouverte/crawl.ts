/**
 * Etapes [3] et [5] pour une page : la recuperer, en tirer les contacts, et decider
 * des pages filles dans la limite du budget de la commune.
 *
 * Deux regles gouvernent la forme de ce handler.
 *
 * `skipped` est reserve a un payload inexploitable. Une page interdite par
 * `robots.txt`, absente, ou qui n'est pas du HTML n'est pas un job rate : c'est un
 * job reussi dont le resultat est negatif, et ce resultat doit etre ecrit. Or le
 * cadre n'execute le `commit` que sur la branche `done` (`src/jobs/worker.ts`) :
 * rendre `skipped` perdrait l'information, ou obligerait a ecrire hors transaction.
 *
 * Un echec transitoire — temporisation, 5xx, 429 — est au contraire relance par une
 * exception, ce qui rend la main a la file, a son backoff et a ses `max_attempts`.
 * Rien n'est reimplemente ici de ce que l'ADR-002 fait deja.
 */

import { createHash } from "node:crypto";

import { toIso } from "../clock.ts";
import { ETAPE } from "../metrics/counters.ts";
import { analyser, decoder, estHtml } from "../parse/html.ts";
import type { Database } from "../db/index.ts";
import type { JobHandler } from "../jobs/worker.ts";
import type { ContactExtrait } from "./extraction.ts";
import type { ContexteDecouverte, PayloadPage } from "./contexte.ts";
import { clePage, hashPage, lirePayloadPage, prioriteDeScore } from "./contexte.ts";
import { extraireContacts } from "./extraction.ts";
import { indexerAssociations, rattacher } from "./rattachement.ts";
import { PROFONDEUR_MAX, estReseauSocial, selectionner } from "./scoring.ts";
import type { LienScore } from "./scoring.ts";

/** Statuts que la page peut prendre en fin de traitement. */
type StatutPage = "visitee" | "bloquee" | "erreur" | "hors_type";

type ContactRattache = {
  contact: ContactExtrait;
  /** Nom normalise de l'association pressentie. L'identifiant est resolu au commit. */
  nomAssociation: string | undefined;
};

const SQL_MAJ_PAGE = `
  UPDATE page
     SET statut = ?, http_status = ?, content_hash = ?, cache_path = ?, fetched_at = ?
   WHERE url_hash = ?
`;

const SQL_MAJ_COMMUNE = `
  UPDATE commune
     SET crawl_statut = ?, crawl_erreur = ?, last_crawled_at = ?, updated_at = ?
   WHERE code_insee = ?
`;

const SQL_BUDGET = `SELECT count(*) AS n FROM page WHERE campagne = ? AND code_insee = ?`;

const SQL_DEJA_VU = `
  SELECT count(*) AS n FROM page
   WHERE campagne = ? AND code_insee = ? AND content_hash = ? AND url_hash <> ?
`;

const SQL_INSERER_PAGE = `
  INSERT OR IGNORE INTO page
    (url_hash, campagne, url, domaine, code_insee, planifiee_at, profondeur, statut,
     score_candidat, url_source)
  VALUES (?, ?, ?, ?, ?, ?, ?, 'a_visiter', ?, ?)
`;

const SQL_ASSOCIATIONS = `
  SELECT id, nom_normalise
    FROM association
   WHERE code_insee = ? AND date_dissolution IS NULL
`;

/**
 * Un rattachement n'est retenu que si le nom designe une seule association de la
 * commune : deux homonymes rendraient le choix arbitraire, et un contact rattache au
 * mauvais destinataire est pire qu'un contact rattache a la commune.
 */
const SQL_RESOUDRE_ASSOCIATION = `
  SELECT id FROM association
   WHERE code_insee = ? AND nom_normalise = ? AND date_dissolution IS NULL
   LIMIT 2
`;

/**
 * Ni la provenance ni la revue humaine ne doivent regresser. Une desobfuscation
 * trouvee au passage suivant ne doit pas remplacer un `mailto:`, et un contact deja
 * valide en revue ne doit pas repasser a « a revoir » : d'ou la garde sur la
 * confiance et l'absence de `review_statut` dans la liste mise a jour.
 */
function sqlContact(rattache: boolean): string {
  const cible = rattache
    ? "(association_id, kind, valeur_normalisee) WHERE association_id IS NOT NULL"
    : "(code_insee, kind, valeur_normalisee) WHERE association_id IS NULL";
  return `
    INSERT INTO contact
      (association_id, code_insee, kind, valeur, valeur_normalisee, is_generique,
       source_url, methode_extraction, confiance, collected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT ${cible} DO UPDATE SET
      valeur = excluded.valeur,
      is_generique = excluded.is_generique,
      source_url = excluded.source_url,
      methode_extraction = excluded.methode_extraction,
      confiance = excluded.confiance,
      collected_at = excluded.collected_at
    WHERE excluded.confiance > contact.confiance
  `;
}

export function handlerPageCrawl(ctx: ContexteDecouverte): JobHandler {
  return async (job, jobCtx) => {
    const payload = lirePayloadPage(job.payload);
    if (payload === undefined) return { kind: "skipped", reason: "payload de page inexploitable" };

    const hash = hashPage(payload.campagne, payload.codeInsee, payload.url);
    const resultat = await ctx.client.fetch(payload.url, { signal: jobCtx.signal });

    if (resultat.kind === "blocked") {
      return terminer(ctx, payload, hash, { statut: "bloquee", raison: resultat.reason });
    }

    if (resultat.kind === "status") {
      if (estTransitoire(resultat.status)) {
        // La file sait retenter avec un backoff ; le throttle a deja ete penalise
        // sur un 429. Reimplementer une attente ici ferait doublon.
        throw new Error(`statut ${resultat.status} sur ${payload.url}`);
      }
      return terminer(ctx, payload, hash, {
        statut: "erreur",
        httpStatus: resultat.status,
        raison: `statut ${resultat.status}`,
      });
    }

    const finale = new URL(resultat.meta.finalUrl);
    if (estReseauSocial(finale.hostname)) {
      // Redirection sortante vers un reseau social : on s'arrete la (§5).
      return terminer(ctx, payload, hash, {
        statut: "hors_type",
        httpStatus: resultat.meta.status,
        raison: "redirection vers un reseau social",
      });
    }
    if (!estHtml(resultat.meta.contentType)) {
      return terminer(ctx, payload, hash, {
        statut: "hors_type",
        httpStatus: resultat.meta.status,
        raison: `type ${resultat.meta.contentType ?? "inconnu"}`,
      });
    }

    const doc = analyser(decoder(resultat.body, resultat.meta.contentType), resultat.meta.finalUrl);
    const extraction = extraireContacts(doc, { avecMobiles: payload.avecMobiles });

    const index = indexerAssociations(
      (ctx.db.prepare(SQL_ASSOCIATIONS).all(payload.codeInsee) as unknown as {
        id: number;
        nom_normalise: string;
      }[]).map((ligne) => ({ id: ligne.id, nomNormalise: ligne.nom_normalise })),
    );
    const contacts: ContactRattache[] = extraction.contacts.map((contact) => ({
      contact,
      nomAssociation: rattacher(index, contact.contextes)?.nomNormalise,
    }));

    const selection =
      payload.profondeur < PROFONDEUR_MAX
        ? selectionner(doc.liens, resultat.meta.finalUrl)
        : { retenus: [], horsDomaine: 0, ignores: 0, ecartes: 0 };

    const contentHash = createHash("sha256").update(resultat.body).digest("hex");

    return {
      kind: "done",
      commit: (db) =>
        persister(ctx, db, payload, hash, {
          contentHash,
          httpStatus: resultat.meta.status,
          cachePath: ctx.client.cachePathFor(payload.url),
          contacts,
          selection: selection.retenus,
          horsDomaine: selection.horsDomaine,
          mobilesExclus: extraction.mobilesExclus,
        }),
    };
  };
}

/** 429 et 5xx sont des etats du serveur, pas des verdicts sur la page. */
function estTransitoire(statut: number): boolean {
  return statut === 429 || statut === 408 || (statut >= 500 && statut < 600);
}

type Echec = { statut: StatutPage; httpStatus?: number; raison: string };

/**
 * Cloture une page sans contenu exploitable. L'ecriture passe par le `commit`, donc
 * par la transaction de completion du job : rien ne peut etre ecrit deux fois.
 */
function terminer(
  ctx: ContexteDecouverte,
  payload: PayloadPage,
  hash: string,
  echec: Echec,
): { kind: "done"; commit: (db: Database) => void } {
  return {
    kind: "done",
    commit: (db) => {
      const maintenant = toIso(ctx.clock.now());
      db.prepare(SQL_MAJ_PAGE).run(
        echec.statut,
        echec.httpStatus ?? null,
        null,
        null,
        maintenant,
        hash,
      );
      if (payload.profondeur === 0) {
        marquerCommune(db, payload.codeInsee, statutCommune(echec), echec.raison, maintenant);
      }
      ctx.counters.inc(ETAPE.decouverte, compteurDeStatut(echec.statut));
    },
  };
}

function statutCommune(echec: Echec): string {
  if (echec.statut === "bloquee") return "interdit_robots";
  if (echec.statut === "hors_type") return "refuse";
  return "injoignable";
}

function compteurDeStatut(statut: StatutPage): string {
  if (statut === "bloquee") return "pages_bloquees";
  if (statut === "erreur") return "pages_en_erreur";
  if (statut === "hors_type") return "pages_hors_type";
  return "pages_visitees";
}

function marquerCommune(
  db: Database,
  codeInsee: string,
  statut: string,
  raison: string | null,
  maintenant: string,
): void {
  db.prepare(SQL_MAJ_COMMUNE).run(statut, raison, maintenant, maintenant, codeInsee);
}

type Succes = {
  contentHash: string;
  httpStatus: number;
  cachePath: string;
  contacts: readonly ContactRattache[];
  selection: readonly LienScore[];
  horsDomaine: number;
  mobilesExclus: number;
};

function persister(
  ctx: ContexteDecouverte,
  db: Database,
  payload: PayloadPage,
  hash: string,
  succes: Succes,
): void {
  const maintenant = toIso(ctx.clock.now());

  db.prepare(SQL_MAJ_PAGE).run(
    "visitee",
    succes.httpStatus,
    succes.contentHash,
    succes.cachePath,
    maintenant,
    hash,
  );
  if (payload.profondeur === 0) {
    marquerCommune(db, payload.codeInsee, "ok", null, maintenant);
  }
  ctx.counters.inc(ETAPE.decouverte, "pages_visitees");
  ctx.counters.inc(ETAPE.decouverte, "liens_hors_domaine", succes.horsDomaine);
  ctx.counters.inc(ETAPE.extraction, "mobiles_exclus", succes.mobilesExclus);

  // Une commune sert souvent la meme page sous plusieurs URL (« / », « /accueil »,
  // une pagination qui boucle). Reextraire n'ajouterait aucun contact, mais suivre a
  // nouveau ses liens consommerait le budget pour rien.
  const dejaVu = Number(
    (db.prepare(SQL_DEJA_VU).get(payload.campagne, payload.codeInsee, succes.contentHash, hash) as
      | { n: number }
      | undefined)?.n ?? 0,
  );
  if (dejaVu > 0) {
    ctx.counters.inc(ETAPE.decouverte, "pages_dupliquees");
    return;
  }

  ecrireContacts(ctx, db, payload, succes.contacts, maintenant);
  enfilerFilles(ctx, db, payload, succes.selection, maintenant);
}

function ecrireContacts(
  ctx: ContexteDecouverte,
  db: Database,
  payload: PayloadPage,
  contacts: readonly ContactRattache[],
  maintenant: string,
): void {
  const rattache = db.prepare(sqlContact(true));
  const orphelin = db.prepare(sqlContact(false));
  const resoudre = db.prepare(SQL_RESOUDRE_ASSOCIATION);

  let ecrits = 0;
  let versAssociation = 0;
  let emails = 0;
  let generiques = 0;
  let nominatifs = 0;

  for (const { contact, nomAssociation } of contacts) {
    // L'identifiant est resolu ici, dans la transaction : une association disparue
    // entre la lecture et le commit ferait echouer la cle etrangere, et le job
    // repartirait en boucle sans jamais pouvoir aboutir.
    const candidats =
      nomAssociation === undefined
        ? []
        : (resoudre.all(payload.codeInsee, nomAssociation) as unknown as { id: number }[]);
    const associationId = candidats.length === 1 ? candidats[0]?.id : undefined;

    const methode = associationId === undefined ? contact.methode : `${contact.methode}+nom`;
    // Le rattachement est une inference : la confiance en tient compte, sans quoi une
    // deduction et une lecture directe seraient indistinguables en revue.
    const confiance = associationId === undefined ? contact.confiance : arrondir(contact.confiance * 0.9);

    const parametres = [
      associationId ?? null,
      // `code_insee` est renseigne meme quand l'association l'est : sans lui, on ne
      // saurait plus grouper par commune, et l'etape [7] ne pourrait pas rapprocher
      // la ligne rattachee de son equivalent au niveau commune.
      payload.codeInsee,
      contact.kind,
      contact.valeur,
      contact.valeurNormalisee,
      contact.isGenerique,
      payload.url,
      methode,
      confiance,
      maintenant,
    ];

    const changes = Number(
      (associationId === undefined ? orphelin : rattache).run(...parametres).changes,
    );
    if (changes === 0) continue;

    ecrits += 1;
    if (associationId !== undefined) versAssociation += 1;
    if (contact.kind === "email") {
      emails += 1;
      if (contact.isGenerique === 1) generiques += 1;
      if (contact.isGenerique === 0) nominatifs += 1;
    }
  }

  ctx.counters.inc(ETAPE.extraction, "contacts_ecrits", ecrits);
  ctx.counters.inc(ETAPE.extraction, "emails", emails);
  ctx.counters.inc(ETAPE.extraction, "telephones", ecrits - emails);
  ctx.counters.inc(ETAPE.extraction, "emails_generiques", generiques);
  ctx.counters.inc(ETAPE.extraction, "emails_nominatifs", nominatifs);
  ctx.counters.inc(ETAPE.extraction, "rattaches_association", versAssociation);
  ctx.counters.inc(ETAPE.extraction, "rattaches_commune", ecrits - versAssociation);
}

function enfilerFilles(
  ctx: ContexteDecouverte,
  db: Database,
  payload: PayloadPage,
  selection: readonly LienScore[],
  maintenant: string,
): void {
  if (selection.length === 0) return;

  // Le comptage et les insertions qui en decoulent partagent la transaction de
  // completion du job. `transaction()` ouvre un BEGIN IMMEDIATE, donc une seule
  // ecriture progresse a la fois : le budget ne peut pas etre depasse par deux
  // workers qui compteraient simultanement.
  const deja = Number(
    (db.prepare(SQL_BUDGET).get(payload.campagne, payload.codeInsee) as { n: number } | undefined)?.n ?? 0,
  );
  let restant = payload.maxPages - deja;
  if (restant <= 0) {
    ctx.counters.inc(ETAPE.decouverte, "budget_atteint");
    return;
  }

  const inserer = db.prepare(SQL_INSERER_PAGE);
  let retenus = 0;

  for (const lien of selection) {
    if (restant <= 0) {
      ctx.counters.inc(ETAPE.decouverte, "budget_atteint");
      break;
    }

    const hashFille = hashPage(payload.campagne, payload.codeInsee, lien.url);
    const insere = Number(
      inserer.run(
        hashFille,
        payload.campagne,
        lien.url,
        new URL(lien.url).hostname,
        payload.codeInsee,
        maintenant,
        payload.profondeur + 1,
        lien.score,
        payload.url,
      ).changes,
    );
    // Deja planifiee : le job existe, et la decompter ferait mentir le budget.
    if (insere === 0) continue;

    ctx.queue.enqueue(
      "page_crawl",
      clePage(hashFille),
      {
        codeInsee: payload.codeInsee,
        url: lien.url,
        campagne: payload.campagne,
        profondeur: payload.profondeur + 1,
        maxPages: payload.maxPages,
        avecMobiles: payload.avecMobiles,
      },
      { runId: ctx.runId, priority: prioriteDeScore(lien.score) },
    );
    restant -= 1;
    retenus += 1;
  }

  ctx.counters.inc(ETAPE.decouverte, "liens_retenus", retenus);
}

function arrondir(valeur: number): number {
  return Math.round(valeur * 100) / 100;
}
