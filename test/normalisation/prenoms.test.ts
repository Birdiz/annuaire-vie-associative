import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  PRENOMS,
  PRENOMS_SEUIL,
  PRENOMS_SHA256,
  PRENOMS_SOURCE,
  PRENOMS_SOURCE_SHA256,
} from "../../src/normalisation/prenoms.ts";
import { EXCLUS } from "../../scripts/prenoms.ts";
import { MOTS_DE_STRUCTURE } from "../../src/normalisation/plausibilite.ts";

/**
 * La liste de prenoms est le deuxieme fichier tiers embarque, apres htmx (ADR-036). Meme
 * discipline : sa provenance est une constante, et son empreinte est verifiee — une liste
 * de deux mille mots ne se relit pas en revue de diff.
 */

test("la liste est celle que le script a generee, et personne ne l'a retouchee", () => {
  const empreinte = createHash("sha256").update(PRENOMS, "utf8").digest("hex");
  assert.equal(empreinte, PRENOMS_SHA256, "regenerer avec `node scripts/prenoms.ts`, ne pas editer a la main");
  assert.match(PRENOMS_SOURCE, /INSEE/);
  assert.match(PRENOMS_SOURCE, /Licence Ouverte/);
  assert.match(PRENOMS_SOURCE_SHA256, /^[0-9a-f]{64}$/);
  assert.ok(PRENOMS_SEUIL >= 1);
});

test("la liste est triee, sans doublon, en minuscules sans accents", () => {
  const prenoms = PRENOMS.split(" ");
  assert.deepEqual(prenoms, [...prenoms].sort(), "triee");
  assert.equal(new Set(prenoms).size, prenoms.length, "sans doublon");
  for (const prenom of prenoms) assert.match(prenom, /^[a-z]{3,}$/, prenom);
  for (const courant of ["pierre", "marie", "jean", "sylvie", "christophe", "nathalie"]) {
    assert.ok(prenoms.includes(courant), courant);
  }
});

test("aucun mot de structure ni aucune exclusion n'y figure", () => {
  const prenoms = new Set(PRENOMS.split(" "));
  for (const exclu of EXCLUS) assert.equal(prenoms.has(exclu), false, exclu);
  for (const mot of MOTS_DE_STRUCTURE) assert.equal(prenoms.has(mot), false, mot);
});

test("son poids reste celui d'une liste, pas d'un dictionnaire", () => {
  // Le poids du bundle est un critere de conception. Au-dela, c'est le seuil qu'il faut
  // revoir, pas la limite.
  assert.ok(PRENOMS.length < 20_000, `${PRENOMS.length} octets`);
});
