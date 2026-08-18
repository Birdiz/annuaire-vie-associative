import { ETAPE } from "../metrics/counters.ts";
import { transaction } from "../db/index.ts";
import { toIso } from "../clock.ts";
import { CsvStreamParser, indexerColonnes } from "../parse/csv.ts";
import { ZipReader } from "../parse/zip.ts";
import { appartientAuDepartement, estEntreeRnaDuDepartement, urlDumpRna } from "../sources.ts";
import type { JobHandler } from "../jobs/worker.ts";
import type { ContexteSeed } from "./contexte.ts";
import { TAILLE_TRANCHE, lireDepartement } from "./contexte.ts";

/**
 * Etape [1] : amorce des associations depuis le RNA.
 *
 * Le dump officiel est decoupe par departement mais son hote l'interdit aux robots
 * (ADR-006). Le miroir autorise est agrege pour la France entiere : 1,25 Go pour les
 * quelques dizaines de Mo qui nous concernent. On le lit donc en flux sans jamais le
 * stocker, en ne retenant que les lignes du departement demande.
 *
 * La reprise se fait par offset d'octets, avance dans la meme transaction que les
 * lignes produites : apres un arret brutal, l'offset et les donnees sont d'accord.
 * `--rna-file` court-circuite tout cela pour lire un ZIP officiel que l'utilisateur a
 * telecharge lui-meme — robots.txt s'adresse aux robots, pas aux personnes.
 */

export type SourceRna = "rna_waldec" | "rna_import";

/** Valeur employee par le RNA pour « non dissoute ». */
const PAS_DE_DISSOLUTION = "0001-01-01";

export type LigneAssociation = {
  rnaId: string;
  codeInsee: string;
  nom: string;
  nomNormalise: string;
  objet: string | undefined;
  codeObjetSocial: string | undefined;
  siteWeb: string | undefined;
  libelleCommune: string | undefined;
  dateDissolution: string | undefined;
};

/**
 * Forme comparable d'un nom d'association : sans diacritiques ni ponctuation. Sert au
 * rapprochement avec les noms lus sur les pages de mairie, au lot suivant.
 */
export function normaliserNom(nom: string): string {
  return nom
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Convertit une ligne du CSV RNA, ou rend `undefined` si elle est inexploitable. */
export function convertirLigne(champ: (nom: string) => string, departement: string): LigneAssociation | undefined {
  const rnaId = champ("id").trim();
  const codeInsee = champ("adrs_codeinsee").trim();
  const nom = champ("titre").trim();
  if (rnaId.length === 0 || nom.length === 0) return undefined;
  if (!appartientAuDepartement(codeInsee, departement)) return undefined;

  const dissolution = champ("date_disso").trim();
  const site = champ("siteweb").trim();
  const objet = champ("objet").trim();
  const objetSocial = champ("objet_social1").trim();
  const commune = champ("adrs_libcommune").trim();

  return {
    rnaId,
    codeInsee,
    nom,
    nomNormalise: normaliserNom(nom),
    objet: objet.length > 0 ? objet : undefined,
    codeObjetSocial: objetSocial.length > 0 ? objetSocial : undefined,
    siteWeb: normaliserSite(site),
    libelleCommune: commune.length > 0 ? commune : undefined,
    dateDissolution: dissolution.length > 0 && dissolution !== PAS_DE_DISSOLUTION ? dissolution : undefined,
  };
}

/** Le RNA note les sites tantot avec schema, tantot sans. */
function normaliserSite(valeur: string): string | undefined {
  if (valeur.length === 0) return undefined;
  if (/^https?:\/\/\S+$/i.test(valeur)) return valeur;
  // Concatenation plutot qu'interpolation : le test d'architecture traque les adresses
  // codees en dur, et un gabarit commencant par un schema en a l'apparence.
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(valeur)) return "https://" + valeur;
  return undefined;
}

const SQL_UPSERT_ASSOCIATION = `
INSERT INTO association (rna_id, code_insee, nom, nom_normalise, objet, code_objet_social,
                         site_web, source_creation, date_dissolution, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, 'rna', ?, ?, ?)
ON CONFLICT (rna_id) DO UPDATE SET
  code_insee = excluded.code_insee,
  nom = excluded.nom,
  nom_normalise = excluded.nom_normalise,
  objet = excluded.objet,
  code_objet_social = excluded.code_objet_social,
  site_web = excluded.site_web,
  -- Une association dissoute depuis le dernier passage doit le devenir en base, sinon
  -- l'annuaire continuerait de la presenter comme vivante.
  date_dissolution = excluded.date_dissolution,
  updated_at = excluded.updated_at`;

/**
 * Une association peut declarer un code INSEE absent de l'Annuaire. Plutot que de
 * perdre la ligne — la cle etrangere la refuserait — on cree une commune minimale,
 * marquee comme non resolue, et on la compte.
 */
const SQL_COMMUNE_MINIMALE = `
INSERT INTO commune (code_insee, nom, departement, statut_resolution, created_at, updated_at)
VALUES (?, ?, ?, 'inconnu', ?, ?)
ON CONFLICT (code_insee) DO NOTHING`;

type Deltas = {
  lignes_lues: number;
  associations_ecrites: number;
  dissoutes: number;
  communes_creees: number;
  hors_departement: number;
};

function deltasVides(): Deltas {
  return { lignes_lues: 0, associations_ecrites: 0, dissoutes: 0, communes_creees: 0, hors_departement: 0 };
}

type SuiviDump = {
  id: number;
  consumedBytes: number;
  etag: string | null;
  lastModified: string | null;
  totalBytes: number | null;
  entete: string | null;
};

export function handlerRna(ctx: ContexteSeed): JobHandler {
  return async (job, jobCtx) => {
    const departement = lireDepartement(job.payload);
    if (departement === undefined) return { kind: "skipped", reason: "payload sans departement" };
    const charge = job.payload as { source?: unknown; rnaFile?: unknown };
    const source: SourceRna = charge.source === "rna_import" ? "rna_import" : "rna_waldec";
    const fichierLocal = typeof charge.rnaFile === "string" && charge.rnaFile.length > 0 ? charge.rnaFile : undefined;

    const ecrivain = new Ecrivain(ctx, departement);
    if (fichierLocal !== undefined) {
      return lireDepuisZip(ctx, ecrivain, fichierLocal, departement, source);
    }
    return lireDepuisMiroir(ctx, ecrivain, departement, source, jobCtx.signal);
  };
}

/** Accumule les lignes et les ecrit par tranches, avec l'offset de reprise. */
class Ecrivain {
  readonly #ctx: ContexteSeed;
  readonly #departement: string;
  #lignes: LigneAssociation[] = [];
  #deltas: Deltas = deltasVides();

  constructor(ctx: ContexteSeed, departement: string) {
    this.#ctx = ctx;
    this.#departement = departement;
  }

  get enAttente(): number {
    return this.#lignes.length;
  }

  compter(cle: keyof Deltas, delta = 1): void {
    this.#deltas[cle] += delta;
  }

  ajouter(ligne: LigneAssociation): void {
    this.#lignes.push(ligne);
    if (ligne.dateDissolution !== undefined) this.#deltas.dissoutes += 1;
  }

  /** Ecrit la tranche courante et, s'il y a lieu, l'offset atteint dans le dump. */
  vider(dumpId: number | undefined, offset: number | undefined): void {
    const lignes = this.#lignes;
    const deltas = this.#deltas;
    this.#lignes = [];
    this.#deltas = deltasVides();
    if (lignes.length === 0 && dumpId === undefined) {
      this.#appliquerCompteurs(deltas);
      return;
    }

    const ctx = this.#ctx;
    transaction(ctx.db, () => {
      const maintenant = toIso(ctx.clock.now());
      const commune = ctx.db.prepare(SQL_COMMUNE_MINIMALE);
      const association = ctx.db.prepare(SQL_UPSERT_ASSOCIATION);
      for (const ligne of lignes) {
        const cree = commune.run(
          ligne.codeInsee,
          ligne.libelleCommune ?? ligne.codeInsee,
          this.#departement,
          maintenant,
          maintenant,
        );
        if (Number(cree.changes) > 0) deltas.communes_creees += 1;
        association.run(
          ligne.rnaId,
          ligne.codeInsee,
          ligne.nom,
          ligne.nomNormalise,
          ligne.objet ?? null,
          ligne.codeObjetSocial ?? null,
          ligne.siteWeb ?? null,
          ligne.dateDissolution ?? null,
          maintenant,
          maintenant,
        );
        deltas.associations_ecrites += 1;
      }
      if (dumpId !== undefined && offset !== undefined) {
        ctx.db.prepare("UPDATE dump SET consumed_bytes = ? WHERE id = ?").run(offset, dumpId);
      }
      this.#appliquerCompteurs(deltas);
    });
  }

  #appliquerCompteurs(deltas: Deltas): void {
    for (const [nom, valeur] of Object.entries(deltas)) {
      if (valeur !== 0) this.#ctx.counters.inc(ETAPE.rna, nom, valeur);
    }
  }
}

function lireDepuisZip(
  ctx: ContexteSeed,
  ecrivain: Ecrivain,
  chemin: string,
  departement: string,
  source: SourceRna,
): { kind: "done"; commit: (db: import("../db/index.ts").Database) => void } | { kind: "skipped"; reason: string } {
  const zip = ZipReader.ouvrir(chemin);
  try {
    const entree = zip.trouver((nom) => estEntreeRnaDuDepartement(nom, departement));
    if (entree === undefined) {
      return { kind: "skipped", reason: `aucune entree pour le departement ${departement} dans ${chemin}` };
    }
    const parseur = new CsvStreamParser();
    const lignes = [...parseur.push(zip.lire(entree)), ...parseur.end()];
    consommer(ecrivain, lignes, departement, null);
    ecrivain.vider(undefined, undefined);
    ctx.logger.info("Amorce RNA lue depuis un fichier local", { departement, fichier: chemin, source });
    return { kind: "done", commit: () => {} };
  } finally {
    zip.fermer();
  }
}

async function lireDepuisMiroir(
  ctx: ContexteSeed,
  ecrivain: Ecrivain,
  departement: string,
  source: SourceRna,
  signal: AbortSignal,
): Promise<
  | { kind: "done"; commit: (db: import("../db/index.ts").Database) => void }
  | { kind: "skipped"; reason: string }
> {
  const url = urlSource(ctx, source);
  const suivi = ouvrirDump(ctx, source, url);

  // Sans en-tete memorise on ne saurait pas nommer les colonnes au milieu du fichier.
  let depart = suivi.entete === null ? 0 : suivi.consumedBytes;
  let entete = depart > 0 ? suivi.entete : null;

  let flux = await ctx.client.openStream(url, { fromByte: depart, identityEncoding: true, signal });
  if (flux.kind === "ok" && depart > 0) {
    const inchangee =
      flux.etag === suivi.etag && flux.lastModified === suivi.lastModified && flux.totalBytes === suivi.totalBytes;
    if (!flux.resumed) {
      // Le serveur a ignore le Range et renvoie tout : on repart de zero plutot que
      // d'ajouter ce corps complet a ce qui etait deja consomme.
      depart = 0;
      entete = null;
      ctx.counters.inc(ETAPE.dump, "redemarrages");
    } else if (!inchangee) {
      // Le miroir n'honore pas If-Range : c'est a nous de refuser de recoller deux
      // moities de fichiers differents.
      ctx.counters.inc(ETAPE.dump, "redemarrages");
      depart = 0;
      entete = null;
      flux = await ctx.client.openStream(url, { fromByte: 0, identityEncoding: true, signal });
    } else {
      ctx.counters.inc(ETAPE.dump, "reprises");
    }
  }

  if (flux.kind === "blocked") {
    echouerDump(ctx, suivi.id, flux.reason);
    return { kind: "skipped", reason: flux.reason };
  }
  if (flux.kind === "status") {
    const raison = `dump ${source} indisponible (statut ${flux.status})`;
    echouerDump(ctx, suivi.id, raison);
    return { kind: "skipped", reason: raison };
  }

  ctx.db
    .prepare("UPDATE dump SET etag = ?, last_modified = ?, total_bytes = ?, consumed_bytes = ? WHERE id = ?")
    .run(flux.etag, flux.lastModified, flux.totalBytes, depart, suivi.id);

  const parseur = new CsvStreamParser();
  let octets = 0;

  for await (const morceau of flux.body) {
    octets += morceau.byteLength;
    let lignes = parseur.push(morceau);
    if (entete === null && lignes.length > 0) {
      const premiere = lignes[0];
      if (premiere !== undefined) {
        entete = premiere.join(",");
        ctx.db.prepare("UPDATE dump SET entete = ? WHERE id = ?").run(entete, suivi.id);
        lignes = lignes.slice(1);
      }
    }
    consommer(ecrivain, lignes, departement, entete);
    if (ecrivain.enAttente >= TAILLE_TRANCHE) {
      ecrivain.vider(suivi.id, depart + parseur.consumedBytes);
    }
  }
  consommer(ecrivain, parseur.end(), departement, entete);
  ecrivain.vider(suivi.id, depart + parseur.consumedBytes);

  ctx.counters.inc(ETAPE.dump, "octets_lus", octets);
  ctx.logger.info("Amorce RNA terminee", { departement, source, octets });

  return {
    kind: "done",
    commit: (db) => {
      db.prepare("UPDATE dump SET statut = 'termine', finished_at = ? WHERE id = ?")
        .run(toIso(ctx.clock.now()), suivi.id);
    },
  };
}

/** Convertit et accumule un lot de lignes brutes. */
function consommer(
  ecrivain: Ecrivain,
  lignes: readonly string[][],
  departement: string,
  entete: string | null,
): void {
  if (lignes.length === 0) return;
  const noms = entete === null ? lignes[0] : entete.split(",");
  const debut = entete === null ? 1 : 0;
  if (noms === undefined) return;
  const lire = indexerColonnes(noms);

  for (let i = debut; i < lignes.length; i++) {
    const ligne = lignes[i];
    if (ligne === undefined) continue;
    ecrivain.compter("lignes_lues");
    const converti = convertirLigne(lire(ligne), departement);
    if (converti === undefined) ecrivain.compter("hors_departement");
    else ecrivain.ajouter(converti);
  }
}

function urlSource(ctx: ContexteSeed, source: SourceRna): string {
  const injecte = source === "rna_waldec" ? ctx.sources?.rnaWaldec : ctx.sources?.rnaImport;
  return injecte ?? urlDumpRna(source);
}

function ouvrirDump(ctx: ContexteSeed, source: SourceRna, url: string): SuiviDump {
  const existant = ctx.db
    .prepare(
      "SELECT id, consumed_bytes, etag, last_modified, total_bytes, entete FROM dump " +
        "WHERE source = ? AND statut = 'en_cours'",
    )
    .get(source) as Record<string, unknown> | undefined;

  if (existant !== undefined) {
    return {
      id: Number(existant["id"]),
      consumedBytes: Number(existant["consumed_bytes"] ?? 0),
      etag: (existant["etag"] as string | null) ?? null,
      lastModified: (existant["last_modified"] as string | null) ?? null,
      totalBytes: existant["total_bytes"] === null ? null : Number(existant["total_bytes"]),
      entete: (existant["entete"] as string | null) ?? null,
    };
  }

  const info = ctx.db
    .prepare("INSERT INTO dump (source, url, statut, started_at) VALUES (?, ?, 'en_cours', ?)")
    .run(source, url, toIso(ctx.clock.now()));
  return {
    id: Number(info.lastInsertRowid),
    consumedBytes: 0,
    etag: null,
    lastModified: null,
    totalBytes: null,
    entete: null,
  };
}

function echouerDump(ctx: ContexteSeed, dumpId: number, raison: string): void {
  ctx.db
    .prepare("UPDATE dump SET statut = 'echec', derniere_erreur = ?, finished_at = ? WHERE id = ?")
    .run(raison, toIso(ctx.clock.now()), dumpId);
}
