import { test } from "node:test";
import assert from "node:assert/strict";

import { analyser } from "../../src/parse/html.ts";
import { extraireContacts } from "../../src/decouverte/extraction.ts";
import { indexerAssociations } from "../../src/decouverte/rattachement.ts";
import { evaluerPage, SEUIL_PAR_DEFAUT } from "../../src/decouverte/prefiltre.ts";
import { normaliserNom } from "../../src/texte.ts";

/**
 * Etape [4] sur fixtures synthetiques. Aucune page reelle n'entre dans le depot, et
 * rien ici ne touche au reseau : la fonction evaluee est pure.
 */

const ASSOCIATIONS: readonly string[] = [
  "Club de Bruz",
  "Amicale laique de Bruz",
  "Tennis club bruzois",
  "Comite des fetes de Bruz",
];

const INDEX = indexerAssociations(
  ASSOCIATIONS.map((nom, i) => ({ id: i + 1, nomNormalise: normaliserNom(nom) })),
);

/** Assez de texte pour qu'une page ne soit pas jugee vide par simple absence de matiere. */
const REMPLISSAGE =
  "La commune accompagne les habitants dans leurs demarches quotidiennes et publie " +
  "regulierement les informations utiles a la vie du territoire, du lundi au vendredi.";

function evaluer(url: string, corps: string) {
  const doc = analyser(corps, url);
  return evaluerPage({
    url,
    doc,
    index: INDEX,
    contacts: extraireContacts(doc, { avecMobiles: false }).contacts,
  });
}

const ANNUAIRE = `<html><body>
<h1>Les associations de Bruz</h1>
<p>${REMPLISSAGE}</p>
<table>
  <tr><td>Club de Bruz</td><td><a href="mailto:club@asso.example">ecrire</a></td><td>02 99 00 11 22</td></tr>
  <tr><td>Amicale laique de Bruz</td><td>amicale [at] asso [dot] example</td><td>02 99 00 11 44</td></tr>
  <tr><td>Tennis club bruzois</td><td>marie.dupont@tennis.example</td><td>02 99 00 11 33</td></tr>
</table>
</body></html>`;

test("un tableau qui nomme des associations connues et leurs coordonnees est retenu", () => {
  const verdict = evaluer("https://bruz.example/vie-associative", ANNUAIRE);

  assert.equal(verdict.verdict, "retenue");
  assert.equal(verdict.motif, "liste", "c'est l'appariement nom/contact qui emporte la decision");
  assert.ok(verdict.signaux.nomsConnus >= 3, "les noms du RNA doivent etre reconnus dans la page");
  assert.ok(verdict.signaux.contactsRattaches >= 3, "chaque ligne porte un nom et son contact");
  assert.equal(
    verdict.candidateLlm,
    false,
    "l'extraction DOM a suffi : rien ne justifie le cout d'une inference",
  );
});

test("une page qui nomme des associations sans livrer de contact est le cas meme du fallback [6]", () => {
  const verdict = evaluer(
    "https://bruz.example/annuaire-des-associations",
    `<html><body><p>${REMPLISSAGE}</p><ul>
       <li>Club de Bruz</li>
       <li>Amicale laique de Bruz</li>
       <li>Tennis club bruzois</li>
       <li>Comite des fetes de Bruz</li>
     </ul></body></html>`,
  );

  assert.equal(verdict.verdict, "retenue");
  assert.equal(verdict.signaux.contacts, 0);
  assert.equal(
    verdict.candidateLlm,
    true,
    "quatre associations nommees et aucun contact : le DOM passe a cote de quelque chose",
  );
});

test("les deux vides ne se valent pas : sans noms ni contacts, la page n'est pas candidate", () => {
  const verdict = evaluer(
    "https://bruz.example/conseil-municipal",
    `<html><body><p>${REMPLISSAGE}</p><p>${REMPLISSAGE}</p></body></html>`,
  );

  assert.equal(verdict.verdict, "ecartee");
  assert.equal(verdict.candidateLlm, false, "une page sans rien n'a rien a offrir a une inference");
});

test("une rubrique administrative est ecartee, et le motif dit pourquoi", () => {
  const verdict = evaluer(
    "https://bruz.example/actualites/marches-publics",
    `<html><body><h1>Avis d'appel public a la concurrence</h1><p>${REMPLISSAGE}</p></body></html>`,
  );

  assert.equal(verdict.verdict, "ecartee");
  assert.equal(verdict.motif, "negatif", "un « ecartee » sans raison ne serait pas discutable en revue");
  assert.ok(verdict.signaux.vocabulaire < 0);
});

test("une page sans texte est dite vide, et non depourvue de vie associative", () => {
  const verdict = evaluer("https://bruz.example/", `<html><body><div id="app"></div></body></html>`);

  assert.equal(verdict.verdict, "ecartee");
  assert.equal(
    verdict.motif,
    "vide",
    "un site rendu en JavaScript n'est pas un site sans associations, et le §4.1 nous interdit de le rendre",
  );
});

test("le vocabulaire est lu sur le chemin de l'URL, pas sur le texte de la page", () => {
  // Le texte d'une page de mairie contient la navigation du site, donc les rubriques de
  // toutes les autres pages : « sport » et « associations » y figurent partout.
  const corps = `<html><body><nav><a href="/sport">Sport</a><a href="/associations">Associations</a>
    <a href="/culture">Culture et loisirs</a></nav><p>${REMPLISSAGE}</p></body></html>`;

  const surRubrique = evaluer("https://bruz.example/vie-associative", corps);
  const surEtatCivil = evaluer("https://bruz.example/etat-civil", corps);

  assert.ok(
    surRubrique.signaux.vocabulaire > surEtatCivil.signaux.vocabulaire,
    "seul le chemin distingue ces deux pages, et il doit suffire",
  );
});

test("aucun signal ne sature le score : le classement reste lisible", () => {
  const beaucoup = ASSOCIATIONS.concat(ASSOCIATIONS).map((nom) => `<li>${nom}</li>`).join("");
  const verdict = evaluer(
    "https://bruz.example/associations",
    `<html><body><p>${REMPLISSAGE}</p><ul>${beaucoup}</ul></body></html>`,
  );

  // Quatre noms suffisent a atteindre le plafond : en repeter huit n'ajoute rien.
  assert.ok(verdict.score <= 20, `score plafonne attendu, recu ${verdict.score}`);
});

test("le seuil est un parametre, pas une propriete de la page", () => {
  const doc = analyser(ANNUAIRE, "https://bruz.example/vie-associative");
  const contacts = extraireContacts(doc, { avecMobiles: false }).contacts;
  const commun = { url: "https://bruz.example/vie-associative", doc, index: INDEX, contacts };

  assert.equal(evaluerPage({ ...commun, seuil: SEUIL_PAR_DEFAUT }).verdict, "retenue");
  assert.equal(
    evaluerPage({ ...commun, seuil: 999 }).verdict,
    "ecartee",
    "regler le seuil doit deplacer la frontiere, sans toucher aux signaux",
  );
  assert.deepEqual(
    evaluerPage({ ...commun, seuil: 999 }).signaux,
    evaluerPage({ ...commun, seuil: 1 }).signaux,
    "les signaux sont mesures, le seuil les interprete",
  );
});
