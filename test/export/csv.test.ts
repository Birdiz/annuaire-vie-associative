import { test } from "node:test";
import assert from "node:assert/strict";

import { openDatabase } from "../../src/db/index.ts";
import { systemClock } from "../../src/clock.ts";
import { ResolveurMx } from "../../src/http/dns.ts";
import { normaliser } from "../../src/normalisation/rejeu.ts";
import { BOM, SEPARATEUR, compterLignes, echapper, lignesCsv } from "../../src/export/csv.ts";
import { DEPARTEMENT, preparerCorpus } from "../helpers/corpus.ts";
import type { TestContext } from "node:test";

/** L'artefact que l'outil produit. Ce qu'on defend ici : la provenance voyage avec. */

function ouvrir(t: TestContext): ReturnType<typeof openDatabase> {
  const { dbFile } = preparerCorpus(t);
  const db = openDatabase(dbFile);
  t.after(() => db.close());
  return db;
}

async function corpusNormalise(t: TestContext): Promise<ReturnType<typeof openDatabase>> {
  const db = ouvrir(t);
  const resolveur = new ResolveurMx({
    resolve: async (domaine) => {
      if (domaine === "theatre-landes.example") throw Object.assign(new Error("x"), { code: "ENODATA" });
      return [{ exchange: `mx.${domaine}`, priority: 10 }];
    },
  });
  await normaliser(db, systemClock, resolveur, { departement: DEPARTEMENT });
  return db;
}

function lire(
  db: ReturnType<typeof openDatabase>,
  options: { scoreMin?: number; avecRejetes?: boolean } = {},
): string[] {
  return [...lignesCsv(db, { departement: DEPARTEMENT, ...options })];
}

test("l'echappement suit la RFC 4180, et desamorce les formules de tableur", () => {
  assert.equal(echapper("Bruzou"), "Bruzou");
  assert.equal(echapper("Sainte-Colombe; la Vallee"), '"Sainte-Colombe; la Vallee"');
  assert.equal(echapper('Le "Grand" club'), '"Le ""Grand"" club"');
  assert.equal(echapper("deux\nlignes"), '"deux\nlignes"');
  // Une valeur qui commence par « = » serait executee comme formule a l'ouverture. Le
  // nom d'une association vient d'une page web : sa forme n'est pas sous notre controle.
  assert.equal(echapper("=1+1"), "'=1+1");
  assert.equal(echapper("@import"), "'@import");
});

test("l'en-tete porte le BOM, et chaque ligne porte sa provenance", async (t) => {
  const db = await corpusNormalise(t);
  const lignes = lire(db);

  assert.ok(lignes[0]?.startsWith(BOM), "sans BOM, un tableur francais lit l'UTF-8 en ANSI");
  const colonnes = (lignes[0] ?? "").slice(BOM.length).trimEnd().split(SEPARATEUR);
  for (const attendue of ["source_url", "collected_at", "methode_extraction", "score", "confiance"]) {
    assert.ok(colonnes.includes(attendue), `la colonne ${attendue} manque : la provenance doit voyager`);
  }

  // Une ligne par contact : les cinq du corpus moins le doublon que [7] a supprime.
  assert.equal(lignes.length - 1, 4);
  for (const ligne of lignes.slice(1)) {
    assert.match(ligne, /https:\/\/bruzou\.example\//, "chaque ligne doit dire d'ou elle vient");
    assert.ok(ligne.endsWith("\r\n"));
  }
});

test("le type classifie et le regime juridique sont des colonnes, pas des deductions", async (t) => {
  const db = await corpusNormalise(t);
  const lignes = lire(db);

  const nominative = lignes.find((ligne) => ligne.includes("marie.dupont@"));
  assert.ok(nominative !== undefined);
  assert.ok(nominative.includes(`${SEPARATEUR}nominatif${SEPARATEUR}`), "§4.7");
  assert.ok(nominative.includes("culturelle"), "le theatre est en famille 006");

  const telephone = lignes.find((ligne) => ligne.includes("+33299000000"));
  assert.ok(telephone !== undefined);
  assert.ok(telephone.includes("comite_des_fetes"), "le nom l'emporte sur la famille 007");
  // Un numero n'a pas de regime : la colonne est vide, elle ne ment pas. Verifiee a sa
  // place exacte — un `;;` quelque part dans la ligne passerait aussi sur une colonne
  // voisine restee vide.
  const entetes = (lignes[0] ?? "").slice(BOM.length).trimEnd().split(SEPARATEUR);
  assert.equal(telephone.split(SEPARATEUR)[entetes.indexOf("regime")], "");
});

test("la valeur corrigee en revue sort a cote de la valeur lue", async (t) => {
  const db = await corpusNormalise(t);
  db.prepare(
    "UPDATE contact SET valeur_corrigee = 'club@tennis-bruzou.example', review_statut = 'corrige' " +
      "WHERE valeur = 'contact@tennis-bruzou.example'",
  ).run();

  const lignes = lire(db);
  const entetes = (lignes[0] ?? "").slice(BOM.length).trimEnd().split(SEPARATEUR);
  const corrigee = lignes.find((ligne) => ligne.includes("club@tennis-bruzou.example"));
  assert.ok(corrigee !== undefined);

  const cellules = corrigee.split(SEPARATEUR);
  // Les trois colonnes disent trois choses differentes : ce qui a ete lu, ce qu'un
  // humain a corrige, et ce qui se publie. Ecraser la premiere perdrait la provenance.
  assert.equal(cellules[entetes.indexOf("valeur")], "contact@tennis-bruzou.example");
  assert.equal(cellules[entetes.indexOf("valeur_corrigee")], "club@tennis-bruzou.example");
  assert.equal(cellules[entetes.indexOf("valeur_publiable")], "club@tennis-bruzou.example");
});

test("un contact rejete en revue ne sort pas, sauf demande explicite", async (t) => {
  const db = await corpusNormalise(t);
  db.prepare("UPDATE contact SET review_statut = 'rejete' WHERE valeur LIKE '%theatre-landes%'").run();

  // Un arbitrage humain qui ne changerait rien au fichier livre ne servirait a rien.
  assert.equal(compterLignes(db, { departement: DEPARTEMENT }), 3);
  assert.equal(lire(db).length - 1, 3);
  assert.ok(!lire(db).some((ligne) => ligne.includes("theatre-landes")));

  assert.equal(compterLignes(db, { departement: DEPARTEMENT, avecRejetes: true }), 4);
  assert.ok(lire(db, { avecRejetes: true }).some((ligne) => ligne.includes("theatre-landes")));
});

test("--score-min ne retient que les contacts assez surs", async (t) => {
  const db = await corpusNormalise(t);

  const tous = compterLignes(db, { departement: DEPARTEMENT });
  const surs = compterLignes(db, { departement: DEPARTEMENT, scoreMin: 0.8 });
  assert.equal(tous, 4);
  assert.ok(surs > 0 && surs < tous, `le seuil doit trancher, recu ${surs}/${tous}`);
  assert.equal(lire(db, { scoreMin: 0.8 }).length - 1, surs);

  // Un contact non note ne passe aucun seuil : l'absence de score n'est pas un bon score.
  db.prepare("UPDATE contact SET score = NULL").run();
  assert.equal(compterLignes(db, { departement: DEPARTEMENT, scoreMin: 0 }), 0);
  assert.equal(compterLignes(db, { departement: DEPARTEMENT }), 4, "sans seuil, tout sort");
});

test("un departement sans contact ne produit que l'en-tete", (t) => {
  const db = ouvrir(t);
  assert.equal(compterLignes(db, { departement: "22" }), 0);
  assert.deepEqual([...lignesCsv(db, { departement: "22" })].length, 1);
});
