import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseRobots,
  isAllowed,
  patternMatches,
  pathWithQuery,
  ALLOW_ALL,
  DISALLOW_ALL,
} from "../../src/http/robots.ts";

const TOKEN = "annuairevieassociative";

function policy(text: string) {
  return parseRobots(text, TOKEN);
}

test("un robots.txt vide n'interdit rien", () => {
  assert.equal(isAllowed(policy(""), "/associations"), true);
  assert.equal(isAllowed(ALLOW_ALL, "/n-importe-quoi"), true);
  assert.equal(isAllowed(DISALLOW_ALL, "/"), false);
});

test("les commentaires et les lignes vides sont ignores", () => {
  const p = policy("# commentaire\n\nUser-agent: *\nDisallow: /prive # interdit\n");
  assert.equal(isAllowed(p, "/prive/page"), false);
  assert.equal(isAllowed(p, "/public"), true);
});

test("« Disallow: » sans valeur n'est pas une interdiction", () => {
  assert.equal(isAllowed(policy("User-agent: *\nDisallow:\n"), "/quoi-que-ce-soit"), true);
});

test("la regle la plus longue gagne, et Allow l'emporte a egalite", () => {
  const p = policy("User-agent: *\nDisallow: /associations\nAllow: /associations/annuaire\n");
  assert.equal(isAllowed(p, "/associations"), false);
  assert.equal(isAllowed(p, "/associations/liste"), false);
  assert.equal(isAllowed(p, "/associations/annuaire"), true);

  const egalite = policy("User-agent: *\nDisallow: /a\nAllow: /a\n");
  assert.equal(isAllowed(egalite, "/a"), true);
});

test("un groupe specifique remplace le groupe generique", () => {
  const p = policy(
    "User-agent: *\nDisallow: /\n\n" + `User-agent: ${TOKEN}\nDisallow: /prive\n`,
  );
  assert.equal(isAllowed(p, "/associations"), true, "notre groupe ne doit pas heriter du groupe *");
  assert.equal(isAllowed(p, "/prive"), false);
});

test("plusieurs User-agent consecutifs partagent le meme groupe", () => {
  const p = policy(`User-agent: AutreBot\nUser-agent: ${TOKEN}\nDisallow: /interdit\n`);
  assert.equal(isAllowed(p, "/interdit"), false);
  assert.equal(isAllowed(p, "/autorise"), true);
});

test("la correspondance de User-agent est insensible a la casse", () => {
  const p = parseRobots("User-agent: AnnuaireVieAssociative\nDisallow: /x\n", TOKEN);
  assert.equal(isAllowed(p, "/x"), false);
});

test("les jokers * et $ sont pris en charge", () => {
  assert.equal(patternMatches("/*.pdf$", "/docs/rapport.pdf"), true);
  assert.equal(patternMatches("/*.pdf$", "/docs/rapport.pdf?v=1"), false);
  assert.equal(patternMatches("/api/*/prive", "/api/v1/prive"), true);
  assert.equal(patternMatches("/prive", "/prive/sous-page"), true);
  assert.equal(patternMatches("/prive", "/public"), false);
});

test("les caracteres speciaux d'expression reguliere sont neutralises", () => {
  assert.equal(patternMatches("/a+b(c)", "/a+b(c)/page"), true);
  assert.equal(patternMatches("/a+b(c)", "/aaab"), false);
});

test("le motif est compare au chemin et a la query, sans le fragment", () => {
  const url = new URL("https://exemple.example/recherche?q=asso#ancre");
  assert.equal(pathWithQuery(url), "/recherche?q=asso");

  const p = policy("User-agent: *\nDisallow: /*?*\n");
  assert.equal(isAllowed(p, pathWithQuery(url)), false);
  assert.equal(isAllowed(p, "/recherche"), true);
});

test("le cas reel de data.gouv : le redirecteur est interdit, l'API de metadonnees non", () => {
  // Extrait fidele du robots.txt de data.gouv.fr (verifie le 17/08/2026).
  const p = policy("User-agent: *\nDisallow: /admin\nDisallow: /api/1/datasets/r/\nDisallow: /resources\n");

  assert.equal(isAllowed(p, "/api/1/datasets/r/73302880-e4df-4d4c-8676-1a61bb997f3d"), false);
  assert.equal(
    isAllowed(p, "/api/1/datasets/service-public-gouv-fr-annuaire-de-ladministration-base-de-donnees-locales/"),
    true,
    "l'API de metadonnees doit rester accessible : c'est par elle qu'on obtient les URL directes",
  );
});

/**
 * Le delai annonce par le site, en millisecondes. Le **plancher** de deux secondes, lui,
 * est applique par `DomainThrottle` et teste la-bas : l'ecrire une seconde fois ici
 * donnerait deux sources de verite pour un invariant qui doit n'en avoir qu'une.
 */
function delaiAnnonce(p: ReturnType<typeof policy>): number {
  return Math.max(2_000, p.crawlDelayMs ?? 0);
}

test("Crawl-delay releve le plancher mais ne peut pas l'abaisser", () => {
  assert.equal(delaiAnnonce(policy("User-agent: *\nCrawl-delay: 10\n")), 10_000);
  assert.equal(delaiAnnonce(policy("User-agent: *\nCrawl-delay: 0.5\n")), 2_000);
  assert.equal(delaiAnnonce(policy("User-agent: *\n")), 2_000);
});

test("un Crawl-delay illisible est ignore plutot que devine", () => {
  assert.equal(delaiAnnonce(policy("User-agent: *\nCrawl-delay: bientot\n")), 2_000);
});

test("un Crawl-delay absurde est plafonne plutot que subi", () => {
  // « Crawl-delay: 86400 » se rencontre. Sans plafond, le job renouvelle son bail
  // toutes les 30 s et occupe un slot de concurrence pendant 24 h ; au-dela de
  // 2^31-1 ms, `setTimeout` ramene silencieusement le delai a 1 ms et la boucle de
  // garde du throttle se met a tourner a vide pendant des annees.
  assert.equal(delaiAnnonce(policy("User-agent: *\nCrawl-delay: 86400\n")), 60_000);
  assert.equal(delaiAnnonce(policy("User-agent: *\nCrawl-delay: 3000000\n")), 60_000);
  assert.equal(delaiAnnonce(policy("User-agent: *\nCrawl-delay: 45\n")), 45_000);
});

test("RFC 9309 §2.2.1 : deux groupes visant le meme agent sont fusionnes", () => {
  // Ne retenir que le premier bloc laissait tomber les Disallow du second, c'est-a-dire
  // echouer dans le sens permissif sur un invariant qui n'en tolere pas.
  const p = policy("User-agent: *\nDisallow: /prive\n\nUser-agent: *\nDisallow: /interne\n");
  assert.equal(isAllowed(p, "/prive/x"), false);
  assert.equal(isAllowed(p, "/interne/x"), false, "le second bloc doit compter autant que le premier");
  assert.equal(isAllowed(p, "/public"), true);
});

test("a la fusion, c'est le Crawl-delay le plus long qui est retenu", () => {
  const p = policy("User-agent: *\nCrawl-delay: 5\n\nUser-agent: *\nCrawl-delay: 12\n");
  assert.equal(delaiAnnonce(p), 12_000);
});

test("un motif a etoiles multiples s'evalue en temps borne", () => {
  // Traduit en regex, ce motif produit `.*a.*a.*a...b` : le temps doublait tous les
  // deux caracteres, et cette assertion ne terminait pas. Le chemin est non
  // contournable (§4.2), donc un robots.txt maladroit gelait l'outil pour de bon.
  const motif = `/${"a*".repeat(14)}b`;
  const chemin = `/${"a".repeat(60)}`;
  const debut = process.hrtime.bigint();
  assert.equal(patternMatches(motif, chemin), false);
  const millisecondes = Number(process.hrtime.bigint() - debut) / 1e6;
  assert.ok(millisecondes < 50, `evaluation en ${millisecondes.toFixed(1)} ms, attendu moins de 50`);
});
