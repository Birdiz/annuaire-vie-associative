import { readFileSync, writeFileSync, existsSync } from "node:fs";

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
    problems.push(`${configFile} est illisible : ${(cause as Error).message}`);
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
    problems.push(`${configFile} n'est pas un JSON valide : ${(cause as Error).message}`);
    return {};
  }
}

function firstDefined(...values: readonly unknown[]): unknown {
  for (const v of values) {
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

function parseContactUrl(value: unknown, problems: string[]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    problems.push("contactUrl doit etre une chaine.");
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    problems.push(`contactUrl n'est pas une URL absolue : ${value}`);
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    problems.push(`contactUrl doit etre en http ou https : ${value}`);
    return undefined;
  }
  return url.toString();
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
  writeFileSync(configFile, `${JSON.stringify(template, null, 2)}\n`, "utf8");
  return true;
}
