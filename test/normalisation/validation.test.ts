import { test } from "node:test";
import assert from "node:assert/strict";

import { valider, validerEmail, validerTelephone } from "../../src/normalisation/validation.ts";

/**
 * Etape [7], volet syntaxique. Le cas qui a motive ce module est reel et mesure :
 * un CMS repandu chez les petites communes ecrit ses `mailto:` sous la forme
 * `nom[^@]domaine.fr`, qu'un script repare cote client. Le motif large de l'etape [5]
 * les acceptait, et 138 contacts d'Ille-et-Vilaine comptaient dans la couverture.
 */

test("une adresse ordinaire est valide", () => {
  for (const adresse of [
    "contact@mairie.example",
    "prenom.nom@asso-du-bourg.example",
    "c@a.fr",
    "vie.associative+asso@ville.example.org",
    "l'inutile-mais-legal_1@a-b.example",
  ]) {
    assert.equal(validerEmail(adresse).valide, true, adresse);
  }
});

test("l'obfuscation [^@] est refusee, motif a l'appui", () => {
  const verdict = validerEmail("abcdanse[^@]gmail.example");
  assert.equal(verdict.valide, false);
  assert.equal(verdict.motif, "partie_locale");
});

test("les formes qui ne sont pas des adresses sont refusees, chacune pour sa raison", () => {
  const cas: readonly (readonly [string, string])[] = [
    ["", "longueur"],
    ["sans-arobase.example", "arobase"],
    ["@domaine.example", "arobase"],
    ["locale@", "arobase"],
    ["a@@b.example", "arobase"],
    ["espace dans@locale.example", "partie_locale"],
    ["locale@sansppoint", "domaine"],
    ["locale@-debut.example", "domaine"],
    ["locale@fin-.example", "domaine"],
    ["locale@double..point.example", "domaine"],
    ["locale@domaine.123", "domaine_de_tete"],
    [`${"a".repeat(65)}@domaine.example`, "longueur"],
  ];
  for (const [adresse, motif] of cas) {
    const verdict = validerEmail(adresse);
    assert.equal(verdict.valide, false, `« ${adresse} » aurait du etre refusee`);
    assert.equal(verdict.motif, motif, `« ${adresse} »`);
  }
});

test("un numero valide est celui que l'etape [5] produit, et rien d'autre", () => {
  assert.equal(validerTelephone("+33299000000").valide, true);
  assert.equal(validerTelephone("0299000000").valide, false);
  assert.equal(validerTelephone("+33099000000").valide, false, "pas de 0 apres l'indicatif");
  assert.equal(validerTelephone("+3329900000").valide, false, "un chiffre de moins");
  assert.equal(validerTelephone("+332990000000").valide, false, "un chiffre de plus");
});

test("valider aiguille selon le type de contact", () => {
  assert.equal(valider("email", "contact@mairie.example").valide, true);
  assert.equal(valider("phone", "contact@mairie.example").valide, false);
  assert.equal(valider("phone", "+33299000000").valide, true);
});
