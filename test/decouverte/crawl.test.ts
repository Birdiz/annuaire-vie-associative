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
import { startServer, robotsAllowAll, text } from "../helpers/server.ts";
import type { Handler, TestServer } from "../helpers/server.ts";
import { makeTempDir } from "../helpers/tmp.ts";

const lookupLocal: LookupFn = async () => ({ address: "127.0.0.1", family: 4 });
const T0 = Date.parse("2026-08-18T10:00:00.000Z");
const CAMPAGNE = "2026-08-18";

/**
 * Faux site de mairie, ecrit a la main : aucune page reelle n'entre dans le depot.
 *
 * Chaque contact n'apparait que sur une seule page. C'est ce qui rend les compteurs
 * comparables au contenu de la base, et donc le test de reprise capable de detecter
 * un effet rejoue.
 */
const ACCUEIL = `<html><head><title>Mairie de Bruz</title></head><body>
<nav>
  <a href="/vie-associative">Vie associative</a>
  <a href="/actualites">Actualites municipales</a>
  <a href="/marches-publics">Marches publics</a>
  <a href="/plaquette.pdf">Plaquette</a>
  <a href="https://www.facebook.com/bruz">Notre page Facebook</a>
</nav>
<p>Mairie : <a href="mailto:contact@bruz.example">contact@bruz.example</a></p>
</body></html>`;

const VIE_ASSOCIATIVE = `<html><head><title>Vie associative</title></head><body>
<table>
  <tr><td>Club de Bruz</td><td><a href="mailto:club@asso.example">ecrire</a></td><td>02 99 00 11 22</td></tr>
  <tr><td>Amicale laique de Bruz</td><td>amicale [at] asso [dot] example</td><td>06 12 34 56 78</td></tr>
  <tr><td>Tennis club bruzois</td><td>marie.dupont@tennis.example</td><td>02 99 00 11 33</td></tr>
</table>
<a href="/annuaire-des-associations">Annuaire complet des associations</a>
</body></html>`;

const ANNUAIRE = `<html><body><ul>
  <li>Comite des fetes de Bruz &mdash; <a href="mailto:fetes@asso.example">fetes@asso.example</a></li>
</ul></body></html>`;

/** Les associations que le lot 2 aurait deposees pour cette commune. */
const ASSOCIATIONS: readonly string[] = [
  "Club de Bruz",
  "Amicale laique de Bruz",
  "Tennis club bruzois",
  "Comite des fetes de Bruz",
];

/** Le helper partage sert du text/plain, que le crawl refuse a raison. */
function html(corps: string): Handler {
  return text(corps, 200, { "content-type": "text/html; charset=utf-8" });
}

function routes(): Record<string, Handler> {
  return {
    "/robots.txt": text("User-agent: *\nDisallow: /prive\n"),
    "/": html(ACCUEIL),
    "/vie-associative": html(VIE_ASSOCIATIVE),
    "/annuaire-des-associations": html(ANNUAIRE),
    "/actualites": html("<html><body>Rien ici</body></html>"),
    "/marches-publics": html("<html><body>Rien ici</body></html>"),
    "/plaquette.pdf": text("%PDF-1.4", 200, { "content-type": "application/pdf" }),
    "/prive": html("<html><body>interdit</body></html>"),
  };
}

type Montage = {
  ctx: ContexteDecouverte;
  db: ReturnType<typeof openDatabase>;
  server: TestServer;
  counters: Counters;
  lancer: (options?: { maxPages?: number; avecMobiles?: boolean }) => Promise<void>;
};

async function setup(
  t: TestContext,
  options: { routes?: Record<string, Handler>; urlMairie?: (origin: string) => string } = {},
): Promise<Montage> {
  const server = await startServer(t, options.routes ?? routes());
  const db = openDatabase(":memory:");
  t.after(() => db.close());

  const clock = fixedClock(T0);
  const counters = new Counters(db);
  const client = new HttpClient({
    cache: new HttpCache(makeTempDir(t)),
    // Le plancher reel de 2 s est couvert par test/http/throttle.test.ts ; l'imposer
    // ici rendrait chaque test du crawl aussi long qu'un run complet.
    throttle: new DomainThrottle({ minDelayMs: 1, lookup: lookupLocal }),
    counters,
    userAgent: buildUserAgent("0.1.0", "https://exemple.fr/contact"),
    cacheTtlMs: 3_600_000,
    clock,
  });
  const queue = new JobQueue(db, clock, counters);

  db.prepare(
    `INSERT INTO commune (code_insee, nom, departement, url_mairie, statut_resolution,
       resolution_source_url, resolution_collected_at, created_at, updated_at)
     VALUES ('35047', 'Bruz', '35', ?, 'resolue', ?, ?, ?, ?)`,
  ).run(
    (options.urlMairie ?? ((origin: string) => `${origin}/`))(server.origin),
    "https://exemple.fr/dump",
    "2026-08-18T00:00:00.000Z",
    "2026-08-18T00:00:00.000Z",
    "2026-08-18T00:00:00.000Z",
  );

  const inserer = db.prepare(
    `INSERT INTO association (rna_id, code_insee, nom, nom_normalise, source_creation, created_at, updated_at)
     VALUES (?, '35047', ?, ?, 'rna', '2026-08-18T00:00:00.000Z', '2026-08-18T00:00:00.000Z')`,
  );
  ASSOCIATIONS.forEach((nom, i) => {
    inserer.run(`W35100000${i}`, nom, nom.toLowerCase());
  });

  const ctx: ContexteDecouverte = {
    db,
    client,
    counters,
    clock,
    logger: new Logger({ console: false }),
    queue,
    runId: null,
  };

  const lancer = async (opts: { maxPages?: number; avecMobiles?: boolean } = {}): Promise<void> => {
    queue.enqueue("decouverte_planifiee", cleDecouverte("35", CAMPAGNE), {
      departement: "35",
      campagne: CAMPAGNE,
      maxPages: opts.maxPages ?? 10,
      avecMobiles: opts.avecMobiles === true,
    });
    const worker = new Worker(queue, creerHandlersDecouverte(ctx), { concurrency: 4 });
    const stats = await worker.run();
    assert.equal(stats.failed, 0, "aucun job ne doit echouer");
  };

  return { ctx, db, server, counters, lancer };
}

function pages(db: ReturnType<typeof openDatabase>): { url: string; statut: string; profondeur: number }[] {
  return db
    .prepare("SELECT url, statut, profondeur FROM page ORDER BY profondeur, url")
    .all() as unknown as { url: string; statut: string; profondeur: number }[];
}

function contacts(db: ReturnType<typeof openDatabase>): {
  valeur_normalisee: string;
  kind: string;
  association_id: number | null;
  is_generique: number | null;
  methode_extraction: string;
  confiance: number;
  source_url: string;
}[] {
  return db
    .prepare(
      `SELECT valeur_normalisee, kind, association_id, is_generique, methode_extraction, confiance, source_url
         FROM contact ORDER BY kind, valeur_normalisee`,
    )
    .all() as unknown as ReturnType<typeof contacts>;
}

test("la decouverte part de l'URL de mairie et suit les liens associatifs", async (t) => {
  const { db, lancer } = await setup(t);
  await lancer();

  const visitees = pages(db).filter((p) => p.statut === "visitee").map((p) => new URL(p.url).pathname);
  assert.deepEqual(
    visitees.sort(),
    ["/", "/annuaire-des-associations", "/vie-associative"],
    "seules les pages au score positif doivent etre visitees",
  );

  const chemins = pages(db).map((p) => new URL(p.url).pathname);
  assert.ok(!chemins.includes("/actualites"), "une rubrique d'actualites ne doit pas etre enfilee");
  assert.ok(!chemins.includes("/marches-publics"), "les marches publics non plus");
  assert.ok(!chemins.includes("/plaquette.pdf"), "un PDF ne doit pas etre enfile");
});

test("INTERDIT : aucun lien de reseau social n'est suivi ni memorise", async (t) => {
  const { db, server, lancer } = await setup(t);
  await lancer();

  const domaines = (db.prepare("SELECT DISTINCT domaine FROM page").all() as unknown as { domaine: string }[])
    .map((row) => row.domaine);
  assert.deepEqual(domaines, ["127.0.0.1"], "aucun domaine tiers ne doit entrer en base");
  assert.equal(server.countOf("/vie-associative"), 1);
});

test("une page interdite par robots.txt n'est jamais demandee", async (t) => {
  const routesAvecLien = routes();
  routesAvecLien["/vie-associative"] = html(
    `<html><body><a href="/prive">Annuaire des associations</a></body></html>`,
  );
  const { db, server, lancer } = await setup(t, { routes: routesAvecLien });
  await lancer();

  assert.equal(server.countOf("/prive"), 0, "la page interdite ne doit pas etre demandee");
  const privee = (db.prepare("SELECT statut FROM page WHERE url LIKE '%/prive'").get() as
    | { statut: string }
    | undefined);
  assert.equal(privee?.statut, "bloquee", "elle doit rester en base, marquee bloquee");
});

test("les contacts portent leur provenance et leur classification", async (t) => {
  const { db, lancer } = await setup(t);
  await lancer();

  const trouves = contacts(db);
  const parValeur = new Map(trouves.map((c) => [c.valeur_normalisee, c]));

  const club = parValeur.get("club@asso.example");
  assert.ok(club !== undefined, "l'adresse du club doit etre extraite");
  assert.equal(club.is_generique, 1, "§4.7 — « club@ » designe une fonction, pas une personne");
  assert.match(club.methode_extraction, /^dom:mailto/);
  assert.match(club.source_url, /\/vie-associative$/, "la source doit etre la page ou l'adresse a ete lue");

  const nominatif = parValeur.get("marie.dupont@tennis.example");
  assert.equal(nominatif?.is_generique, 0, "§4.7 — prenom.nom est nominatif");

  const mairie = parValeur.get("contact@bruz.example");
  assert.equal(mairie?.is_generique, 1, "§4.7 — « contact@ » est generique");

  const obfusque = parValeur.get("amicale@asso.example");
  assert.ok(obfusque !== undefined, "une adresse obfusquee doit etre reconstruite");
  assert.ok(obfusque.confiance < 0.6, "une reconstruction vaut moins qu'une lecture directe");

  for (const contact of trouves) {
    assert.ok(contact.source_url !== "", "§4.5 — pas de donnee sans URL source");
    assert.ok(contact.confiance > 0 && contact.confiance <= 1);
  }
});

test("INVARIANT : les mobiles 06/07 sont exclus sans le drapeau, presents avec", async (t) => {
  const sans = await setup(t);
  await sans.lancer();
  const mobilesSans = (sans.db
    .prepare("SELECT count(*) AS n FROM contact WHERE kind = 'phone' AND valeur_normalisee LIKE '+336%'")
    .get() as { n: number }).n;
  assert.equal(mobilesSans, 0, "§4.6 — aucun mobile par defaut");
  assert.equal(sans.counters.snapshot()["extraction"]?.["mobiles_exclus"], 1);

  const avec = await setup(t);
  await avec.lancer({ avecMobiles: true });
  const mobilesAvec = (avec.db
    .prepare("SELECT count(*) AS n FROM contact WHERE kind = 'phone' AND valeur_normalisee = '+33612345678'")
    .get() as { n: number }).n;
  assert.equal(mobilesAvec, 1, "le drapeau explicite doit les laisser passer");
});

test("un contact trouve dans la ligne d'une association lui est rattache", async (t) => {
  const { db, lancer } = await setup(t);
  await lancer();

  const rattache = db
    .prepare(
      `SELECT a.nom FROM contact c JOIN association a ON a.id = c.association_id
        WHERE c.valeur_normalisee = 'club@asso.example'`,
    )
    .get() as { nom: string } | undefined;
  assert.equal(rattache?.nom, "Club de Bruz", "la ligne du tableau porte le nom et l'adresse");

  const mairie = db
    .prepare("SELECT association_id, code_insee FROM contact WHERE valeur_normalisee = 'contact@bruz.example'")
    .get() as { association_id: number | null; code_insee: string } | undefined;
  assert.equal(mairie?.association_id, null, "l'adresse de la mairie ne se rattache a aucune association");
  assert.equal(mairie?.code_insee, "35047", "elle reste exploitable au niveau de la commune");

  const rattaches = db
    .prepare("SELECT count(*) AS n FROM contact WHERE association_id IS NOT NULL")
    .get() as { n: number };
  assert.ok(rattaches.n >= 3, `au moins trois contacts devraient etre rattaches, vu ${rattaches.n}`);
});

test("le budget de pages par commune n'est jamais depasse", async (t) => {
  const { db, lancer } = await setup(t, { routes: routesLarges() });
  await lancer({ maxPages: 3 });

  const total = (db.prepare("SELECT count(*) AS n FROM page WHERE code_insee = '35047'").get() as { n: number }).n;
  assert.equal(total, 3, "le budget doit borner le nombre total de pages de la commune");
});

test("la profondeur est bornee a deux sauts", async (t) => {
  const { db, lancer } = await setup(t, { routes: routesProfondes() });
  await lancer({ maxPages: 50 });

  const max = (db.prepare("SELECT max(profondeur) AS p FROM page").get() as { p: number }).p;
  assert.equal(max, 2, "aucune page ne doit depasser la profondeur 2");
});

test("rejouer la decouverte ne cree ni page ni contact en double", async (t) => {
  const { db, lancer } = await setup(t);
  await lancer();

  const pagesApres = pages(db).length;
  const contactsApres = contacts(db).length;

  // Meme campagne, memes cles de dedup : le second passage ne doit rien ajouter.
  await lancer();

  assert.equal(pages(db).length, pagesApres, "aucune page en double");
  assert.equal(contacts(db).length, contactsApres, "aucun contact en double");
});

test("la commune retient ce que la decouverte a constate, sans toucher a la resolution", async (t) => {
  const { db, lancer } = await setup(t);
  await lancer();

  const commune = db
    .prepare("SELECT statut_resolution, crawl_statut, last_crawled_at FROM commune WHERE code_insee = '35047'")
    .get() as { statut_resolution: string; crawl_statut: string; last_crawled_at: string | null };

  assert.equal(commune.crawl_statut, "ok", "le site a repondu");
  assert.equal(commune.statut_resolution, "resolue", "ce que declare l'Annuaire ne doit pas bouger");
  assert.ok(commune.last_crawled_at !== null, "la date de crawl doit etre renseignee");
});

test("une mairie injoignable est marquee sans faire echouer le run", async (t) => {
  const vides = routes();
  vides["/"] = text("introuvable", 404);
  const { db, lancer } = await setup(t, { routes: vides });
  await lancer();

  const commune = db.prepare("SELECT crawl_statut FROM commune WHERE code_insee = '35047'").get() as {
    crawl_statut: string;
  };
  assert.equal(commune.crawl_statut, "injoignable");
});

test("INTERDIT : une mairie declaree sur un reseau social n'est pas crawlee", async (t) => {
  const { db, server, lancer } = await setup(t, { urlMairie: () => "https://www.facebook.com/mairie-de-bruz" });
  await lancer();

  assert.equal(server.requests.length, 0, "aucune requete ne doit partir");
  const commune = db.prepare("SELECT crawl_statut FROM commune WHERE code_insee = '35047'").get() as {
    crawl_statut: string;
  };
  assert.equal(commune.crawl_statut, "refuse");
  assert.equal((db.prepare("SELECT count(*) AS n FROM page").get() as { n: number }).n, 0);
});

/** Beaucoup de liens associatifs : de quoi saturer un budget volontairement bas. */
function routesLarges(): Record<string, Handler> {
  const liens = Array.from({ length: 12 }, (_, i) => `<a href="/asso-${i}">Association ${i}</a>`).join(" ");
  const table: Record<string, Handler> = {
    "/robots.txt": robotsAllowAll,
    "/": html(`<html><body>${liens}</body></html>`),
  };
  for (let i = 0; i < 12; i += 1) {
    table[`/asso-${i}`] = html(`<html><body>Association ${i}</body></html>`);
  }
  return table;
}

/** Une chaine de pages associatives plus longue que la profondeur autorisee. */
function routesProfondes(): Record<string, Handler> {
  const table: Record<string, Handler> = { "/robots.txt": robotsAllowAll };
  for (let i = 0; i <= 5; i += 1) {
    table[i === 0 ? "/" : `/associations-${i}`] =
      html(`<html><body><a href="/associations-${i + 1}">Associations suite</a></body></html>`);
  }
  return table;
}
