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

/**
 * Plafond du `Crawl-delay` annonce par un site. Voir le commentaire de `parseRobots` :
 * c'est un garde-fou contre une valeur absurde, pas une derogation au plancher de 2 s.
 */
const CRAWL_DELAY_MAX_S = 60;

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
      // Le plancher de 2 s reste l'invariant ; ce plafond n'y deroge pas, il borne une
      // valeur qu'aucun site n'a de raison legitime de poser. « Crawl-delay: 86400 »
      // figerait le domaine 24 h en occupant un slot de concurrence, et au-dela de
      // 2^31-1 ms `setTimeout` ramene silencieusement le delai a 1 ms.
      if (Number.isFinite(seconds) && seconds >= 0) {
        current.crawlDelay = Math.min(seconds, CRAWL_DELAY_MAX_S) * 1000;
      }
    }
  }

  // RFC 9309 §2.2.1 : tous les groupes visant le meme agent sont **fusionnes**. Ne
  // retenir que le premier laissait tomber les directives d'un second bloc
  // « User-agent: * » — un echec dans le sens permissif, sur un invariant qui n'en
  // tolere pas. Le delai retenu est le plus long des groupes fusionnes.
  const specific = groups.filter((group) => group.agents.includes(token));
  const chosen = specific.length > 0 ? specific : groups.filter((group) => group.agents.includes("*"));
  if (chosen.length === 0) return ALLOW_ALL;

  const delais = chosen.map((group) => group.crawlDelay).filter((d) => d !== null);
  return {
    rules: chosen.flatMap((group) => group.rules),
    crawlDelayMs: delais.length === 0 ? null : Math.max(...delais),
  };
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

/**
 * Motif de chemin robots : `*` couvre n'importe quelle suite, `$` ancre la fin.
 *
 * **Ce motif vient d'un fichier tiers, il ne peut donc pas passer par une regex.**
 * Traduire chaque `*` en `.*` produit `.*a.*a.*a...b`, forme canonique du backtracking
 * catastrophique : mesure sur `/*a*a*a*a*a*a*a*a*a*a*b`, le temps double tous les deux
 * caracteres, et contre un chemin de 60 caracteres l'evaluation ne termine pas. Il n'y a
 * ni timeout ni signal autour de `isAllowed`, et l'invariant §4.2 rend ce chemin non
 * contournable : une mairie au robots.txt maladroit gelerait l'outil pour de bon —
 * l'interface avec, depuis que le worker tourne dans son process (ADR-024).
 *
 * D'ou ce scan a deux index, sans retour arriere. Les segments litteraux separes par `*`
 * sont cherches au plus tot : c'est optimal ici, puisque `*` accepte n'importe quoi et
 * qu'une correspondance plus a gauche laisse toujours plus de place aux suivantes.
 */
export function patternMatches(pattern: string, path: string): boolean {
  const anchoredEnd = pattern.endsWith("$");
  const body = anchoredEnd ? pattern.slice(0, -1) : pattern;
  const segments = body.split("*");

  // Un motif robots est ancre au debut : il se compare a un prefixe de chemin.
  const premier = segments[0] ?? "";
  if (!path.startsWith(premier)) return false;
  let position = premier.length;

  const dernier = segments.length - 1;
  for (let i = 1; i <= dernier; i += 1) {
    const segment = segments[i] ?? "";
    // Avec `$`, le dernier segment doit tomber a la fin du chemin, pas n'importe ou.
    if (i === dernier && anchoredEnd) {
      return path.length - segment.length >= position && path.endsWith(segment);
    }
    if (segment === "") continue;
    const trouve = path.indexOf(segment, position);
    if (trouve === -1) return false;
    position = trouve + segment.length;
  }

  // Sans aucun `*`, `$` exige que le prefixe ait consomme tout le chemin.
  return !anchoredEnd || position === path.length;
}

/*
 * Le delai effectif ne se calcule pas ici. Le plancher de deux secondes est un plancher
 * et jamais un plafond, et c'est `DomainThrottle` qui l'applique — une seule fois, en un
 * seul endroit. Une fonction `effectiveDelayMs` a vecu ici, sans autre appelant que ses
 * propres tests : deux ecritures de la meme regle, dont l'une ne servait a rien.
 */

/** Extrait la partie comparee aux motifs : chemin + query, sans le fragment. */
export function pathWithQuery(url: URL): string {
  return `${url.pathname}${url.search}`;
}
