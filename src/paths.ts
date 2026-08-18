import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";

const APP_DIR_NAME = "annuaire-vie-associative";

export type Paths = {
  /** Racine de tout ce que l'outil ecrit sur disque. */
  dataDir: string;
  /** Le fichier SQLite unique. */
  dbFile: string;
  /** Cache HTTP adresse par hash d'URL. */
  cacheDir: string;
  /** Telechargements volumineux (dumps RNA, annuaire de l'administration). */
  downloadsDir: string;
  /** Journal structure. */
  logFile: string;
  /** Fichier de configuration de l'utilisateur. */
  configFile: string;
};

export type Environment = {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
};

export const realEnvironment: Environment = {
  platform: process.platform,
  env: process.env,
  home: homedir(),
};

/**
 * Ordre de resolution : argument explicite, puis variable d'environnement, puis
 * emplacement conventionnel de la plateforme.
 *
 * Sur les plateformes non-Windows on suit XDG plutot que les conventions macOS :
 * la cible de distribution est Windows et Docker, macOS n'est qu'un poste de
 * developpement, et une regle unique vaut mieux qu'une branche de plus.
 */
export function resolveDataDir(explicit: string | undefined, e: Environment): string {
  if (explicit !== undefined && explicit !== "") return resolve(explicit);

  const fromEnv = e.env["ANNUAIRE_DATA_DIR"];
  if (fromEnv !== undefined && fromEnv !== "") return resolve(fromEnv);

  if (e.platform === "win32") {
    const base = e.env["LOCALAPPDATA"];
    if (base !== undefined && base !== "") return join(base, APP_DIR_NAME);
    return join(e.home, "AppData", "Local", APP_DIR_NAME);
  }

  const xdg = e.env["XDG_DATA_HOME"];
  if (xdg !== undefined && xdg !== "") return join(xdg, APP_DIR_NAME);
  return join(e.home, ".local", "share", APP_DIR_NAME);
}

export function buildPaths(dataDir: string): Paths {
  return {
    dataDir,
    dbFile: join(dataDir, "annuaire.sqlite"),
    cacheDir: join(dataDir, "cache"),
    downloadsDir: join(dataDir, "downloads"),
    logFile: join(dataDir, "annuaire.log"),
    configFile: join(dataDir, "config.json"),
  };
}

export function resolvePaths(
  explicit: string | undefined,
  e: Environment = realEnvironment,
): Paths {
  return buildPaths(resolveDataDir(explicit, e));
}

/** Cree l'arborescence. Idempotent : relancer `init` ne casse rien. */
export function ensurePaths(paths: Paths): void {
  mkdirSync(paths.dataDir, { recursive: true });
  mkdirSync(paths.cacheDir, { recursive: true });
  mkdirSync(paths.downloadsDir, { recursive: true });
}
