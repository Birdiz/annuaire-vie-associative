import { test } from "node:test";
import assert from "node:assert/strict";

import { openDatabase } from "../../src/db/index.ts";
import { fixedClock } from "../../src/clock.ts";
import { Counters, ETAPE } from "../../src/metrics/counters.ts";
import { arbitrer, normaliserSaisie } from "../../src/ui/revue.ts";
import { ResolveurMx } from "../../src/http/dns.ts";
import { normaliser } from "../../src/normalisation/rejeu.ts";
import { CODE_INSEE, DEPARTEMENT, preparerCorpus } from "../helpers/corpus.ts";
import type { Database } from "../../src/db/index.ts";
import type { TestContext } from "node:test";

/**
 * Revue humaine. Ce qui est defendu ici : ce qu'un humain corrige entre en base sans
 * effacer ce qui a ete lu, et ce que la base refuse, elle le refuse elle-meme.
 */

const HORLOGE = fixedClock(Date.parse("2026-09-01T10:00:00.000Z"));

function ouvrir(t: TestContext): Database {
  const { dbFile } = preparerCorpus(t);
  const db = openDatabase(dbFile);
  t.after(() => db.close());
  return db;
}

function idDe(db: Database, valeur: string): number {
  const ligne = db.prepare("SELECT id FROM contact WHERE valeur = ? LIMIT 1").get(valeur) as
    | { id: number }
    | undefined;
  assert.ok(ligne !== undefined, `contact ${valeur} absent du corpus`);
  return ligne.id;
}

function ligneDe(db: Database, id: number): Record<string, unknown> {
  return db.prepare("SELECT * FROM contact WHERE id = ?").get(id) as Record<string, unknown>;
}

test("valider et rejeter posent un statut, une date et un compteur", (t) => {
  const db = ouvrir(t);
  const counters = new Counters(db, null);
  const id = idDe(db, "mairie@bruzou.example");

  assert.deepEqual(arbitrer(db, HORLOGE, counters, { id, action: "valide" }), {
    kind: "ok",
    action: "valide",
  });

  const apres = ligneDe(db, id);
  assert.equal(apres["review_statut"], "valide");
  assert.equal(apres["review_at"], "2026-09-01T10:00:00.000Z");
  assert.equal(counters.get(ETAPE.revue, "valides"), 1);

  // Changer d'avis est permis : c'est l'etat de la ligne qui fait foi, et les compteurs
  // ne comptent que des evenements.
  arbitrer(db, HORLOGE, counters, { id, action: "rejete", note: "boite fermee" });
  assert.equal(ligneDe(db, id)["review_statut"], "rejete");
  assert.equal(ligneDe(db, id)["review_note"], "boite fermee");
  assert.equal(counters.get(ETAPE.revue, "valides"), 1);
  assert.equal(counters.get(ETAPE.revue, "rejetes"), 1);
});

test("un arbitrage sur un contact disparu ne fabrique rien", (t) => {
  const db = ouvrir(t);
  assert.deepEqual(arbitrer(db, HORLOGE, new Counters(db, null), { id: 9999, action: "valide" }), {
    kind: "introuvable",
  });
});

test("corriger ecrit a cote de la valeur lue, jamais par-dessus", (t) => {
  const db = ouvrir(t);
  const counters = new Counters(db, null);
  const id = idDe(db, "marie.dupont@theatre-landes.example");

  const resultat = arbitrer(db, HORLOGE, counters, {
    id,
    action: "corrige",
    valeur: "  Contact@Theatre-Landes.example ",
  });
  assert.deepEqual(resultat, { kind: "ok", action: "corrige" });

  const apres = ligneDe(db, id);
  assert.equal(apres["valeur"], "marie.dupont@theatre-landes.example", "la provenance ne se reecrit pas");
  assert.equal(apres["valeur_corrigee"], "Contact@Theatre-Landes.example");
  assert.equal(apres["valeur_normalisee"], "contact@theatre-landes.example", "le MX lit celle-la");
  assert.equal(apres["is_generique"], 1, "le regime se recalcule sur la valeur corrigee (§4.7)");
  assert.equal(apres["review_statut"], "corrige");
  assert.equal(apres["score_version"], null, "la correction rouvre la notation, elle ne note pas");
  assert.equal(counters.get(ETAPE.revue, "corriges"), 1);
});

test("la correction rouvre la notation, et la notation en tient compte", async (t) => {
  const db = ouvrir(t);
  const resolveur = new ResolveurMx({
    resolve: async (domaine) => [{ exchange: `mx.${domaine}`, priority: 10 }],
  });
  await normaliser(db, HORLOGE, resolveur, { departement: DEPARTEMENT });

  const id = idDe(db, "marie.dupont@theatre-landes.example");
  const avant = ligneDe(db, id);
  assert.ok(typeof avant["score"] === "number");

  arbitrer(db, HORLOGE, new Counters(db, null), {
    id,
    action: "corrige",
    valeur: "contact@theatre-landes.example",
  });
  await normaliser(db, HORLOGE, resolveur, { departement: DEPARTEMENT });

  const apres = ligneDe(db, id);
  assert.ok(
    (apres["score"] as number) > (avant["score"] as number),
    "une valeur corrigee a la main ne doit pas rester plafonnee par la lecture machine",
  );
  const motifs = JSON.parse(String(apres["score_motifs"])) as {
    base: number;
    signaux: { signal: string }[];
  };
  assert.equal(motifs.base, 0.95);
  assert.ok(
    motifs.signaux.some((signal) => signal.signal === "revue"),
    "l'ecran doit pouvoir dire d'ou vient une base inhabituelle",
  );
});

test("une correction refusee ne touche a rien", (t) => {
  const db = ouvrir(t);
  const counters = new Counters(db, null);
  const id = idDe(db, "mairie@bruzou.example");

  const cas: readonly [string, string, RegExp][] = [
    ["vide", "   ", /Aucune valeur/],
    ["sans forme d'adresse", "pas une adresse", /forme d'une adresse/],
    ["identique a la valeur lue", "mairie@bruzou.example", /identique/],
  ];

  for (const [nom, valeur, attendu] of cas) {
    const resultat = arbitrer(db, HORLOGE, counters, { id, action: "corrige", valeur });
    assert.equal(resultat.kind, "refus", nom);
    if (resultat.kind === "refus") assert.match(resultat.message, attendu, nom);
  }

  const apres = ligneDe(db, id);
  assert.equal(apres["valeur_corrigee"], null);
  assert.equal(apres["review_statut"], "a_revoir");
  assert.equal(counters.get(ETAPE.revue, "corriges"), 0);
});

test("§4.6 — un mobile ne rentre pas par la revue", (t) => {
  const db = ouvrir(t);
  const id = idDe(db, "+33299000000");

  const resultat = arbitrer(db, HORLOGE, new Counters(db, null), {
    id,
    action: "corrige",
    valeur: "06 12 34 56 78",
  });
  assert.equal(resultat.kind, "refus");
  if (resultat.kind === "refus") assert.match(resultat.message, /06\/07/);

  // Un fixe, lui, passe : c'est bien le prefixe qui est refuse, pas la correction.
  assert.equal(
    arbitrer(db, HORLOGE, new Counters(db, null), { id, action: "corrige", valeur: "02 99 11 22 33" }).kind,
    "ok",
  );
});

test("une correction qui fabriquerait un doublon est refusee par la base", (t) => {
  const db = ouvrir(t);
  const association = db.prepare("SELECT association_id FROM contact WHERE valeur = ?").get(
    "contact@tennis-bruzou.example",
  ) as { association_id: number };

  db.prepare(
    "INSERT INTO contact (association_id, code_insee, kind, valeur, valeur_normalisee, " +
      "is_generique, source_url, methode_extraction, confiance, collected_at) " +
      "VALUES (?, ?, 'email', ?, ?, 1, 'https://bruzou.example/associations', 'texte:motif', 0.5, 't')",
  ).run(association.association_id, CODE_INSEE, "secretariat@tennis-bruzou.example", "secretariat@tennis-bruzou.example");

  const id = idDe(db, "secretariat@tennis-bruzou.example");
  const resultat = arbitrer(db, HORLOGE, new Counters(db, null), {
    id,
    action: "corrige",
    valeur: "contact@tennis-bruzou.example",
  });

  assert.equal(resultat.kind, "refus");
  if (resultat.kind === "refus") assert.match(resultat.message, /existe deja/);
  assert.equal(ligneDe(db, id)["valeur_normalisee"], "secretariat@tennis-bruzou.example");
});

test("la base refuse elle-meme un contact corrige sans valeur corrigee", (t) => {
  const db = ouvrir(t);
  const id = idDe(db, "mairie@bruzou.example");

  // Le trigger, pas le serveur : l'incoherence doit echouer meme si l'ecriture vient
  // d'ailleurs — d'un script, d'une session sqlite3 ouverte a la main.
  assert.throws(
    () => db.prepare("UPDATE contact SET review_statut = 'corrige' WHERE id = ?").run(id),
    /valeur corrigee/,
  );
  assert.throws(
    () =>
      db
        .prepare(
          "INSERT INTO contact (code_insee, kind, valeur, valeur_normalisee, source_url, " +
            "methode_extraction, confiance, collected_at, review_statut) " +
            "VALUES (?, 'email', 'x@y.example', 'x@y.example', 'u', 'm', 0.5, 't', 'corrige')",
        )
        .run(CODE_INSEE),
    /valeur corrigee/,
  );
});

test("la saisie humaine passe par les regles de forme de l'extraction", () => {
  assert.deepEqual(normaliserSaisie("email", " Contact@Mairie.example "), {
    kind: "ok",
    valeur: "Contact@Mairie.example",
    valeurNormalisee: "contact@mairie.example",
    isGenerique: 1,
  });
  assert.deepEqual(normaliserSaisie("phone", "02.99.00.00.00"), {
    kind: "ok",
    valeur: "02.99.00.00.00",
    valeurNormalisee: "+33299000000",
    isGenerique: null,
  });
  assert.equal(normaliserSaisie("phone", "12345").kind, "refus");
});
