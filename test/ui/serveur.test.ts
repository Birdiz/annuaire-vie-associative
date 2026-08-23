import { test } from "node:test";
import assert from "node:assert/strict";

import { openDatabase } from "../../src/db/index.ts";
import { fixedClock } from "../../src/clock.ts";
import { Counters } from "../../src/metrics/counters.ts";
import { JobQueue } from "../../src/jobs/queue.ts";
import { ADRESSE_ECOUTE, demarrerServeur } from "../../src/ui/serveur.ts";
import { NOM_COOKIE } from "../../src/ui/routes.ts";
import { DEPARTEMENT, preparerCorpus } from "../helpers/corpus.ts";
import { piloteDouble, reglagesDouble } from "../helpers/pilote-double.ts";
import type { ServeurUi } from "../../src/ui/serveur.ts";
import type { TestContext } from "node:test";

/**
 * Le serveur pour de vrai, sur un port ephemere de la boucle locale. Le garde-fou
 * `test/helpers/pas-de-reseau.ts` autorise cet hote et lui seul : ces requetes ne
 * sortent pas de la machine.
 */

const HORLOGE = fixedClock(Date.parse("2026-09-01T10:00:00.000Z"));

async function servir(t: TestContext): Promise<ServeurUi> {
  const { dbFile } = preparerCorpus(t);
  const db = openDatabase(dbFile);
  db.prepare("UPDATE contact SET score = 0.4, score_version = 1").run();
  t.after(() => db.close());

  const counters = new Counters(db, null);
  const serveur = await demarrerServeur({
    port: 0,
    db,
    queue: new JobQueue(db, HORLOGE, counters),
    counters,
    clock: HORLOGE,
    version: "0.1.0",
    departementSecours: DEPARTEMENT,
    supprimerCache: () => false,
    pilote: piloteDouble(),
    reglages: reglagesDouble("https://exemple.example/contact"),
  });
  t.after(() => serveur.fermer());
  return serveur;
}

function adresse(serveur: ServeurUi, chemin: string): string {
  return `http://${ADRESSE_ECOUTE}:${serveur.port}${chemin}`;
}

function cookie(serveur: ServeurUi): Record<string, string> {
  return { cookie: `${NOM_COOKIE}=${serveur.jeton}` };
}

test("le serveur n'ecoute que sur la boucle locale, et son jeton change a chaque demarrage", async (t) => {
  const premier = await servir(t);
  const second = await servir(t);

  assert.match(premier.url, /^http:\/\/127\.0\.0\.1:\d+\/\?jeton=/);
  assert.notEqual(premier.jeton, second.jeton, "un jeton reconduit survivrait a un redemarrage");
  assert.notEqual(premier.port, second.port);
});

test("l'ouverture par l'URL imprimee pose le cookie et sert l'ecran", async (t) => {
  const serveur = await servir(t);

  const echange = await fetch(serveur.url, { redirect: "manual" });
  assert.equal(echange.status, 303);
  const pose = echange.headers.get("set-cookie") ?? "";
  assert.match(pose, new RegExp(`${NOM_COOKIE}=`));

  const ecran = await fetch(adresse(serveur, "/"), { headers: cookie(serveur) });
  assert.equal(ecran.status, 200);
  const html = await ecran.text();
  assert.match(html, /Couverture/);
  assert.match(html, /htmx\.min\.js/);
});

test("sans jeton, le serveur refuse", async (t) => {
  const serveur = await servir(t);
  const reponse = await fetch(adresse(serveur, "/"));
  assert.equal(reponse.status, 401);
  assert.match(await reponse.text(), /Jeton absent/);
});

test("htmx est servi depuis cette machine, avec son type", async (t) => {
  const serveur = await servir(t);
  const reponse = await fetch(adresse(serveur, "/assets/htmx.min.js"), { headers: cookie(serveur) });

  assert.equal(reponse.status, 200);
  assert.match(reponse.headers.get("content-type") ?? "", /text\/javascript/);
  assert.ok((await reponse.text()).includes("htmx"));
});

test("un arbitrage traverse le socket et s'ecrit en base", async (t) => {
  const serveur = await servir(t);
  const ecran = await fetch(adresse(serveur, `/revue?departement=${DEPARTEMENT}`), {
    headers: cookie(serveur),
  });
  const html = await ecran.text();

  const trouve = /id="contact-(\d+)"/.exec(html);
  assert.ok(trouve !== null, "la file de revue doit contenir au moins une carte");
  const id = trouve[1];

  const reponse = await fetch(adresse(serveur, `/revue/${id}?departement=${DEPARTEMENT}`), {
    method: "POST",
    headers: {
      ...cookie(serveur),
      "content-type": "application/x-www-form-urlencoded",
      "hx-request": "true",
      "sec-fetch-site": "same-origin",
    },
    body: "action=valide",
  });

  assert.equal(reponse.status, 200);
  const fragment = await reponse.text();
  assert.doesNotMatch(fragment, new RegExp(`id="contact-${id}"`), "la carte arbitree quitte la file");
});

test("l'export sort en piece jointe, morceau par morceau", async (t) => {
  const serveur = await servir(t);
  const reponse = await fetch(adresse(serveur, `/export.csv?departement=${DEPARTEMENT}`), {
    headers: cookie(serveur),
  });

  assert.equal(reponse.status, 200);
  assert.match(reponse.headers.get("content-disposition") ?? "", /attachment/);
  const csv = await reponse.text();
  assert.match(csv, /code_insee;commune/);
  assert.ok(csv.split("\r\n").length > 2);
});

test("fermer libere le port", async (t) => {
  const serveur = await servir(t);
  const port = serveur.port;
  await serveur.fermer();

  await assert.rejects(fetch(`http://${ADRESSE_ECOUTE}:${port}/`), /fetch failed/);
});
