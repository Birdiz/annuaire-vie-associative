import { MAX_REDIRECTS, MAX_RESPONSE_BYTES, REQUEST_TIMEOUT_MS, USER_AGENT_PRODUCT } from "../invariants.ts";
import type { Clock } from "../clock.ts";
import { systemClock, toIso } from "../clock.ts";
import type { Counters } from "../metrics/counters.ts";
import { ETAPE } from "../metrics/counters.ts";
import { HttpCache, canonicalizeUrl } from "./cache.ts";
import type { CacheMeta } from "./cache.ts";
import { DomainThrottle } from "./throttle.ts";
import { ALLOW_ALL, DISALLOW_ALL, isAllowed, parseRobots, pathWithQuery } from "./robots.ts";
import type { RobotsPolicy } from "./robots.ts";

/**
 * L'unique porte de sortie reseau du projet.
 *
 * Aucun autre module ne doit importer `fetch`, `node:http`, `node:https` ou `undici` —
 * un test echoue si c'est le cas. C'est ce qui rend les invariants §4.2, §4.3 et §4.4
 * vrais par construction plutot que par discipline : il n'existe simplement pas de
 * chemin de code capable d'emettre une requete sans passer par ici.
 */

export type FetchSource = "cache" | "network" | "revalidated";

export type FetchOutcome =
  | { kind: "ok"; meta: CacheMeta; body: Buffer; source: FetchSource }
  | { kind: "blocked"; reason: string }
  | { kind: "status"; status: number; finalUrl: string };

export type HttpClientOptions = {
  cache: HttpCache;
  throttle: DomainThrottle;
  counters: Counters;
  /** Construit par `buildUserAgent`. Doit contenir une URL de contact (§4.4). */
  userAgent: string;
  cacheTtlMs: number;
  clock?: Clock;
  /** Injecte par les tests, qui visent un serveur local jetable. */
  fetchImpl?: typeof globalThis.fetch;
};

export type FetchOptions = {
  signal?: AbortSignal;
  maxBytes?: number;
  /** Ignore la fraicheur du cache et revalide systematiquement. */
  forceRevalidate?: boolean;
};

/**
 * Un dump ouvert ne passe pas par `fetch` : il pese de 273 Mo a 1,25 Go, la ou `fetch`
 * plafonne a `MAX_RESPONSE_BYTES` et garde le corps entier en memoire avant de l'ecrire
 * dans le cache. Le cache par hash est concu pour des pages, pas pour cela.
 *
 * `openStream` rend donc le corps au fil de l'eau. Il applique les memes garanties que
 * `fetch` — robots.txt, throttle, User-Agent identifiable — parce qu'il emprunte les
 * memes chemins internes.
 */
export type StreamOptions = {
  signal?: AbortSignal;
  /**
   * Octets deja consommes lors d'une tentative precedente. Declenche une requete `Range`.
   * L'appelant doit d'abord verifier que la ressource n'a pas change (voir `resumed`).
   */
  fromByte?: number;
  /**
   * Refuse la compression de transport. Indispensable des qu'on veut reprendre par
   * `Range` : un offset d'octets decompresses n'a aucun sens pour le serveur, qui
   * compte en octets transmis.
   */
  identityEncoding?: boolean;
};

export type StreamOutcome =
  | {
      kind: "ok";
      etag: string | null;
      lastModified: string | null;
      /** Taille totale de la ressource, y compris quand la reponse est partielle. */
      totalBytes: number | null;
      /** Faux si le serveur a ignore le `Range` : l'appelant doit repartir de zero. */
      resumed: boolean;
      body: AsyncIterable<Uint8Array>;
    }
  | { kind: "blocked"; reason: string }
  | { kind: "status"; status: number; finalUrl: string };

export function buildUserAgent(version: string, contactUrl: string): string {
  return `${USER_AGENT_PRODUCT}/${version} (+${contactUrl})`;
}

/** Jeton compare aux lignes `User-agent:` de robots.txt. */
export const ROBOTS_TOKEN = USER_AGENT_PRODUCT.toLowerCase();

export class TooLargeError extends Error {
  constructor(limit: number) {
    super(`Reponse superieure a la limite de ${limit} octets`);
    this.name = "TooLargeError";
  }
}

export class HttpClient {
  readonly #cache: HttpCache;
  readonly #throttle: DomainThrottle;
  readonly #counters: Counters;
  readonly #userAgent: string;
  readonly #cacheTtlMs: number;
  readonly #clock: Clock;
  readonly #fetch: typeof globalThis.fetch;
  readonly #policies = new Map<string, Promise<RobotsPolicy>>();

  constructor(options: HttpClientOptions) {
    this.#cache = options.cache;
    this.#throttle = options.throttle;
    this.#counters = options.counters;
    this.#userAgent = options.userAgent;
    this.#cacheTtlMs = options.cacheTtlMs;
    this.#clock = options.clock ?? systemClock;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
  }

  async fetch(rawUrl: string | URL, options: FetchOptions = {}): Promise<FetchOutcome> {
    const requested = new URL(canonicalizeUrl(rawUrl));
    assertSupportedScheme(requested);

    const maxBytes = options.maxBytes ?? MAX_RESPONSE_BYTES;

    const hit = this.#cache.get(requested.href);
    if (hit !== undefined && options.forceRevalidate !== true && this.#isFresh(hit.meta)) {
      this.#counters.inc(ETAPE.http, "cache_hits");
      return { kind: "ok", meta: hit.meta, body: hit.body, source: "cache" };
    }

    let current = requested;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const decision = await this.#checkRobots(current, options.signal);
      if (!decision.allowed) {
        this.#counters.inc(ETAPE.http, "robots_blocked");
        return { kind: "blocked", reason: decision.reason };
      }

      await this.#throttle.acquire(current, decision.delayMs, options.signal);

      const response = await this.#send(current, hit?.meta, options.signal);
      this.#counters.inc(ETAPE.http, "requests");

      if (response.status === 304 && hit !== undefined) {
        this.#counters.inc(ETAPE.http, "revalidated");
        const fetchedAt = toIso(this.#clock.now());
        this.#cache.touch(requested.href, fetchedAt);
        return { kind: "ok", meta: { ...hit.meta, fetchedAt }, body: hit.body, source: "revalidated" };
      }

      if (response.status === 429) {
        this.#counters.inc(ETAPE.http, "throttled_429");
        this.#throttle.penalize(current, retryAfterMs(response.headers.get("retry-after")));
        return { kind: "status", status: 429, finalUrl: current.href };
      }

      if (isRedirect(response.status)) {
        const location = response.headers.get("location");
        if (location === null) return { kind: "status", status: response.status, finalUrl: current.href };
        const next = new URL(location, current);
        assertSupportedScheme(next);
        this.#counters.inc(ETAPE.http, "redirects");
        current = new URL(canonicalizeUrl(next));
        continue;
      }

      if (response.status < 200 || response.status >= 300) {
        this.#counters.inc(ETAPE.http, `status_${statusClass(response.status)}`);
        return { kind: "status", status: response.status, finalUrl: current.href };
      }

      const body = await readCapped(response, maxBytes);
      this.#counters.inc(ETAPE.http, "cache_miss");
      this.#counters.inc(ETAPE.http, "bytes", body.byteLength);

      const meta = this.#cache.set(requested.href, {
        finalUrl: current.href,
        status: response.status,
        etag: response.headers.get("etag"),
        lastModified: response.headers.get("last-modified"),
        contentType: response.headers.get("content-type"),
        fetchedAt: toIso(this.#clock.now()),
      }, body);

      return { kind: "ok", meta, body, source: "network" };
    }

    this.#counters.inc(ETAPE.http, "redirect_loops");
    return { kind: "status", status: 310, finalUrl: current.href };
  }


  /**
   * Ouvre un flux de lecture sur une ressource volumineuse.
   *
   * Le timeout de `REQUEST_TIMEOUT_MS` ne couvre que l'obtention des en-tetes : une fois
   * la reponse acquise, le corps peut couler aussi longtemps qu'il le faut. L'appelant
   * garde la main par son propre `signal`.
   */
  async openStream(rawUrl: string | URL, options: StreamOptions = {}): Promise<StreamOutcome> {
    let current = new URL(canonicalizeUrl(rawUrl));
    assertSupportedScheme(current);

    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const decision = await this.#checkRobots(current, options.signal);
      if (!decision.allowed) {
        this.#counters.inc(ETAPE.http, "robots_blocked");
        return { kind: "blocked", reason: decision.reason };
      }

      await this.#throttle.acquire(current, decision.delayMs, options.signal);

      const response = await this.#sendStream(current, options);
      this.#counters.inc(ETAPE.http, "requests");

      if (response.status === 429) {
        this.#counters.inc(ETAPE.http, "throttled_429");
        this.#throttle.penalize(current, retryAfterMs(response.headers.get("retry-after")));
        return { kind: "status", status: 429, finalUrl: current.href };
      }

      if (isRedirect(response.status)) {
        const location = response.headers.get("location");
        if (location === null) return { kind: "status", status: response.status, finalUrl: current.href };
        const next = new URL(location, current);
        assertSupportedScheme(next);
        this.#counters.inc(ETAPE.http, "redirects");
        current = new URL(canonicalizeUrl(next));
        continue;
      }

      if (response.status < 200 || response.status >= 300) {
        this.#counters.inc(ETAPE.http, `status_${statusClass(response.status)}`);
        return { kind: "status", status: response.status, finalUrl: current.href };
      }

      const demandePartielle = (options.fromByte ?? 0) > 0;
      const resumed = demandePartielle && response.status === 206;
      if (response.body === null) {
        return { kind: "status", status: response.status, finalUrl: current.href };
      }

      return {
        kind: "ok",
        etag: response.headers.get("etag"),
        lastModified: response.headers.get("last-modified"),
        totalBytes: tailleTotale(response),
        resumed,
        body: iterer(response.body),
      };
    }

    this.#counters.inc(ETAPE.http, "redirect_loops");
    return { kind: "status", status: 310, finalUrl: current.href };
  }

  /** Chemin relatif du corps en cache, a stocker dans `page.cache_path`. */
  cachePathFor(url: string | URL): string {
    return this.#cache.relativeBodyPath(url);
  }

  #isFresh(meta: CacheMeta): boolean {
    return Date.parse(meta.fetchedAt) + this.#cacheTtlMs > this.#clock.now();
  }


  /**
   * Variante de `#send` pour les flux : pas de revalidation par cache, un `Range`
   * optionnel, et un timeout desarme des que les en-tetes arrivent.
   */
  async #sendStream(url: URL, options: StreamOptions): Promise<Response> {
    const headers = new Headers({ "user-agent": this.#userAgent, accept: "*/*" });
    const depuis = options.fromByte ?? 0;
    if (depuis > 0) headers.set("range", `bytes=${depuis}-`);
    // `identity` et `Range` vont de pair : sans cela le serveur compterait les octets
    // compresses et l'offset de reprise designerait le mauvais endroit.
    if (options.identityEncoding === true) headers.set("accept-encoding", "identity");

    const minuteur = new AbortController();
    const minuterie = setTimeout(() => minuteur.abort(), REQUEST_TIMEOUT_MS);
    const signaux = options.signal === undefined ? [minuteur.signal] : [options.signal, minuteur.signal];
    try {
      return await this.#fetch(url, {
        method: "GET",
        headers,
        redirect: "manual",
        signal: AbortSignal.any(signaux),
      });
    } finally {
      clearTimeout(minuterie);
    }
  }

  async #send(url: URL, cached: CacheMeta | undefined, signal?: AbortSignal): Promise<Response> {
    const headers = new Headers({ "user-agent": this.#userAgent, accept: "*/*" });
    if (cached?.etag != null) headers.set("if-none-match", cached.etag);
    if (cached?.lastModified != null) headers.set("if-modified-since", cached.lastModified);

    return this.#fetch(url, {
      method: "GET",
      headers,
      redirect: "manual",
      signal: withTimeout(signal),
    });
  }

  /**
   * robots.txt est recupere une fois par origine et par execution. Sa propre requete
   * est evidemment exemptee de la verification, mais pas du throttle : elle compte
   * comme une visite du domaine.
   */
  async #checkRobots(
    url: URL,
    signal?: AbortSignal,
  ): Promise<{ allowed: true; delayMs: number } | { allowed: false; reason: string }> {
    const policy = await this.#policyFor(url.origin, signal);
    const path = pathWithQuery(url);
    if (!isAllowed(policy, path)) {
      return { allowed: false, reason: `robots.txt interdit ${path} sur ${url.origin}` };
    }
    // Seul le delai demande par le site remonte ici. Le plancher de 2 s est applique
    // par le throttle, et une seule fois : le dupliquer a cet endroit donnerait deux
    // sources de verite pour un invariant qui doit n'en avoir qu'une.
    return { allowed: true, delayMs: policy.crawlDelayMs ?? 0 };
  }

  #policyFor(origin: string, signal?: AbortSignal): Promise<RobotsPolicy> {
    let pending = this.#policies.get(origin);
    if (pending === undefined) {
      pending = this.#loadPolicy(origin, signal);
      this.#policies.set(origin, pending);
    }
    return pending;
  }

  async #loadPolicy(origin: string, signal?: AbortSignal): Promise<RobotsPolicy> {
    const url = new URL("/robots.txt", origin);
    try {
      await this.#throttle.acquire(url, 0, signal);
      const response = await this.#fetch(url, {
        method: "GET",
        headers: new Headers({ "user-agent": this.#userAgent }),
        redirect: "follow",
        signal: withTimeout(signal),
      });
      this.#counters.inc(ETAPE.http, "robots_fetched");

      // 4xx : robots.txt indisponible, tout est permis (RFC 9309 §2.3.1.3).
      if (response.status >= 400 && response.status < 500) return ALLOW_ALL;
      // 5xx : site injoignable, on s'abstient (RFC 9309 §2.3.1.4).
      if (response.status >= 500) return DISALLOW_ALL;
      if (response.status < 200 || response.status >= 300) return ALLOW_ALL;

      const text = (await readCapped(response, MAX_RESPONSE_BYTES)).toString("utf8");
      return parseRobots(text, ROBOTS_TOKEN);
    } catch (error) {
      if (isAbort(error)) throw error;
      this.#counters.inc(ETAPE.http, "robots_unreachable");
      return DISALLOW_ALL;
    }
  }
}


/** Convertit le corps d'une reponse en iterable asynchrone d'octets. */
async function* iterer(flux: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const lecteur = flux.getReader();
  try {
    for (;;) {
      const { done, value } = await lecteur.read();
      if (done) return;
      if (value !== undefined) yield value;
    }
  } finally {
    lecteur.releaseLock();
  }
}

/**
 * Taille de la ressource entiere. Sur une reponse partielle, `Content-Length` ne donne
 * que celle du fragment : c'est `Content-Range` qui porte le total.
 */
function tailleTotale(response: Response): number | null {
  const plage = response.headers.get("content-range");
  if (plage !== null) {
    const total = /\/\s*(\d+)\s*$/.exec(plage);
    if (total?.[1] !== undefined) return Number(total[1]);
  }
  const longueur = response.headers.get("content-length");
  if (longueur === null) return null;
  const valeur = Number(longueur);
  return Number.isFinite(valeur) ? valeur : null;
}

function assertSupportedScheme(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Schema non supporte : ${url.protocol} (${url.href})`);
  }
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function statusClass(status: number): string {
  return `${Math.floor(status / 100)}xx`;
}

function retryAfterMs(header: string | null): number {
  if (header === null) return 60_000;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 3_600_000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, Math.min(date - Date.now(), 3_600_000));
  return 60_000;
}

function withTimeout(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

/**
 * Lit le corps en refusant de depasser la limite.
 *
 * On ne se fie pas au seul `content-length` : un serveur peut l'omettre ou mentir. La
 * lecture est donc interrompue des que le cumul depasse le plafond, sans avoir mis
 * l'integralite de la reponse en memoire.
 */
export async function readCapped(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new TooLargeError(maxBytes);
  }

  if (response.body === null) return Buffer.alloc(0);

  const chunks: Buffer[] = [];
  let total = 0;
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new TooLargeError(maxBytes);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}
