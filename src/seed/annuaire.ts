import { ETAPE } from "../metrics/counters.ts";
import { transaction } from "../db/index.ts";
import { toIso } from "../clock.ts";
import { JsonArraySplitter } from "../parse/json-stream.ts";
import { URL_ANNUAIRE_LISTING, appartientAuDepartement, choisirDernierDumpAnnuaire, departementDeCodeInsee } from "../sources.ts";
import type { JobHandler } from "../jobs/worker.ts";
import type { ContexteSeed } from "./contexte.ts";
import { TAILLE_TRANCHE, lireDepartement } from "./contexte.ts";

/**
 * Etape [2] : resolution de l'URL de mairie.
 *
 * La source est le dump JSON du co-marquage — 273 Mo, servi compresse. On le lit en
 * flux plutot que de le stocker : le decoupeur rend les fiches une a une et seules
 * celles du departement demande atteignent la base.
 *
 * Aucune reprise par offset ici, contrairement au RNA : le transfert compresse pese
 * quelques dizaines de Mo, et le recommencer coute moins cher que de renoncer a la
 * compression pour rendre un `Range` exploitable. Les ecritures restent idempotentes,
 * la cle primaire de `commune` s'en charge.
 */

export type FicheMairie = {
  codeInsee: string;
  nom: string;
  urlMairie: string | undefined;
};

const PREFIXE_MAIRIE = /^mairie(\s+\S+)?\s*[-–]\s*/i;

/**
 * Extrait les mairies d'une fiche de service, limitees au departement voulu.
 *
 * Une fiche peut couvrir plusieurs communes : une commune nouvelle conserve les codes
 * INSEE de ses communes deleguees.
 */
export function extraireMairies(brut: string, departement: string): FicheMairie[] {
  let service: Record<string, unknown>;
  try {
    service = JSON.parse(brut) as Record<string, unknown>;
  } catch {
    return [];
  }

  const codes = new Set<string>();
  for (const pivot of tableau(service["pivot"])) {
    if (typeof pivot !== "object" || pivot === null) continue;
    const entree = pivot as Record<string, unknown>;
    if (entree["type_service_local"] !== "mairie") continue;
    for (const code of tableau(entree["code_insee_commune"])) {
      if (typeof code === "string" && code.trim().length > 0) codes.add(code.trim());
    }
  }
  if (codes.size === 0) return [];

  const urlMairie = premierSiteInternet(service["site_internet"]);
  const nomCommune = premierNomCommune(service["adresse"]) ?? nomDepuisLibelle(service["nom"]);

  const fiches: FicheMairie[] = [];
  for (const codeInsee of codes) {
    if (!appartientAuDepartement(codeInsee, departement)) continue;
    fiches.push({ codeInsee, nom: nomCommune, urlMairie });
  }
  return fiches;
}

function tableau(valeur: unknown): readonly unknown[] {
  return Array.isArray(valeur) ? valeur : [];
}

function premierSiteInternet(valeur: unknown): string | undefined {
  for (const entree of tableau(valeur)) {
    if (typeof entree !== "object" || entree === null) continue;
    const brut = (entree as { valeur?: unknown }).valeur;
    if (typeof brut !== "string") continue;
    const url = brut.trim();
    if (url.length === 0) continue;
    // Le dump contient quelques valeurs libres : on n'accepte que ce qui est une URL.
    if (!/^https?:\/\/\S+$/i.test(url)) continue;
    return url;
  }
  return undefined;
}

function premierNomCommune(valeur: unknown): string | undefined {
  for (const entree of tableau(valeur)) {
    if (typeof entree !== "object" || entree === null) continue;
    const nom = (entree as { nom_commune?: unknown }).nom_commune;
    if (typeof nom === "string" && nom.trim().length > 0) return nom.trim();
  }
  return undefined;
}

/** Repli quand l'adresse ne porte pas de commune : « Mairie - Bruz » donne « Bruz ». */
function nomDepuisLibelle(valeur: unknown): string {
  if (typeof valeur !== "string") return "";
  return valeur.replace(PREFIXE_MAIRIE, "").trim();
}

type Deltas = {
  services_lus: number;
  mairies_vues: number;
  communes_touchees: number;
  urls_resolues: number;
  sans_site: number;
};

function deltasVides(): Deltas {
  return { services_lus: 0, mairies_vues: 0, communes_touchees: 0, urls_resolues: 0, sans_site: 0 };
}

const SQL_UPSERT_COMMUNE = `
INSERT INTO commune (code_insee, nom, departement, url_mairie, statut_resolution, source_resolution,
                     resolution_source_url, resolution_collected_at, resolution_confiance,
                     created_at, updated_at)
VALUES (?, ?, ?, ?, ?, 'annuaire_local', ?, ?, ?, ?, ?)
ON CONFLICT (code_insee) DO UPDATE SET
  nom = CASE WHEN excluded.nom <> '' THEN excluded.nom ELSE commune.nom END,
  -- Une fiche sans site (mairie annexe, mairie deleguee) ne doit pas effacer l'URL
  -- deja trouvee : l'ordre de lecture du dump devient ainsi sans consequence.
  url_mairie = COALESCE(excluded.url_mairie, commune.url_mairie),
  statut_resolution = CASE
    WHEN excluded.url_mairie IS NOT NULL THEN 'resolue'
    WHEN commune.url_mairie IS NOT NULL THEN commune.statut_resolution
    ELSE 'sans_site' END,
  source_resolution = CASE
    WHEN excluded.url_mairie IS NOT NULL THEN excluded.source_resolution
    ELSE commune.source_resolution END,
  resolution_source_url = CASE
    WHEN excluded.url_mairie IS NOT NULL THEN excluded.resolution_source_url
    ELSE commune.resolution_source_url END,
  resolution_collected_at = CASE
    WHEN excluded.url_mairie IS NOT NULL THEN excluded.resolution_collected_at
    ELSE commune.resolution_collected_at END,
  resolution_confiance = CASE
    WHEN excluded.url_mairie IS NOT NULL THEN excluded.resolution_confiance
    ELSE commune.resolution_confiance END,
  updated_at = excluded.updated_at`;

/**
 * L'Annuaire est une source officielle et declarative : l'URL y est publiee par la
 * collectivite elle-meme. La confiance est donc haute, mais pas absolue — personne n'a
 * verifie que l'adresse repond encore. Cette verification releve de la decouverte.
 */
const CONFIANCE_ANNUAIRE = 0.9;

export function handlerAnnuaire(ctx: ContexteSeed): JobHandler {
  return async (job, jobCtx) => {
    const departement = lireDepartement(job.payload);
    if (departement === undefined) return { kind: "skipped", reason: "payload sans departement" };

    const urlListing = ctx.sources?.annuaireListing ?? URL_ANNUAIRE_LISTING;
    const listing = await ctx.client.fetch(urlListing, { signal: jobCtx.signal });
    if (listing.kind === "blocked") return { kind: "skipped", reason: listing.reason };
    if (listing.kind === "status") {
      return { kind: "skipped", reason: `listing de l'Annuaire indisponible (statut ${listing.status})` };
    }

    const url = choisirDernierDumpAnnuaire(listing.body.toString("utf8"), urlListing);
    if (url === undefined) return { kind: "skipped", reason: "aucun dump de l'Annuaire dans le listing" };

    const dumpId = ouvrirDump(ctx, url);
    const flux = await ctx.client.openStream(url, { signal: jobCtx.signal });
    if (flux.kind === "blocked") {
      echouerDump(ctx, dumpId, flux.reason);
      return { kind: "skipped", reason: flux.reason };
    }
    if (flux.kind === "status") {
      const raison = `dump de l'Annuaire indisponible (statut ${flux.status})`;
      echouerDump(ctx, dumpId, raison);
      return { kind: "skipped", reason: raison };
    }

    ctx.db.prepare("UPDATE dump SET etag = ?, last_modified = ?, total_bytes = ? WHERE id = ?")
      .run(flux.etag, flux.lastModified, flux.totalBytes, dumpId);

    const upsert = ctx.db.prepare(SQL_UPSERT_COMMUNE);
    const splitter = new JsonArraySplitter("service");
    let fiches: FicheMairie[] = [];
    let deltas = deltasVides();
    let octets = 0;

    const ecrire = (): void => {
      const aEcrire = fiches;
      const aCompter = deltas;
      const position = octets;
      fiches = [];
      deltas = deltasVides();
      transaction(ctx.db, () => {
        const maintenant = toIso(ctx.clock.now());
        for (const fiche of aEcrire) {
          const resolue = fiche.urlMairie !== undefined;
          upsert.run(
            fiche.codeInsee,
            fiche.nom,
            departementDeCodeInsee(fiche.codeInsee) ?? departement,
            fiche.urlMairie ?? null,
            resolue ? "resolue" : "sans_site",
            resolue ? url : null,
            resolue ? maintenant : null,
            resolue ? CONFIANCE_ANNUAIRE : null,
            maintenant,
            maintenant,
          );
        }
        ctx.db.prepare("UPDATE dump SET consumed_bytes = ? WHERE id = ?").run(position, dumpId);
        for (const [nom, valeur] of Object.entries(aCompter)) {
          if (valeur !== 0) ctx.counters.inc(ETAPE.annuaire, nom, valeur);
        }
      });
    };

    for await (const morceau of flux.body) {
      octets += morceau.byteLength;
      for (const brut of splitter.push(morceau)) {
        deltas.services_lus += 1;
        const trouvees = extraireMairies(brut, departement);
        if (trouvees.length > 0) deltas.mairies_vues += 1;
        for (const fiche of trouvees) {
          deltas.communes_touchees += 1;
          if (fiche.urlMairie === undefined) deltas.sans_site += 1;
          else deltas.urls_resolues += 1;
          fiches.push(fiche);
        }
      }
      if (fiches.length >= TAILLE_TRANCHE) ecrire();
    }
    splitter.end();
    ecrire();

    ctx.counters.inc(ETAPE.dump, "octets_lus", octets);
    ctx.logger.info("Resolution des URL de mairie terminee", { departement, octets });

    return {
      kind: "done",
      commit: (db) => {
        db.prepare("UPDATE dump SET statut = 'termine', finished_at = ? WHERE id = ?")
          .run(toIso(ctx.clock.now()), dumpId);
        // L'amorce RNA n'est enfilee qu'ici : elle rattache les associations aux
        // communes, qui n'existent qu'une fois cette etape passee. Comme l'enfilement
        // partage la transaction de completion du job, il ne peut ni se perdre ni se
        // dupliquer si le process meurt entre les deux.
        enfilerAmorceRna(ctx, job.payload, departement);
      },
    };
  };
}

/**
 * Enfile l'amorce RNA qui suit la resolution des communes.
 *
 * La cle de deduplication porte le mois : le RNA est publie mensuellement, donc rejouer
 * un run dans le meme mois ne retelecharge rien, tandis que le mois suivant repart.
 */
function enfilerAmorceRna(ctx: ContexteSeed, payload: unknown, departement: string): void {
  const charge = (typeof payload === "object" && payload !== null ? payload : {}) as {
    avecImport?: unknown;
    rnaFile?: unknown;
  };
  const rnaFile = typeof charge.rnaFile === "string" && charge.rnaFile.length > 0 ? charge.rnaFile : undefined;
  const mois = toIso(ctx.clock.now()).slice(0, 7);

  ctx.queue.enqueue(
    "rna_seed",
    `rna_waldec:${departement}:${mois}`,
    { departement, source: "rna_waldec", ...(rnaFile === undefined ? {} : { rnaFile }) },
    { runId: ctx.runId },
  );

  // Un fichier fourni a la main ne contient qu'une extraction : on ne va pas chercher
  // l'autre sur le reseau sans que ce soit demande.
  if (charge.avecImport === true && rnaFile === undefined) {
    ctx.queue.enqueue(
      "rna_seed",
      `rna_import:${departement}:${mois}`,
      { departement, source: "rna_import" },
      { runId: ctx.runId },
    );
  }
}

/**
 * Ouvre — ou reprend — la ligne de suivi du dump. L'index unique partiel garantit qu'il
 * n'y en a jamais qu'une en cours par source, donc que la reprise ne choisit pas.
 */
function ouvrirDump(ctx: ContexteSeed, url: string): number {
  const existant = ctx.db
    .prepare("SELECT id FROM dump WHERE source = 'annuaire_local' AND statut = 'en_cours'")
    .get() as { id?: number } | undefined;
  if (existant?.id !== undefined) {
    ctx.db.prepare("UPDATE dump SET url = ?, consumed_bytes = 0 WHERE id = ?").run(url, existant.id);
    return Number(existant.id);
  }
  const info = ctx.db
    .prepare("INSERT INTO dump (source, url, statut, started_at) VALUES ('annuaire_local', ?, 'en_cours', ?)")
    .run(url, toIso(ctx.clock.now()));
  return Number(info.lastInsertRowid);
}

function echouerDump(ctx: ContexteSeed, dumpId: number, raison: string): void {
  ctx.db
    .prepare("UPDATE dump SET statut = 'echec', derniere_erreur = ?, finished_at = ? WHERE id = ?")
    .run(raison, toIso(ctx.clock.now()), dumpId);
}
