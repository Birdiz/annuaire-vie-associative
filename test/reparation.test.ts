import { test } from "node:test";
import assert from "node:assert/strict";

import { openApp } from "../src/app.ts";
import { VERSION_ADRESSES, reparerApresMiseAJour } from "../src/reparation.ts";
import { VERSION_NOM } from "../src/decouverte/nom-pressenti.ts";
import { hashPage } from "../src/decouverte/contexte.ts";
import { makeTempDir } from "./helpers/tmp.ts";
import type { App } from "../src/app.ts";
import type { TestContext } from "node:test";

/**
 * La reparation au demarrage (lot 11).
 *
 * Ce qu'on defend ici : un client qui installe la nouvelle version et exporte dans la
 * foulee obtient un fichier propre **sans rien taper**. Jusqu'ici la correction d'une
 * heuristique n'atteignait que les collectes suivantes, et la commande qui rattrapait
 * l'ancienne base demandait de savoir qu'elle existait.
 */

const CAMPAGNE = "2026-09-13";
const INSEE = "35047";
const T = "2026-09-13T00:00:00.000Z";
const URL = "https://bruz.example/associations";

const PAGE = `<html><body><table>
  <tr><td>Tennis Club de Bruz</td><td>tennis@asso.example</td></tr>
</table></body></html>`;

function preparer(t: TestContext, options: { avecCache?: boolean } = {}): App {
  const app = openApp({ dataDir: makeTempDir(t), console: false });
  t.after(() => app.close());

  app.db
    .prepare(
      "INSERT INTO commune (code_insee, nom, departement, created_at, updated_at) " +
        "VALUES (?, 'Bruz', '35', 't', 't')",
    )
    .run(INSEE);
  app.db
    .prepare(
      "INSERT INTO page (url_hash, campagne, url, domaine, code_insee, statut, fetched_at, profondeur) " +
        "VALUES (?, ?, ?, 'bruz.example', ?, 'visitee', 't', 1)",
    )
    .run(hashPage(CAMPAGNE, INSEE, URL), CAMPAGNE, URL, INSEE);

  if (options.avecCache !== false) {
    app.cache.set(
      URL,
      {
        finalUrl: URL,
        status: 200,
        etag: null,
        lastModified: null,
        contentType: "text/html; charset=utf-8",
        fetchedAt: T,
      },
      Buffer.from(PAGE, "utf8"),
    );
  }
  return app;
}

/** Un contact nomme par une version anterieure de l'heuristique. */
function contactAncien(app: App, valeur: string, nom: string, url = URL): void {
  app.db
    .prepare(
      "INSERT INTO contact (code_insee, kind, valeur, valeur_normalisee, is_generique, source_url, " +
        "methode_extraction, confiance, collected_at, nom_pressenti, nom_pressenti_normalise, " +
        "nom_pressenti_source, nom_pressenti_at, nom_pressenti_version) " +
        "VALUES (?, 'email', ?, ?, 1, ?, 'dom:mailto', 0.9, ?, ?, ?, 'bloc:avant', ?, 1)",
    )
    .run(INSEE, valeur, valeur, url, T, nom, nom.toLowerCase(), T);
}

test("le nom perime est refait depuis le cache, sans commande ni reseau", (t) => {
  const app = preparer(t);
  contactAncien(app, "tennis@asso.example", "Site internet");

  const resultat = reparerApresMiseAJour(app);

  assert.equal(resultat.versionAppliquee, VERSION_NOM);
  const ligne = app.db
    .prepare("SELECT nom_pressenti AS n, nom_pressenti_version AS v FROM contact")
    .get() as { n: string | null; v: number };
  assert.equal(ligne.n, "Tennis Club de Bruz", "la page dit mieux que l'ancienne heuristique");
  assert.equal(Number(ligne.v), VERSION_NOM);
});

test("sans cache, le nom qui ne passerait plus est efface plutot que garde", (t) => {
  // C'est le cas du poste dont le cache a ete purge : on ne peut plus relire la page,
  // mais « ce nom passerait-il aujourd'hui ? » ne demande que la chaine. Garder un
  // « Site internet » parce qu'on ne sait plus le recalculer serait le pire des deux.
  const app = preparer(t, { avecCache: false });
  contactAncien(app, "tennis@asso.example", "Site internet");
  contactAncien(app, "amicale@asso.example", "Amicale Laique de Bruz");

  const resultat = reparerApresMiseAJour(app);
  assert.equal(resultat.nomsInvalides, 1);

  const noms = (
    app.db.prepare("SELECT valeur AS v, nom_pressenti AS n FROM contact ORDER BY v").all() as unknown as {
      v: string;
      n: string | null;
    }[]
  ).map((l) => [l.v, l.n]);
  assert.deepEqual(noms, [
    ["amicale@asso.example", "Amicale Laique de Bruz"],
    ["tennis@asso.example", null],
  ]);
});

test("la reparation ne s'execute qu'une fois par version de l'heuristique", (t) => {
  const app = preparer(t);
  contactAncien(app, "tennis@asso.example", "Site internet");

  assert.equal(reparerApresMiseAJour(app).noms?.examines, 1);
  // Le marqueur est ce qui fait converger : une base dont le cache a disparu repasserait
  // sinon sur tous ses contacts a chaque commande.
  assert.equal(reparerApresMiseAJour(app).noms, undefined);

  const marqueur = app.db
    .prepare("SELECT valeur AS v FROM metric WHERE run_id IS NULL AND etape = 'reparation' AND nom = 'nom_pressenti_version'")
    .get() as { v: number };
  assert.equal(Number(marqueur.v), VERSION_NOM);
});

test("une base neuve n'a rien a reparer, et le dit en une requete", (t) => {
  const app = preparer(t);
  const resultat = reparerApresMiseAJour(app);
  assert.equal(resultat.noms?.examines, 0);
  assert.equal(resultat.nomsInvalides, 0);
});

/**
 * Lot 12 — les adresses qu'une version anterieure a ecrites soudees au mot suivant :
 * « …@cidff43.frhttps », en double de la vraie, et nommees d'apres leur domaine casse.
 */

function adresse(app: App, valeur: string, options: { corrigee?: string; revue?: string } = {}): void {
  app.db
    .prepare(
      "INSERT INTO contact (code_insee, kind, valeur, valeur_normalisee, is_generique, source_url, " +
        "methode_extraction, confiance, collected_at, valeur_corrigee, review_statut, score, score_version) " +
        "VALUES (?, 'email', ?, ?, 1, ?, 'texte:motif', 0.6, ?, ?, ?, 0.2, 1)",
    )
    .run(INSEE, valeur, valeur.toLowerCase(), URL, T, options.corrigee ?? null, options.revue ?? "a_revoir");
}

function valeurs(app: App): string[] {
  return (app.db.prepare("SELECT valeur_normalisee AS v FROM contact ORDER BY v").all() as { v: string }[]).map((l) => l.v);
}

test("une adresse collee est decollee en place, et son score sera recalcule", (t) => {
  const app = preparer(t);
  adresse(app, "club@asso.example.comhttps");
  adresse(app, "jeu@laposte.netJudo");

  assert.equal(reparerApresMiseAJour(app).adressesDecollees, 2);
  assert.deepEqual(valeurs(app), ["club@asso.example.com", "jeu@laposte.net"]);
  const score = app.db.prepare("SELECT count(*) AS n FROM contact WHERE score IS NOT NULL").get() as { n: number };
  assert.equal(Number(score.n), 0, "le score jugeait une adresse qui n'existait pas");
});

test("une adresse collee dont la jumelle existe se fond avec elle", (t) => {
  // La copie propre a ete lue dans le `mailto:` : elle garde sa provenance, la collee part.
  const app = preparer(t);
  adresse(app, "club@asso.example.com");
  adresse(app, "club@asso.example.comhttps", { revue: "valide" });

  reparerApresMiseAJour(app);
  assert.deepEqual(valeurs(app), ["club@asso.example.com"]);
  const statut = app.db.prepare("SELECT review_statut AS s FROM contact").get() as { s: string };
  assert.equal(statut.s, "valide", "la validation humaine de la copie collee n'est pas perdue");
});

test("INVARIANT §10 : une adresse collee dont la forme decollee est exclue est supprimee", (t) => {
  // Sans cette consultation, la reparation remettrait dans l'annuaire une personne qui
  // avait demande a en sortir.
  const app = preparer(t);
  app.db
    .prepare("INSERT INTO exclusion (portee, valeur, motif, origine, created_at) VALUES ('contact', ?, 'opposition', 'cli', ?)")
    .run("club@asso.example.com", T);
  adresse(app, "club@asso.example.comhttps");

  reparerApresMiseAJour(app);
  assert.deepEqual(valeurs(app), []);
});

test("INVARIANT §10 : une exclusion inscrite sous la forme collee vaut aussi pour la forme decollee", (t) => {
  const app = preparer(t);
  app.db
    .prepare("INSERT INTO exclusion (portee, valeur, motif, origine, created_at) VALUES ('contact', ?, 'opposition', 'cli', ?)")
    .run("club@asso.example.comhttps", T);

  reparerApresMiseAJour(app);
  const exclusions = (app.db.prepare("SELECT valeur AS v FROM exclusion ORDER BY v").all() as { v: string }[]).map((l) => l.v);
  assert.deepEqual(exclusions, ["club@asso.example.com", "club@asso.example.comhttps"]);
});

test("une correction humaine l'emporte sur le decollage", (t) => {
  const app = preparer(t);
  adresse(app, "club@asso.example.comhttps", { corrigee: "bureau@asso.example.com" });

  assert.equal(reparerApresMiseAJour(app).adressesDecollees, 0);
  assert.deepEqual(valeurs(app), ["club@asso.example.comhttps"]);
});

test("le decollage ne s'execute qu'une fois, et avant le rejeu des noms", (t) => {
  // Le rejeu retrouve chaque contact dans sa page par sa valeur : une valeur encore collee
  // n'y serait plus, et le contact resterait sans nom.
  const app = preparer(t);
  adresse(app, "tennis@asso.example.frhttps");
  app.cache.set(
    "https://bruz.example/associations",
    { finalUrl: URL, status: 200, etag: null, lastModified: null, contentType: "text/html; charset=utf-8", fetchedAt: T },
    Buffer.from(PAGE.replace("tennis@asso.example", "tennis@asso.example.fr"), "utf8"),
  );

  const premiere = reparerApresMiseAJour(app);
  assert.equal(premiere.adressesDecollees, 1);
  const nom = app.db.prepare("SELECT nom_pressenti AS n FROM contact").get() as { n: string | null };
  assert.equal(nom.n, "Tennis Club de Bruz");

  assert.equal(reparerApresMiseAJour(app).adressesDecollees, 0);
  const marqueur = app.db
    .prepare("SELECT valeur AS v FROM metric WHERE run_id IS NULL AND etape = 'reparation' AND nom = 'adresses_version'")
    .get() as { v: number };
  assert.equal(Number(marqueur.v), VERSION_ADRESSES);
});

test("sans cache, un nom de personne ecrit par une version anterieure est efface", (t) => {
  // Le quart des lignes livrees sur l'Ain et la Haute-Loire. Noms inventes.
  const app = preparer(t, { avecCache: false });
  contactAncien(app, "tennis@asso.example", "Annie DURANDEL");
  contactAncien(app, "amicale@asso.example", "Paul DURANDEL - 06 39 98 00 01Albert");

  assert.equal(reparerApresMiseAJour(app).nomsInvalides, 2);
  const noms = app.db.prepare("SELECT count(*) AS n FROM contact WHERE nom_pressenti IS NOT NULL").get() as { n: number };
  assert.equal(Number(noms.n), 0);
});
