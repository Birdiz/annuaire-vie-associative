import { test } from "node:test";
import assert from "node:assert/strict";
import { get as httpGet } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as http2Connect } from "node:http2";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Le meta-test du garde-fou anti-reseau.
 *
 * `test/helpers/pas-de-reseau.ts` est la piece qui rend vrai « la suite ne sort jamais
 * sur Internet ». Rien ne le verifiait du cote `fetch` — seule la porte DNS avait le
 * sien (`test/normalisation/mx.test.ts`). Ce fichier comble le manque, et couvre du meme
 * geste les clients que le garde-fou ne voyait pas avant le lot 8 : `node:http`,
 * `node:https`, `node:http2`.
 *
 * Ce fichier importe ces trois modules, et c'est le seul endroit ou ce soit legitime :
 * son objet est precisement de prouver qu'ils sont bloques. La regle d'architecture, elle,
 * ne porte que sur `src/`.
 *
 * **La cible est une adresse IP, pas un nom.** Un nom en `.invalid` echoue d'abord a la
 * resolution, et le test passerait au vert sans avoir rien prouve du garde-fou. 203.0.113.1
 * appartient a TEST-NET-3 (RFC 5737) : reservee a la documentation, elle ne route nulle part.
 */

const DISTANT = "203.0.113.1";

/** L'erreur arrive selon le client par un jet ou par un evenement : les deux comptent. */
async function erreurDe(amorcer: () => { once(evenement: "error", ecouteur: (e: Error) => void): unknown }): Promise<Error> {
  try {
    const emetteur = amorcer();
    return await new Promise<Error>((resoudre) => emetteur.once("error", resoudre));
  } catch (jetee) {
    return jetee as Error;
  }
}

test("INTERDIT : fetch vers un hote distant est refuse", async () => {
  await assert.rejects(fetch(`http://${DISTANT}/x`), /ne sort jamais sur Internet/);
});

test("INTERDIT : http.get vers un hote distant est refuse", async () => {
  const erreur = await erreurDe(() => httpGet(`http://${DISTANT}/x`));
  assert.match(erreur.message, /ne sort jamais sur Internet/);
});

test("INTERDIT : https.request vers un hote distant est refuse", async () => {
  const erreur = await erreurDe(() => httpsRequest(`https://${DISTANT}/x`));
  assert.match(erreur.message, /ne sort jamais sur Internet/);
});

test("INTERDIT : http2.connect vers un hote distant est refuse", async () => {
  // Ce module ne figurait ni dans le garde-fou ni dans le test d'architecture : c'etait
  // le chemin complet par lequel un test pouvait sortir sur Internet.
  const erreur = await erreurDe(() => http2Connect(`https://${DISTANT}`));
  assert.match(erreur.message, /ne sort jamais sur Internet/);
});

test("AUTORISE : la boucle locale passe, sinon la suite ne pourrait rien tester", async (t) => {
  const serveur = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  await new Promise<void>((resoudre) => serveur.listen(0, "127.0.0.1", resoudre));
  t.after(() => new Promise<void>((resoudre) => serveur.close(() => resoudre())));

  const port = (serveur.address() as AddressInfo).port;
  const reponse = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(await reponse.text(), "ok");
});
