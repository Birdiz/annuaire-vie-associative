import { lookup } from "node:dns/promises";
import { MIN_DELAY_PER_DOMAIN_MS } from "../invariants.ts";

/**
 * Espacement des requetes sortantes (§4.3).
 *
 * Deux cles plutot qu'une. Prise au pied de la lettre par nom d'hote, la regle « 1
 * requete / 2 s par domaine » se contourne sans le vouloir : un prestataire qui heberge
 * trois cents mairies sur trois cents hotes distincts encaisserait trois cents fois le
 * debit autorise. La seconde cle est le /24 de l'adresse resolue, ce qui rattrape
 * l'hebergement mutualise sans embarquer de Public Suffix List. Voir ADR-004.
 *
 * Le delai n'est pas un parametre du constructeur par hasard : il vient de
 * `invariants.ts` et ne remonte nulle part dans la configuration.
 */

export type LookupFn = (hostname: string) => Promise<{ address: string; family: number }>;

const defaultLookup: LookupFn = async (hostname) => {
  const result = await lookup(hostname);
  return { address: result.address, family: result.family };
};

/**
 * Source de temps monotone, en millisecondes fractionnaires.
 *
 * Deliberement distincte de l'horloge murale de `clock.ts`. Cette derniere sert a
 * horodater les donnees collectees et doit donc donner des dates reelles ; ici on
 * mesure une duree ecoulee, ce qui appelle deux proprietes que `Date.now()` n'a pas :
 * elle ne recule jamais (une synchronisation NTP ferait partir une requete en avance)
 * et sa resolution est inferieure a la milliseconde (a granularite entiere, deux
 * departs reserves a 2000 ms d'ecart peuvent se produire a 1999,1 ms d'intervalle).
 */
export type MonotonicNow = () => number;

export class DomainThrottle {
  readonly #now: MonotonicNow;
  readonly #lookup: LookupFn;
  readonly #minDelayMs: number;
  /** Prochaine date de depart autorisee, par cle. */
  readonly #nextAt = new Map<string, number>();
  readonly #ipKeys = new Map<string, Promise<string | null>>();

  /**
   * `minDelayMs` n'existe que pour les tests, qui ont besoin de verifier la mecanique
   * de file sans attendre deux secondes par requete. Le delai reel de production est
   * la valeur par defaut, et un test dedie verifie qu'elle vaut bien 2 s de bout en
   * bout via le client HTTP.
   */
  constructor(
    options: { now?: MonotonicNow; lookup?: LookupFn; minDelayMs?: number } = {},
  ) {
    this.#now = options.now ?? (() => performance.now());
    this.#lookup = options.lookup ?? defaultLookup;
    this.#minDelayMs = options.minDelayMs ?? MIN_DELAY_PER_DOMAIN_MS;
  }

  /**
   * Attend le creneau libre puis rend la main. L'appelant doit emettre sa requete
   * immediatement : la reservation est faite pour l'instant du retour, et toute
   * attente supplementaire inseree ici rapprocherait les departs reels.
   */
  async acquire(url: URL, delayMs = this.#minDelayMs, signal?: AbortSignal): Promise<void> {
    const effective = Math.max(this.#minDelayMs, delayMs);
    const keys = await this.#keysFor(url);

    // Reservation synchrone : aucun `await` entre la lecture des creneaux et leur mise
    // a jour, donc deux appels concurrents ne peuvent pas obtenir le meme creneau.
    const now = this.#now();
    let startAt = now;
    for (const key of keys) {
      startAt = Math.max(startAt, this.#nextAt.get(key) ?? 0);
    }
    for (const key of keys) {
      this.#nextAt.set(key, startAt + effective);
    }

    // `setTimeout` peut rendre la main avant l'echeance : on reboucle jusqu'a l'avoir
    // reellement atteinte plutot que de faire confiance a une seule attente.
    for (let remaining = startAt - this.#now(); remaining > 0; remaining = startAt - this.#now()) {
      await sleep(remaining, signal);
    }

    // Reservation definitive depuis le depart REEL et non depuis le creneau prevu.
    // Un reveil depasse toujours son echeance, d'un delai variable : deux creneaux
    // espaces d'exactement 2 s produisent des departs a 1999 ms d'intervalle si le
    // premier a depasse de 0,9 ms et le second de 0,1 ms. En repartant de l'instant
    // constate, l'espacement est garanti sur les departs effectifs.
    //
    // Ce recalcul ne peut qu'avancer la date dans le futur — l'instant constate est
    // toujours posterieur au creneau reserve — donc il ne peut pas laisser passer un
    // appel concurrent plus tot que prevu.
    const departure = this.#now();
    for (const key of keys) {
      this.#nextAt.set(key, Math.max(this.#nextAt.get(key) ?? 0, departure + effective));
    }
  }

  /**
   * Repousse le creneau d'un hote, typiquement sur un 429 assorti d'un `Retry-After`.
   * Le serveur impose son rythme ; la file de jobs se chargera de la reprise.
   */
  penalize(url: URL, delayMs: number): void {
    const until = this.#now() + delayMs;
    for (const key of this.#cachedKeysFor(url)) {
      this.#nextAt.set(key, Math.max(this.#nextAt.get(key) ?? 0, until));
    }
  }

  async #keysFor(url: URL): Promise<string[]> {
    const host = url.hostname.toLowerCase();
    const keys = [`host:${host}`];
    const ipKey = await this.#ipKeyFor(host);
    if (ipKey !== null) keys.push(ipKey);
    return keys;
  }

  /** Variante synchrone, pour les penalites : n'utilise que ce qui est deja resolu. */
  #cachedKeysFor(url: URL): string[] {
    return [`host:${url.hostname.toLowerCase()}`];
  }

  async #ipKeyFor(host: string): Promise<string | null> {
    let pending = this.#ipKeys.get(host);
    if (pending === undefined) {
      pending = this.#lookup(host)
        .then((result) => subnetKey(result.address, result.family))
        // Une resolution qui echoue ne doit pas empecher la requete : la cle par hote
        // continue de s'appliquer, et l'erreur remontera de la requete elle-meme.
        .catch(() => null);
      this.#ipKeys.set(host, pending);
    }
    return pending;
  }
}

/** IPv4 : /24. IPv6 : /48, granularite usuelle d'allocation d'un site. */
export function subnetKey(address: string, family: number): string | null {
  if (family === 4) {
    const octets = address.split(".");
    if (octets.length !== 4) return null;
    return `net:${octets[0]}.${octets[1]}.${octets[2]}`;
  }
  if (family === 6) {
    const groups = address.split(":");
    if (groups.length < 3) return null;
    return `net6:${groups.slice(0, 3).join(":")}`;
  }
  return null;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      cleanup();
      const error = new Error("Attente interrompue");
      error.name = "AbortError";
      reject(error);
    };
    function cleanup(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    if (signal?.aborted === true) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
