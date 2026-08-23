import { resolvePaths, ensurePaths } from "./paths.ts";
import type { Paths, Environment } from "./paths.ts";
import { realEnvironment } from "./paths.ts";
import { loadConfig, requireContactUrl, ecrireContactUrl } from "./config.ts";
import type { Config } from "./config.ts";
import { openDatabase } from "./db/index.ts";
import type { Database } from "./db/index.ts";
import { HttpCache } from "./http/cache.ts";
import { DomainThrottle } from "./http/throttle.ts";
import { HttpClient, buildUserAgent } from "./http/client.ts";
import { ResolveurMx } from "./http/dns.ts";
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
  /**
   * Enregistre l'URL de contact et reconstruit le client, sans redemarrer le process.
   *
   * C'est ce qui rend l'executable Windows utilisable sans editeur de texte : le §4.4
   * exige une URL joignable avant toute collecte, et l'interface doit pouvoir la
   * demander (ADR-024). Le **cache et le throttle sont conserves** — un throttle neuf
   * remettrait a zero l'espacement de deux secondes par domaine, que l'invariant 3
   * interdit de contourner, fut-ce par inadvertance.
   *
   * Sans effet si `ANNUAIRE_CONTACT_URL` est definie : la variable l'emporte sur le
   * fichier, et ecrire dans celui-ci donnerait l'illusion d'un changement.
   */
  configurerContactUrl(valeur: string): { url: string } | { erreur: string };
  /**
   * Seconde porte de sortie reseau (ADR-017). Elle n'est pas conditionnee a l'URL de
   * contact : une requete DNS n'a pas de User-Agent, il n'y a donc personne a qui se
   * presenter, et rien a joindre pour un webmestre qui voudrait nous ecrire.
   */
  resolveurMx: ResolveurMx;
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

  // Le throttle vit au niveau de l'application, pas du client : reconstruire celui-ci
  // apres un changement d'URL de contact ne doit pas effacer ce qu'il sait des delais
  // deja consommes.
  const throttle = new DomainThrottle();

  // Sans URL de contact, aucun client n'est construit : il vaut mieux qu'une commande
  // de collecte echoue a l'assemblage qu'emettre une requete anonyme.
  const construireClient = (contactUrl: string | undefined): HttpClient | undefined =>
    contactUrl === undefined
      ? undefined
      : new HttpClient({
          cache,
          throttle,
          counters,
          userAgent: buildUserAgent(VERSION, contactUrl),
          cacheTtlMs: config.cacheTtlHours * 3_600_000,
          clock,
        });

  const app: App = {
    paths,
    config,
    db,
    cache,
    queue,
    counters,
    logger,
    clock,
    client: construireClient(config.contactUrl),
    configurerContactUrl: (valeur) => {
      const env = options.processEnv ?? process.env;
      if (env["ANNUAIRE_CONTACT_URL"] !== undefined && env["ANNUAIRE_CONTACT_URL"] !== "") {
        return {
          erreur:
            "ANNUAIRE_CONTACT_URL est definie dans l'environnement : elle l'emporte sur le " +
            "fichier de configuration. Modifiez la variable, ou retirez-la.",
        };
      }
      const resultat = ecrireContactUrl(paths.configFile, valeur);
      if ("erreur" in resultat) return resultat;
      config.contactUrl = resultat.url;
      app.client = construireClient(resultat.url);
      return resultat;
    },
    resolveurMx: new ResolveurMx(),
    close: () => db.close(),
  };

  return app;
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
  const total =
    result.contacts + result.pages + result.runs + result.domaines + result.entreesCache;
  if (total > 0) {
    app.logger.info("Purge des donnees de plus de trois ans", {
      borne: result.cutoff,
      contacts: result.contacts,
      pages: result.pages,
      runs: result.runs,
      domaines: result.domaines,
      entrees_cache: result.entreesCache,
    });
  }
  return result;
}
