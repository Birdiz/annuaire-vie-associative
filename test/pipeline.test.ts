import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { openApp } from "../src/app.ts";
import { executerRun, refusDepartement, optionsDecouvertePardefaut } from "../src/pipeline.ts";
import { makeTempDir } from "./helpers/tmp.ts";
import type { App } from "../src/app.ts";
import type { OptionsRun } from "../src/pipeline.ts";
import type { TestContext } from "node:test";

/**
 * L'orchestration d'un run, extraite de la CLI au lot 8 pour que l'interface puisse la
 * lancer aussi (ADR-024).
 *
 * Les sources reelles sont hors d'atteinte sous le garde-fou anti-reseau : c'est le cas
 * d'une machine sans connexion, et le run doit s'en sortir sans planter — la meme
 * situation que le test « un run se termine proprement meme quand la collecte echoue ».
 * Ce qui se verifie ici est ce que la ligne `run` raconte pendant et apres.
 */

function application(t: TestContext): App {
  const app = openApp({
    dataDir: join(makeTempDir(t), "instance"),
    console: false,
    processEnv: { ANNUAIRE_CONTACT_URL: "https://exemple.fr/contact" },
  });
  t.after(() => app.close());
  return app;
}

function options(): OptionsRun {
  return {
    departement: "35",
    avecImport: false,
    rnaFile: undefined,
    sansDecouverte: false,
    decouverte: optionsDecouvertePardefaut(),
  };
}

function ligneRun(app: App): { statut: string; phase: string | null; finished_at: string | null } {
  return app.db.prepare("SELECT statut, phase, finished_at FROM run WHERE id = 1").get() as {
    statut: string;
    phase: string | null;
    finished_at: string | null;
  };
}

test("un departement est valide de la meme facon pour la CLI et pour l'interface", () => {
  assert.equal(refusDepartement("35"), undefined);
  assert.equal(refusDepartement("2A"), undefined);
  assert.equal(refusDepartement("971"), undefined);

  assert.match(refusDepartement(undefined) ?? "", /Un departement est requis/);
  assert.match(refusDepartement("trente-cinq") ?? "", /Un departement est requis/);
  for (const droitLocal of ["57", "67", "68"]) {
    assert.match(refusDepartement(droitLocal) ?? "", /hors du champ du RNA/);
  }
});

test("le run s'annonce des son ouverture, avant meme d'avoir attendu un job", async (t) => {
  const app = application(t);

  // L'insertion est synchrone : la ligne existe avant le premier `await`, donc avant
  // que le moindre job ne soit pris. C'est ce qui permet a l'interface d'afficher un
  // run des le clic, sans attendre le premier resultat.
  const promesse = executerRun(app, options(), new AbortController().signal);
  const ligne = ligneRun(app);
  assert.equal(ligne.statut, "en_cours");
  assert.equal(ligne.phase, "amorce");
  assert.equal(ligne.finished_at, null);

  await promesse;
});

test("un run mene a terme clot sa ligne et n'annonce plus de phase", async (t) => {
  const app = application(t);

  const resultat = await executerRun(app, options(), new AbortController().signal);

  assert.equal(resultat.interrompu, false);
  assert.equal(resultat.runId, 1);
  const ligne = ligneRun(app);
  assert.equal(ligne.statut, "termine");
  assert.equal(ligne.phase, null, "une phase qui survit a la cloture serait un mensonge d'ecran");
  assert.notEqual(ligne.finished_at, null);
});

test("un signal deja annule arrete le run sans le declarer en echec", async (t) => {
  const app = application(t);
  const controller = new AbortController();
  controller.abort();

  const resultat = await executerRun(app, options(), controller.signal);

  assert.equal(resultat.interrompu, true);
  const ligne = ligneRun(app);
  assert.equal(ligne.statut, "interrompu", "une interruption n'est pas un echec : la file reprendra");
  assert.equal(ligne.phase, null);
});

test("l'amorce est enfilee une seule fois, meme relancee le meme jour", async (t) => {
  const app = application(t);

  await executerRun(app, options(), new AbortController().signal);
  await executerRun(app, options(), new AbortController().signal);

  // Invariant 9 : la cle de deduplication a la journee tient, deux runs ne creent pas
  // deux amorces. Les deux lignes `run`, elles, sont deux evenements distincts.
  const jobs = app.db
    .prepare("SELECT count(*) AS n FROM job WHERE type = 'annuaire_dump'")
    .get() as { n: number };
  assert.equal(jobs.n, 1);
  assert.equal((app.db.prepare("SELECT count(*) AS n FROM run").get() as { n: number }).n, 2);
});
