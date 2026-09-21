import { test } from "node:test";
import assert from "node:assert/strict";

import {
  designeUnePersonne,
  estUnNomDePersonne,
  estUnPrenom,
  porteUnePersonne,
} from "../../src/normalisation/personne.ts";
import { MOTIFS_NOM } from "../../src/normalisation/classification.ts";

/**
 * Une personne n'est pas une structure (ADR-036).
 *
 * Les formes rejetees ci-dessous reproduisent celles que le client a trouvees dans ses
 * fichiers de l'Ain et de la Haute-Loire — un quart des lignes livrees —, avec des noms
 * **inventes** : aucune donnee collectee n'entre dans le depot. Les formes gardees sont le
 * vrai risque : un filtre trop zele viderait le fichier sans que personne ne sache pourquoi.
 */

test("un nom de personne, sous toutes ses formes, n'est pas un nom de structure", () => {
  for (const segment of [
    "Annie DURANDEL",
    "DURANDEL Gerard",
    "Jean Paul DURANDEL",
    "DURANDEL Marie Thérèse",
    "Aline DURANDEL-PICHOT",
    "Delphine DE MARTINO",
    "Christophe Durandel",
    "Pierre",
    "Sylvie",
    "Jean-Baptiste",
    "Katy Le Santel",
    "Laure DURANDEL et Paul MARTINOT",
    "Henri Durandel ou Jean-Pierre Martinot",
    "Caroline DURANDEL - Julie MARTINOT",
    "FAISANDEL Nadine Trésorière",
    "Julien Martinot Tél",
    "Margaux DURANDEL Mail",
    "Marie-Andrée DURANDEL au",
  ]) {
    assert.equal(designeUnePersonne(segment), true, segment);
  }
});

test("ce qui designe une personne contamine le nom qu'il accompagne", () => {
  // Un nom qui porte une personne n'est pas livrable, meme s'il nomme aussi une structure.
  for (const segment of [
    "Agnès DURANDEL préside cette association",
    "Il est présidé par Paul Martinot.",
    "Entraineur M Christophe DURANDEL",
    "Mme DURANDEL Accueil de loisirs",
    "Père Jean Louis Martinot",
    "Sébastien Martinot (directeur général)",
    "Laetitia Durandel (responsable) et Annie Martinot",
  ]) {
    assert.equal(porteUnePersonne(segment), true, segment);
  }
});

test("une structure qui porte le nom d'une personne reste une structure", () => {
  for (const segment of [
    "Association Jean Moulin",
    "Les Amis de Pierre Loti",
    "Club Léo Lagrange",
    "Saint-Pierre Sports",
    "Ecole Jules Ferry",
    "Espace Simone Veil",
    "Jeanne d'Arc",
    "Harmonie municipale",
    "APEL Saint-Joseph",
    "SPA Haute-Loire",
    "Anciens AFN",
    "Sofia Prod",
    "Lorraine Patrimoine",
    "Fleur de Lotus",
    "Comité des fêtes - Président",
    "Les Amis de Madame Bovary",
    "Karaté Club - St - Grégoire",
    "Collège Jean-Paul II",
    "JEAN MOULIN",
    "ROSE DE PICARDIE",
    "MARTIN PECHEUR",
    "SOPHIA",
    "Tennis Club ABC",
    "ASRU Bruzou",
    "Nancy",
    "Mardi matin",
  ]) {
    assert.equal(designeUnePersonne(segment), false, segment);
  }
});

test("aucun motif de structure n'est pris pour une personne", () => {
  // Le garde-fou symetrique de celui du mobilier : un mot ajoute demain a la liste des
  // prenoms ne doit pas eteindre « Accueil de loisirs » en silence.
  for (const [motif] of MOTIFS_NOM) {
    assert.equal(designeUnePersonne(`${motif} du Ru`), false, motif);
    assert.equal(designeUnePersonne(motif.toUpperCase()), false, motif);
  }
});

test("un prenom compose l'est par chacune de ses parties", () => {
  assert.equal(estUnPrenom("Jean-Pierre"), true);
  assert.equal(estUnPrenom("Marie-Thérèse"), true);
  assert.equal(estUnPrenom("Saint-Pierre"), false, "saint n'est pas un prenom");
  // Les prenoms qui sont aussi des mots de structure ou des mois sont hors de la liste.
  for (const mot of ["Harmonie", "Espérance", "Avril", "France"]) assert.equal(estUnPrenom(mot), false, mot);
});

test("en capitales partout, seule la forme du prenom seul ne suffit plus", () => {
  // « RESEAU LILAS », « PAGE BLANCHE » sont des noms du RNA : sans la casse, « NOM Prenom »
  // et « MOT Prenom » ne se separent pas.
  assert.equal(estUnNomDePersonne("RESEAU LILAS"), false);
  assert.equal(estUnNomDePersonne("PIERRE ANGULAIRE"), false);
  // En casse mixte, le nom de famille en capitales confirme.
  assert.equal(estUnNomDePersonne("Pierre ANGULAIREAU"), true);
});

test("la ponctuation, un chiffre ou un mot-outil au bout du nom ne cachent pas la personne", () => {
  // Formes relevees sur l'Ille-et-Vilaine et les Vosges, noms inventes.
  for (const segment of ["Evelyne DURANDEL (", "Lucien DURANDEL Lieu d'", "Sophie DURANDEL -Gaëtan MARTINOT", "Véronique Durandel au 06 39"]) {
    assert.equal(designeUnePersonne(segment), true, segment);
  }
});
