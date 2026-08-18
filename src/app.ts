import { resolvePaths, ensurePaths } from "./paths.ts";
import type { Paths, Environment } from "./paths.ts";
import { realEnvironment } from "./paths.ts";
import { loadConfig, requireContactUrl } from "./config.ts";
import type { Config } from "./config.ts";
import { openDatabase } from "./db/index.ts";
import type { Database } from "./db/index.ts";
import { HttpCache } from "./http/cache.ts";
import { DomainThrottle } from "./http/throttle.ts";
import { HttpClient, buildUserAgent } from "./http/client.ts";
import { JobQueue } from "./jobs/queue.ts";
import { Counters } from "./metrics/counters.ts";
import { Logger } from "./log.ts";
import type { LogLevel } from "./log.ts";
import { purge } from "./purge.ts";
import type { PurgeResult } from "./purge.ts";
import { systemClock } from "./clock.ts";
import type { Clock } from "./clock.ts";
import { VERSION } from "./version.ts";

/**
 * Assemblage de l'application.
 *
 * Un seul endroit construit le client HTTP, et il ne lui passe jamais de delai : le
 * throttle prend sa valeur par defaut, celle de `invariants.ts`. C'est la contrepartie
 * concrete de « les invariants ne sont pas configurables ».
 */

export type App = {
  paths: Paths;
  config: Config;
  db: Database;
  cache: HttpCache;
  queue: JobQueue;
  counters: Counters;
  logger: Logger;
  clock: Clock;
  /** Absent tant qu'aucune URL de contact n'est configuree (§4.4). */
  client: HttpClient | undefined;
  close(): void;
};

export type OpenAppOptions = {
  dataDir?: string | undefined;
  env?: Environment;
  processEnv?: Record<string, string | undefined>;
  clock?: Clock;
  logLevel?: LogLevel;
  console?: boolean;
};

export function openApp(options: OpenAppOptions = {}): App {
  const paths = resolvePaths(options.dataDir, options.env ?? realEnvironment);
  ensurePaths(paths);

  const clock = options.clock ?? systemClock;
  const config = loadConfig(paths.configFile, options.processEnv ?? process.env);
  const db = openDatabase(paths.dbFile, clock);
  const counters = new Counters(db, null);
  const cache = new HttpCache(paths.cacheDir);
  const queue = new JobQueue(db, clock, counters);

  const logger = new Logger({
    file: paths.logFile,
    level: options.logLevel ?? "info",
    console: options.console ?? true,
    clock,
  });

  // Sans URL de contact, aucun client n'est construit : il vaut mieux qu'une commande
  // de collecte echoue a l'assemblage qu'emettre une requete anonyme.
  const client =
    config.contactUrl === undefined
      ? undefined
      : new HttpClient({
          cache,
          throttle: new DomainThrottle(),
          counters,
          userAgent: buildUserAgent(VERSION, config.contactUrl),
          cacheTtlMs: config.cacheTtlHours * 3_600_000,
          clock,
        });

  return {
    paths,
    config,
    db,
    cache,
    queue,
    counters,
    logger,
    clock,
    client,
    close: () => db.close(),
  };
}

/** Echoue avec un message actionnable si la collecte n'est pas configurable. */
export function requireClient(app: App): HttpClient {
  requireContactUrl(app.config);
  if (app.client === undefined) throw new Error("Client HTTP indisponible.");
  return app.client;
}

/** Purge du §4.8, executee avant tout traitement. */
export function startupPurge(app: App): PurgeResult {
  const result = purge(app.db, app.cache, app.clock, app.counters);
  const total = result.contacts + result.pages + result.runs + result.entreesCache;
  if (total > 0) {
    app.logger.info("Purge des donnees de plus de trois ans", {
      borne: result.cutoff,
      contacts: result.contacts,
      pages: result.pages,
      runs: result.runs,
      entrees_cache: result.entreesCache,
    });
  }
  return result;
}
