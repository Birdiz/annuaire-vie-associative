import { test } from "node:test";
import assert from "node:assert/strict";
import { JsonArraySplitter, JsonArrayError } from "../../src/parse/json-stream.ts";

function decouper(entree: string, taille: number): string[] {
  const octets = Buffer.from(entree, "utf8");
  const splitter = new JsonArraySplitter("service");
  const objets: string[] = [];
  for (let i = 0; i < octets.length; i += taille) {
    objets.push(...splitter.push(octets.subarray(i, i + taille)));
  }
  objets.push(...splitter.end());
  return objets;
}

const DUMP = `{
  "service" : [ {
    "nom" : "Mairie - A",
    "site_internet" : [ { "libelle" : "", "valeur" : "https://a.fr" } ],
    "pivot" : [ { "type_service_local" : "mairie", "code_insee_commune" : [ "35001" ] } ]
  }, {
    "nom" : "Mairie - B {piege}",
    "commentaire" : "un guillemet echappe \\" et une accolade } dans une chaine",
    "pivot" : [ { "type_service_local" : "mairie", "code_insee_commune" : [ "35002" ] } ]
  }, {
    "nom" : "Service - C",
    "imbrique" : { "a" : { "b" : [ 1, 2, { "c" : 3 } ] } }
  } ]
}`;

test("rend chaque objet du tableau", () => {
  const objets = decouper(DUMP, 4096);
  assert.equal(objets.length, 3);
  assert.equal(JSON.parse(objets[0] ?? "").nom, "Mairie - A");
  assert.equal(JSON.parse(objets[2] ?? "").nom, "Service - C");
});

test("les accolades et guillemets echappes dans une chaine ne trompent pas le scan", () => {
  const objets = decouper(DUMP, 4096);
  const b = JSON.parse(objets[1] ?? "");
  assert.equal(b.nom, "Mairie - B {piege}");
  assert.equal(b.commentaire, 'un guillemet echappe " et une accolade } dans une chaine');
});

test("les objets imbriques ne sont pas rendus separement", () => {
  const objets = decouper(DUMP, 4096);
  const c = JSON.parse(objets[2] ?? "");
  assert.deepEqual(c.imbrique, { a: { b: [1, 2, { c: 3 }] } });
});

test("le resultat ne depend pas du decoupage en morceaux", () => {
  const reference = decouper(DUMP, 65536);
  const longueur = Buffer.byteLength(DUMP, "utf8");
  for (let taille = 1; taille <= longueur; taille++) {
    assert.deepEqual(decouper(DUMP, taille), reference, `decoupage par ${taille} octets`);
  }
});

test("le crochet fermant termine le flux", () => {
  const splitter = new JsonArraySplitter("service");
  splitter.push(Buffer.from(DUMP, "utf8"));
  assert.equal(splitter.termine, true);
});

test("une cle absente est signalee", () => {
  assert.throws(() => decouper('{ "autre" : [ { "a" : 1 } ] }', 4096), JsonArrayError);
});

test("un flux coupe au milieu d'un objet est signale", () => {
  const partiel = '{ "service" : [ { "nom" : "incomplet"';
  assert.throws(() => decouper(partiel, 4096), JsonArrayError);
});

test("une cle homonyme dans une valeur de chaine ne declenche pas l'entree dans le tableau", () => {
  const piege = '{ "note" : "le mot \\"service\\" apparait ici", "service" : [ { "n" : 1 } ] }';
  const objets = decouper(piege, 4096);
  assert.equal(objets.length, 1);
  assert.equal(JSON.parse(objets[0] ?? "").n, 1);
});
