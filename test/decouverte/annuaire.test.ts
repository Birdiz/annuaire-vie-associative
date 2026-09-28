import { test } from "node:test";
import assert from "node:assert/strict";

import { analyser } from "../../src/parse/html.ts";
import { extraireContacts } from "../../src/decouverte/extraction.ts";
import {
  lirePayloadDecouverte,
  lirePayloadPage,
  prioriteAnnuaire,
  prioritePage,
} from "../../src/decouverte/contexte.ts";
import {
  CONTACTS_MAX_PAR_FICHE,
  FICHES_MIN,
  PAGES_MAX_ANNUAIRE,
  contextesDeRattachement,
  horsAnnuaire,
  nettoyerLibelle,
  nommerDansLaPage,
  predicatFiche,
  reconnaitreAnnuaire,
} from "../../src/decouverte/annuaire.ts";
import type { RolePage } from "../../src/decouverte/annuaire.ts";
import type { Lien } from "../../src/parse/html.ts";

/**
 * ADR-038. Fixtures synthetiques ecrites a la main, sur la forme d'un annuaire de CMS de
 * mairie : une liste paginee de cartes, chacune liee a sa fiche.
 */
const ORIGINE = "https://ville.example";
const LISTE = `${ORIGINE}/vie-locale/annuaire-des-associations`;

function lien(chemin: string, ancre: string): Lien {
  return { href: new URL(chemin, ORIGINE).href, ancre };
}

function fiches(n: number): Lien[] {
  return Array.from({ length: n }, (_, i) => lien(`/vie-locale/annuaire-des-associations/club-${i}`, `Club ${i}`));
}

const PAGINATION: readonly Lien[] = [
  lien("/vie-locale/annuaire-des-associations?tx_paginate%5BcurrentPage%5D=2&cHash=ab12", "2"),
  lien("/vie-locale/annuaire-des-associations?tx_paginate%5BcurrentPage%5D=3&cHash=cd34", "3"),
  lien("/vie-locale/annuaire-des-associations?tx_paginate%5BcurrentPage%5D=2&cHash=ab12", "Suivant"),
];

test("une liste paginee de fiches est reconnue, pagination et fiches a part", () => {
  const annuaire = reconnaitreAnnuaire([...fiches(6), ...PAGINATION, lien("/contact", "Contact")], LISTE, "exploration");
  assert.ok(annuaire !== undefined);
  assert.equal(annuaire.fiches.length, 6);
  assert.equal(annuaire.pagination.length, 2, "« Suivant » et « 2 » menent a la meme page");
  assert.ok(
    annuaire.pagination.every((page) => page.urlRequete.includes("tx_paginate%5BcurrentPage%5D=")),
    "la page se demande telle que le site l'ecrit",
  );
});

test("les formes de pagination courantes sont reconnues", () => {
  const formes: readonly [string, string][] = [
    ["/associations", "/associations?page=2"],
    ["/associations", "/associations/?paged=3"],
    ["/associations", "/associations/page/2/"],
    ["/associations/page/2/", "/associations/page/3/"],
  ];
  for (const [base, suivante] of formes) {
    const liens = [
      ...Array.from({ length: FICHES_MIN }, (_, i) => lien(`/associations/club-${i}`, `Club ${i}`)),
      lien(suivante, "Suivant"),
    ];
    const annuaire = reconnaitreAnnuaire(liens, `${ORIGINE}${base}`, "exploration");
    assert.equal(annuaire?.pagination.length, 1, `${base} -> ${suivante}`);
    assert.equal(annuaire?.fiches.length, FICHES_MIN, `${base} -> ${suivante}`);
  }
});

test("ce qui n'est pas la liste d'un annuaire d'associations n'est pas reconnu", () => {
  const cas: readonly [string, readonly Lien[], RolePage][] = [
    // Trop peu de fiches : une rubrique et ses sous-pages.
    [LISTE, fiches(FICHES_MIN - 1), "exploration"],
    // Des actualites rangees sous la vie associative restent des actualites.
    [
      `${ORIGINE}/vie-associative/actualites`,
      Array.from({ length: 8 }, (_, i) => lien(`/vie-associative/actualites/article-${i}`, `Article ${i}`)),
      "exploration",
    ],
    [`${ORIGINE}/agenda`, Array.from({ length: 8 }, (_, i) => lien(`/agenda/evenement-${i}`, `Evenement ${i}`)), "exploration"],
    // L'annuaire des entreprises est un annuaire, pas celui des associations.
    [
      `${ORIGINE}/commerces/annuaire-des-entreprises`,
      Array.from({ length: 8 }, (_, i) => lien(`/commerces/annuaire-des-entreprises/garage-${i}`, `Garage ${i}`)),
      "exploration",
    ],
    // L'annuaire general de la mairie, et ceux qui ne sont pas des associations : suivis,
    // ils livraient des entreprises et des cabinets medicaux sous un indice associatif.
    [
      `${ORIGINE}/annuaire`,
      Array.from({ length: 8 }, (_, i) => lien(`/annuaire/entreprise-${i}`, `Entreprise ${i}`)),
      "exploration",
    ],
    [
      `${ORIGINE}/culture-sport-et-associations/annuaire-des-equipements`,
      Array.from({ length: 8 }, (_, i) => lien(`/culture-sport-et-associations/annuaire-des-equipements/gymnase-${i}`, `Gymnase ${i}`)),
      "exploration",
    ],
    [
      `${ORIGINE}/vie-associative/annuaire-des-professionnels`,
      Array.from({ length: 8 }, (_, i) => lien(`/vie-associative/annuaire-des-professionnels/cabinet-${i}`, `Cabinet ${i}`)),
      "exploration",
    ],
    // L'accueil lie des rubriques, il n'est pas un annuaire.
    [`${ORIGINE}/`, Array.from({ length: 8 }, (_, i) => lien(`/associations-${i}`, `Associations ${i}`)), "exploration"],
  ];
  for (const [base, liens, role] of cas) {
    assert.equal(reconnaitreAnnuaire(liens, base, role), undefined, base);
  }
});

test("ni les pages utilitaires du CMS ni les liens mal ecrits par le site ne sont des fiches", () => {
  const faux = [
    lien("/vie-locale/annuaire-des-associations/pdf", "Exporter la page au format PDF"),
    lien("/vie-locale/annuaire-des-associations/feed/", "Flux RSS"),
    lien("/vie-locale/annuaire-des-associations/imprimer", "Imprimer"),
    // Le site a oublie le schema ou le `mailto:` : le navigateur, comme nous, les resout en
    // relatif, et le serveur repond 404.
    lien("/vie-locale/annuaire-des-associations/www.club.example", "www.club.example"),
    lien("/vie-locale/annuaire-des-associations/club.example", "club.example"),
    lien("/vie-locale/annuaire-des-associations/president@club.example", "Ecrire"),
  ];
  const annuaire = reconnaitreAnnuaire([...fiches(5), ...faux], LISTE, "exploration");
  assert.deepEqual(
    annuaire?.fiches.map((fiche) => new URL(fiche.url).pathname.split("/").pop()),
    ["club-0", "club-1", "club-2", "club-3", "club-4"],
  );
  // Les extensions de page restent des fiches.
  const avecExtension = [...fiches(4), lien("/vie-locale/annuaire-des-associations/judo.html", "Judo")];
  assert.equal(reconnaitreAnnuaire(avecExtension, LISTE, "exploration")?.fiches.length, 5);
});

test("la derniere page d'une liste, atteinte par la pagination, n'a besoin que d'une fiche", () => {
  const derniere = `${LISTE}?tx_paginate%5BcurrentPage%5D=34&cHash=ef56`;
  assert.equal(reconnaitreAnnuaire(fiches(2), derniere, "exploration"), undefined);
  assert.equal(reconnaitreAnnuaire(fiches(2), derniere, "pagination")?.fiches.length, 2);
});

test("une fiche qui liste d'autres fiches est reconnue a son tour : l'annuaire range par categories", () => {
  const categorie = `${ORIGINE}/associations/sport`;
  const clubs = Array.from({ length: FICHES_MIN }, (_, i) => lien(`/associations/sport/club-${i}`, `Club ${i}`));
  assert.equal(reconnaitreAnnuaire(clubs, categorie, "fiche")?.fiches.length, FICHES_MIN);
});

test("seules les pages de l'annuaire sortent des liens d'exploration", () => {
  const liens = [...fiches(6), ...PAGINATION, lien("/vie-locale/forum-des-associations", "Forum des associations")];
  const annuaire = reconnaitreAnnuaire(liens, LISTE, "exploration");
  assert.deepEqual(
    horsAnnuaire(liens, annuaire, LISTE).map((l) => l.ancre),
    ["Forum des associations"],
  );
});

/** Une page de liste : six cartes, la categorie au-dessus du nom, l'adresse dessous. */
const PAGE_DE_LISTE = `<html><body><main><h1>Annuaire des associations</h1><ul>
${Array.from(
  { length: 6 },
  (_, i) => `<li><article>
  <p class="tag">Culture du monde</p>
  <h3><a href="/vie-locale/annuaire-des-associations/club-${i}">CLUB ${i} DE LA VILLE</a></h3>
  <div><p>Adresse : Chez M. Jean DUPONT, ${i} rue des Lilas</p>
  <p><a href="tel:047800000${i}">04 78 00 00 0${i}</a></p></div>
</article></li>`,
).join("\n")}
</ul><a href="/vie-locale/annuaire-des-associations?page=2">Suivant</a></main>
<footer><p>Mairie : <a href="tel:0478999999">04 78 99 99 99</a></p></footer></body></html>`;

function lire(html: string, base: string, role: RolePage) {
  const doc = analyser(html, base);
  const annuaire = reconnaitreAnnuaire(doc.liens, base, role);
  const extraction = extraireContacts(doc, { avecMobiles: false, estUneFiche: predicatFiche(annuaire, base) });
  const page = { doc, role, annuaire, contactsHorsGabarit: extraction.contactsHorsGabarit };
  return { page, contacts: extraction.contacts };
}

test("sur la liste, une carte nomme sa structure par l'ancre du lien vers sa fiche", () => {
  const { page, contacts } = lire(PAGE_DE_LISTE, LISTE, "exploration");
  assert.ok(page.annuaire !== undefined);

  const club = contacts.find((c) => c.valeurNormalisee === "+33478000003");
  assert.equal(club?.ancreDeFiche, "CLUB 3 DE LA VILLE");
  assert.deepEqual(nommerDansLaPage(club!, page, "Ville"), {
    nom: "CLUB 3 DE LA VILLE",
    normalise: "club 3 de la ville",
    source: "annuaire:ancre",
  });
  assert.equal(contextesDeRattachement(club!, page)[0], "CLUB 3 DE LA VILLE", "le RNA se cherche d'abord dans l'ancre");

  const mairie = contacts.find((c) => c.valeurNormalisee === "+33478999999");
  assert.equal(mairie?.gabarit, true);
  assert.equal(mairie?.ancreDeFiche, undefined, "le pied de page n'appartient a aucune carte");
});

const FICHE = `<html><body>
<nav><a href="/">Accueil</a></nav>
<main><header><p class="tag">Culture</p><h1>ACPE</h1><p class="teaser">Association culturelle des Pierres Elevees</p>
<div><p>Tel. : <a href="tel:0478111111">04 78 11 11 11</a></p>
<p><a href="#" data-mailto-token="nbjmup+bdqfAbttp/fybnqmf" data-mailto-vector="1">Courriel</a></p></div></header>
<p>Promouvoir la culture, la danse et la cuisine.</p></main>
<footer><p>Mairie de la Ville — <a href="tel:0478999999">04 78 99 99 99</a></p></footer>
</body></html>`;

test("sur une fiche, le titre nomme les contacts de la page, jamais ceux du pied de page", () => {
  const { page, contacts } = lire(FICHE, `${LISTE}/acpe`, "fiche");

  const courriel = contacts.find((c) => c.valeurNormalisee === "acpe@asso.example");
  assert.equal(courriel?.methode, "dom:mailto+typo3");
  assert.equal(nommerDansLaPage(courriel!, page, "Ville")?.nom, "ACPE");
  assert.equal(nommerDansLaPage(courriel!, page, "Ville")?.source, "fiche:titre");

  const telephone = contacts.find((c) => c.valeurNormalisee === "+33478111111");
  assert.equal(nommerDansLaPage(telephone!, page, "Ville")?.nom, "ACPE");
  assert.deepEqual(
    contextesDeRattachement(telephone!, page).slice(0, 2),
    ["Association culturelle des Pierres Elevees", "ACPE"],
    "la forme longue sert au rattachement au RNA",
  );

  const mairie = contacts.find((c) => c.valeurNormalisee === "+33478999999");
  assert.notEqual(nommerDansLaPage(mairie!, page, "Ville")?.nom, "ACPE");
});

test("la meme page lue en exploration ne se nomme pas par son titre", () => {
  const { page, contacts } = lire(FICHE, `${ORIGINE}/acpe`, "exploration");
  const telephone = contacts.find((c) => c.valeurNormalisee === "+33478111111");
  assert.notEqual(nommerDansLaPage(telephone!, page, "Ville")?.source, "fiche:titre");
});

test("une « fiche » qui porte trop de contacts est une rubrique : son titre ne nomme personne", () => {
  const lignes = Array.from(
    { length: CONTACTS_MAX_PAR_FICHE + 1 },
    (_, i) => `<p>Club ${i} : <a href="tel:04781000${String(i).padStart(2, "0")}">04 78 10 00 ${String(i).padStart(2, "0")}</a></p>`,
  ).join("");
  const { page, contacts } = lire(`<main><h1>Associations sportives</h1>${lignes}</main>`, `${LISTE}/sport`, "fiche");
  assert.ok(contacts.length > CONTACTS_MAX_PAR_FICHE);
  for (const contact of contacts) {
    assert.notEqual(nommerDansLaPage(contact, page, "Ville")?.source, "fiche:titre");
  }
});

test("un titre de fiche qui nomme une personne ne nomme rien", () => {
  const { page, contacts } = lire(
    `<main><h1>Jean DUPONT</h1><p><a href="tel:0478222222">04 78 22 22 22</a></p></main>`,
    `${LISTE}/jean-dupont`,
    "fiche",
  );
  assert.equal(nommerDansLaPage(contacts[0]!, page, "Ville"), undefined);
});

test("ADR-038 : une page d'annuaire passe apres toute l'exploration, la liste avant ses fiches", () => {
  const derniereExploration = prioritePage(2, 0);
  assert.ok(prioriteAnnuaire("pagination") > derniereExploration);
  assert.ok(prioriteAnnuaire("fiche") > prioriteAnnuaire("pagination"));
});

test("ADR-038 : un payload ecrit avant la 1.4.0 se lit en exploration, avec le budget d'annuaire par defaut", () => {
  const ancien = lirePayloadPage({
    codeInsee: "35047",
    url: "https://bruz.example/",
    campagne: "2026-08-18",
    profondeur: 1,
    maxPages: 20,
    avecMobiles: false,
  });
  assert.equal(ancien?.role, "exploration");
  assert.equal(ancien?.maxPagesAnnuaire, PAGES_MAX_ANNUAIRE);
  assert.equal(ancien?.urlRequete, undefined, "l'URL demandee reste alors `url`");

  const nul = lirePayloadDecouverte({ departement: "35", campagne: "2026-08-18", maxPagesAnnuaire: 0 });
  assert.equal(nul?.maxPagesAnnuaire, 0, "zero est un choix, pas une absence");

  assert.equal(
    lirePayloadPage({ codeInsee: "35047", url: "https://bruz.example/", campagne: "c", role: "inconnu" })?.role,
    "exploration",
  );
});

test("le bouton qui termine l'ancre d'une carte, ou le titre d'une fiche, ne fait pas partie du nom", () => {
  assert.equal(nettoyerLibelle("ASMC Yoga Fiche annuaire"), "ASMC Yoga");
  assert.equal(nettoyerLibelle("Club de voile — En savoir plus »"), "Club de voile");
  assert.equal(nettoyerLibelle("Plus d'infos"), "");
  assert.equal(nettoyerLibelle("Decouvrir le Beaujolais"), "Decouvrir le Beaujolais", "seulement en fin d'ancre");
});

test("un titre de fiche qui porte le libelle du bouton est nomme sans lui", () => {
  const { page, contacts } = lire(
    `<main><h1>ASMC Yoga <span class="sr-only">Fiche annuaire</span></h1><p><a href="tel:0478333333">04 78 33 33 33</a></p></main>`,
    `${LISTE}/asmc-yoga`,
    "fiche",
  );
  assert.equal(nommerDansLaPage(contacts[0]!, page, "Ville")?.nom, "ASMC Yoga");
});
