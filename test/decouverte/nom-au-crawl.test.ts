import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { openDatabase } from "../../src/db/index.ts";
import { SQL_COMBLER_NOM, sqlContact } from "../../src/decouverte/crawl.ts";
import { VERSION_NOM } from "../../src/decouverte/nom-pressenti.ts";
import { makeTempDir } from "../helpers/tmp.ts";
import type { TestContext } from "node:test";

/**
 * La regle du nom a l'ecriture : **un nom connu ne s'efface jamais, un nom absent se
 * comble.**
 *
 * Les deux moities se testent ici directement, sur le SQL. La raison est de proportion :
 * reproduire « une seconde vue moins sure du meme contact » par un crawl complet
 * demanderait un second site de fixtures entier pour verifier deux lignes de requete.
 */

const NOW = "2026-09-01T10:00:00.000Z";
const INSEE = "35047";

type Vue = { confiance: number; nom: string | null };

function base(t: TestContext): ReturnType<typeof openDatabase> {
  const db = openDatabase(join(makeTempDir(t), "test.sqlite"));
  t.after(() => db.close());
  db.prepare(
    "INSERT INTO commune (code_insee, nom, departement, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(INSEE, "Bruz", "35", NOW, NOW);
  return db;
}

/** Une ecriture de contact orphelin, telle que `ecrireContacts` la produit. */
function ecrire(db: ReturnType<typeof openDatabase>, vue: Vue): number {
  return Number(
    db
      .prepare(sqlContact(false))
      .run(
        null,
        INSEE,
        "email",
        "contact@club.example",
        "contact@club.example",
        1,
        "https://bruz.example/a",
        "dom:mailto",
        vue.confiance,
        NOW,
        vue.nom,
        vue.nom === null ? null : vue.nom.toLowerCase(),
        vue.nom === null ? null : "bloc:avant",
        vue.nom === null ? null : NOW,
        vue.nom === null ? null : VERSION_NOM,
      ).changes,
  );
}

function nomEnBase(db: ReturnType<typeof openDatabase>): {
  nom_pressenti: string | null;
  nom_pressenti_version: number | null;
} {
  return db
    .prepare("SELECT nom_pressenti, nom_pressenti_version FROM contact WHERE valeur_normalisee = ?")
    .get("contact@club.example") as { nom_pressenti: string | null; nom_pressenti_version: number | null };
}

test("le nom est ecrit des l'insertion, avec sa methode et sa version", (t) => {
  const db = base(t);
  ecrire(db, { confiance: 0.6, nom: "Club de Bruz" });

  const ligne = db
    .prepare(
      "SELECT nom_pressenti, nom_pressenti_normalise, nom_pressenti_source, " +
        "nom_pressenti_at, nom_pressenti_version FROM contact",
    )
    .get() as Record<string, unknown>;

  // Les cinq colonnes bougent ensemble : une version qui expliquerait un nom absent, ou
  // un nom sans version, ne se relit pas.
  assert.equal(ligne["nom_pressenti"], "Club de Bruz");
  assert.equal(ligne["nom_pressenti_normalise"], "club de bruz");
  assert.equal(ligne["nom_pressenti_source"], "bloc:avant");
  assert.equal(ligne["nom_pressenti_at"], NOW);
  assert.equal(ligne["nom_pressenti_version"], VERSION_NOM);
});

test("une vue moins sure n'ecrase rien, le nom compris", (t) => {
  const db = base(t);
  ecrire(db, { confiance: 0.9, nom: "Club de Bruz" });
  const changes = ecrire(db, { confiance: 0.6, nom: "Actualites" });

  assert.equal(changes, 0, "le garde-fou de confiance existe depuis le lot 3");
  assert.equal(nomEnBase(db).nom_pressenti, "Club de Bruz");
});

test("une vue plus sure mais sans nom n'efface pas le nom deja trouve", (t) => {
  const db = base(t);
  ecrire(db, { confiance: 0.6, nom: "Club de Bruz" });
  const changes = ecrire(db, { confiance: 0.9, nom: null });

  // Sans le `CASE` du `SET`, la valeur et la provenance se mettraient a jour — ce qui est
  // voulu — en emportant au passage un nom que plus rien ne retrouverait.
  assert.equal(changes, 1, "la valeur, elle, doit bien etre mise a jour");
  assert.equal(nomEnBase(db).nom_pressenti, "Club de Bruz");
  assert.equal(nomEnBase(db).nom_pressenti_version, VERSION_NOM);
});

test("une vue plus sure qui apporte un meilleur nom l'emporte", (t) => {
  const db = base(t);
  ecrire(db, { confiance: 0.6, nom: "Actualites" });
  ecrire(db, { confiance: 0.9, nom: "Club de Bruz" });

  assert.equal(nomEnBase(db).nom_pressenti, "Club de Bruz");
});

test("une vue moins sure comble un nom absent, alors qu'elle n'ecrit rien d'autre", (t) => {
  const db = base(t);
  ecrire(db, { confiance: 0.9, nom: null });
  const changes = ecrire(db, { confiance: 0.6, nom: "Club de Bruz" });
  assert.equal(changes, 0, "l'insertion elle-meme est bien refusee");

  // C'est `SQL_COMBLER_NOM` qui rattrape ce cas, faute de quoi un contact resterait
  // anonyme alors que la page le nommait.
  const comble = Number(
    db
      .prepare(SQL_COMBLER_NOM)
      .run("Club de Bruz", "club de bruz", "bloc:avant", NOW, VERSION_NOM, INSEE, "email", "contact@club.example")
      .changes,
  );
  assert.equal(comble, 1);
  assert.equal(nomEnBase(db).nom_pressenti, "Club de Bruz");
});

test("combler n'ecrase jamais un nom deja la", (t) => {
  const db = base(t);
  ecrire(db, { confiance: 0.9, nom: "Club de Bruz" });

  const comble = Number(
    db
      .prepare(SQL_COMBLER_NOM)
      .run("Actualites", "actualites", "bloc:apres", NOW, VERSION_NOM, INSEE, "email", "contact@club.example")
      .changes,
  );
  // La clause `nom_pressenti IS NULL` est ce qui empeche cette requete de devenir une
  // seconde porte d'ecrasement, contournant la garde de confiance.
  assert.equal(comble, 0);
  assert.equal(nomEnBase(db).nom_pressenti, "Club de Bruz");
});
