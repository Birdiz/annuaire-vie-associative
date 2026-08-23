import { test } from "node:test";
import assert from "node:assert/strict";

import { openDatabase } from "../../src/db/index.ts";
import { systemClock } from "../../src/clock.ts";
import { ResolveurMx } from "../../src/http/dns.ts";
import { normaliser } from "../../src/normalisation/rejeu.ts";
import { mesurerCouverture } from "../../src/metrics/couverture.ts";
import { DEPARTEMENT, preparerCorpus } from "../helpers/corpus.ts";
import type { Database } from "../../src/db/index.ts";
import type { TestContext } from "node:test";

/**
 * Premiere metrique du §8. Ce qui est defendu ici : les trois numerateurs ne disent pas
 * la meme chose, et les confondre ferait passer une adresse morte pour une association
 * joignable.
 */

async function corpus(t: TestContext, mx: (domaine: string) => boolean): Promise<Database> {
  const { dbFile } = preparerCorpus(t);
  const db = openDatabase(dbFile);
  t.after(() => db.close());

  const resolveur = new ResolveurMx({
    resolve: async (domaine) => {
      if (!mx(domaine)) throw Object.assign(new Error("aucun MX"), { code: "ENODATA" });
      return [{ exchange: `mx.${domaine}`, priority: 10 }];
    },
  });
  await normaliser(db, systemClock, resolveur, { departement: DEPARTEMENT });
  return db;
}

test("les trois numerateurs se distinguent, et le denominateur reste les actives", async (t) => {
  const db = await corpus(t, () => true);
  const mesure = mesurerCouverture(db, DEPARTEMENT);

  assert.equal(mesure.actives, 4, "les quatre associations du corpus sont actives");
  // Deux associations portent un email : le tennis et le theatre. Le comite des fetes
  // n'a qu'un telephone, la quatrieme n'a rien.
  assert.equal(mesure.avecEmail, 2);
  assert.equal(mesure.avecEmailExploitable, 2);
  assert.equal(mesure.avecEmailJoignable, 2);
});

test("un domaine sans MX sort du numerateur le plus strict, pas des autres", async (t) => {
  const db = await corpus(t, (domaine) => domaine !== "theatre-landes.example");
  const mesure = mesurerCouverture(db, DEPARTEMENT);

  assert.equal(mesure.avecEmail, 2);
  assert.equal(mesure.avecEmailExploitable, 2, "l'adresse a bien la forme d'une adresse");
  assert.equal(mesure.avecEmailJoignable, 1, "mais ce domaine ne recoit pas de courrier");
});

test("une adresse cassee ne compte pas comme une couverture", async (t) => {
  const db = await corpus(t, () => true);

  // La forme que l'ADR-017 a trouvee : un CMS remplace l'arobase par un litteral. Le
  // motif permissif de l'etape [5] l'acceptait, et 138 contacts comptaient ainsi dans la
  // couverture du departement.
  db.prepare("UPDATE contact SET valeur_normalisee = ? WHERE valeur_normalisee = ?").run(
    "club[at]tennis-bruzou.example",
    "contact@tennis-bruzou.example",
  );
  await normaliser(
    db,
    systemClock,
    new ResolveurMx({ resolve: async () => [{ exchange: "mx", priority: 10 }] }),
    { departement: DEPARTEMENT, tout: true },
  );

  const mesure = mesurerCouverture(db, DEPARTEMENT);
  assert.equal(mesure.avecEmail, 2, "la ligne existe toujours, et sa trace vaut quelque chose");
  assert.equal(mesure.avecEmailExploitable, 1, "mais elle ne joint personne");
});

test("un contact rejete en revue ne compte plus", async (t) => {
  const db = await corpus(t, () => true);
  db.prepare("UPDATE contact SET review_statut = 'rejete' WHERE valeur LIKE '%theatre-landes%'").run();

  const mesure = mesurerCouverture(db, DEPARTEMENT);
  assert.equal(mesure.avecEmail, 1, "un arbitrage humain doit se voir dans la mesure");
});

test("un rejet en revue fait bouger le meme chiffre partout", async (t) => {
  // La CLI recalculait son propre taux, sans le filtre sur les contacts rejetes : des
  // qu'un humain arbitrait, `annuaire run` et l'ecran de synthese annoncaient deux
  // valeurs differentes pour la meme base — sur la metrique que le §8 designe comme
  // celle qui fera le README.
  const db = await corpus(t, () => true);
  const avant = mesurerCouverture(db, DEPARTEMENT);
  assert.ok(avant.avecEmail > 0, "le corpus doit partir d'une couverture non nulle");

  db.prepare("UPDATE contact SET review_statut = 'rejete' WHERE kind = 'email'").run();
  const apres = mesurerCouverture(db, DEPARTEMENT);

  assert.equal(apres.avecEmail, 0, "un contact rejete ne couvre plus rien");
  assert.equal(apres.avecEmailJoignable, 0);
});

test("le numerateur qualifie suit la borne de dormance", async (t) => {
  const db = await corpus(t, () => true);
  const sansBorne = mesurerCouverture(db, DEPARTEMENT);
  assert.equal(sansBorne.avecEmailNonDormantes, undefined, "sans borne, pas de taux qualifie");

  // Sans date de declaration, une association ne peut pas etre dite non dormante :
  // c'est le comportement de l'ADR-013, et il vaut aussi bien ici que dans la CLI.
  assert.equal(mesurerCouverture(db, DEPARTEMENT, "1900-01-01").avecEmailNonDormantes, 0);

  db.prepare("UPDATE association SET date_declaration = '2025-06-01'").run();
  const large = mesurerCouverture(db, DEPARTEMENT, "1900-01-01");
  assert.equal(large.avecEmailNonDormantes, large.avecEmail, "une borne ancienne ne retire personne");

  const stricte = mesurerCouverture(db, DEPARTEMENT, "2999-01-01");
  assert.equal(stricte.avecEmailNonDormantes, 0, "une borne future ne laisse personne");
});
