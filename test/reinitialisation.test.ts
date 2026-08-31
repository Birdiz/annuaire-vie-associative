import { test } from "node:test";
import assert from "node:assert/strict";

import { openDatabase } from "../src/db/index.ts";
import { fixedClock } from "../src/clock.ts";
import { Counters } from "../src/metrics/counters.ts";
import { compter, reinitialiser } from "../src/reinitialisation.ts";
import { oublier } from "../src/oubli.ts";
import { CODE_INSEE, DEPARTEMENT, preparerCorpus } from "./helpers/corpus.ts";
import type { TestContext } from "node:test";

const HORLOGE = fixedClock(Date.parse("2026-09-01T10:00:00.000Z"));

function base(t: TestContext) {
  const { dbFile } = preparerCorpus(t);
  const db = openDatabase(dbFile);
  t.after(() => db.close());
  return { db, counters: new Counters(db, null) };
}

/** Un second departement, pour verifier qu'on n'emporte pas le voisin. */
function ajouterVoisin(db: ReturnType<typeof openDatabase>): void {
  // `statut_resolution = 'resolue'` exigerait la provenance complete : le schema tient
  // l'invariant 5 par une contrainte CHECK, et ce voisin n'a pas besoin d'etre resolu.
  db.prepare(
    "INSERT INTO commune (code_insee, nom, departement, statut_resolution, created_at, updated_at) " +
      "VALUES ('88001', 'Ailleurs', '88', 'inconnu', 't', 't')",
  ).run();
  db.prepare(
    "INSERT INTO association (rna_id, code_insee, nom, nom_normalise, source_creation, created_at, updated_at) " +
      "VALUES ('W881', '88001', 'Club des Vosges', 'club des vosges', 'rna', 't', 't')",
  ).run();
  db.prepare("INSERT INTO run (departement, started_at, statut) VALUES ('88', 't', 'termine')").run();
}

test("reinitialiser efface tout ce qui appartient au departement", (t) => {
  const { db, counters } = base(t);
  const avant = compter(db, DEPARTEMENT);
  assert.ok(avant.communes > 0 && avant.associations > 0 && avant.contacts > 0, "le corpus doit etre peuple");

  const bilan = reinitialiser(db, counters, DEPARTEMENT);

  assert.equal(bilan.simulation, false);
  assert.deepEqual(compter(db, DEPARTEMENT), {
    departement: DEPARTEMENT,
    communes: 0,
    associations: 0,
    contacts: 0,
    pages: 0,
    runs: 0,
  });
});

/**
 * `association.code_insee` est en `ON DELETE SET NULL`, pas en cascade.
 *
 * S'en remettre aux cles etrangeres laisserait donc des associations rattachees a rien :
 * plus aucune requete par departement ne les verrait, et la collecte suivante en
 * recreerait d'autres a cote. Le test compte les lignes de la table entiere, pas celles
 * du departement — c'est justement la difference qu'un oubli produirait.
 */
test("aucune association orpheline ne survit a la suppression des communes", (t) => {
  const { db, counters } = base(t);
  ajouterVoisin(db);

  reinitialiser(db, counters, DEPARTEMENT);

  const orphelines = Number(
    (db.prepare("SELECT count(*) AS n FROM association WHERE code_insee IS NULL").get() as { n: number }).n,
  );
  assert.equal(orphelines, 0, "une association sans commune est introuvable pour toujours");
});

test("le departement voisin n'est pas emporte", (t) => {
  const { db, counters } = base(t);
  ajouterVoisin(db);

  reinitialiser(db, counters, DEPARTEMENT);

  const voisin = compter(db, "88");
  assert.equal(voisin.communes, 1);
  assert.equal(voisin.associations, 1);
  assert.equal(voisin.runs, 1);
});

/**
 * Le point qui compte le plus de ce module.
 *
 * Une personne qui a demande a etre effacee l'a ete pour de bon : l'exclusion est
 * l'objet durable, la suppression n'en est que la consequence (invariant 10). Si
 * reinitialiser levait l'exclusion, la collecte suivante remettrait la donnee en base
 * sans que personne ne s'en apercoive — et l'outil aurait promis un droit qu'il ne tient
 * que jusqu'au prochain run.
 */
test("les exclusions survivent : effacer un departement ne rend pas le droit a l'oubli caduc", (t) => {
  const { db, counters } = base(t);
  oublier(db, HORLOGE, counters, {
    portee: "contact",
    valeur: "marie.dupont@theatre-landes.example",
    motif: "opposition du 12/03",
    origine: "cli",
  });
  oublier(db, HORLOGE, counters, {
    portee: "commune",
    valeur: CODE_INSEE,
    motif: "demande de la mairie",
    origine: "cli",
  });

  reinitialiser(db, counters, DEPARTEMENT);

  const restantes = db
    .prepare("SELECT portee, valeur FROM exclusion ORDER BY valeur")
    .all() as unknown as { portee: string; valeur: string }[];
  assert.equal(restantes.length, 2, "les deux exclusions doivent rester");
  assert.deepEqual(
    restantes.map((ligne) => ligne.portee).sort(),
    ["commune", "contact"],
    "y compris celle dont la portee est justement la commune effacee",
  );
});

test("le registre national et les verdicts MX ne sont pas touches", (t) => {
  const { db, counters } = base(t);
  db.prepare(
    "INSERT INTO dump (source, url, statut, started_at) VALUES ('rna_waldec', 'https://x.test/r.csv', 'termine', 't')",
  ).run();
  db.prepare(
    "INSERT INTO domaine_mail (domaine, mx, methode, verifie_at) VALUES ('orange.fr', 1, 'dns', 't')",
  ).run();

  reinitialiser(db, counters, DEPARTEMENT);

  // Le registre est national : le reprendre couterait 1,25 Go pour rien.
  assert.equal(Number((db.prepare("SELECT count(*) AS n FROM dump").get() as { n: number }).n), 1);
  // `orange.fr` sert des associations dans tous les departements.
  assert.equal(Number((db.prepare("SELECT count(*) AS n FROM domaine_mail").get() as { n: number }).n), 1);
});

test("la simulation compte sans rien ecrire", (t) => {
  const { db, counters } = base(t);
  const avant = compter(db, DEPARTEMENT);

  const bilan = reinitialiser(db, counters, DEPARTEMENT, { simulation: true });

  assert.equal(bilan.simulation, true);
  assert.equal(bilan.contacts, avant.contacts);
  assert.deepEqual(compter(db, DEPARTEMENT), avant, "la base ne doit pas avoir bouge");
});

test("le cache disque des pages du departement est efface, et lui seul", (t) => {
  const { db, counters } = base(t);
  db.prepare("UPDATE page SET cache_path = 'ab/cdef' WHERE code_insee = ?").run(CODE_INSEE);
  const effaces: string[] = [];

  const bilan = reinitialiser(db, counters, DEPARTEMENT, {
    supprimerCache: (chemin) => {
      effaces.push(chemin);
      return true;
    },
  });

  assert.ok(bilan.entreesCache > 0, "le cache garde le HTML brut, donc la donnee elle-meme");
  assert.deepEqual([...new Set(effaces)], ["ab/cdef"]);
});

test("reinitialiser deux fois de suite ne fait rien la seconde", (t) => {
  const { db, counters } = base(t);
  reinitialiser(db, counters, DEPARTEMENT);

  const second = reinitialiser(db, counters, DEPARTEMENT);

  assert.equal(second.communes, 0);
  assert.equal(second.contacts, 0);
});
