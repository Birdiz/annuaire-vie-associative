import { test } from "node:test";
import assert from "node:assert/strict";

import { openDatabase } from "../../src/db/index.ts";
import { fixedClock } from "../../src/clock.ts";
import { Counters, ETAPE } from "../../src/metrics/counters.ts";
import { ResolveurMx, domaineDeLAdresse } from "../../src/http/dns.ts";
import { FRAICHEUR_MX_JOURS, domainesDuDepartement, lireVerdicts, verifierDomaines } from "../../src/normalisation/mx.ts";
import { DEPARTEMENT, preparerCorpus } from "../helpers/corpus.ts";
import type { TestContext } from "node:test";
import type { EnregistrementMx } from "../../src/http/dns.ts";

/**
 * Etape [7], volet MX (ADR-017). Le resolveur est injecte : la suite de tests ne sort
 * jamais sur Internet, et un verdict MX dependrait sinon d'enregistrements que nous ne
 * controlons pas.
 */

const DEBUT = Date.parse("2026-08-22T10:00:00.000Z");

/** Resolveur de test : rend ce qu'on lui dicte, et compte ce qu'on lui a demande. */
function faux(
  reponses: Record<string, readonly EnregistrementMx[] | { code: string }>,
): { resolveur: ResolveurMx; appels: string[] } {
  const appels: string[] = [];
  const resolveur = new ResolveurMx({
    resolve: async (domaine) => {
      appels.push(domaine);
      const reponse = reponses[domaine];
      if (reponse === undefined) {
        const erreur = Object.assign(new Error("ENODATA"), { code: "ENODATA" });
        throw erreur;
      }
      if (Array.isArray(reponse)) return reponse;
      throw Object.assign(new Error("echec"), { code: (reponse as { code: string }).code });
    },
  });
  return { resolveur, appels };
}

function ouvrir(t: TestContext): ReturnType<typeof openDatabase> {
  const { dbFile } = preparerCorpus(t);
  const db = openDatabase(dbFile);
  t.after(() => db.close());
  return db;
}

test("le domaine se tire de l'adresse, et seulement d'une adresse plausible", () => {
  assert.equal(domaineDeLAdresse("contact@mairie.example"), "mairie.example");
  assert.equal(domaineDeLAdresse("Contact@Mairie.Example"), "mairie.example");
  assert.equal(domaineDeLAdresse("sans-arobase"), undefined);
  assert.equal(domaineDeLAdresse("@mairie.example"), undefined);
  assert.equal(domaineDeLAdresse("contact@"), undefined);
  assert.equal(domaineDeLAdresse("contact@sanspoint"), undefined);
});

test("un MX present, une absence de MX et un echec sont trois verdicts distincts", async () => {
  const { resolveur } = faux({
    "avec.example": [{ exchange: "mx2.avec.example", priority: 20 }, { exchange: "mx1.avec.example", priority: 10 }],
    "panne.example": { code: "ESERVFAIL" },
    "vide.example": [],
  });

  const avec = await resolveur.verifier("avec.example");
  assert.equal(avec.mx, 1);
  assert.deepEqual(avec.hotes, ["mx1.avec.example", "mx2.avec.example"], "tries par priorite croissante");

  // ENODATA : le domaine existe mais n'annonce rien. C'est un « non », pas une panne.
  const sans = await resolveur.verifier("inconnu.example");
  assert.equal(sans.mx, 0);
  assert.equal(sans.erreur, undefined);

  // Une reponse vide vaut la meme chose qu'un ENODATA.
  assert.equal((await resolveur.verifier("vide.example")).mx, 0);

  // Une panne de resolveur ne doit surtout pas se figer en jugement sur le domaine.
  const panne = await resolveur.verifier("panne.example");
  assert.equal(panne.mx, null);
  assert.equal(panne.erreur, "ESERVFAIL");
});

test("les domaines du departement sont dedupliques avant toute requete", (t) => {
  const db = ouvrir(t);
  assert.deepEqual(domainesDuDepartement(db, DEPARTEMENT), [
    "bruzou.example",
    "tennis-bruzou.example",
    "theatre-landes.example",
  ]);
});

test("un domaine deja connu et frais n'est jamais reinterroge", async (t) => {
  const db = ouvrir(t);
  const clock = fixedClock(DEBUT);
  const counters = new Counters(db, null);
  const { resolveur, appels } = faux({
    "tennis-bruzou.example": [{ exchange: "mx.tennis-bruzou.example", priority: 10 }],
    "bruzou.example": [{ exchange: "mx.bruzou.example", priority: 10 }],
  });

  const premier = await verifierDomaines(db, resolveur, clock, { departement: DEPARTEMENT, counters });
  assert.equal(premier.distincts, 3);
  assert.equal(premier.verifies, 3);
  assert.equal(premier.deja, 0);
  assert.equal(appels.length, 3);

  const second = await verifierDomaines(db, resolveur, clock, { departement: DEPARTEMENT, counters });
  // Deux domaines repondent, le troisieme est un ENODATA : les trois sont des verdicts
  // fermes, aucun n'a a etre repose.
  assert.equal(second.verifies, 0);
  assert.equal(second.deja, 3);
  assert.equal(appels.length, 3, "aucune requete supplementaire");

  const verdicts = lireVerdicts(db);
  assert.equal(verdicts.get("tennis-bruzou.example"), 1);
  assert.equal(verdicts.get("theatre-landes.example"), 0);
  assert.equal(counters.get(ETAPE.normalisation, "domaines_verifies"), 3);
  assert.equal(counters.get(ETAPE.normalisation, "domaines_sans_mx"), 1);
});

test("un verdict perime est repose, un verdict en echec l'est toujours", async (t) => {
  const db = ouvrir(t);
  const clock = fixedClock(DEBUT);
  const { resolveur, appels } = faux({
    "tennis-bruzou.example": [{ exchange: "mx.tennis-bruzou.example", priority: 10 }],
    "bruzou.example": { code: "ETIMEOUT" },
  });

  await verifierDomaines(db, resolveur, clock, { departement: DEPARTEMENT });
  assert.equal(appels.length, 3);
  assert.equal(lireVerdicts(db).get("bruzou.example"), null);

  // Le lendemain : rien n'est perime, mais l'echec reste a reprendre.
  appels.length = 0;
  clock.advance(86_400_000);
  const lendemain = await verifierDomaines(db, resolveur, clock, { departement: DEPARTEMENT });
  assert.deepEqual(appels, ["bruzou.example"], "seul l'echec est repris");
  assert.equal(lendemain.verifies, 1);

  // Au-dela de la fenetre de fraicheur, tout redevient a verifier.
  appels.length = 0;
  clock.advance((FRAICHEUR_MX_JOURS + 1) * 86_400_000);
  const plusTard = await verifierDomaines(db, resolveur, clock, { departement: DEPARTEMENT });
  assert.equal(plusTard.verifies, 3);
});

test("--tout reinterroge meme ce qui est frais", async (t) => {
  const db = ouvrir(t);
  const clock = fixedClock(DEBUT);
  const { resolveur, appels } = faux({});

  await verifierDomaines(db, resolveur, clock, { departement: DEPARTEMENT });
  appels.length = 0;
  const force = await verifierDomaines(db, resolveur, clock, { departement: DEPARTEMENT, tout: true });
  assert.equal(force.verifies, 3);
  assert.equal(appels.length, 3);
});

test("chaque verdict est ecrit des qu'il tombe, pas a la fin du lot", async (t) => {
  const db = ouvrir(t);
  const clock = fixedClock(DEBUT);

  // Le troisieme appel abandonne le lot. Ce que les deux premiers ont paye doit
  // pourtant etre en base : c'est ce qui fait qu'un kill -9 ne fait pas tout repayer.
  let appels = 0;
  const resolveur = new ResolveurMx({
    concurrence: 1,
    resolve: async (domaine) => {
      appels += 1;
      if (appels === 3) throw Object.assign(new Error("coupure"), { code: "ECONNREFUSED" });
      return [{ exchange: `mx.${domaine}`, priority: 10 }];
    },
  });

  await verifierDomaines(db, resolveur, clock, { departement: DEPARTEMENT });
  const verdicts = lireVerdicts(db);
  assert.equal(verdicts.size, 3);
  assert.equal([...verdicts.values()].filter((mx) => mx === 1).length, 2);
  assert.equal([...verdicts.values()].filter((mx) => mx === null).length, 1);
});

test("INTERDIT : sans resolveur injecte, la suite de tests ne joint personne", async () => {
  // `test/helpers/pas-de-reseau.ts` pointe le resolveur par defaut vers un port mort.
  // Le verdict doit etre un echec — et non une absence de MX, qui serait un faux
  // negatif silencieux sur un domaine parfaitement valide.
  const verdict = await new ResolveurMx().verifier("exemple-inexistant.example");
  assert.equal(verdict.mx, null, "aucune requete ne doit aboutir depuis la suite de tests");
  assert.ok(verdict.erreur !== undefined && verdict.erreur !== "ENODATA");
});
