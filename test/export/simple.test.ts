import { test } from "node:test";
import assert from "node:assert/strict";

import { openDatabase } from "../../src/db/index.ts";
import { systemClock } from "../../src/clock.ts";
import { ResolveurMx } from "../../src/http/dns.ts";
import { normaliser } from "../../src/normalisation/rejeu.ts";
import { BOM, SEPARATEUR, compterLignes, compterSansNom, lignesCsv } from "../../src/export/csv.ts";
import { DEPARTEMENT, ajouterSansRna, preparerCorpus } from "../helpers/corpus.ts";
import type { OptionsExport } from "../../src/export/csv.ts";
import type { TestContext } from "node:test";

/**
 * Le fichier a cinq colonnes, une ligne par structure (ADR-032).
 *
 * Ce qu'on defend ici : le client doit pouvoir travailler chaque ligne. Une ligne sans
 * nom ne se travaille pas, et une structure qui sort deux fois — une fois avec son
 * email, une fois avec son telephone — se lit comme deux structures.
 */

function ouvrir(t: TestContext): ReturnType<typeof openDatabase> {
  const { dbFile } = preparerCorpus(t);
  const db = openDatabase(dbFile);
  t.after(() => db.close());
  return db;
}

/** Le corpus complet : les associations du RNA, plus celles qu'il ne connait pas. */
async function corpusComplet(t: TestContext): Promise<ReturnType<typeof openDatabase>> {
  const db = ouvrir(t);
  ajouterSansRna(db);
  const resolveur = new ResolveurMx({
    resolve: async (domaine) => [{ exchange: `mx.${domaine}`, priority: 10 }],
  });
  await normaliser(db, systemClock, resolveur, { departement: DEPARTEMENT });
  return db;
}

type Ligne = {
  departement: string;
  commune: string;
  nom: string;
  type: string;
  telephone: string;
  email: string;
};

function lireSimple(db: ReturnType<typeof openDatabase>, options: Partial<OptionsExport> = {}): Ligne[] {
  const lignes = [...lignesCsv(db, { departement: DEPARTEMENT, profil: "simple", ...options })];
  assert.ok(lignes[0]?.startsWith(BOM), "sans BOM, un tableur francais lit l'UTF-8 en ANSI");
  return lignes.slice(1).map((brute) => {
    const cellules = brute.trimEnd().split(SEPARATEUR);
    return {
      departement: cellules[0] ?? "",
      commune: cellules[1] ?? "",
      nom: cellules[2] ?? "",
      type: cellules[3] ?? "",
      telephone: cellules[4] ?? "",
      email: cellules[5] ?? "",
    };
  });
}

test("une structure sort sur une seule ligne, telephone et email cote a cote", async (t) => {
  const db = await corpusComplet(t);
  const lignes = lireSimple(db);

  const petitesMains = lignes.filter((ligne) => ligne.nom === "Les Petites Mains");
  assert.equal(petitesMains.length, 1, "deux lignes pour une structure se lisent comme deux structures");
  // Le numero sort tel qu'il a ete lu, apostrophe de desamorcage comprise : un tableur
  // verrait sinon une formule dans « +33... ». Le profil ne reformate rien — la graphie
  // de la page est ce que le client reconnait.
  assert.equal(petitesMains[0]?.telephone, "'+33299000001");
  assert.equal(petitesMains[0]?.email, "lespetitesmains@petites-mains.example");
});

test("aucune ligne ne sort sans nom : c'est la plainte a laquelle ce profil repond", async (t) => {
  const db = await corpusComplet(t);
  for (const ligne of lireSimple(db)) {
    assert.notEqual(ligne.nom, "", "une ligne sans nom ne se travaille pas");
    assert.equal(ligne.departement, DEPARTEMENT);
    assert.notEqual(ligne.commune, "");
  }
});

test("chaque groupe est unique : aucune paire (commune, nom) ne se repete", async (t) => {
  const db = await corpusComplet(t);
  const vus = new Set<string>();
  for (const ligne of lireSimple(db)) {
    // Sauf la mairie, dont chaque service garde sa ligne (D5) : reunir six adresses de
    // service dans une cellule unique rendrait la ligne inutilisable.
    if (ligne.nom.startsWith("Mairie de ")) continue;
    const cle = `${ligne.commune}|${ligne.nom}`;
    assert.ok(!vus.has(cle), `« ${cle} » sort deux fois`);
    vus.add(cle);
  }
});

test("la cascade nomme dans l'ordre : RNA, puis bloc, puis domaine, puis mairie", async (t) => {
  const db = await corpusComplet(t);
  const noms = new Set(lireSimple(db).map((ligne) => ligne.nom));

  // 1. Le RNA, quand le rattachement a reussi.
  assert.ok(noms.has("Tennis club de Bruzou"));
  // 2. Le bloc de la page. Son domaine est pourtant specifique — s'il l'emportait, la
  //    ligne s'appellerait « Petites Mains » : c'est ce test qui fixe la priorite.
  assert.ok(noms.has("Les Petites Mains"));
  assert.ok(!noms.has("Petites Mains"));
  // 3. Le domaine, faute de mieux.
  assert.ok(noms.has("Judo Club Bruzou"));
  // 4. La mairie, nommee par sa commune.
  assert.ok(noms.has("Mairie de Bruzou"));
});

test("le libelle de la mairie s'elide devant une voyelle", (t) => {
  // Une ligne sur deux d'un departement porte ce libelle : « Mairie de Algrange » se lit
  // comme une faute de l'outil, dans un fichier que le client ouvre tel quel.
  const db = ouvrir(t);
  db.prepare("UPDATE commune SET nom = 'Algrange'").run();
  const mairie = lireSimple(db).find((ligne) => ligne.nom.startsWith("Mairie"));
  assert.equal(mairie?.nom, "Mairie d'Algrange");

  db.prepare("UPDATE commune SET nom = 'Bruzou'").run();
  assert.equal(
    lireSimple(db).find((ligne) => ligne.nom.startsWith("Mairie"))?.nom,
    "Mairie de Bruzou",
  );
});

test("le type vient du RNA quand il est la, du nom quand il ne l'est pas", async (t) => {
  const db = await corpusComplet(t);
  const parNom = new Map(lireSimple(db).map((ligne) => [ligne.nom, ligne.type]));

  // 1. Association du RNA : le type calcule par l'etape [7], code objet a l'appui.
  assert.equal(parNom.get("Tennis club de Bruzou"), "sportive");
  assert.equal(parNom.get("Theatre des Grandes Landes"), "culturelle");
  // `comite des fetes` est reconnu sur le nom, la ou le code objet ne le porte pas.
  assert.equal(parNom.get("Comite des fetes de Bruzou"), "comite_des_fetes");

  // 2. Hors RNA : seul un motif de nom compte. « Les Petites Mains » n'en porte aucun,
  //    et `diverses` par defaut ferait passer une ignorance pour un classement.
  assert.equal(parNom.get("Les Petites Mains"), "");
  assert.equal(parNom.get("Judo Club Bruzou"), "");
  assert.equal(parNom.get("Mairie de Bruzou"), "");
});

test("un nom lu dans un bloc qui porte un motif est classe, meme hors RNA", (t) => {
  const db = ouvrir(t);
  // C'est le cas qui compte pour une collectivite : un accueil de loisirs communal n'est
  // jamais au RNA, donc jamais rattache. Sans le second chemin, sa colonne serait vide
  // par construction — et c'est le premier type que le client a nomme.
  db.prepare(
    "INSERT INTO contact (code_insee, kind, valeur, valeur_normalisee, is_generique, source_url, " +
      "methode_extraction, confiance, collected_at, nom_pressenti, nom_pressenti_normalise, " +
      "nom_pressenti_version) " +
      "VALUES ((SELECT code_insee FROM commune LIMIT 1), 'email', ?, ?, 1, 'https://x.example', " +
      "'dom:mailto', 0.8, 't', ?, ?, 1)",
  ).run("periscolaire@loisirs.example", "periscolaire@loisirs.example", "Accueil de loisirs du Ru", "accueil de loisirs du ru");

  const ligne = lireSimple(db).find((l) => l.nom === "Accueil de loisirs du Ru");
  assert.equal(ligne?.type, "centre_de_loisirs");
});

test("ce que le simple ecarte, le complet le garde — et il dit combien", async (t) => {
  const db = await corpusComplet(t);
  const options: OptionsExport = { departement: DEPARTEMENT, profil: "simple" };

  // Deux contacts que rien ne peut nommer : une adresse chez un fournisseur grand
  // public, et un numero — un telephone n'a pas de domaine, donc aucun repli.
  assert.equal(compterSansNom(db, options), 2);

  const complet = [...lignesCsv(db, { departement: DEPARTEMENT, profil: "complet" })].join("");
  assert.match(complet, /jean\.perdu@gmail\.com/);
  assert.match(complet, /\+33299000099/);

  const simple = [...lignesCsv(db, options)].join("");
  assert.doesNotMatch(simple, /jean\.perdu@gmail\.com/);
  assert.doesNotMatch(simple, /\+33299000099/);
});

test("le nombre annonce est celui du fichier, pour les deux profils", async (t) => {
  const db = await corpusComplet(t);
  // Le seul garde-fou serieux contre une divergence entre la requete de comptage et
  // celle du rendu : sans lui, l'ecran annonce un chiffre que le fichier ne tient pas.
  for (const profil of ["simple", "complet"] as const) {
    const options: OptionsExport = { departement: DEPARTEMENT, profil };
    assert.equal(compterLignes(db, options), [...lignesCsv(db, options)].length - 1, profil);
  }
});

test("un doublon commune/association ne devient pas une seconde structure", async (t) => {
  // Le corpus porte la meme adresse deux fois : rattachee, et vue dans un bloc anonyme.
  // Base **non normalisee**, donc l'etape [7] n'a pas resorbe le doublon. Avant le lot 10
  // la ligne en trop sortait sans nom, dans le bruit ; maintenant qu'elle serait nommee,
  // elle ressemblerait a un vrai second club.
  const db = ouvrir(t);
  const lignes = lireSimple(db);

  const tennis = lignes.filter((ligne) => ligne.email.includes("tennis-bruzou"));
  assert.equal(tennis.length, 1);
  assert.equal(tennis[0]?.nom, "Tennis club de Bruzou", "la ligne rattachee l'emporte");
});

test("le seuil et les rejetes s'appliquent avant le regroupement", async (t) => {
  const db = await corpusComplet(t);

  // Un seuil qu'aucun contact n'atteint doit vider le fichier, et pas seulement en
  // retirer des cellules : un groupe dont tous les contacts sont filtres disparait.
  const lignes = lireSimple(db, { scoreMin: 0.99 });
  assert.equal(lignes.length, 0);
  assert.equal(compterLignes(db, { departement: DEPARTEMENT, profil: "simple", scoreMin: 0.99 }), 0);
});

test("un departement sans contact ne rend que l'en-tete", (t) => {
  const db = ouvrir(t);
  for (const profil of ["simple", "complet"] as const) {
    const lignes = [...lignesCsv(db, { departement: "99", profil })];
    assert.equal(lignes.length, 1);
    assert.ok(lignes[0]?.startsWith(BOM));
  }
});

test("une valeur piegeuse reste desamorcee apres avoir ete reunie dans une cellule", (t) => {
  const db = ouvrir(t);
  db.prepare(
    "INSERT INTO contact (code_insee, kind, valeur, valeur_normalisee, is_generique, source_url, " +
      "methode_extraction, confiance, collected_at, nom_pressenti, nom_pressenti_normalise) " +
      "VALUES ((SELECT code_insee FROM commune LIMIT 1), 'email', ?, ?, 1, 'https://x.example', " +
      "'texte:motif', 0.5, 't', ?, ?)",
  ).run("=1+1@piege.example", "=1+1@piege.example", "Club; \"piege\"", "club piege");

  const brute = [...lignesCsv(db, { departement: DEPARTEMENT, profil: "simple" })].find((ligne) =>
    ligne.includes("piege"),
  );
  assert.ok(brute !== undefined);
  // Le nom porte un separateur et un guillemet : il doit etre guillemete et double.
  assert.match(brute, /"Club; ""piege"""/);
  // L'adresse commence par « = » : un tableur y verrait une formule.
  assert.match(brute, /'=1\+1@piege\.example/);
});
