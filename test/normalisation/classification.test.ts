import { test } from "node:test";
import assert from "node:assert/strict";

import { classer, familleDe, VERSION_CLASSIFICATION } from "../../src/normalisation/classification.ts";

/**
 * Etape [7] : le type d'une association. Table de cas ecrite a la main — aucun nom
 * reel, aucune donnee collectee (§5).
 */

test("la famille est les trois premiers chiffres, code court recale a gauche", () => {
  assert.equal(familleDe("011000"), "011");
  assert.equal(familleDe("006030"), "006");
  // Le RNA ecrit tantot « 011000 », tantot « 11000 ». Sans recalage, la seconde forme
  // donnerait « 110 », famille inexistante, et l'association tomberait en silence dans
  // le fourre-tout.
  assert.equal(familleDe("11000"), "011");
  assert.equal(familleDe(""), undefined);
  assert.equal(familleDe(null), undefined);
  assert.equal(familleDe("abc"), undefined);
});

test("les familles connues donnent les quatre types que le code RNA distingue", () => {
  assert.equal(classer("011000", "Tennis municipal").type, "sportive");
  assert.equal(classer("006030", "Theatre du soir").type, "culturelle");
  assert.equal(classer("010000", "Les amis du vieux moulin").type, "culturelle");
  assert.equal(classer("020000", "Entraide sans frontieres").type, "sociale");
  assert.equal(classer("017000", "Donneurs de sang du bourg").type, "sociale");
});

test("une famille sans correspondance tombe dans diverses, mais reste tracee", () => {
  // Le brief ne prevoit aucun type pour l'environnement, l'education ou le culte. Le
  // fourre-tout est assume ; ce qui ne l'est pas serait de perdre la trace du code.
  const environnement = classer("024000", "Protection des rives");
  assert.equal(environnement.type, "diverses");
  assert.equal(environnement.source, "rna:024");

  const sansCode = classer(undefined, "Structure sans code");
  assert.equal(sansCode.type, "diverses");
  assert.equal(sansCode.source, "defaut");
});

test("le nom l'emporte sur le code pour les deux types que le code ne porte pas", () => {
  // Sur le departement de validation, les « comite des fetes » se repartissent sur six
  // familles differentes : aucun rabattement de famille ne les trouverait.
  for (const code of ["009000", "007000", "006030", "014035"]) {
    const verdict = classer(code, "Comite des fetes de Sainte-Colombe");
    assert.equal(verdict.type, "comite_des_fetes", `famille ${code}`);
    assert.equal(verdict.source, "nom:comite_des_fetes");
  }

  // Meme un nom en famille « sport » : le motif est plus specifique que la famille.
  assert.equal(classer("011000", "Centre de loisirs du bourg").type, "centre_de_loisirs");
  assert.equal(classer("015000", "Accueil de loisirs les Lutins").type, "centre_de_loisirs");
});

test("les apostrophes disparaissent a la normalisation, les deux graphies sont reconnues", () => {
  assert.equal(classer("009000", "Comite d'animation de la vallee").type, "comite_des_fetes");
  assert.equal(classer("009000", "Comite d animation de la vallee").type, "comite_des_fetes");
});

test("les motifs sont cherches sur limites de mots, pas par simple inclusion", () => {
  // « alsh » est un motif court : sans limites de mots il attraperait n'importe quel
  // nom qui contient ces quatre lettres a la suite.
  assert.equal(classer("011000", "Les Balshanais reunis").type, "sportive");
  assert.equal(classer("011000", "ALSH de la commune").type, "centre_de_loisirs");
});

test("la version de classification est exposee et stable", () => {
  assert.equal(typeof VERSION_CLASSIFICATION, "number");
  assert.ok(VERSION_CLASSIFICATION >= 1);
});
