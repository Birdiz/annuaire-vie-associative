import { test } from "node:test";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";

import { openDatabase } from "../../src/db/index.ts";
import { SEUIL_DORMANCE_ANNEES, mesurerDormance } from "../../src/metrics/dormance.ts";

/**
 * La mesure que l'ADR-013 posait comme prealable au lot 4 : sans elle, le taux de
 * couverture du §8 se calcule sur un denominateur dont personne ne sait ce qu'il
 * contient.
 */

const MAINTENANT = Date.parse("2026-08-21T00:00:00.000Z");

type Association = { rna: string; declaration: string | null; dissolution?: string };

function base(t: TestContext, associations: readonly Association[]) {
  const db = openDatabase(":memory:");
  t.after(() => db.close());

  db.prepare(
    "INSERT INTO commune (code_insee, nom, departement, created_at, updated_at) " +
      "VALUES ('35047', 'Bruz', '35', 't', 't')",
  ).run();

  const inserer = db.prepare(
    "INSERT INTO association (rna_id, code_insee, nom, nom_normalise, source_creation, " +
      "date_declaration, date_dissolution, created_at, updated_at) " +
      "VALUES (?, '35047', ?, ?, 'rna', ?, ?, 't', 't')",
  );
  for (const a of associations) {
    inserer.run(a.rna, a.rna, a.rna.toLowerCase(), a.declaration, a.dissolution ?? null);
  }
  return db;
}

test("trois populations distinctes : declarantes recentes, dormantes, et indeterminees", (t) => {
  const db = base(t, [
    { rna: "W1", declaration: "2025-03-01" },
    { rna: "W2", declaration: "2024-11-12" },
    { rna: "W3", declaration: "2008-04-02" },
    { rna: "W4", declaration: null },
  ]);

  const mesure = mesurerDormance(db, "35", MAINTENANT);

  assert.equal(mesure.actives, 4);
  assert.equal(mesure.nonDormantes, 2);
  assert.equal(mesure.dormantes, 1);
  // Ni dormante ni vivante : la source ne dit rien, et le rendre visible vaut mieux
  // que de trancher par defaut une question sur laquelle elle se tait.
  assert.equal(mesure.sansDate, 1);
  assert.equal(mesure.actives, mesure.nonDormantes + mesure.dormantes + mesure.sansDate);
});

test("une association dissoute ne compte dans aucun denominateur", (t) => {
  const db = base(t, [
    { rna: "W1", declaration: "2025-03-01" },
    { rna: "W2", declaration: "2025-05-01", dissolution: "2025-07-01" },
  ]);

  const mesure = mesurerDormance(db, "35", MAINTENANT);
  assert.equal(mesure.actives, 1, "un annuaire de la vie associative ne presente pas les dissoutes");
  assert.equal(mesure.nonDormantes, 1);
});

test("le seuil est un parametre affiche, pas une verite cachee", (t) => {
  const db = base(t, [
    { rna: "W1", declaration: "2023-01-01" },
    { rna: "W2", declaration: "2012-01-01" },
  ]);

  const large = mesurerDormance(db, "35", MAINTENANT, 20);
  assert.equal(large.nonDormantes, 2);
  assert.equal(large.seuilAnnees, 20, "le critere voyage avec le chiffre qu'il produit");

  const etroit = mesurerDormance(db, "35", MAINTENANT, 1);
  assert.equal(etroit.nonDormantes, 0);
  assert.equal(etroit.dormantes, 2);

  assert.equal(mesurerDormance(db, "35", MAINTENANT).seuilAnnees, SEUIL_DORMANCE_ANNEES);
});

test("la borne tombe au jour pres, et non a l'horodatage pres", (t) => {
  const mesure = mesurerDormance(base(t, []), "35", MAINTENANT, 5);
  assert.equal(mesure.borne, "2021-08-21");
  assert.equal(mesure.borne.length, 10, "comparer une date a un horodatage complet perdrait ce jour-la");
});

test("l'histogramme rend la distribution par annee, qui doit fixer le seuil", (t) => {
  const db = base(t, [
    { rna: "W1", declaration: "2024-01-05" },
    { rna: "W2", declaration: "2024-09-30" },
    { rna: "W3", declaration: "2011-02-03" },
    { rna: "W4", declaration: null },
  ]);

  const parAnnee = mesurerDormance(db, "35", MAINTENANT).parAnnee.map((ligne) => ({
    annee: ligne.annee,
    associations: Number(ligne.associations),
  }));
  assert.deepEqual(parAnnee, [
    { annee: "2011", associations: 1 },
    { annee: "2024", associations: 2 },
  ]);
});
