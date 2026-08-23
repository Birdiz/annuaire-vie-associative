import { readFileSync, existsSync } from "node:fs";
import { writeAtomic } from "./http/cache.ts";
import { messageDe } from "./log.ts";

/**
 * Configuration de l'utilisateur.
 *
 * Ce qui n'est PAS ici est aussi important que ce qui y est : le delai de 2 s entre
 * requetes, le respect de robots.txt et la retention a 3 ans vivent dans
 * `invariants.ts` et n'ont aucune representation configurable. Ne pas les ajouter.
 */
export type Config = {
  /**
   * URL de contact annoncee dans le User-Agent (§4.4). Obligatoire pour lancer une
   * collecte, sans valeur par defaut : un User-Agent qui ne mene nulle part vaut un
   * User-Agent anonyme.
   */
  contactUrl: string | undefined;
  /**
   * Nombre de cles de throttle traitees en parallele. Seul levier de debit : le delai
   * par domaine, lui, est fixe.
   */
  concurrency: number;
  /** Duree au-dela de laquelle une entree de cache est revalidee (pas supprimee). */
  cacheTtlHours: number;
  llm: LlmConfig;
};

export type LlmConfig =
  | { provider: "none" }
  | { provider: "anthropic"; apiKey: string; model: string };

const DEFAULTS = {
  concurrency: 8,
  cacheTtlHours: 168,
  llmModel: "claude-haiku-4-5-20251001",
} as const;

const MAX_CONCURRENCY = 16;

export class ConfigError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`Configuration invalide :\n  - ${problems.join("\n  - ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

type RawEnv = Record<string, string | undefined>;

export function loadConfig(configFile: string, env: RawEnv = process.env): Config {
  const problems: string[] = [];
  const fromFile = readConfigFile(configFile, problems);

  const contactUrl = firstDefined(env["ANNUAIRE_CONTACT_URL"], fromFile["contactUrl"]);
  const concurrency = firstDefined(env["ANNUAIRE_CONCURRENCY"], fromFile["concurrency"]);
  const cacheTtlHours = firstDefined(env["ANNUAIRE_CACHE_TTL_HOURS"], fromFile["cacheTtlHours"]);

  const config: Config = {
    contactUrl: parseContactUrl(contactUrl, problems),
    concurrency: parseBoundedInt(concurrency, "concurrency", 1, MAX_CONCURRENCY, DEFAULTS.concurrency, problems),
    cacheTtlHours: parseBoundedInt(cacheTtlHours, "cacheTtlHours", 1, 24 * 365, DEFAULTS.cacheTtlHours, problems),
    llm: parseLlm(fromFile, env, problems),
  };

  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}

/**
 * A appeler avant toute collecte. Separee de `loadConfig` pour que `init`, `status`
 * et `metrics` fonctionnent sur une installation qui n'a pas encore ete configuree.
 */
export function requireContactUrl(config: Config): string {
  if (config.contactUrl === undefined) {
    throw new ConfigError([
      "contactUrl est obligatoire pour lancer une collecte (§4.4 : le User-Agent doit " +
        "inclure une URL de contact joignable). Renseignez-la dans config.json ou via " +
        "la variable ANNUAIRE_CONTACT_URL.",
    ]);
  }
  return config.contactUrl;
}

function readConfigFile(configFile: string, problems: string[]): Record<string, unknown> {
  if (!existsSync(configFile)) return {};
  let text: string;
  try {
    text = readFileSync(configFile, "utf8");
  } catch (cause) {
    problems.push(`${configFile} est illisible : ${messageDe(cause)}`);
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      problems.push(`${configFile} doit contenir un objet JSON.`);
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch (cause) {
    problems.push(`${configFile} n'est pas un JSON valide : ${messageDe(cause)}`);
    return {};
  }
}

function firstDefined(...values: readonly unknown[]): unknown {
  for (const v of values) {
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

/**
 * Le seul controle de l'URL de contact, partage par le chargement du fichier et par la
 * saisie dans l'interface (lot 8). Deux controles differents finiraient par diverger, et
 * c'est l'invariant 4 qui en paierait le prix : un User-Agent qui ne mene nulle part.
 */
export function validerContactUrl(value: string): { url: string } | { erreur: string } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { erreur: `contactUrl n'est pas une URL absolue : ${value}` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { erreur: `contactUrl doit etre en http ou https : ${value}` };
  }
  // §4.4 demande une URL **joignable**. Une adresse de boucle locale, une plage privee
  // ou un nom sans point passaient : le User-Agent etait alors syntaxiquement conforme et
  // fonctionnellement anonyme, ce qui vide l'invariant de son objet — un webmestre doit
  // pouvoir joindre quelqu'un.
  if (!estJoignableDepuisInternet(url.hostname)) {
    return {
      erreur:
        `contactUrl doit etre joignable depuis Internet : ${value}\n` +
        "  Une adresse locale ou privee ne permet a personne de vous ecrire, et c'est " +
        "tout l'objet de l'invariant §4.4.",
    };
  }
  return { url: url.toString() };
}

/** Boucle locale, adresses privees (RFC 1918), lien-local, et noms sans point. */
function estJoignableDepuisInternet(hostname: string): boolean {
  const hote = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hote === "localhost" || hote === "::1" || hote.endsWith(".localhost")) return false;
  if (/^127\./.test(hote) || hote === "0.0.0.0") return false;
  if (/^10\./.test(hote) || /^192\.168\./.test(hote) || /^169\.254\./.test(hote)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(hote)) return false;
  if (/^(fc|fd|fe80)/.test(hote)) return false;
  // Un nom sans point ne se resout que sur un reseau local.
  return hote.includes(".") || /^\d+\.\d+\.\d+\.\d+$/.test(hote);
}

function parseContactUrl(value: unknown, problems: string[]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    problems.push("contactUrl doit etre une chaine.");
    return undefined;
  }
  const resultat = validerContactUrl(value);
  if ("erreur" in resultat) {
    problems.push(resultat.erreur);
    return undefined;
  }
  return resultat.url;
}

function parseBoundedInt(
  value: unknown,
  name: string,
  min: number,
  max: number,
  fallback: number,
  problems: string[],
): number {
  if (value === undefined) return fallback;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n)) {
    problems.push(`${name} doit etre un entier, recu : ${String(value)}`);
    return fallback;
  }
  if (n < min || n > max) {
    problems.push(`${name} doit etre compris entre ${min} et ${max}, recu : ${n}`);
    return fallback;
  }
  return n;
}

/**
 * LLM en BYOK (D4) : la cle vient de l'utilisateur final, aucune cle n'est embarquee,
 * et l'absence de configuration n'est pas une erreur — le pipeline doit rester
 * complet et mesurable sans aucune inference.
 */
function parseLlm(fromFile: Record<string, unknown>, env: RawEnv, problems: string[]): LlmConfig {
  const raw = fromFile["llm"];
  const fileLlm: Record<string, unknown> =
    raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};

  const provider = firstDefined(env["ANNUAIRE_LLM_PROVIDER"], fileLlm["provider"], "none");
  if (provider === "none") return { provider: "none" };
  if (provider !== "anthropic") {
    problems.push(`llm.provider inconnu : ${String(provider)} (attendu "none" ou "anthropic")`);
    return { provider: "none" };
  }

  const apiKey = firstDefined(env["ANNUAIRE_LLM_API_KEY"], fileLlm["apiKey"]);
  if (typeof apiKey !== "string") {
    problems.push(
      'llm.provider vaut "anthropic" mais aucune cle API n\'est fournie ' +
        "(llm.apiKey dans config.json, ou ANNUAIRE_LLM_API_KEY).",
    );
    return { provider: "none" };
  }

  const model = firstDefined(env["ANNUAIRE_LLM_MODEL"], fileLlm["model"], DEFAULTS.llmModel);
  if (typeof model !== "string") {
    problems.push("llm.model doit etre une chaine.");
    return { provider: "none" };
  }

  return { provider: "anthropic", apiKey, model };
}

/** Ecrit un gabarit lisible au premier `init`. N'ecrase jamais un fichier existant. */
export function writeConfigTemplate(configFile: string): boolean {
  if (existsSync(configFile)) return false;
  const template = {
    _aide: [
      "contactUrl est obligatoire pour lancer une collecte : elle est annoncee dans le",
      "User-Agent afin qu'un webmestre puisse vous joindre. Le delai entre requetes, le",
      "respect de robots.txt et la purge a 3 ans ne sont pas configurables : ce sont des",
      "invariants du produit.",
    ],
    contactUrl: null,
    concurrency: DEFAULTS.concurrency,
    cacheTtlHours: DEFAULTS.cacheTtlHours,
    llm: { provider: "none" },
  };
  writeAtomic(configFile, Buffer.from(`${JSON.stringify(template, null, 2)}\n`, "utf8"));
  return true;
}

/**
 * Ecrit `contactUrl` dans le fichier de configuration, en preservant tout le reste.
 *
 * Relit le fichier plutot que de reserialiser un `Config` : celui-ci a des valeurs par
 * defaut, et les ecrire figerait dans le fichier des choix que l'utilisateur n'a pas
 * faits. L'aide et les cles inconnues survivent pour la meme raison.
 */
export function ecrireContactUrl(configFile: string, valeur: string): { url: string } | { erreur: string } {
  const resultat = validerContactUrl(valeur.trim());
  if ("erreur" in resultat) return resultat;

  const problems: string[] = [];
  const actuel = readConfigFile(configFile, problems);
  if (problems.length > 0) return { erreur: problems[0] ?? "configuration illisible" };

  const contenu = { ...actuel, contactUrl: resultat.url };
  try {
    // Temporaire puis `rename`, comme le cache : une interruption pendant cette ecriture
    // — elle vient de l'interface, donc d'un clic — laissait un config.json tronque, et
    // le demarrage suivant echouait sur un ConfigError incomprehensible.
    writeAtomic(configFile, Buffer.from(`${JSON.stringify(contenu, null, 2)}\n`, "utf8"));
  } catch (cause) {
    return { erreur: `${configFile} n'a pas pu etre ecrit : ${messageDe(cause)}` };
  }
  return resultat;
}
