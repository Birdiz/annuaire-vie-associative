import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, existsSync, statSync, readdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";

/**
 * Cache HTTP sur disque, adresse par hash d'URL canonicalisee.
 *
 * Deux fichiers par entree : le corps, puis les metadonnees. Les deux sont ecrits en
 * temporaire puis renommes — `rename` est atomique sur un meme systeme de fichiers, si
 * bien qu'un `kill -9` en cours d'ecriture laisse au pire un fichier temporaire
 * orphelin, jamais une entree tronquee que le run suivant relirait comme valide.
 *
 * Les metadonnees font office de marqueur de validite : elles ne sont ecrites qu'apres
 * le corps. Une entree dont le corps manque est donc traitee comme absente.
 */

export type CacheMeta = {
  /** URL canonicalisee ayant servi de cle. */
  url: string;
  /** URL finale apres redirections. */
  finalUrl: string;
  status: number;
  etag: string | null;
  lastModified: string | null;
  contentType: string | null;
  size: number;
  fetchedAt: string;
};

export type CacheHit = {
  meta: CacheMeta;
  body: Buffer;
};

/**
 * Canonicalisation : deux URL qui designent la meme ressource doivent produire la meme
 * cle, sans quoi le cache se remplit de doublons et le throttle compte mal.
 *
 * Le chemin garde sa casse : contrairement au schema et a l'hote, il est sensible a la
 * casse sur la plupart des serveurs.
 */
export function canonicalizeUrl(input: string | URL): string {
  const url = new URL(normalizeForRequest(input));

  // Le tri de la query n'appartient qu'a la cle : il passe par `URLSearchParams`, qui
  // reserialise (« %20 » devient « + »). Excellent pour reconnaitre deux URL
  // equivalentes, inacceptable pour ce qu'on envoie au serveur — d'ou la separation.
  const params = [...url.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  url.search = "";
  for (const [key, value] of params) url.searchParams.append(key, value);

  return url.toString();
}

/**
 * Normalisation de ce qui part reellement sur le reseau : fragment retire (il ne
 * traverse pas HTTP), schema et hote en minuscules, port par defaut et chemin vide
 * remis en forme. **La query n'est pas touchee** — la trier ou la reencoder reviendrait
 * a demander autre chose que ce que l'appelant a demande.
 */
export function normalizeForRequest(input: string | URL): string {
  const url = new URL(input);
  url.hash = "";
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();

  if ((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443")) {
    url.port = "";
  }
  if (url.pathname === "") url.pathname = "/";

  return url.toString();
}

/**
 * Age minimal d'un fichier incomplet avant qu'il soit considere comme abandonne. Une
 * heure : sans commune mesure avec la fenetre d'ecriture d'une entree, qui est
 * synchrone, ni avec la borne de retention de trois ans.
 */
const DELAI_DE_GRACE_MS = 3_600_000;

export function urlHash(url: string | URL): string {
  return createHash("sha256").update(canonicalizeUrl(url), "utf8").digest("hex");
}

export class HttpCache {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
    mkdirSync(root, { recursive: true });
  }

  /** Chemin relatif du corps, tel que stocke dans `page.cache_path`. */
  relativeBodyPath(url: string | URL): string {
    const hash = urlHash(url);
    return join(hash.slice(0, 2), hash.slice(2, 4), `${hash}.body`);
  }

  get(url: string | URL): CacheHit | undefined {
    const { metaPath, bodyPath } = this.#pathsFor(url);
    if (!existsSync(metaPath)) {
      // Corps sans metadonnees : le `kill -9` tombe entre les deux ecritures de `set()`.
      // L'entree est inutilisable, mais elle porte du HTML de mairie — donc des donnees
      // personnelles. L'ignorer sans la supprimer la rendait immortelle, la purge ne
      // parcourant que les fichiers de metadonnees (§4.8).
      this.#removeFiles(metaPath, bodyPath);
      return undefined;
    }

    let meta: CacheMeta;
    try {
      meta = JSON.parse(readFileSync(metaPath, "utf8")) as CacheMeta;
    } catch {
      // Metadonnees illisibles : on considere l'entree absente plutot que de deviner.
      this.#removeFiles(metaPath, bodyPath);
      return undefined;
    }

    if (!existsSync(bodyPath)) {
      this.#removeFiles(metaPath, bodyPath);
      return undefined;
    }

    const body = readFileSync(bodyPath);
    if (body.byteLength !== meta.size) {
      this.#removeFiles(metaPath, bodyPath);
      return undefined;
    }

    return { meta, body };
  }

  set(url: string | URL, meta: Omit<CacheMeta, "url" | "size">, body: Buffer): CacheMeta {
    const { dir, metaPath, bodyPath } = this.#pathsFor(url);
    mkdirSync(dir, { recursive: true });

    const complete: CacheMeta = {
      ...meta,
      url: canonicalizeUrl(url),
      size: body.byteLength,
    };

    // Corps d'abord, metadonnees ensuite : l'ordre fait la validite de l'entree.
    writeAtomic(bodyPath, body);
    writeAtomic(metaPath, Buffer.from(`${JSON.stringify(complete, null, 2)}\n`, "utf8"));
    return complete;
  }

  /** Rafraichit l'horodatage sans retelecharger, apres un 304. */
  touch(url: string | URL, fetchedAt: string): void {
    const hit = this.get(url);
    if (hit === undefined) return;
    const { metaPath } = this.#pathsFor(url);
    writeAtomic(metaPath, Buffer.from(`${JSON.stringify({ ...hit.meta, fetchedAt }, null, 2)}\n`, "utf8"));
  }

  delete(url: string | URL): void {
    const { metaPath, bodyPath } = this.#pathsFor(url);
    this.#removeFiles(metaPath, bodyPath);
  }

  /**
   * Supprime une entree designee par le chemin relatif stocke dans `page.cache_path`.
   *
   * Sert a l'effacement (art. 17) : le contact est supprime en base, et la page qui le
   * portait garde son HTML brut — donc l'adresse elle-meme. Passer par le chemin plutot
   * que par l'URL evite d'avoir a la recanonicaliser, et de se tromper.
   */
  supprimerParChemin(cheminRelatif: string): boolean {
    // Le chemin vient de la base, mais il decrit un emplacement disque : on refuse tout
    // ce qui sortirait du cache, plutot que de faire confiance a une colonne.
    const bodyPath = resolve(this.#root, cheminRelatif);
    if (!bodyPath.startsWith(resolve(this.#root) + sep)) return false;
    if (!existsSync(bodyPath)) return false;
    this.#removeFiles(bodyPath.replace(/\.body$/, ".meta.json"), bodyPath);
    return true;
  }

  /**
   * Supprime les entrees plus anciennes que la borne. Renvoie le nombre d'entrees
   * supprimees.
   *
   * **La date qui fait foi est `meta.fetchedAt`, pas le `mtime` du fichier.** S'en
   * remettre au systeme de fichiers rendait la retention dependante de tout ce qui
   * reecrit les horodatages — restauration de sauvegarde, `docker cp`, copie du
   * repertoire, synchronisation cloud : des donnees de plus de trois ans redevenaient
   * « fraiches » aux yeux de la purge, et definitivement.
   *
   * Le `mtime` garde un role, mais seulement comme raccourci sur : il ne peut qu'etre
   * **posterieur** a `fetchedAt` (il est pose a l'ecriture, et ne fait ensuite
   * qu'augmenter). Un fichier deja plus vieux que la borne l'est donc a coup sur, et se
   * supprime sans lire son JSON. Le cout de lecture ne revient que pour les entrees
   * candidates a la conservation.
   *
   * Le parcours porte sur **toutes** les entrees et non sur les seuls fichiers de
   * metadonnees : un corps orphelin ou un temporaire abandonne par un `kill -9` porte
   * les memes donnees personnelles, et n'etait jamais nettoye.
   */
  pruneOlderThan(cutoffMs: number, nowMs: number = Date.now()): number {
    let removed = 0;
    for (const bucket of readdirSafe(this.#root)) {
      const bucketPath = join(this.#root, bucket);
      if (!isDirectory(bucketPath)) continue;
      for (const sub of readdirSafe(bucketPath)) {
        const subPath = join(bucketPath, sub);
        if (!isDirectory(subPath)) continue;
        removed += this.#pruneDir(subPath, cutoffMs, nowMs);
      }
    }
    return removed;
  }

  #pruneDir(subPath: string, cutoffMs: number, nowMs: number): number {
    const fichiers = readdirSafe(subPath);
    const avecMeta = new Set(
      fichiers.filter((f) => f.endsWith(".meta.json")).map((f) => f.slice(0, -".meta.json".length)),
    );

    let removed = 0;
    for (const file of fichiers) {
      const chemin = join(subPath, file);

      // Temporaire abandonne entre `writeFileSync` et `renameSync`, et corps sans
      // metadonnees : dans les deux cas l'entree est inutilisable. Le delai de grace
      // couvre largement la fenetre d'ecriture d'un autre process — l'ecriture est
      // synchrone — sans approcher la borne de retention.
      if (file.endsWith(".tmp") || (file.endsWith(".body") && !avecMeta.has(file.slice(0, -".body".length)))) {
        const stats = statSafe(chemin);
        if (stats !== undefined && nowMs - stats.mtimeMs > DELAI_DE_GRACE_MS) {
          rmSync(chemin, { force: true });
          removed += 1;
        }
        continue;
      }

      if (!file.endsWith(".meta.json")) continue;
      const bodyPath = join(subPath, `${file.slice(0, -".meta.json".length)}.body`);
      const stats = statSafe(chemin);
      if (stats === undefined) continue;

      if (stats.mtimeMs >= cutoffMs && !this.#collecteAvant(chemin, cutoffMs)) continue;
      this.#removeFiles(chemin, bodyPath);
      removed += 1;
    }
    return removed;
  }

  /** Vrai si l'entree a ete collectee avant la borne, ou si ses metadonnees sont illisibles. */
  #collecteAvant(metaPath: string, cutoffMs: number): boolean {
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf8")) as CacheMeta;
      const collecte = Date.parse(meta.fetchedAt);
      // Un horodatage illisible ne protege pas l'entree : on ne conserve pas une donnee
      // personnelle sur la foi d'un champ qu'on ne sait pas lire.
      return !Number.isFinite(collecte) || collecte < cutoffMs;
    } catch {
      return true;
    }
  }

  #pathsFor(url: string | URL): { dir: string; metaPath: string; bodyPath: string } {
    const hash = urlHash(url);
    const dir = join(this.#root, hash.slice(0, 2), hash.slice(2, 4));
    return {
      dir,
      metaPath: join(dir, `${hash}.meta.json`),
      bodyPath: join(dir, `${hash}.body`),
    };
  }

  #removeFiles(metaPath: string, bodyPath: string): void {
    rmSync(metaPath, { force: true });
    rmSync(bodyPath, { force: true });
  }
}

/** Ecriture atomique : temporaire voisin puis `rename`. */
export function writeAtomic(target: string, content: Buffer): void {
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, target);
}

function readdirSafe(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function statSafe(path: string) {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

function isDirectory(path: string): boolean {
  return statSafe(path)?.isDirectory() ?? false;
}
