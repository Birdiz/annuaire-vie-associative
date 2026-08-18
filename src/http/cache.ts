import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, existsSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";

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
  const url = new URL(input);
  url.hash = "";
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();

  if ((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443")) {
    url.port = "";
  }
  if (url.pathname === "") url.pathname = "/";

  const params = [...url.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  url.search = "";
  for (const [key, value] of params) url.searchParams.append(key, value);

  return url.toString();
}

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
    if (!existsSync(metaPath)) return undefined;

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
   * Supprime les entrees plus anciennes que la borne, en s'appuyant sur la date de
   * modification du fichier plutot que sur les metadonnees : la purge doit rester
   * praticable sur des centaines de milliers d'entrees, sans lire un JSON par entree.
   *
   * Renvoie le nombre d'entrees supprimees.
   */
  pruneOlderThan(cutoffMs: number): number {
    let removed = 0;
    for (const bucket of readdirSafe(this.#root)) {
      const bucketPath = join(this.#root, bucket);
      if (!isDirectory(bucketPath)) continue;
      for (const sub of readdirSafe(bucketPath)) {
        const subPath = join(bucketPath, sub);
        if (!isDirectory(subPath)) continue;
        for (const file of readdirSafe(subPath)) {
          if (!file.endsWith(".meta.json")) continue;
          const metaPath = join(subPath, file);
          const bodyPath = metaPath.replace(/\.meta\.json$/, ".body");
          const stats = statSafe(metaPath);
          if (stats === undefined || stats.mtimeMs >= cutoffMs) continue;
          this.#removeFiles(metaPath, bodyPath);
          removed += 1;
        }
      }
    }
    return removed;
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
