import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseRobots,
  isAllowed,
  patternMatches,
  effectiveDelayMs,
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
  const url = new URL("https://exemple.fr/recherche?q=asso#ancre");
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

test("Crawl-delay releve le plancher mais ne peut pas l'abaisser", () => {
  assert.equal(effectiveDelayMs(policy("User-agent: *\nCrawl-delay: 10\n"), 2_000), 10_000);
  assert.equal(effectiveDelayMs(policy("User-agent: *\nCrawl-delay: 0.5\n"), 2_000), 2_000);
  assert.equal(effectiveDelayMs(policy("User-agent: *\n"), 2_000), 2_000);
});

test("un Crawl-delay illisible est ignore plutot que devine", () => {
  assert.equal(effectiveDelayMs(policy("User-agent: *\nCrawl-delay: bientot\n"), 2_000), 2_000);
});
