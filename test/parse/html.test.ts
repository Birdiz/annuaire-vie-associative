import { test } from "node:test";
import assert from "node:assert/strict";

import { analyser, decoder, estHtml } from "../../src/parse/html.ts";

/** Fixtures synthetiques, ecrites a la main : aucune page reelle n'entre dans le depot. */
const PAGE = `<html><head><title>Mairie de Bruz</title><style>a { color: red }</style></head><body>
<nav><a href="/vie-associative">Vie associative</a> <a href="https://ailleurs.example/x">Ailleurs</a></nav>
<table>
  <tr><td>Club de Bruz</td><td><a href="mailto:contact@club.example">&eacute;crire</a></td></tr>
  <tr><td>Amicale la&iuml;que</td><td>amicale<span>@</span>bruz.example</td></tr>
</table>
<script>var pisteur = "pisteur@regie.example";</script>
</body></html>`;

test("le contenu des script et des style n'est pas du texte de page", () => {
  const doc = analyser(PAGE, "https://exemple.fr/accueil");
  assert.ok(!doc.texte.includes("pisteur"), "une adresse de regie ne doit pas etre collectee");
  assert.ok(!doc.texte.includes("color"), "les regles CSS ne sont pas du texte");
});

test("les liens sont resolus en absolu et portent leur texte d'ancre", () => {
  const doc = analyser(PAGE, "https://exemple.fr/accueil");
  assert.deepEqual(doc.liens.slice(0, 2), [
    { href: "https://exemple.fr/vie-associative", ancre: "Vie associative" },
    { href: "https://ailleurs.example/x", ancre: "Ailleurs" },
  ]);
  assert.equal(doc.liens[2]?.href, "mailto:contact@club.example", "mailto est conserve tel quel");
});

test("un element en ligne ne coupe pas une adresse, un element de bloc separe deux cellules", () => {
  const doc = analyser(PAGE, "https://exemple.fr/accueil");
  assert.ok(
    doc.texte.includes("amicale@bruz.example"),
    `un <span> au milieu d'une adresse ne doit pas la couper : ${doc.texte}`,
  );
  assert.ok(
    !doc.texte.includes("Club de Bruzécrire"),
    "deux cellules voisines ne doivent pas etre collees, sinon un numero peut etre fabrique",
  );
});

test("les blocs vont du plus etroit au plus large et portent leurs liens", () => {
  const doc = analyser(PAGE, "https://exemple.fr/accueil");
  const ligne = doc.blocs.find((bloc) => bloc.texte.includes("Club de Bruz") && bloc.texte.includes("crire"));
  assert.ok(ligne !== undefined, "la ligne de tableau doit etre un bloc");
  assert.deepEqual(
    ligne.liens.map((lien) => lien.href),
    ["mailto:contact@club.example"],
    "un bloc porte les liens de son sous-arbre",
  );
  const cellule = doc.blocs.find((bloc) => bloc.texte === "Club de Bruz");
  assert.ok(cellule !== undefined, "la cellule doit aussi etre un bloc, plus etroit que la ligne");
});

test("les entites HTML sont decodees, y compris les references numeriques", () => {
  const doc = analyser("<p>Th&eacute;&acirc;tre &#38; danse &#x40; Bruz</p>", "https://exemple.fr/");
  assert.equal(doc.texte, "Théâtre & danse @ Bruz");
});

test("des items de liste non fermes restent des blocs distincts", () => {
  // Forme courante sur les sites de mairie. Si les deux items fusionnaient, un contact
  // serait rattache a l'association de la ligne precedente.
  const doc = analyser(
    `<ul><li>Club de Bruz <a href="mailto:club@a.example">ecrire</a>` +
      `<li>Amicale laique <a href="mailto:amicale@a.example">ecrire</a></ul>`,
    "https://exemple.fr/",
  );
  assert.deepEqual(
    doc.blocs.map((bloc) => bloc.texte),
    ["Club de Bruz ecrire", "Amicale laique ecrire"],
  );
  assert.deepEqual(
    doc.blocs.map((bloc) => bloc.liens.map((lien) => lien.href)),
    [["mailto:club@a.example"], ["mailto:amicale@a.example"]],
    "chaque item ne porte que son propre contact",
  );
});

test("une ancre interne ou un lien sans href ne produit aucun candidat", () => {
  const doc = analyser(
    `<a href="#contenu">Aller au contenu</a><a>sans href</a><a href="  ">vide</a>`,
    "https://exemple.fr/",
  );
  assert.deepEqual(doc.liens, [], "rien a suivre, et aucune exception");
});

test("un site declare en UTF-8 mais servi en Windows-1252 est quand meme lisible", () => {
  // Declaration mensongere frequente : y faire confiance ecrirait des « Ã© » en base,
  // donc dans l'export remis au client.
  const corps = Buffer.from("<html><body>Théâtre municipal</body></html>", "latin1");
  assert.match(decoder(corps, "text/html; charset=utf-8"), /Théâtre municipal/);
  assert.match(decoder(corps, null), /Théâtre municipal/);
  assert.match(decoder(corps, "text/html; charset=iso-8859-1"), /Théâtre municipal/);
});

test("le charset declare dans un meta est pris en compte a defaut d'en-tete", () => {
  const corps = Buffer.concat([
    Buffer.from('<html><head><meta charset="iso-8859-1"></head><body>', "latin1"),
    Buffer.from([0x54, 0x68, 0xe9, 0xe2, 0x74, 0x72, 0x65]),
    Buffer.from("</body></html>", "latin1"),
  ]);
  assert.match(decoder(corps, null), /Théâtre/);
});

test("un BOM prime sur toute declaration contraire", () => {
  const corps = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("<p>Théâtre</p>", "utf8")]);
  const texte = decoder(corps, "text/html; charset=iso-8859-1");
  assert.equal(texte, "<p>Théâtre</p>", "le BOM est un octet, pas une affirmation");
});

test("INVARIANT DE PACKAGING : l'ICU embarque connait Windows-1252", () => {
  // Un Node compile en small-icu ferait echouer le decodage de la moitie des sites de
  // mairie. Le repli existe, mais il doit rester un repli : si cette assertion tombe,
  // c'est l'image de distribution qu'il faut corriger, pas le code.
  assert.equal(new TextDecoder("windows-1252").encoding, "windows-1252");
  assert.equal(new TextDecoder("iso-8859-1").encoding, "windows-1252", "alias WHATWG attendu");
});

test("seul du HTML est analyse", () => {
  assert.ok(estHtml("text/html; charset=utf-8"));
  assert.ok(estHtml("application/xhtml+xml"));
  assert.ok(estHtml(null), "un type absent est frequent et le parseur est permissif");
  assert.ok(!estHtml("application/pdf"), "les sites de mairie sont pleins de PDF");
  assert.ok(!estHtml("text/plain"));
  assert.ok(!estHtml("image/png"));
});
