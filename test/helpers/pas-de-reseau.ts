/**
 * Garde-fou de la suite de tests : aucune sortie sur Internet.
 *
 * L'interdit existait depuis le lot 1, mais reposait sur la discipline — chaque test
 * devait penser a viser le serveur local. Au lot 2, une commande de bout en bout a
 * suffi a le rompre : `run` declenche desormais une vraie collecte, et la suite a
 * telecharge 1,5 Go de dumps publics sans que rien ne s'y oppose.
 *
 * Ce module est precharge par `node --test --import`. Il remplace `fetch` par une
 * version qui refuse tout hote autre que la boucle locale. L'interdit devient ainsi
 * vrai par construction : un test qui tenterait de sortir echoue immediatement, avec
 * un message qui dit quoi faire.
 *
 * Le lot 5 ouvre une seconde porte de sortie : la resolution MX de `src/http/dns.ts`.
 * Elle ne passe pas par `fetch`, donc la garde ci-dessus ne la couvrait pas. Le
 * resolveur DNS par defaut est donc pointe vers un port mort de la boucle locale :
 * `resolveMx` echoue immediatement en ECONNREFUSED, et aucune requete ne part. Ce
 * choix est deliberement plus fin qu'il n'y parait :
 *
 * - il ne touche pas `lookup()`, qui passe par le resolveur du systeme et dont
 *   `src/http/throttle.ts` a besoin a chaque requete vers le serveur local de test ;
 * - il produit une **erreur** et non une absence de MX. Le code distingue les deux, et
 *   un test qui oublierait d'injecter un faux resolveur verra un verdict `null` — pas
 *   un « ce domaine ne recoit pas de courrier » silencieusement faux.
 *
 * **Le lot 8 elargit la garde a la socket.** Remplacer `fetch` ne couvrait que `fetch` :
 * `node:http`, `node:https`, `node:http2`, `undici` et tout client tiers passaient au
 * travers, et le test d'architecture qui devait les rattraper avait ses propres trous.
 * On enveloppe donc `net.Socket.prototype.connect`, par ou tout finit par passer — une
 * seule garde, valable pour les clients d'aujourd'hui comme pour ceux de demain.
 */

import dnsPromises from "node:dns/promises";
import dnsCallback from "node:dns";
import { Socket } from "node:net";

type EntreeFetch = Parameters<typeof globalThis.fetch>[0];

/**
 * Boucle locale, port 9 (discard) : rien n'y ecoute, la connexion est refusee net.
 *
 * L'appel passe par l'objet du module et non par un binding nomme : `setServers` agit
 * sur le resolveur porte par cet objet, via `this`. Importee nue, elle ne reconfigure
 * rien — et le garde-fou serait un commentaire.
 */
dnsPromises.setServers(["127.0.0.1:9"]);
// Les deux API portent des resolveurs **independants** : `dnsPromises.setServers` ne
// touche pas celui de l'API a callback. Verifie — `dns.getServers()` restait sur les
// serveurs du systeme. Sans cette seconde ligne, la symetrie de la garde est une
// illusion des lors qu'un module utiliserait l'API historique.
dnsCallback.setServers(["127.0.0.1:9"]);

const RESEAU_LOCAL = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Vrai pour une cible de la boucle locale, la seule que la suite ait le droit de joindre. */
export function estLocal(hote: string): boolean {
  return RESEAU_LOCAL.has(hote) || hote.startsWith("127.") || hote === "0.0.0.0";
}

export class SortieReseauInterdite extends Error {
  constructor(cible: string) {
    super(
      `La suite de tests ne sort jamais sur Internet (${cible} refuse).\n` +
        "Visez le serveur local de test/helpers/server.ts, ou injectez les URL de " +
        "sources par le contexte de seed.",
    );
    this.name = "SortieReseauInterdite";
  }
}

/**
 * La garde de fond. Tout client HTTP de Node — `http`, `https`, `http2`, `undici`, donc
 * `fetch` lui-meme — finit par ouvrir une socket TCP ici.
 */
const connecterReel = Socket.prototype.connect;
Socket.prototype.connect = function connecterSousSurveillance(this: Socket, ...args: unknown[]) {
  const hote = hoteDemande(args);
  if (hote !== undefined && !estLocal(hote)) throw new SortieReseauInterdite(hote);
  return (connecterReel as (...a: unknown[]) => Socket).apply(this, args);
} as typeof Socket.prototype.connect;

/**
 * `connect(options)`, `connect(port, host)` ou `connect(path)` : seule la cible compte.
 *
 * Le piege est `options.path`. Pour `net` il designe une socket de domaine Unix, mais
 * l'agent de `node:http` transmet ses propres options telles quelles — et `path` y vaut
 * le chemin de la requete. S'y fier laissait passer tout `http.get`, ce qu'un premier
 * jet de ce garde-fou faisait : c'est un `port` present qui tranche entre les deux.
 */
function hoteDemande(args: readonly unknown[]): string | undefined {
  // `net.createConnection` — donc l'agent de `node:http` — appelle `connect` avec le
  // tableau d'arguments **deja normalise** : `connect([options, rappel])`. Sans ce
  // deballage, la garde ne voyait qu'un objet sans hote et laissait tout passer.
  const premier = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
  if (typeof premier === "object" && premier !== null) {
    const options = premier as { host?: unknown; port?: unknown; path?: unknown };
    const versLeReseau = options.port !== undefined && options.port !== null;
    if (!versLeReseau && typeof options.path === "string") return undefined; // socket Unix
    return typeof options.host === "string" ? options.host : "localhost";
  }
  if (typeof premier === "number") {
    const second = args[1];
    return typeof second === "string" ? second : "localhost";
  }
  return undefined; // connect(path) : socket de domaine Unix
}

const fetchReel = globalThis.fetch;

globalThis.fetch = function fetchSousSurveillance(entree: EntreeFetch, init?: RequestInit): Promise<Response> {
  const cible = extraireUrl(entree);
  // Redondant avec la garde sur la socket, et delibere : le message arrive ici avant
  // toute resolution de nom, et il dit ce qu'il faut faire.
  if (cible !== undefined && !estLocal(cible.hostname)) {
    return Promise.reject(new SortieReseauInterdite(cible.origin));
  }
  return fetchReel(entree, init);
} as typeof globalThis.fetch;

function extraireUrl(entree: EntreeFetch): URL | undefined {
  try {
    if (typeof entree === "string") return new URL(entree);
    if (entree instanceof URL) return entree;
    return new URL(entree.url);
  } catch {
    return undefined;
  }
}
