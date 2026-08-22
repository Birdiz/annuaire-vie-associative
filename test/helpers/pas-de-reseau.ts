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
 */

import dnsPromises from "node:dns/promises";

type EntreeFetch = Parameters<typeof globalThis.fetch>[0];

/**
 * Boucle locale, port 9 (discard) : rien n'y ecoute, la connexion est refusee net.
 *
 * L'appel passe par l'objet du module et non par un binding nomme : `setServers` agit
 * sur le resolveur porte par cet objet, via `this`. Importee nue, elle ne reconfigure
 * rien — et le garde-fou serait un commentaire.
 */
dnsPromises.setServers(["127.0.0.1:9"]);

const RESEAU_LOCAL = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

const fetchReel = globalThis.fetch;

globalThis.fetch = function fetchSousSurveillance(entree: EntreeFetch, init?: RequestInit): Promise<Response> {
  const cible = extraireUrl(entree);
  if (cible !== undefined && !RESEAU_LOCAL.has(cible.hostname)) {
    return Promise.reject(
      new Error(
        `La suite de tests ne sort jamais sur Internet (${cible.origin} refuse).\n` +
          "Visez le serveur local de test/helpers/server.ts, ou injectez les URL de " +
          "sources par le contexte de seed.",
      ),
    );
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
