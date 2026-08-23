import { test } from "node:test";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { openDatabase } from "../src/db/index.ts";

/**
 * Migration 8 — la provenance de la commune, au complet.
 *
 * L'invariant 5 enumere quatre elements. Les triggers de la migration 2 n'en
 * controlaient que deux : la methode d'extraction et le score de confiance tenaient par
 * discipline applicative, alors que le CLAUDE.md exige que ce soit la base qui refuse.
 */

function base(t: TestContext) {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  db.prepare(
    "INSERT INTO commune (code_insee, nom, departement, created_at, updated_at) " +
      "VALUES ('35100', 'Bruz', '35', '2026-08-18T00:00:00.000Z', '2026-08-18T00:00:00.000Z')",
  ).run();
  return db;
}

function resoudre(db: ReturnType<typeof openDatabase>, colonnes: Record<string, string | number | null>): void {
  const complet: Record<string, string | number | null> = {
    url_mairie: "https://mairie.example",
    resolution_source_url: "https://source.example/dump",
    resolution_collected_at: "2026-08-18T00:00:00.000Z",
    source_resolution: "annuaire",
    resolution_confiance: 0.9,
    ...colonnes,
  };
  const noms = Object.keys(complet);
  db.prepare(
    `UPDATE commune SET statut_resolution = 'resolue', ${noms.map((n) => `${n} = ?`).join(", ")} ` +
      "WHERE code_insee = '35100'",
  ).run(...noms.map((n) => complet[n] ?? null));
}

test("la methode d'extraction est exigee par le schema, pas par l'applicatif", (t) => {
  const db = base(t);
  assert.throws(() => resoudre(db, { source_resolution: null }), /provenance complete/);
});

test("le score de confiance est exige par le schema, pas par l'applicatif", (t) => {
  const db = base(t);
  assert.throws(() => resoudre(db, { resolution_confiance: null }), /provenance complete/);
});

test("les quatre elements reunis passent", (t) => {
  const db = base(t);
  resoudre(db, {});
  const ligne = db.prepare("SELECT statut_resolution FROM commune WHERE code_insee = '35100'").get() as
    | { statut_resolution: string }
    | undefined;
  assert.equal(ligne?.statut_resolution, "resolue");
});

test("une commune sans site reste dispensee de provenance", (t) => {
  const db = base(t);
  db.prepare("UPDATE commune SET statut_resolution = 'sans_site' WHERE code_insee = '35100'").run();
  const ligne = db.prepare("SELECT statut_resolution FROM commune WHERE code_insee = '35100'").get() as
    | { statut_resolution: string }
    | undefined;
  assert.equal(ligne?.statut_resolution, "sans_site");
});
