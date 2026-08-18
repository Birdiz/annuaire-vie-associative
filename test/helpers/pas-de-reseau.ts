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
 */

type EntreeFetch = Parameters<typeof globalThis.fetch>[0];

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
