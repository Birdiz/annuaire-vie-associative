import { test } from "node:test";
import assert from "node:assert/strict";

import { analyser } from "../../src/parse/html.ts";
import { RAYON_EXTRAIT, extraireContacts, extraitAutour } from "../../src/decouverte/extraction.ts";
import type { ContactExtrait, Extrait } from "../../src/decouverte/extraction.ts";

/**
 * ADR-040 : la preuve d'une carte de relecture. Ce qu'on defend ici : l'extrait cite ce que
 * la page **montrait** — l'ancre d'un `mailto:` quand l'adresse n'est pas ecrite, jamais le
 * contenu d'un `<script>` — et reste assez court pour tenir sur une carte.
 */

const BASE = "https://bruz.example/associations";

function preuves(html: string): Map<string, Extrait | undefined> {
  const doc = analyser(html, BASE);
  const { contacts } = extraireContacts(doc, { avecMobiles: false });
  return new Map(contacts.map((contact: ContactExtrait) => [contact.valeurNormalisee, extraitAutour(doc, contact)]));
}

test("une adresse lue dans le texte est surlignee telle quelle, avec ce qui l'entoure", () => {
  const extrait = preuves(
    "<p>Judo club du Val. Pour toute inscription, ecrire au tresorier : judo@asso.example. Cours le mercredi.</p>",
  ).get("judo@asso.example");

  assert.equal(extrait?.cible, "judo@asso.example");
  assert.match(extrait?.avant ?? "", /ecrire au tresorier : $/);
  assert.match(extrait?.apres ?? "", /^\. Cours le mercredi\.$/);
});

test("un mailto dont la page n'ecrit pas l'adresse surligne l'ancre que la page montrait", () => {
  const extrait = preuves(
    '<table><tr><td>Club de Bruz</td><td><a href="mailto:club@asso.example">Ecrire au club</a></td></tr></table>',
  ).get("club@asso.example");

  assert.equal(extrait?.cible, "Ecrire au club");
  assert.match(extrait?.avant ?? "", /Club de Bruz/);
});

test("un tel: ecrit en forme internationale retrouve le numero tel que la page l'affiche", () => {
  const doc = analyser("<p>Accueil du club : 02 99 00 11 22, le mardi.</p>", BASE);
  const extrait = extraitAutour(doc, {
    kind: "phone",
    valeur: "+33299001122",
    valeurNormalisee: "+33299001122",
    empreinte: "tel:+33299001122",
  });

  assert.equal(extrait?.cible, "02 99 00 11 22");
});

test("ADR-037 : un courriel TYPO3 surligne le lien chiffre que la page affichait", () => {
  const extrait = preuves(
    '<div><h1>Tennis club</h1><p>Nous joindre : <a href="#" data-mailto-token="nbjmup+ufoojtAbttp/fybnqmf" data-mailto-vector="1">Courriel du club</a></p></div>',
  ).get("tennis@asso.example");

  assert.equal(extrait?.cible, "Courriel du club");
});

test("un extrait ne cite jamais le contenu d'un script", () => {
  const extrait = preuves(
    '<script>var secret = "club@asso.example";</script><p>Contact du club : club@asso.example</p>',
  ).get("club@asso.example");

  assert.equal(extrait?.cible, "club@asso.example");
  assert.doesNotMatch(`${extrait?.avant}${extrait?.apres}`, /secret|var /);
});

test("une valeur que la page n'affiche pas n'a pas de preuve, plutot qu'une preuve inventee", () => {
  const doc = analyser("<p>Rien a voir ici.</p>", BASE);
  const extrait = extraitAutour(doc, {
    kind: "email",
    valeur: "absent@asso.example",
    valeurNormalisee: "absent@asso.example",
    empreinte: "mailto:absent@asso.example",
  });

  assert.equal(extrait, undefined);
});

test("l'extrait est borne et coupe aux mots, avec une ellipse de chaque cote", () => {
  const remplissage = Array.from({ length: 80 }, (_, i) => `mot${i}`).join(" ");
  const extrait = preuves(`<p>${remplissage} contact@asso.example ${remplissage}</p>`).get("contact@asso.example");

  assert.ok(extrait !== undefined);
  assert.ok(extrait.avant.startsWith("… mot"), "l'extrait commence par un mot entier");
  assert.ok(extrait.apres.endsWith(" …"));
  assert.ok(extrait.avant.length <= RAYON_EXTRAIT + 2);
  assert.ok(extrait.apres.length <= RAYON_EXTRAIT + 2);
});
