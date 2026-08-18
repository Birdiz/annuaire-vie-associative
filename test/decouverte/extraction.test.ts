import { test } from "node:test";
import assert from "node:assert/strict";

import { analyser } from "../../src/parse/html.ts";
import {
  classerEmail,
  estMobile,
  extraireContacts,
  normaliserTelephone,
} from "../../src/decouverte/extraction.ts";
import { LONGUEUR_MIN_NOM, indexerAssociations, rattacher } from "../../src/decouverte/rattachement.ts";
import { MOBILE_PREFIXES } from "../../src/invariants.ts";

const BASE = "https://exemple.fr/associations";

function extraire(html: string, avecMobiles = false) {
  return extraireContacts(analyser(html, BASE), { avecMobiles });
}

test("un lien declare par la page vaut plus qu'un motif lu dans du texte", () => {
  const { contacts } = extraire(
    `<p><a href="mailto:club@asso.example">ecrire</a></p><p>amicale@asso.example</p>`,
  );
  const parValeur = new Map(contacts.map((contact) => [contact.valeurNormalisee, contact]));
  const declare = parValeur.get("club@asso.example");
  const lu = parValeur.get("amicale@asso.example");

  assert.equal(declare?.methode, "dom:mailto");
  assert.equal(lu?.methode, "texte:motif");
  assert.ok(
    (declare?.confiance ?? 0) > (lu?.confiance ?? 0),
    "une declaration de l'auteur de la page vaut mieux qu'une lecture de notre part",
  );
});

test("une adresse obfusquee est reconstruite, avec la confiance la plus basse", () => {
  for (const forme of [
    "amicale [at] asso [dot] example",
    "amicale (at) asso (point) example",
    "amicale arobase asso point example",
  ]) {
    const { contacts } = extraire(`<p>Nous ecrire : ${forme}</p>`);
    const trouve = contacts.find((contact) => contact.valeurNormalisee === "amicale@asso.example");
    assert.ok(trouve !== undefined, `forme non reconnue : ${forme}`);
    assert.equal(trouve.methode, "texte:obfusque");
    assert.ok(trouve.confiance < 0.6, "une reconstruction n'est pas une lecture");
  }
});

test("un nom de fichier qui ressemble a une adresse n'en est pas une", () => {
  const { contacts } = extraire(`<p>logo@2x.png visuel@sprite.jpg style@main.css</p>`);
  assert.deepEqual(contacts, []);
});

test("INVARIANT §4.7 : generique, nominatif, ou indetermine", () => {
  assert.equal(classerEmail("contact@exemple.fr"), 1);
  assert.equal(classerEmail("secretariat@exemple.fr"), 1);
  assert.equal(classerEmail("vie.associative@exemple.fr"), 1, "une fonction reste une fonction");
  assert.equal(classerEmail("president@exemple.fr"), 1, "un role n'est pas une personne");
  assert.equal(classerEmail("marie.dupont@exemple.fr"), 0);
  assert.equal(classerEmail("j.dupont@exemple.fr"), 0);
  assert.equal(classerEmail("mdupont@exemple.fr"), null, "on ne devine pas ce que la forme ne dit pas");
  assert.equal(classerEmail("w35001@exemple.fr"), null);
});

test("INVARIANT §4.6 : les mobiles sont exclus par defaut, admis derriere le drapeau", () => {
  const page = `<p>Fixe 02 99 00 11 22 — mobile 06 12 34 56 78</p>`;

  const sans = extraire(page);
  assert.deepEqual(
    sans.contacts.map((contact) => contact.valeurNormalisee),
    ["+33299001122"],
  );
  assert.equal(sans.mobilesExclus, 1, "l'exclusion doit etre comptee, pas silencieuse");

  const avec = extraire(page, true);
  assert.deepEqual(
    avec.contacts.map((contact) => contact.valeurNormalisee).sort(),
    ["+33299001122", "+33612345678"],
  );
  assert.equal(avec.mobilesExclus, 0);
});

test("les prefixes mobiles sont ceux d'invariants.ts, appliques a la forme normalisee", () => {
  assert.deepEqual([...MOBILE_PREFIXES], ["06", "07"]);
  assert.ok(estMobile("+33612345678"));
  assert.ok(estMobile("+33712345678"));
  assert.ok(!estMobile("+33299001122"));
  // Ecrit en international, un mobile reste un mobile : c'est la normalisation qui le
  // garantit, et non un prefixe supplementaire dans la constante.
  assert.equal(normaliserTelephone("+33 6 12 34 56 78"), "+33612345678");
});

test("les formes usuelles de numero sont normalisees, les autres refusees", () => {
  for (const brut of ["02 99 00 11 22", "02.99.00.11.22", "02-99-00-11-22", "0299001122", "+33299001122"]) {
    assert.equal(normaliserTelephone(brut), "+33299001122", `forme non reconnue : ${brut}`);
  }
  assert.equal(normaliserTelephone("00 33 2 99 00 11 22"), "+33299001122");
  assert.equal(normaliserTelephone("12 34 56"), undefined);
  assert.equal(normaliserTelephone("00 99 00 11 22"), undefined, "un numero ne commence pas par 00");
  assert.equal(normaliserTelephone("SIRET 123 456 789"), undefined);
});

test("un contact est vu une seule fois, avec sa meilleure lecture", () => {
  // Cas le plus courant : l'adresse est a la fois dans le href et dans le texte du lien.
  const { contacts } = extraire(`<a href="mailto:club@asso.example">club@asso.example</a>`);
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0]?.methode, "dom:mailto");
});

test("le contexte d'un contact va de la cellule a la ligne", () => {
  const { contacts } = extraire(
    `<table><tr><td>Club de Bruz</td><td><a href="mailto:club@asso.example">ecrire</a></td></tr></table>`,
  );
  const contextes = contacts[0]?.contextes ?? [];
  assert.ok(contextes.length >= 2, "la cellule seule ne suffit pas a rattacher");
  assert.ok(
    contextes.some((contexte) => contexte.includes("Club de Bruz")),
    `un contexte doit porter le nom de l'association : ${JSON.stringify(contextes)}`,
  );
  assert.ok(
    (contextes[0]?.length ?? 0) <= (contextes[contextes.length - 1]?.length ?? 0),
    "les contextes vont du plus etroit au plus large",
  );
});

test("un contact est rattache a l'association nommee dans son bloc", () => {
  const index = indexerAssociations([
    { id: 1, nomNormalise: "club de bruz" },
    { id: 2, nomNormalise: "amicale laique de bruz" },
  ]);
  assert.deepEqual(rattacher(index, ["ecrire", "Club de Bruz ecrire"]), {
    associationId: 1,
    nomNormalise: "club de bruz",
  });
  assert.equal(rattacher(index, ["Nous ecrire"]), undefined, "aucun nom, aucun rattachement");
});

test("le rattachement resiste aux accents et a la ponctuation", () => {
  const index = indexerAssociations([{ id: 1, nomNormalise: "comite des fetes de saint meen" }]);
  assert.equal(rattacher(index, ["Comité des Fêtes de Saint-Méen — 02 99 00 11 22"])?.associationId, 1);
});

test("un nom trop court ne rattache rien", () => {
  const index = indexerAssociations([
    { id: 1, nomNormalise: "acca" },
    { id: 2, nomNormalise: "as bruz" },
  ]);
  assert.deepEqual(index, [], `sous ${LONGUEUR_MIN_NOM} caracteres, un nom rattacherait n'importe quoi`);
  assert.equal(rattacher(index, ["ACCA de Bruz, contact@acca.example"]), undefined);
});

test("un nom n'est reconnu que sur des mots entiers", () => {
  const index = indexerAssociations([{ id: 1, nomNormalise: "tennis club" }]);
  assert.equal(rattacher(index, ["Le tennis club bruzois"])?.associationId, 1, "suite de mots entiers");
  assert.equal(rattacher(index, ["Le tennisclub bruzois"]), undefined, "pas au milieu d'un mot");
});

test("a texte egal, le nom le plus long l'emporte", () => {
  const index = indexerAssociations([
    { id: 1, nomNormalise: "club de bruz" },
    { id: 2, nomNormalise: "club de bruz tennis de table" },
  ]);
  assert.equal(
    rattacher(index, ["Club de Bruz tennis de table, contact@exemple.fr"])?.associationId,
    2,
    "le nom le plus specifique designe mieux",
  );
});
