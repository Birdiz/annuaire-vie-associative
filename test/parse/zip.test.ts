import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { ZipReader, ZipError } from "../../src/parse/zip.ts";
import { makeTempDir } from "../helpers/tmp.ts";

type Source = { nom: string; contenu: Buffer; stocke?: boolean };

/**
 * Construit un ZIP octet par octet. Aucune archive binaire n'est committee : la fixture
 * est fabriquee par le test lui-meme, ce qui la rend lisible et modifiable.
 */
function construireZip(sources: readonly Source[]): Buffer {
  const morceaux: Buffer[] = [];
  const catalogue: Buffer[] = [];
  let offset = 0;

  for (const source of sources) {
    const nom = Buffer.from(source.nom, "utf8");
    const stocke = source.stocke === true;
    const donnees = stocke ? source.contenu : deflateRawSync(source.contenu);
    const methode = stocke ? 0 : 8;
    const somme = crc32(source.contenu);

    const entete = Buffer.alloc(30);
    entete.writeUInt32LE(0x04034b50, 0);
    entete.writeUInt16LE(20, 4);
    entete.writeUInt16LE(0, 6);
    entete.writeUInt16LE(methode, 8);
    entete.writeUInt32LE(somme, 14);
    entete.writeUInt32LE(donnees.length, 18);
    entete.writeUInt32LE(source.contenu.length, 22);
    entete.writeUInt16LE(nom.length, 26);
    entete.writeUInt16LE(0, 28);

    const fiche = Buffer.alloc(46);
    fiche.writeUInt32LE(0x02014b50, 0);
    fiche.writeUInt16LE(20, 4);
    fiche.writeUInt16LE(20, 6);
    fiche.writeUInt16LE(0, 8);
    fiche.writeUInt16LE(methode, 10);
    fiche.writeUInt32LE(somme, 16);
    fiche.writeUInt32LE(donnees.length, 20);
    fiche.writeUInt32LE(source.contenu.length, 24);
    fiche.writeUInt16LE(nom.length, 28);
    fiche.writeUInt32LE(offset, 42);

    morceaux.push(entete, nom, donnees);
    catalogue.push(fiche, nom);
    offset += entete.length + nom.length + donnees.length;
  }

  const corps = Buffer.concat(morceaux);
  const cd = Buffer.concat(catalogue);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0);
  fin.writeUInt16LE(sources.length, 8);
  fin.writeUInt16LE(sources.length, 10);
  fin.writeUInt32LE(cd.length, 12);
  fin.writeUInt32LE(corps.length, 16);
  return Buffer.concat([corps, cd, fin]);
}

function ecrireZip(t: Parameters<typeof makeTempDir>[0], sources: readonly Source[]): string {
  const chemin = join(makeTempDir(t), "archive.zip");
  writeFileSync(chemin, construireZip(sources));
  return chemin;
}

const DPT_35 = "id,titre,adrs_codeinsee\nW351000001,Club de Rennes,35238\n";

test("liste les entrees du catalogue", (t) => {
  const chemin = ecrireZip(t, [
    { nom: "rna_waldec_20260801_dpt_29.csv", contenu: Buffer.from("a\n", "utf8") },
    { nom: "rna_waldec_20260801_dpt_35.csv", contenu: Buffer.from(DPT_35, "utf8") },
  ]);
  const zip = ZipReader.ouvrir(chemin);
  t.after(() => zip.fermer());
  assert.deepEqual(
    zip.entrees().map((e) => e.name),
    ["rna_waldec_20260801_dpt_29.csv", "rna_waldec_20260801_dpt_35.csv"],
  );
});

test("detend une entree deflate", (t) => {
  const chemin = ecrireZip(t, [
    { nom: "autre.csv", contenu: Buffer.from("x".repeat(500), "utf8") },
    { nom: "rna_waldec_20260801_dpt_35.csv", contenu: Buffer.from(DPT_35, "utf8") },
  ]);
  const zip = ZipReader.ouvrir(chemin);
  t.after(() => zip.fermer());
  const entree = zip.trouver((nom) => nom.endsWith("_dpt_35.csv"));
  assert.ok(entree);
  assert.equal(zip.lire(entree).toString("utf8"), DPT_35);
});

test("lit une entree stockee sans compression", (t) => {
  const chemin = ecrireZip(t, [{ nom: "brut.csv", contenu: Buffer.from(DPT_35, "utf8"), stocke: true }]);
  const zip = ZipReader.ouvrir(chemin);
  t.after(() => zip.fermer());
  const entree = zip.entrees()[0];
  assert.ok(entree);
  assert.equal(entree.method, 0);
  assert.equal(zip.lire(entree).toString("utf8"), DPT_35);
});

test("trouver rend undefined quand aucun nom ne correspond", (t) => {
  const chemin = ecrireZip(t, [{ nom: "dpt_29.csv", contenu: Buffer.from("a\n", "utf8") }]);
  const zip = ZipReader.ouvrir(chemin);
  t.after(() => zip.fermer());
  assert.equal(zip.trouver((nom) => nom.endsWith("_dpt_35.csv")), undefined);
});

test("un fichier qui n'est pas un ZIP est rejete", (t) => {
  const chemin = join(makeTempDir(t), "faux.zip");
  writeFileSync(chemin, Buffer.from("ceci n'est pas une archive", "utf8"));
  assert.throws(() => ZipReader.ouvrir(chemin), ZipError);
});

test("une archive Zip64 est rejetee explicitement", (t) => {
  const base = construireZip([{ nom: "a.csv", contenu: Buffer.from("a\n", "utf8") }]);
  // On marque l'offset de catalogue comme deborde, ce qui est la signature de Zip64.
  base.writeUInt32LE(0xffffffff, base.length - 22 + 16);
  const chemin = join(makeTempDir(t), "zip64.zip");
  writeFileSync(chemin, base);
  assert.throws(() => ZipReader.ouvrir(chemin), /Zip64/);
});

test("un catalogue qui annonce plus que le fichier ne contient echoue proprement", (t) => {
  // `Buffer.alloc` sur un uint32 non borne levait un `RangeError` de V8 : ni une
  // `ZipError`, ni quelque chose que les appelants attrapent. Un catalogue est
  // declaratif et vient du meme fichier que les donnees ; il ne se croit pas sur parole.
  const chemin = join(makeTempDir(t), "casse.zip");
  const original = readFileSync(ecrireZip(t, [{ nom: "rna_35.csv", contenu: Buffer.from("id,nom\n1,X\n") }]));

  // Le champ « compressed size » de l'en-tete central, pousse a 0xFFFFFFFF.
  const casse = Buffer.from(original);
  const central = casse.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.notEqual(central, -1, "l'archive de test doit avoir un catalogue");
  casse.writeUInt32LE(0xffffffff, central + 20);
  writeFileSync(chemin, casse);

  const lecteur = ZipReader.ouvrir(chemin);
  t.after(() => lecteur.fermer());
  const entree = lecteur.entrees()[0];
  assert.ok(entree);
  assert.throws(() => lecteur.lire(entree), ZipError);
});
