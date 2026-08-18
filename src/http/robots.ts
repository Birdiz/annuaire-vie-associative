/**
 * Analyse et application de robots.txt (RFC 9309).
 *
 * L'invariant §4.2 ne prevoit aucune option de desactivation : il n'existe donc pas de
 * drapeau `ignoreRobots` dans ce module, et il ne faut pas en ajouter.
 */

export type RobotsRule = {
  allow: boolean;
  pattern: string;
};

export type RobotsPolicy = {
  rules: readonly RobotsRule[];
  crawlDelayMs: number | null;
};

/** Politique appliquee quand robots.txt est absent ou en 4xx : tout est permis. */
export const ALLOW_ALL: RobotsPolicy = { rules: [], crawlDelayMs: null };

/**
 * Politique appliquee quand robots.txt est injoignable (5xx, panne reseau).
 *
 * La RFC 9309 §2.3.1.4 autorise a considerer le site comme entierement interdit dans
 * ce cas. On retient cette lecture : en cas de doute sur la volonte du site, on
 * s'abstient plutot que de collecter.
 */
export const DISALLOW_ALL: RobotsPolicy = { rules: [{ allow: false, pattern: "/" }], crawlDelayMs: null };

/**
 * Selectionne le groupe correspondant a notre jeton de User-Agent, sinon le groupe `*`.
 * Un groupe specifique remplace entierement le groupe generique, il ne s'y ajoute pas.
 */
export function parseRobots(text: string, userAgentToken: string): RobotsPolicy {
  const token = userAgentToken.toLowerCase();

  // Un groupe = une suite de lignes User-agent suivie de ses directives.
  const groups: { agents: string[]; rules: RobotsRule[]; crawlDelay: number | null }[] = [];
  let current: (typeof groups)[number] | undefined;
  let previousWasAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split("#")[0]?.trim() ?? "";
    if (line === "") continue;

    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === "user-agent") {
      if (!previousWasAgent || current === undefined) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      previousWasAgent = true;
      continue;
    }

    previousWasAgent = false;
    if (current === undefined) continue;

    if (field === "disallow") {
      // « Disallow: » sans valeur signifie « rien n'est interdit » : pas une regle.
      if (value !== "") current.rules.push({ allow: false, pattern: value });
    } else if (field === "allow") {
      if (value !== "") current.rules.push({ allow: true, pattern: value });
    } else if (field === "crawl-delay") {
      const seconds = Number(value.replace(",", "."));
      if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelay = seconds * 1000;
    }
  }

  const specific = groups.find((group) => group.agents.some((agent) => agent === token));
  const generic = groups.find((group) => group.agents.includes("*"));
  const chosen = specific ?? generic;
  if (chosen === undefined) return ALLOW_ALL;

  return { rules: chosen.rules, crawlDelayMs: chosen.crawlDelay };
}

/**
 * Regle la plus longue gagnante ; a longueur egale, `Allow` l'emporte (RFC 9309 §2.2.2).
 */
export function isAllowed(policy: RobotsPolicy, pathWithQuery: string): boolean {
  let best: RobotsRule | undefined;
  let bestLength = -1;

  for (const rule of policy.rules) {
    if (!patternMatches(rule.pattern, pathWithQuery)) continue;
    const length = rule.pattern.length;
    if (length > bestLength || (length === bestLength && rule.allow)) {
      best = rule;
      bestLength = length;
    }
  }

  return best === undefined ? true : best.allow;
}

/** Motif de chemin robots : `*` couvre n'importe quelle suite, `$` ancre la fin. */
export function patternMatches(pattern: string, path: string): boolean {
  const anchoredEnd = pattern.endsWith("$");
  const body = anchoredEnd ? pattern.slice(0, -1) : pattern;

  const source = body
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");

  return new RegExp(`^${source}${anchoredEnd ? "$" : ""}`).test(path);
}

/**
 * Delai effectif entre deux requetes vers un meme domaine.
 *
 * Le minimum du produit est un plancher, jamais un plafond : un site qui demande plus
 * lent est suivi, un site qui demande plus rapide ne l'obtient pas.
 */
export function effectiveDelayMs(policy: RobotsPolicy, minimumMs: number): number {
  return Math.max(minimumMs, policy.crawlDelayMs ?? 0);
}

/** Extrait la partie comparee aux motifs : chemin + query, sans le fragment. */
export function pathWithQuery(url: URL): string {
  return `${url.pathname}${url.search}`;
}
