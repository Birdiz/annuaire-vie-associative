import { test } from "node:test";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";

import { openDatabase } from "../../src/db/index.ts";
import { Counters } from "../../src/metrics/counters.ts";
import { HttpCache } from "../../src/http/cache.ts";
import { DomainThrottle } from "../../src/http/throttle.ts";
import type { LookupFn } from "../../src/http/throttle.ts";
import { HttpClient, buildUserAgent } from "../../src/http/client.ts";
import { JobQueue } from "../../src/jobs/queue.ts";
import { Worker } from "../../src/jobs/worker.ts";
import { Logger } from "../../src/log.ts";
import { fixedClock } from "../../src/clock.ts";
import { creerHandlersDecouverte } from "../../src/decouverte/index.ts";
import { cleDecouverte } from "../../src/decouverte/contexte.ts";
import type { ContexteDecouverte } from "../../src/decouverte/contexte.ts";
import { VERSION_PREFILTRE } from "../../src/decouverte/prefiltre.ts";
import { derniereCampagne, distributionPrefiltre, rejouerPrefiltre } from "../../src/decouverte/rejeu.ts";
import { normaliserNom } from "../../src/texte.ts";
import { startServer, text } from "../helpers/server.ts";
import type { Handler } from "../helpers/server.ts";
import { makeTempDir } from "../helpers/tmp.ts";

/**
 * Le rejeu de l'etape [4] relit les corps dans le cache disque : il ne doit emettre
 * aucune requete. La garde `test/helpers/pas-de-reseau.ts`, prechargee par `npm test`,
 * en fait la preuve — une sortie vers un hote quelconque ferait echouer ce fichier.
 */

const lookupLocal: LookupFn = async () => ({ address: "127.0.0.1", family: 4 });
const T0 = Date.parse("2026-08-18T10:00:00.000Z");
const CAMPAGNE = "2026-08-18";

const ASSOCIATIONS: readonly string[] = [
  "Club de Bruz",
  "Amicale laique de Bruz",
  "Tennis club bruzois",
];

const ACCUEIL = `<html><head><title>Mairie de Bruz</title></head><body>
<nav><a href="/vie-associative">Vie associative</a><a href="/actualites">Actualites</a></nav>
<p>La mairie accueille le public du lundi au vendredi, et repond aux demandes courantes
des habitants tout au long de l'annee.</p>
<p>Nous ecrire : <a href="mailto:contact@bruz.example">contact@bruz.example</a></p>
</body></html>`;

const VIE_ASSOCIATIVE = `<html><head><title>Vie associative</title></head><body>
<p>Les associations de la commune se retrouvent chaque annee au forum de rentree.</p>
<table>
  <tr><td>Club de Bruz</td><td><a href="mailto:club@asso.example">ecrire</a></td></tr>
  <tr><td>Amicale laique de Bruz</td><td><a href="mailto:amicale@asso.example">ecrire</a></td></tr>
  <tr><td>Tennis club bruzois</td><td>marie.dupont@tennis.example</td></tr>
</table>
</body></html>`;

function html(corps: string): Handler {
  return text(corps, 200, { "content-type": "text/html; charset=utf-8" });
}

type Montage = {
  db: ReturnType<typeof openDatabase>;
  cache: HttpCache;
  clock: ReturnType<typeof fixedClock>;
};

async function crawler(t: TestContext): Promise<Montage> {
  const server = await startServer(t, {
    "/robots.txt": text("User-agent: *\nDisallow:\n"),
    "/": html(ACCUEIL),
    "/vie-associative": html(VIE_ASSOCIATIVE),
    "/actualites": html("<html><body>Conseil municipal</body></html>"),
  });

  const db = openDatabase(":memory:");
  t.after(() => db.close());

  const clock = fixedClock(T0);
  const counters = new Counters(db);
  const cache = new HttpCache(makeTempDir(t));
  const client = new HttpClient({
    cache,
    throttle: new DomainThrottle({ minDelayMs: 1, lookup: lookupLocal }),
    counters,
    userAgent: buildUserAgent("0.1.0", "https://exemple.example/contact"),
    cacheTtlMs: 3_600_000,
    clock,
  });
  const queue = new JobQueue(db, clock, counters);

  db.prepare(
    `INSERT INTO commune (code_insee, nom, departement, url_mairie, statut_resolution,
       resolution_source_url, resolution_collected_at, source_resolution, resolution_confiance,
       created_at, updated_at)
     VALUES ('35047', 'Bruz', '35', ?, 'resolue', ?, ?, 'annuaire', 0.9, ?, ?)`,
  ).run(`${server.origin}/`, "https://exemple.example/dump", "2026-08-18T00:00:00.000Z", "t", "t");

  const inserer = db.prepare(
    `INSERT INTO association (rna_id, code_insee, nom, nom_normalise, source_creation, created_at, updated_at)
     VALUES (?, '35047', ?, ?, 'rna', 't', 't')`,
  );
  ASSOCIATIONS.forEach((nom, i) => inserer.run(`W3510000${i}`, nom, normaliserNom(nom)));

  const ctx: ContexteDecouverte = {
    db,
    client,
    counters,
    clock,
    logger: new Logger({ console: false }),
    queue,
    runId: null,
  };

  queue.enqueue("decouverte_planifiee", cleDecouverte("35", CAMPAGNE), {
    departement: "35",
    campagne: CAMPAGNE,
    maxPages: 10,
    avecMobiles: false,
  });
  const stats = await new Worker(queue, creerHandlersDecouverte(ctx), { concurrency: 2 }).run();
  assert.equal(stats.failed, 0, "aucun job ne doit echouer");

  return { db, cache, clock };
}

type Verdict = {
  url: string;
  prefiltre_score: number | null;
  prefiltre_verdict: string | null;
  prefiltre_motif: string | null;
  prefiltre_version: number | null;
  contacts_extraits: number | null;
};

function verdicts(db: ReturnType<typeof openDatabase>): Verdict[] {
  return db
    .prepare(
      "SELECT url, prefiltre_score, prefiltre_verdict, prefiltre_motif, prefiltre_version, " +
        "contacts_extraits FROM page WHERE statut = 'visitee' ORDER BY url",
    )
    .all() as unknown as Verdict[];
}

test("le crawl juge chaque page visitee, et rien d'autre", async (t) => {
  const { db } = await crawler(t);

  const juges = verdicts(db);
  assert.ok(juges.length >= 2, "au moins l'accueil et la rubrique associative");
  for (const page of juges) {
    assert.ok(page.prefiltre_verdict !== null, `${page.url} n'a pas de verdict`);
    assert.equal(page.prefiltre_version, VERSION_PREFILTRE);
    assert.ok(page.contacts_extraits !== null, "le portillon [6] a besoin de ce compte");
  }

  // Une page bloquee, absente ou hors type n'est pas soumise au filtre : lui donner un
  // verdict la ferait entrer dans un denominateur qu'elle n'a jamais traverse.
  const nonVisitees = db
    .prepare("SELECT count(*) AS n FROM page WHERE statut <> 'visitee' AND prefiltre_verdict IS NOT NULL")
    .get() as { n: number };
  assert.equal(Number(nonVisitees.n), 0);
});

test("le verdict est consultatif : une page ecartee livre quand meme ses contacts", async (t) => {
  const { db } = await crawler(t);

  // L'accueil ne nomme aucune association et ne porte qu'un seul contact : le filtre
  // l'ecarte, c'est-a-dire qu'il ne vaut pas une inference. Il livre pourtant son
  // mailto, parce que l'extraction [5] est bon marche et deja faite. L'etape [4] ne
  // gouverne que le cout de l'etape [6] ; elle n'a aucun droit de regard sur l'acquis.
  const accueil = db
    .prepare("SELECT url, prefiltre_verdict FROM page WHERE profondeur = 0")
    .get() as { url: string; prefiltre_verdict: string };
  assert.equal(accueil.prefiltre_verdict, "ecartee");

  const contacts = db
    .prepare("SELECT valeur_normalisee FROM contact WHERE source_url = ?")
    .all(accueil.url) as unknown as { valeur_normalisee: string }[];
  assert.deepEqual(
    contacts.map((contact) => contact.valeur_normalisee),
    ["contact@bruz.example"],
    "une page ecartee garde tout ce que le DOM avait deja rendu",
  );
});

test("le rejeu depuis le cache redit exactement ce que le crawl avait dit", async (t) => {
  const { db, cache, clock } = await crawler(t);
  const avant = verdicts(db);

  const resultat = rejouerPrefiltre(db, cache, clock, {
    departement: "35",
    campagne: CAMPAGNE,
    tout: true,
  });

  assert.equal(resultat.evaluees, avant.length);
  assert.equal(resultat.sansCache, 0, "les corps viennent d'etre mis en cache par le crawl");
  assert.deepEqual(verdicts(db), avant, "le rejeu est un recalcul, pas une reinterpretation");
});

test("un rejeu deja a jour ne recalcule rien, et un second passage ne change rien", async (t) => {
  const { db, cache, clock } = await crawler(t);
  const avant = verdicts(db);

  const premier = rejouerPrefiltre(db, cache, clock, { departement: "35", campagne: CAMPAGNE });
  assert.equal(premier.evaluees, 0, "le crawl vient de les juger avec la version courante");
  assert.equal(premier.aJour, avant.length);

  const second = rejouerPrefiltre(db, cache, clock, { departement: "35", campagne: CAMPAGNE, tout: true });
  assert.equal(second.evaluees, avant.length);
  assert.deepEqual(verdicts(db), avant, "rejouer est idempotent : c'est ce qui rend une reprise sure");
});

test("regler le seuil deplace la frontiere sans retoucher au corpus", async (t) => {
  const { db, cache, clock } = await crawler(t);

  rejouerPrefiltre(db, cache, clock, { departement: "35", campagne: CAMPAGNE, seuil: 999, tout: true });
  const strict = distributionPrefiltre(db, "35", CAMPAGNE);
  assert.equal(strict.retenues, 0);
  assert.equal(strict.ecartees, strict.jugees);

  rejouerPrefiltre(db, cache, clock, { departement: "35", campagne: CAMPAGNE, seuil: 0, tout: true });
  const large = distributionPrefiltre(db, "35", CAMPAGNE);
  assert.equal(large.ecartees, 0);
  assert.equal(large.retenues, large.jugees);
  assert.equal(large.jugees, strict.jugees, "le nombre de pages jugees ne depend pas du seuil");
});

test("la derniere campagne est celle sur laquelle on regle par defaut", async (t) => {
  const { db } = await crawler(t);
  assert.equal(derniereCampagne(db, "35"), CAMPAGNE);
  assert.equal(derniereCampagne(db, "22"), undefined, "un departement sans page n'a pas de campagne");
});
