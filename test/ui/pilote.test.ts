import { test } from "node:test";
import assert from "node:assert/strict";

import { PiloteRun } from "../../src/ui/pilote.ts";
import { fixedClock } from "../../src/clock.ts";
import type { App } from "../../src/app.ts";
import type { OptionsRun, ResultatRun } from "../../src/pipeline.ts";

/**
 * La machine a etats du pilote, sans file de jobs ni client HTTP.
 *
 * L'orchestration reelle est injectee : ce qui se teste ici est ce que l'interface
 * refuse, ce dont elle se souvient, et le fait qu'un run ne soit jamais attendu par le
 * routeur — `demarrer` doit rendre la main tout de suite.
 */

const HORLOGE = fixedClock(Date.parse("2026-09-01T10:00:00.000Z"));

type Espion = {
  appels: OptionsRun[];
  signaux: AbortSignal[];
  resoudre(resultat: ResultatRun): void;
  rejeter(erreur: Error): void;
  executer(app: App, options: OptionsRun, signal: AbortSignal, onRunId?: (id: number) => void): Promise<ResultatRun>;
};

function espion(): Espion {
  let resoudre: ((r: ResultatRun) => void) | undefined;
  let rejeter: ((e: Error) => void) | undefined;
  const e: Espion = {
    appels: [],
    signaux: [],
    resoudre: (resultat) => resoudre?.(resultat),
    rejeter: (erreur) => rejeter?.(erreur),
    executer(_app, options, signal, onRunId) {
      e.appels.push(options);
      e.signaux.push(signal);
      onRunId?.(42);
      return new Promise<ResultatRun>((ok, ko) => {
        resoudre = ok;
        rejeter = ko;
      });
    },
  };
  return e;
}

const journal = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };

function appFictive(contactUrl: string | undefined): App {
  return { config: { contactUrl }, clock: HORLOGE, logger: journal } as unknown as App;
}

/** `sansContact` plutot qu'un parametre `undefined` : celui-ci retomberait sur le defaut. */
function pilote(sansContact = false): [PiloteRun, Espion] {
  const e = espion();
  const app = appFictive(sansContact ? undefined : "https://exemple.fr/contact");
  return [new PiloteRun(app, e.executer), e];
}

test("un departement hors du champ du RNA est refuse, et le refus se garde", () => {
  const [p, e] = pilote();

  assert.deepEqual(p.demarrer("67"), {
    kind: "refus",
    message:
      "Le departement 67 est hors du champ du RNA (droit local d'Alsace-Moselle). " +
      "Aucune amorce n'est disponible pour ce departement.",
  });
  assert.equal(e.appels.length, 0, "rien ne doit avoir ete lance");
  assert.match(p.refus() ?? "", /hors du champ du RNA/, "le bloc de suivi se rafraichit : il faut s'en souvenir");
  assert.equal(p.etat().kind, "inactif");
});

test("une saisie qui n'est pas un departement est refusee", () => {
  const [p] = pilote();
  assert.equal(p.demarrer("trente-cinq").kind, "refus");
  assert.equal(p.demarrer(undefined).kind, "refus");
});

test("sans URL de contact, aucune collecte ne part (§4.4)", () => {
  const [p, e] = pilote(true);

  const reponse = p.demarrer("35");
  assert.equal(reponse.kind, "refus");
  assert.match(p.refus() ?? "", /URL de contact/);
  assert.equal(e.appels.length, 0);
});

test("un run lance rend la main aussitot, et se souvient de son identifiant", () => {
  const [p, e] = pilote();

  assert.deepEqual(p.demarrer("35"), { kind: "lance" });
  assert.equal(e.appels.length, 1);
  assert.equal(e.appels[0]?.departement, "35");
  assert.equal(e.appels[0]?.sansDecouverte, false, "l'interface lance le run complet");

  const etat = p.etat();
  assert.equal(etat.kind, "en_cours");
  assert.equal(etat.kind === "en_cours" ? etat.runId : undefined, 42);
});

test("un second lancement est refuse tant que le premier tourne", () => {
  const [p, e] = pilote();
  p.demarrer("35");

  assert.deepEqual(p.demarrer("35"), {
    kind: "refus",
    message: "Un run est deja en cours dans cette interface.",
  });
  assert.equal(e.appels.length, 1);
});

test("arreter propage le signal, et l'interruption n'est pas un echec", async () => {
  const [p, e] = pilote();
  p.demarrer("35");

  assert.equal(p.arreter(), true);
  assert.equal(e.signaux[0]?.aborted, true, "le signal doit atteindre le worker");

  e.resoudre({ runId: 42, interrompu: true });
  await p.attendre();

  assert.deepEqual(p.etat(), {
    kind: "fini",
    departement: "35",
    issue: "interrompu",
    message: undefined,
  });
  assert.equal(p.arreter(), false, "plus rien a arreter");
});

test("un echec atterrit dans l'etat plutot que dans un rejet que personne n'observe", async () => {
  const [p, e] = pilote();
  p.demarrer("35");

  e.rejeter(new Error("dump introuvable"));
  await p.attendre();

  const etat = p.etat();
  assert.equal(etat.kind, "fini");
  assert.equal(etat.kind === "fini" ? etat.issue : undefined, "echec");
  assert.equal(etat.kind === "fini" ? etat.message : undefined, "dump introuvable");
});

test("un run mene a terme efface le refus precedent", async () => {
  const [p, e] = pilote();
  p.demarrer("67");
  assert.notEqual(p.refus(), undefined);

  p.demarrer("35");
  assert.equal(p.refus(), undefined, "le refus ne doit pas survivre a un lancement accepte");

  e.resoudre({ runId: 42, interrompu: false });
  await p.attendre();
  assert.equal(p.etat().kind === "fini" ? (p.etat() as { issue: string }).issue : "", "termine");
});

test("attendre ne bloque pas quand rien ne tourne", async () => {
  const [p] = pilote();
  await p.attendre();
});
