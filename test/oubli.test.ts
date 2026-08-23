import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { openDatabase } from "../src/db/index.ts";
import { HttpCache } from "../src/http/cache.ts";
import { Counters } from "../src/metrics/counters.ts";
import { fixedClock } from "../src/clock.ts";
import { oublier, exclusions, normaliserValeur, SQL_EST_EXCLU } from "../src/oubli.ts";
import { makeTempDir } from "./helpers/tmp.ts";

/**
 * Art. 17 et 21. Ce qui est defendu ici : effacer sans inscrire l'exclusion ne serait pas
 * effacer — la campagne suivante recollecterait la donnee, et personne ne le verrait.
 */

const MAINTENANT = Date.parse("2026-08-23T10:00:00.000Z");

function socle(t: TestContext) {
  const dir = makeTempDir(t);
  const db = openDatabase(join(dir, "test.sqlite"));
  t.after(() => db.close());
  const cache = new HttpCache(join(dir, "cache"));

  db.prepare(
    "INSERT INTO commune (code_insee, nom, departement, created_at, updated_at) " +
      "VALUES ('35047', 'Bruz', '35', 't', 't')",
  ).run();
  db.prepare(
    "INSERT INTO commune (code_insee, nom, departement, created_at, updated_at) " +
      "VALUES ('35238', 'Rennes', '35', 't', 't')",
  ).run();

  const ajouter = (codeInsee: string, valeur: string, sourceUrl: string): void => {
    db.prepare(
      `INSERT INTO contact (code_insee, kind, valeur, valeur_normalisee, source_url,
                            methode_extraction, confiance, collected_at)
       VALUES (?, 'email', ?, ?, ?, 'dom:mailto', 0.9, '2026-08-01T00:00:00.000Z')`,
    ).run(codeInsee, valeur, valeur, sourceUrl);
  };

  return { db, cache, dir, counters: new Counters(db, null), clock: fixedClock(MAINTENANT), ajouter };
}

test("oublier un contact le supprime et l'empeche de revenir", (t) => {
  const { db, counters, clock, ajouter } = socle(t);
  ajouter("35047", "p.deville@bruz.example", "https://bruz.example/assos");
  ajouter("35047", "contact@bruz.example", "https://bruz.example/assos");

  const resultat = oublier(db, clock, counters, {
    portee: "contact",
    valeur: "P.Deville@Bruz.example",
    motif: "opposition du 12/03",
    origine: "cli",
  });

  assert.equal(resultat.contactsSupprimes, 1);
  assert.equal(resultat.nouvelle, true);
  assert.equal(resultat.valeur, "p.deville@bruz.example", "la valeur est normalisee comme en base");

  const restants = db.prepare("SELECT valeur_normalisee FROM contact").all() as { valeur_normalisee: string }[];
  assert.deepEqual(restants.map((l) => l.valeur_normalisee), ["contact@bruz.example"]);

  // Le point qui distingue un effacement d'une simple suppression.
  const exclu = db.prepare(SQL_EST_EXCLU).get("p.deville@bruz.example", "35047");
  assert.notEqual(exclu, undefined, "la campagne suivante doit voir l'exclusion");
});

test("oublier un domaine emporte toutes ses adresses", (t) => {
  const { db, counters, clock, ajouter } = socle(t);
  ajouter("35047", "a@cabinet.example", "https://bruz.example/a");
  ajouter("35238", "b@cabinet.example", "https://rennes.example/b");
  ajouter("35047", "c@mairie.example", "https://bruz.example/a");

  const resultat = oublier(db, clock, counters, {
    portee: "domaine",
    // Saisi sous forme d'adresse : l'erreur est courante, et se rattrape.
    valeur: "quelquun@cabinet.example",
    motif: "demande du cabinet",
    origine: "cli",
  });

  assert.equal(resultat.valeur, "cabinet.example");
  assert.equal(resultat.contactsSupprimes, 2);
  assert.notEqual(db.prepare(SQL_EST_EXCLU).get("nouveau@cabinet.example", "35047"), undefined);
  assert.equal(db.prepare(SQL_EST_EXCLU).get("c@mairie.example", "35047"), undefined);
});

test("oublier une commune emporte ce qui lui est rattache, et rien d'autre", (t) => {
  const { db, counters, clock, ajouter } = socle(t);
  ajouter("35047", "a@x.example", "https://bruz.example/a");
  ajouter("35238", "b@x.example", "https://rennes.example/b");

  const resultat = oublier(db, clock, counters, {
    portee: "commune",
    valeur: "35047",
    motif: "la commune se retire du dispositif",
    origine: "cli",
  });

  assert.equal(resultat.contactsSupprimes, 1);
  const restants = db.prepare("SELECT code_insee FROM contact").all() as { code_insee: string }[];
  assert.deepEqual(restants.map((l) => l.code_insee), ["35238"]);
});

test("la copie en cache de la page part avec le contact", (t) => {
  // Le cache contient le HTML brut, donc l'adresse elle-meme. L'y laisser reviendrait a
  // effacer d'une main ce qu'on conserve de l'autre.
  const { db, cache, counters, clock, ajouter } = socle(t);
  const url = "https://bruz.example/assos";
  const meta = {
    finalUrl: url,
    status: 200,
    etag: null,
    lastModified: null,
    contentType: "text/html",
    fetchedAt: "2026-08-01T00:00:00.000Z",
  };
  cache.set(url, meta, Buffer.from("<p>p.deville@bruz.example</p>"));
  const cheminRelatif = cache.relativeBodyPath(url);

  db.prepare(
    "INSERT INTO page (url_hash, campagne, url, domaine, code_insee, statut, cache_path, fetched_at) " +
      "VALUES ('h1', '2026-08-23', ?, 'bruz.example', '35047', 'visitee', ?, 't')",
  ).run(url, cheminRelatif);
  ajouter("35047", "p.deville@bruz.example", url);

  const resultat = oublier(
    db,
    clock,
    counters,
    { portee: "contact", valeur: "p.deville@bruz.example", motif: "opposition", origine: "cli" },
    (chemin) => cache.supprimerParChemin(chemin),
  );

  assert.equal(resultat.entreesCacheSupprimees, 1);
  assert.equal(cache.get(url), undefined, "la page en cache devait partir");
});

test("un chemin de cache qui sortirait du repertoire est refuse", (t) => {
  const { cache } = socle(t);
  assert.equal(cache.supprimerParChemin("../../ailleurs.body"), false);
  assert.equal(cache.supprimerParChemin("/etc/passwd"), false);
});

test("oublier deux fois ne change rien la seconde fois", (t) => {
  const { db, counters, clock, ajouter } = socle(t);
  ajouter("35047", "a@x.example", "https://bruz.example/a");
  const demande = { portee: "contact" as const, valeur: "a@x.example", motif: "opposition", origine: "cli" as const };

  const premier = oublier(db, clock, counters, demande);
  const second = oublier(db, clock, counters, demande);

  assert.equal(premier.nouvelle, true);
  assert.equal(second.nouvelle, false);
  assert.equal(second.contactsSupprimes, 0);
  assert.equal(exclusions(db).length, 1, "une seule exclusion, pas deux");
});

test("un motif vide est refuse : il fait la preuve de la demande honoree", (t) => {
  const { db, counters, clock } = socle(t);
  assert.throws(
    () => oublier(db, clock, counters, { portee: "contact", valeur: "a@x.example", motif: "  ", origine: "cli" }),
    /motif est requis/,
  );
});

test("la normalisation ramene une portee « domaine » saisie en adresse", () => {
  assert.equal(normaliserValeur("domaine", "  Contact@Mairie.EXAMPLE "), "mairie.example");
  assert.equal(normaliserValeur("domaine", "Mairie.example"), "mairie.example");
  assert.equal(normaliserValeur("contact", "  A@B.example "), "a@b.example");
  assert.equal(normaliserValeur("commune", " 35047 "), "35047");
});

test("l'exclusion est inscrite et supprimee dans la meme transaction", (t) => {
  // Une opposition a moitie honoree — la ligne supprimee, l'exclusion absente — serait
  // pire que rien : le run suivant remettrait la donnee sans que personne ne le voie.
  const { db, counters, clock, ajouter } = socle(t);
  ajouter("35047", "a@x.example", "https://bruz.example/a");
  // Une page en cache, pour que le rappel de suppression soit reellement atteint.
  db.prepare(
    "INSERT INTO page (url_hash, campagne, url, domaine, code_insee, statut, cache_path, fetched_at) " +
      "VALUES ('h1', '2026-08-23', 'https://bruz.example/a', 'bruz.example', '35047', 'visitee', 'ab/cd/x.body', 't')",
  ).run();

  assert.throws(() =>
    oublier(
      db,
      clock,
      counters,
      { portee: "contact", valeur: "a@x.example", motif: "opposition", origine: "cli" },
      () => {
        throw new Error("le cache tombe");
      },
    ),
  );

  assert.equal(exclusions(db).length, 0, "rien ne doit rester inscrit");
  assert.equal(
    (db.prepare("SELECT count(*) AS n FROM contact").get() as { n: number }).n,
    1,
    "le contact ne doit pas avoir ete supprime sans son exclusion",
  );
});

