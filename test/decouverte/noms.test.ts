import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { openDatabase } from "../../src/db/index.ts";
import { HttpCache } from "../../src/http/cache.ts";
import { systemClock } from "../../src/clock.ts";
import { hashPage } from "../../src/decouverte/contexte.ts";
import { remplirNoms } from "../../src/decouverte/noms.ts";
import { VERSION_NOM } from "../../src/decouverte/nom-pressenti.ts";
import { makeTempDir } from "../helpers/tmp.ts";
import type { TestContext } from "node:test";

/**
 * Le rattrapage du nom sur une base deja collectee (ADR-033, lot 3).
 *
 * Rien ne sort ici : les corps sont deposes directement dans le cache disque, et la passe
 * les relit. Le garde-fou global le prouve deja — ce fichier verifie ce qu'il ne peut pas
 * dire : que la passe converge, qu'elle n'insere rien, et qu'un cache froid n'est pas
 * traite comme un verdict.
 */

const CAMPAGNE = "2026-08-22";
const INSEE = "35047";
const T = "2026-08-22T00:00:00.000Z";

const PAGE_ASSOS = `<html><body><table>
  <tr><td>Tennis Club de Bruz</td><td>tennis@asso.example</td><td>02 99 00 11 22</td></tr>
  <tr><td>Amicale Laique de Bruz</td><td>amicale@asso.example</td></tr>
</table></body></html>`;

const PAGE_CONTACT = `<html><body><p>Contact : mairie@bruz.example</p></body></html>`;

type Corpus = { db: ReturnType<typeof openDatabase>; cache: HttpCache; cacheDir: string };

function preparer(t: TestContext, options: { avecCache?: boolean } = {}): Corpus {
  const racine = makeTempDir(t);
  const cacheDir = join(racine, "cache");
  const cache = new HttpCache(cacheDir);
  const db = openDatabase(join(racine, "noms.sqlite"));
  t.after(() => db.close());

  db.prepare(
    "INSERT INTO commune (code_insee, nom, departement, created_at, updated_at) " +
      "VALUES (?, 'Bruz', '35', 't', 't')",
  ).run(INSEE);

  const insererPage = db.prepare(
    "INSERT INTO page (url_hash, campagne, url, domaine, code_insee, statut, fetched_at, profondeur) " +
      "VALUES (?, ?, ?, 'bruz.example', ?, 'visitee', 't', 1)",
  );
  const insererContact = db.prepare(
    "INSERT INTO contact (association_id, code_insee, kind, valeur, valeur_normalisee, is_generique, " +
      "source_url, methode_extraction, confiance, collected_at) " +
      "VALUES (NULL, ?, ?, ?, ?, ?, ?, 'texte:motif', 0.6, ?)",
  );

  for (const [url, corps] of [
    ["https://bruz.example/associations", PAGE_ASSOS],
    ["https://bruz.example/contact", PAGE_CONTACT],
  ] as const) {
    insererPage.run(hashPage(CAMPAGNE, INSEE, url), CAMPAGNE, url, INSEE);
    if (options.avecCache !== false) {
      cache.set(
        url,
        {
          finalUrl: url,
          status: 200,
          etag: null,
          lastModified: null,
          contentType: "text/html; charset=utf-8",
          fetchedAt: T,
        },
        Buffer.from(corps, "utf8"),
      );
    }
  }

  const assos = "https://bruz.example/associations";
  insererContact.run(INSEE, "email", "tennis@asso.example", "tennis@asso.example", 1, assos, T);
  insererContact.run(INSEE, "phone", "02 99 00 11 22", "+33299001122", null, assos, T);
  insererContact.run(INSEE, "email", "amicale@asso.example", "amicale@asso.example", 1, assos, T);
  insererContact.run(INSEE, "email", "mairie@bruz.example", "mairie@bruz.example", 1, "https://bruz.example/contact", T);

  return { db, cache, cacheDir };
}

function noms(db: ReturnType<typeof openDatabase>): Record<string, string | null> {
  const lignes = db
    .prepare("SELECT valeur_normalisee AS v, nom_pressenti AS n FROM contact ORDER BY v")
    .all() as unknown as { v: string; n: string | null }[];
  return Object.fromEntries(lignes.map((ligne) => [ligne.v, ligne.n]));
}

test("les contacts orphelins recoivent le nom lu dans le bloc de leur page", (t) => {
  const { db, cache } = preparer(t);
  const resultat = remplirNoms(db, cache, systemClock, { departement: "35" });

  assert.equal(resultat.examines, 4);
  assert.equal(resultat.nommes, 3);
  // « Contact : » est du mobilier de page, pas un nom de structure.
  assert.equal(resultat.sansNom, 1);
  assert.equal(resultat.sansCache, 0);

  const trouves = noms(db);
  assert.equal(trouves["tennis@asso.example"], "Tennis Club de Bruz");
  assert.equal(trouves["amicale@asso.example"], "Amicale Laique de Bruz");
  // Le telephone de la meme ligne recoit le meme nom : c'est ce qui reunira les deux sur
  // une seule ligne du profil simple.
  assert.equal(trouves["+33299001122"], "Tennis Club de Bruz");
  assert.equal(trouves["mairie@bruz.example"], null);
});

test("un second passage ne change rien : la passe converge", (t) => {
  const { db, cache } = preparer(t);
  remplirNoms(db, cache, systemClock, { departement: "35" });
  const avant = noms(db);

  const second = remplirNoms(db, cache, systemClock, { departement: "35" });
  assert.equal(second.examines, 0, "tout a deja ete regarde");
  assert.equal(second.nommes, 0);
  // Le contact que rien n'a su nommer est compte « a jour », et non reexamine : c'est ce
  // qui empeche le balayage sans fin, et la seule preuve qu'il converge.
  assert.equal(second.aJour, 1);
  assert.deepEqual(noms(db), avant);
});

test("--tout reexamine tout, noms deja ecrits compris", (t) => {
  const { db, cache } = preparer(t);
  remplirNoms(db, cache, systemClock, { departement: "35" });

  const rejoue = remplirNoms(db, cache, systemClock, { departement: "35", tout: true });
  // Les quatre repassent, pas seulement celui que rien n'avait nomme. C'est le correctif
  // du defaut trouve sur le departement 88 : avec un filtre sur `nom_pressenti IS NULL`,
  // une correction de l'heuristique n'atteignait jamais les contacts deja nommes, et un
  // departement livre gardait ses rebuts jusqu'a une recollecte complete.
  assert.equal(rejoue.examines, 4);
  assert.equal(rejoue.nommes, 3);
  assert.equal(rejoue.sansNom, 1);
});

test("un changement de VERSION_NOM suffit a faire reviser les noms", (t) => {
  const { db, cache } = preparer(t);
  remplirNoms(db, cache, systemClock, { departement: "35" });

  // C'est tout l'objet de la colonne : elle repond a « quels noms sont perimes ». On
  // simule ici la version precedente, sans `--tout`.
  db.prepare("UPDATE contact SET nom_pressenti_version = 1").run();
  const revise = remplirNoms(db, cache, systemClock, { departement: "35" });
  assert.equal(revise.examines, 4, "un nom perime se refait, meme s'il est deja ecrit");
  assert.equal(revise.aJour, 0);
});

test("un corps absent du cache n'est pas un verdict : la ligne repassera", (t) => {
  const { db, cache } = preparer(t, { avecCache: false });
  const resultat = remplirNoms(db, cache, systemClock, { departement: "35" });

  assert.equal(resultat.sansCache, 4);
  assert.equal(resultat.nommes, 0);

  const versions = db
    .prepare("SELECT count(*) AS n FROM contact WHERE nom_pressenti_version IS NOT NULL")
    .get() as { n: number };
  // Aucune version ecrite : un cache froid veut dire « on n'a pas pu regarder », pas
  // « on a regarde et il n'y a rien ». Marquer ici condamnerait ces contacts.
  assert.equal(versions.n, 0);
});

test("la passe n'insere jamais un contact", (t) => {
  const { db, cache } = preparer(t);
  const avant = (db.prepare("SELECT count(*) AS n FROM contact").get() as { n: number }).n;

  remplirNoms(db, cache, systemClock, { departement: "35" });

  const apres = (db.prepare("SELECT count(*) AS n FROM contact").get() as { n: number }).n;
  // Elle lit les pages avec `avecMobiles: true`, ce qui est delibere — on nomme des
  // lignes deja en base. Si elle inserait, ce serait une porte derobee a l'invariant 6.
  assert.equal(apres, avant);
});

test("une URL revisitee a deux campagnes ne fait pas travailler deux fois", (t) => {
  const { db, cache } = preparer(t);
  // La meme page, revue a une campagne plus recente. Sans la sous-requete `max(campagne)`
  // de `SQL_A_NOMMER`, chaque contact serait rendu deux fois par la jointure.
  db.prepare(
    "INSERT INTO page (url_hash, campagne, url, domaine, code_insee, statut, fetched_at, profondeur) " +
      "VALUES (?, '2026-09-01', 'https://bruz.example/associations', 'bruz.example', ?, 'visitee', 't', 1)",
  ).run(hashPage("2026-09-01", INSEE, "https://bruz.example/associations"), INSEE);

  const resultat = remplirNoms(db, cache, systemClock, { departement: "35" });
  assert.equal(resultat.examines, 4, "quatre contacts, quel que soit le nombre de campagnes");
});

test("un contact rattache n'est pas candidat : il a deja son nom", (t) => {
  const { db, cache } = preparer(t);
  db.prepare(
    "INSERT INTO association (id, rna_id, code_insee, nom, nom_normalise, source_creation, created_at, updated_at) " +
      "VALUES (1, 'W351', ?, 'Tennis club bruzois', 'tennis club bruzois', 'rna', 't', 't')",
  ).run(INSEE);
  db.prepare("UPDATE contact SET association_id = 1 WHERE valeur_normalisee = 'tennis@asso.example'").run();

  const resultat = remplirNoms(db, cache, systemClock, { departement: "35" });
  assert.equal(resultat.examines, 3);
  assert.equal(noms(db)["tennis@asso.example"], null, "le RNA le nomme deja, la cascade s'arrete avant");
});

test("la version accompagne toujours le nom, trouve ou non", (t) => {
  const { db, cache } = preparer(t);
  remplirNoms(db, cache, systemClock, { departement: "35" });

  const incoherents = db
    .prepare(
      "SELECT count(*) AS n FROM contact WHERE nom_pressenti IS NOT NULL AND nom_pressenti_version IS NULL",
    )
    .get() as { n: number };
  assert.equal(incoherents.n, 0, "une version qui manque expliquerait un nom qu'on ne sait plus dater");
  assert.equal(
    (db.prepare("SELECT count(*) AS n FROM contact WHERE nom_pressenti_version = ?").get(VERSION_NOM) as {
      n: number;
    }).n,
    4,
  );
});
