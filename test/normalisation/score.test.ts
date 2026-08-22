import { test } from "node:test";
import assert from "node:assert/strict";

import { noter, VERSION_SCORE } from "../../src/normalisation/score.ts";
import type { ContactANoter } from "../../src/normalisation/score.ts";

/**
 * Etape [8] : le score de revue. Fonction pure, donc testable sans base ni reseau.
 *
 * Ce que ces tests defendent n'est pas un bareme — il bougera — mais ses proprietes :
 * un signal degrade toujours dans le meme sens, aucun signal ne fait sortir de [0, 1],
 * et tout ce qui a joue est explique dans les motifs.
 */

const PARFAIT: ContactANoter = {
  kind: "email",
  syntaxeValide: true,
  confiance: 0.9,
  isGenerique: 1,
  rattache: true,
  mx: 1,
  prefiltreVerdict: "retenue",
};

test("un contact ideal garde la confiance de lecture, sans signal degradant", () => {
  const note = noter(PARFAIT);
  assert.equal(note.score, 0.9);
  assert.deepEqual(note.motifs.signaux, [], "rien n'a joue, rien ne doit etre explique");
  assert.equal(note.motifs.base, 0.9);
});

test("chaque signal degrade, et jamais dans l'autre sens", () => {
  const reference = noter(PARFAIT).score;
  const degradations: readonly [string, Partial<ContactANoter>][] = [
    ["sans MX", { mx: 0 }],
    ["MX inconnu", { mx: null }],
    ["adresse nominative", { isGenerique: 0 }],
    ["regime indetermine", { isGenerique: null }],
    ["non rattache", { rattache: false }],
    ["page ecartee", { prefiltreVerdict: "ecartee" }],
    ["page non jugee", { prefiltreVerdict: null }],
    ["lecture moins sure", { confiance: 0.45 }],
  ];

  for (const [nom, modification] of degradations) {
    const note = noter({ ...PARFAIT, ...modification });
    assert.ok(note.score < reference, `${nom} doit faire baisser le score`);
    assert.ok(note.score >= 0 && note.score <= 1, `${nom} doit rester dans [0, 1]`);
  }
});

test("un domaine sans MX pese plus lourd que tous les autres signaux", () => {
  // Une adresse dont le domaine ne recoit pas de courrier est inexploitable : aucune
  // autre faiblesse ne doit lui etre comparable.
  const sansMx = noter({ ...PARFAIT, mx: 0 }).score;
  for (const autre of [
    noter({ ...PARFAIT, isGenerique: 0 }).score,
    noter({ ...PARFAIT, rattache: false }).score,
    noter({ ...PARFAIT, prefiltreVerdict: "ecartee" }).score,
  ]) {
    assert.ok(sansMx < autre, "l'absence de MX doit dominer");
  }
});

test("chaque signal qui a joue laisse un motif lisible", () => {
  const note = noter({ ...PARFAIT, mx: 0, isGenerique: 0, rattache: false, prefiltreVerdict: "ecartee" });
  const signaux = note.motifs.signaux.map((signal) => signal.signal);
  assert.deepEqual(signaux, ["mx", "regime", "rattachement", "page"]);
  for (const signal of note.motifs.signaux) {
    assert.ok(signal.facteur > 0 && signal.facteur < 1, `${signal.signal} : facteur hors ]0, 1[`);
    assert.ok(signal.detail.length > 0, `${signal.signal} : un motif sans texte n'explique rien`);
  }
  // Le score doit etre exactement le produit annonce : les motifs ne sont pas un
  // commentaire a cote du calcul, ils sont le calcul.
  const produit = note.motifs.signaux.reduce((acc, s) => acc * s.facteur, note.motifs.base);
  assert.equal(note.score, Math.round(produit * 100) / 100);
});

test("une valeur qui n'a pas la forme d'une adresse ne vaut rien, et le dit", () => {
  // Le facteur est nul et non seulement bas : il n'y a rien a arbitrer en revue, et un
  // score residuel ferait remonter cette ligne au-dessus de contacts lisibles.
  const note = noter({ ...PARFAIT, syntaxeValide: false });
  assert.equal(note.score, 0);
  assert.deepEqual(
    note.motifs.signaux.map((signal) => signal.signal),
    ["syntaxe"],
    "la syntaxe court-circuite : un facteur de MX sur une non-adresse serait absurde",
  );
});

test("le MX et le regime ne s'appliquent pas a un telephone", () => {
  const telephone = noter({
    kind: "phone",
    syntaxeValide: true,
    confiance: 0.9,
    isGenerique: null,
    rattache: true,
    mx: 0,
    prefiltreVerdict: "retenue",
  });
  assert.equal(telephone.score, 0.9, "un numero n'a ni domaine de messagerie ni regime d'adresse");
  assert.deepEqual(telephone.motifs.signaux, []);
});

test("une confiance hors bornes ne fait pas sortir le score de [0, 1]", () => {
  assert.equal(noter({ ...PARFAIT, confiance: 5 }).score, 1);
  assert.equal(noter({ ...PARFAIT, confiance: -1 }).score, 0);
  assert.equal(noter({ ...PARFAIT, confiance: Number.NaN }).score, 0);
});

test("la version du bareme est exposee et stable", () => {
  assert.equal(typeof VERSION_SCORE, "number");
  assert.ok(VERSION_SCORE >= 1);
});
