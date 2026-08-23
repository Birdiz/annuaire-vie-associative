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
    processEnv: { ANNUAIRE_CONTACT_URL: "https://exemple.example/contact" },
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

test("un run qui echoue clot sa ligne en « echec » plutot que de la laisser ouverte", async (t) => {
  // `executerRun` n'avait aucun try/catch : une exception laissait `statut = 'en_cours'`
  // et une phase non nulle, indefiniment. L'ecran affichait donc durablement « Run #N —
  // phase decouverte » a cote du message d'echec, alors que le process savait tres bien
  // que le run etait mort. Le `CHECK` du schema acceptait 'echec' depuis toujours, et
  // personne ne l'ecrivait.
  const app = application(t);

  // Rendre la file inutilisable : l'echec tombe au premier enfilement, apres que la
  // ligne `run` a ete ouverte.
  app.db.exec("DROP TABLE job");

  await assert.rejects(executerRun(app, options(), new AbortController().signal));

  const ligne = app.db.prepare("SELECT statut, phase, finished_at FROM run ORDER BY id DESC LIMIT 1").get() as
    | { statut: string; phase: string | null; finished_at: string | null }
    | undefined;

  assert.equal(ligne?.statut, "echec");
  assert.equal(ligne?.phase, null, "la phase doit disparaitre : le run n'en est plus a aucune");
  assert.notEqual(ligne?.finished_at, null, "un run fini porte une date de fin, meme rate");
});

test("« decouvrir » ouvre un run qui s'affiche comme les autres", async (t) => {
  // La commande tenait sa propre copie du cycle de vie, et cette copie n'ecrivait
  // jamais de phase : un run lance dans un terminal ne s'affichait pas comme un run
  // lance depuis l'interface, ce que la migration 7 dit vouloir eviter.
  const { executerDecouverteSeule } = await import("../src/pipeline.ts");
  const app = application(t);
  app.db
    .prepare(
      "INSERT INTO commune (code_insee, nom, departement, url_mairie, statut_resolution, " +
        "resolution_source_url, resolution_collected_at, source_resolution, resolution_confiance, " +
        "created_at, updated_at) VALUES ('35047', 'Bruz', '35', 'https://bruz.example/', 'resolue', " +
        "'https://source.example', 't', 'annuaire', 0.9, 't', 't')",
    )
    .run();

  // La ligne `run` est ouverte de facon **synchrone**, avant le premier `await` : on la
  // lit donc juste apres l'appel, sans echantillonner. Un observateur periodique
  // dependrait de la vitesse de la machine — et sur une machine au repos, le run se
  // termine avant le premier echantillon.
  const promesse = executerDecouverteSeule(
    app,
    { departement: "35", decouverte: optionsDecouvertePardefaut() },
    new AbortController().signal,
  );

  const pendant = app.db.prepare("SELECT statut, phase FROM run ORDER BY id DESC LIMIT 1").get() as
    | { statut: string; phase: string | null }
    | undefined;
  assert.equal(pendant?.statut, "en_cours");
  assert.equal(pendant?.phase, "decouverte", "un run lance dans un terminal doit s'afficher comme les autres");

  const { runId, interrompu } = await promesse;

  assert.equal(interrompu, false);
  const ligne = app.db.prepare("SELECT statut, phase FROM run WHERE id = ?").get(runId) as
    | { statut: string; phase: string | null }
    | undefined;
  assert.equal(ligne?.statut, "termine");
  assert.equal(ligne?.phase, null, "la phase est effacee a la cloture");
});
