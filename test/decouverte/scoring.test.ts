import { test } from "node:test";
import assert from "node:assert/strict";

import {
  LIENS_MAX_PAR_PAGE,
  PROFONDEUR_MAX,
  estReseauSocial,
  memeSite,
  scorerLien,
  selectionner,
} from "../../src/decouverte/scoring.ts";
import type { Lien } from "../../src/parse/html.ts";

const BASE = "https://exemple.fr/accueil";

function lien(href: string, ancre = ""): Lien {
  return { href, ancre };
}

test("les termes du §6 du brief remontent le score, sur l'URL comme sur l'ancre", () => {
  const parUrl = scorerLien(new URL("https://exemple.fr/vie-associative"), "En savoir plus");
  const parAncre = scorerLien(new URL("https://exemple.fr/rubrique-12"), "Vie associative");
  const parLesDeux = scorerLien(new URL("https://exemple.fr/vie-associative"), "Vie associative");

  assert.ok(parUrl > 0, "le chemin seul doit suffire");
  assert.ok(parAncre > 0, "l'ancre seule doit suffire");
  assert.ok(parLesDeux > parUrl, "un lien dont l'URL et l'ancre concordent est un meilleur pari");
});

test("les rubriques administratives sont ecartees, meme sur un site par ailleurs riche", () => {
  for (const chemin of ["/actualites", "/marches-publics", "/etat-civil", "/urbanisme", "/mentions-legales"]) {
    assert.ok(
      scorerLien(new URL(`https://exemple.fr${chemin}`), "") < 0,
      `${chemin} devrait etre ecarte : c'est la que part le budget sinon`,
    );
  }
});

test("un pluriel qui ne contient pas son singulier est quand meme reconnu", () => {
  // « marches publics » ne contient pas « marche public » : la liste doit porter les
  // deux formes, sinon la rubrique la plus courante des sites de mairie passe.
  assert.ok(scorerLien(new URL("https://exemple.fr/marches-publics"), "Marches publics") < 0);
  assert.ok(scorerLien(new URL("https://exemple.fr/comptes-rendus"), "Comptes rendus") < 0);
});

test("les accents et la casse de l'URL ne changent rien au score", () => {
  const sansAccent = scorerLien(new URL("https://exemple.fr/vie-associative"), "");
  const avecAccent = scorerLien(new URL("https://exemple.fr/Vie-Associative"), "");
  const encode = scorerLien(new URL("https://exemple.fr/vie-associative%20locale"), "");
  assert.equal(avecAccent, sansAccent);
  assert.ok(encode > 0, "un chemin encode doit etre decode avant scoring");
});

test("le site de la commune est reconnu au prefixe www pres, et lui seul", () => {
  const base = new URL(BASE);
  assert.ok(memeSite(new URL("https://www.exemple.fr/x"), base));
  assert.ok(memeSite(new URL("https://exemple.fr/x"), base));
  assert.ok(!memeSite(new URL("https://autre.exemple.fr/x"), base), "un sous-domaine peut appartenir a un tiers");
  assert.ok(!memeSite(new URL("https://exemple.com/x"), base));
});

test("INTERDIT : les reseaux sociaux sont reconnus quel que soit leur domaine de tete", () => {
  for (const hote of ["www.facebook.com", "fr-fr.facebook.com", "x.com", "twitter.com", "youtu.be", "instagram.com"]) {
    assert.ok(estReseauSocial(hote), `${hote} doit etre refuse (§5 du brief)`);
  }
  assert.ok(!estReseauSocial("exemple.fr"));
  assert.ok(!estReseauSocial("facebook.exemple.fr"), "un sous-domaine de la mairie reste un site de mairie");
});

test("un lien hors site est compte mais jamais suivi", () => {
  const resultat = selectionner(
    [lien("https://ailleurs.example/associations", "Associations"), lien("https://www.facebook.com/x", "Facebook")],
    BASE,
  );
  assert.deepEqual(resultat.retenus, []);
  assert.equal(resultat.horsDomaine, 2, "les deux doivent etre comptes, aucun retenu");
});

test("ce qui n'est pas une page est ecarte avant toute requete", () => {
  const resultat = selectionner(
    [
      lien("https://exemple.fr/associations.pdf", "Annuaire des associations"),
      lien("https://exemple.fr/photo-du-forum.jpg", "Forum des associations"),
      lien("https://exemple.fr/donnees.zip", "Associations"),
      lien("mailto:contact@exemple.fr", "Nous ecrire"),
      lien("javascript:void(0)", "Associations"),
    ],
    BASE,
  );
  assert.deepEqual(resultat.retenus, [], "aucun de ces liens ne merite une requete");
  assert.equal(resultat.ignores, 5);
});

test("la meme page vue sous deux formes n'est retenue qu'une fois", () => {
  const resultat = selectionner(
    [
      lien("https://exemple.fr/vie-associative", "Vie associative"),
      lien("https://www.exemple.fr/vie-associative", "Vie associative"),
      lien("https://exemple.fr/vie-associative#contenu", "Vie associative"),
    ],
    BASE,
  );
  assert.equal(resultat.retenus.length, 1, "sinon la meme page consommerait trois fois le budget");
  assert.equal(resultat.retenus[0]?.url, "https://exemple.fr/vie-associative");
});

test("la page d'ou vient le lien n'est pas reprise", () => {
  const resultat = selectionner([lien(BASE, "Accueil"), lien("https://www.exemple.fr/accueil", "Accueil")], BASE);
  assert.deepEqual(resultat.retenus, []);
});

test("les meilleurs liens passent devant, et leur nombre est borne", () => {
  const liens = [
    lien("https://exemple.fr/culture", "Culture"),
    lien("https://exemple.fr/vie-associative", "Vie associative"),
    lien("https://exemple.fr/sport", "Sport"),
    ...Array.from({ length: 20 }, (_, i) => lien(`https://exemple.fr/club-${i}`, "Club")),
  ];
  const resultat = selectionner(liens, BASE);

  assert.equal(resultat.retenus[0]?.url, "https://exemple.fr/vie-associative", "le mieux score d'abord");
  assert.equal(resultat.retenus.length, LIENS_MAX_PAR_PAGE, "une page de menu ne doit pas faire entrer tout le site");
  const scores = resultat.retenus.map((candidat) => candidat.score);
  assert.deepEqual([...scores].sort((a, b) => b - a), scores, "les scores doivent etre decroissants");
});

test("la profondeur retenue est celle du brief", () => {
  assert.equal(PROFONDEUR_MAX, 2, "§6 : profondeur 2");
});
