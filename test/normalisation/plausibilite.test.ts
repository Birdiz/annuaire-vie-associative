import { test } from "node:test";
import assert from "node:assert/strict";

import {
  estStructurePlausible,
  evoqueUnCommerce,
  evoqueUneStructure,
} from "../../src/normalisation/plausibilite.ts";
import { MOTIFS_NOM } from "../../src/normalisation/classification.ts";

/**
 * Ce module decide de ce qui sort du profil simple. Ce qu'on defend ici : une ligne du
 * fichier livre **affirme** une structure de la vie associative, et le client de la Loire
 * a eu raison de refuser celles qui n'en etaient pas.
 */

test("les motifs de classification sont tous reconnus comme des structures", () => {
  // Sans cela, « Accueil de loisirs du Ru » serait classe par un module et refuse par
  // l'autre — c'est exactement le genre de divergence que la liste unique evite.
  for (const [motif] of MOTIFS_NOM) {
    assert.ok(evoqueUneStructure(motif), motif);
  }
});

test("un commerce se reconnait, et une association qui en porte le mot n'en est pas un", () => {
  for (const nom of [
    "Garage Pupier",
    "Boulangerie Vericel-Guyot",
    "CIC Lyonnaise de banque",
    "GAEC Jacquet Elevage",
    "Efficity Immobilier",
    "SABINE Coiffure",
  ]) {
    assert.ok(evoqueUnCommerce(nom), nom);
  }
  // Le nom qui porte les deux nomme une association : c'est le sens de la priorite.
  assert.ok(!evoqueUnCommerce("Amicale des Boulangers"));
  assert.ok(!evoqueUnCommerce("Association des commercants de Bruzou"));
  // Et le filtre porte sur des mots, jamais sur des sous-chaines.
  assert.ok(!evoqueUnCommerce("AUTOUR DU LIVRE"), "« autour » contient « auto »");
});

test("le RNA passe avant tout, le commerce avant tout le reste", () => {
  const socle = { nomInfere: false, pageAssociative: false };
  // Une association du registre sort, quoi qu'en disent les heuristiques.
  assert.ok(estStructurePlausible({ ...socle, rattacheeAuRna: true, nom: "Garage des Amis" }));
  // Une liste de commercants publiee sous /vie-locale/ reste une liste de commercants.
  assert.ok(
    !estStructurePlausible({
      ...socle,
      rattacheeAuRna: false,
      nom: "Garage Pupier",
      pageAssociative: true,
    }),
  );
});

test("un nom lu se defend par son vocabulaire ou par sa page ; un nom deduit, par sa page seule", () => {
  const lu = { rattacheeAuRna: false, nomInfere: false, pageAssociative: false };
  assert.ok(estStructurePlausible({ ...lu, nom: "Amicale des Meuniers" }), "le vocabulaire suffit");
  assert.ok(!estStructurePlausible({ ...lu, nom: "Les Traives" }), "rien ne l'appuie");
  assert.ok(estStructurePlausible({ ...lu, nom: "Les Traives", pageAssociative: true }));

  // Une inference n'a ete lue nulle part : son vocabulaire ne prouve donc rien de plus
  // que le domaine dont elle sort. Seule la page peut la corroborer.
  const deduit = { ...lu, nomInfere: true };
  assert.ok(!estStructurePlausible({ ...deduit, nom: "Judo Club Bruzou" }));
  assert.ok(estStructurePlausible({ ...deduit, nom: "Judo Club Bruzou", pageAssociative: true }));
});

test("une personne n'est pas une structure, meme sur une page d'annuaire ; le RNA passe toujours", () => {
  // Lot 12 (ADR-036). L'indice de page ne rachete pas un nom de personne.
  const base = { rattacheeAuRna: false, nomInfere: false, pageAssociative: true };
  assert.equal(estStructurePlausible({ ...base, nom: "Annie DURANDEL", personne: true }), false);
  assert.equal(estStructurePlausible({ ...base, nom: "Jean Durandel", nomInfere: true, personne: true }), false);
  assert.equal(estStructurePlausible({ ...base, rattacheeAuRna: true, nom: "ASSOCIATION JEAN MOULIN", personne: true }), true);
  assert.equal(estStructurePlausible({ ...base, nom: "Amicale du Moulin", personne: false }), true);
});
