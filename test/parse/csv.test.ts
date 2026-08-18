import { test } from "node:test";
import assert from "node:assert/strict";
import { CsvStreamParser, indexerColonnes } from "../../src/parse/csv.ts";

/** Parse une entree en la decoupant en morceaux de `taille` octets. */
function parserParMorceaux(entree: string, taille: number): { lignes: string[][]; consumed: number } {
  const octets = Buffer.from(entree, "utf8");
  const parseur = new CsvStreamParser();
  const lignes: string[][] = [];
  for (let i = 0; i < octets.length; i += taille) {
    lignes.push(...parseur.push(octets.subarray(i, i + taille)));
  }
  lignes.push(...parseur.end());
  return { lignes, consumed: parseur.consumedBytes };
}

test("lit un CSV simple", () => {
  const { lignes } = parserParMorceaux("a,b,c\n1,2,3\n", 1024);
  assert.deepEqual(lignes, [
    ["a", "b", "c"],
    ["1", "2", "3"],
  ]);
});

test("un champ quote peut contenir le delimiteur", () => {
  const { lignes } = parserParMorceaux('nom,objet\nX,"sport, culture et loisirs"\n', 1024);
  assert.deepEqual(lignes[1], ["X", "sport, culture et loisirs"]);
});

test("un guillemet double represente un guillemet litteral", () => {
  const { lignes } = parserParMorceaux('a\n"dit ""bonjour"" ici"\n', 1024);
  assert.deepEqual(lignes[1], ['dit "bonjour" ici']);
});

test("un champ quote peut contenir un saut de ligne", () => {
  const { lignes } = parserParMorceaux('a,b\n"ligne1\nligne2",fin\n', 1024);
  assert.deepEqual(lignes, [
    ["a", "b"],
    ["ligne1\nligne2", "fin"],
  ]);
});

test("les fins de ligne CRLF sont acceptees", () => {
  const { lignes } = parserParMorceaux("a,b\r\n1,2\r\n", 1024);
  assert.deepEqual(lignes, [
    ["a", "b"],
    ["1", "2"],
  ]);
});

test("la derniere ligne sans saut de ligne final est rendue par end()", () => {
  const { lignes } = parserParMorceaux("a,b\n1,2", 1024);
  assert.deepEqual(lignes[1], ["1", "2"]);
});

test("consumedBytes ne compte que les lignes completes rendues", () => {
  const parseur = new CsvStreamParser();
  const rendu = parseur.push(Buffer.from("a,b\n1,", "utf8"));
  assert.equal(rendu.length, 1);
  // Seule la premiere ligne est complete : 4 octets, saut de ligne compris.
  assert.equal(parseur.consumedBytes, 4);
  parseur.push(Buffer.from("2\n", "utf8"));
  assert.equal(parseur.consumedBytes, 8);
});

test("consumedBytes compte des octets, pas des caracteres", () => {
  // "e accent aigu" fait deux octets en UTF-8 : un comptage en caracteres decalerait
  // la reprise et couperait la sequence multi-octets.
  const entree = "nom\nChâteaubourg\n";
  const { consumed } = parserParMorceaux(entree, 3);
  assert.equal(consumed, Buffer.byteLength(entree, "utf8"));
});

test("le resultat ne depend pas du decoupage en morceaux", () => {
  const entree =
    'id,titre,objet\n' +
    'W001,"Club, sportif","dit ""bonjour""\net saute une ligne"\n' +
    'W002,Sans guillemets,Châteaubourg\r\n' +
    'W003,,"",fin';
  const reference = parserParMorceaux(entree, 4096);
  const longueur = Buffer.byteLength(entree, "utf8");

  for (let taille = 1; taille <= longueur; taille++) {
    const obtenu = parserParMorceaux(entree, taille);
    assert.deepEqual(obtenu.lignes, reference.lignes, `decoupage par ${taille} octets`);
    assert.equal(obtenu.consumed, reference.consumed, `consumedBytes, decoupage par ${taille}`);
  }
  assert.equal(reference.consumed, longueur);
});

test("indexerColonnes rend une chaine vide pour une colonne absente", () => {
  const lire = indexerColonnes(["id", "titre", "adrs_codeinsee"]);
  const champ = lire(["W001", "Club", "35238"]);
  assert.equal(champ("id"), "W001");
  assert.equal(champ("adrs_codeinsee"), "35238");
  assert.equal(champ("colonne_disparue"), "");
});

test("indexerColonnes tolere une ligne plus courte que l'entete", () => {
  const lire = indexerColonnes(["id", "titre", "siteweb"]);
  const champ = lire(["W001", "Club"]);
  assert.equal(champ("siteweb"), "");
});
