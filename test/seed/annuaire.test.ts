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
import { Logger } from "../../src/log.ts";
import { fixedClock } from "../../src/clock.ts";
import { extraireMairies, handlerAnnuaire } from "../../src/seed/annuaire.ts";
import type { ContexteSeed } from "../../src/seed/contexte.ts";
import { startServer, robotsAllowAll, text } from "../helpers/server.ts";
import { makeTempDir } from "../helpers/tmp.ts";

const lookupLocal: LookupFn = async () => ({ address: "127.0.0.1", family: 4 });
const T0 = Date.parse("2026-08-18T10:00:00.000Z");

/** Fixture synthetique : aucune donnee reelle collectee n'entre dans le depot. */
function service(options: {
  nom: string;
  codes: string[];
  site?: string;
  commune?: string;
  type?: string;
}): string {
  const site = options.site === undefined ? "[ ]" : `[ { "libelle" : "", "valeur" : "${options.site}" } ]`;
  const adresse =
    options.commune === undefined ? "[ ]" : `[ { "type_adresse" : "Adresse", "nom_commune" : "${options.commune}" } ]`;
  const codes = options.codes.map((c) => `"${c}"`).join(", ");
  return `{
    "nom" : "${options.nom}",
    "site_internet" : ${site},
    "adresse" : ${adresse},
    "pivot" : [ { "type_service_local" : "${options.type ?? "mairie"}", "code_insee_commune" : [ ${codes} ] } ]
  }`;
}

const DUMP = `{ "service" : [
  ${service({ nom: "Mairie - Bruz", codes: ["35047"], site: "https://bruz.example", commune: "Bruz" })},
  ${service({ nom: "Mairie - Le Ferré", codes: ["35111"], commune: "Le Ferré" })},
  ${service({ nom: "Mairie - Quimper", codes: ["29232"], site: "https://quimper.example", commune: "Quimper" })},
  ${service({ nom: "Centre des impôts - Rennes", codes: ["35238"], site: "https://impots.example", type: "sip" })},
  ${service({ nom: "Mairie déléguée - Bruz annexe", codes: ["35047"], commune: "Bruz" })}
] }`;

async function setup(t: TestContext, dump: string = DUMP) {
  const listing = `<pre>
<a href="2026-08-17_050000-data.gouv_local.json">2026-08-17_050000-data.gouv_local.json</a>
<a href="2026-08-18_053123-data.gouv_local.json">2026-08-18_053123-data.gouv_local.json</a>
</pre>`;
  const server = await startServer(t, {
    "/robots.txt": robotsAllowAll,
    "/all/": text(listing),
    "/all/2026-08-18_053123-data.gouv_local.json": text(dump),
    "/all/2026-08-17_050000-data.gouv_local.json": text('{ "service" : [ ] }'),
  });
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const clock = fixedClock(T0);
  const ctx: ContexteSeed = {
    db,
    client: new HttpClient({
      cache: new HttpCache(makeTempDir(t)),
      throttle: new DomainThrottle({ minDelayMs: 1, lookup: lookupLocal }),
      counters: new Counters(db, null),
      userAgent: buildUserAgent("0.1.0", "https://exemple.example/contact"),
      cacheTtlMs: 3_600_000,
      clock,
    }),
    counters: new Counters(db, null),
    clock,
    logger: new Logger({ console: false }),
    queue: new JobQueue(db, clock),
    runId: null,
    sources: { annuaireListing: `${server.origin}/all/` },
  };
  return { server, ctx, db };
}

const JOB = { id: 1, runId: null, type: "annuaire_dump", dedupKey: "k", payload: { departement: "35" }, attempts: 1, maxAttempts: 5 };

test("extrait les mairies et ignore les autres services", () => {
  const fiches = extraireMairies(service({ nom: "Mairie - Bruz", codes: ["35047"], site: "https://bruz.example", commune: "Bruz" }), "35");
  assert.deepEqual(fiches, [{ codeInsee: "35047", nom: "Bruz", urlMairie: "https://bruz.example" }]);
  const autre = extraireMairies(service({ nom: "Impôts", codes: ["35238"], type: "sip" }), "35");
  assert.deepEqual(autre, []);
});

test("une fiche hors departement est ecartee", () => {
  assert.deepEqual(extraireMairies(service({ nom: "Mairie - Quimper", codes: ["29232"] }), "35"), []);
});

test("une valeur de site qui n'est pas une URL est ignoree", () => {
  const fiches = extraireMairies(service({ nom: "Mairie - X", codes: ["35001"], site: "en cours de refonte", commune: "X" }), "35");
  assert.equal(fiches[0]?.urlMairie, undefined);
});

test("une commune nouvelle couvre plusieurs codes INSEE", () => {
  const fiches = extraireMairies(service({ nom: "Mairie - Nouvelle", codes: ["35001", "35002"], site: "https://n.example" }), "35");
  assert.deepEqual(fiches.map((f) => f.codeInsee), ["35001", "35002"]);
});

test("le nom se replie sur le libelle quand l'adresse ne porte pas de commune", () => {
  const fiches = extraireMairies(service({ nom: "Mairie - Saint-Malo", codes: ["35288"], site: "https://sm.example" }), "35");
  assert.equal(fiches[0]?.nom, "Saint-Malo");
});

test("peuple les communes du departement avec leur URL de mairie", async (t) => {
  const { ctx, db } = await setup(t);
  const resultat = await handlerAnnuaire(ctx)(JOB, { signal: new AbortController().signal });
  assert.equal(resultat.kind, "done");

  const communes = db.prepare("SELECT code_insee, nom, url_mairie, statut_resolution FROM commune ORDER BY code_insee").all();
  assert.deepEqual(
    communes.map((c) => [c.code_insee, c.nom, c.url_mairie, c.statut_resolution]),
    [
      ["35047", "Bruz", "https://bruz.example", "resolue"],
      ["35111", "Le Ferré", null, "sans_site"],
    ],
  );
});

test("la provenance de la resolution est enregistree", async (t) => {
  const { ctx, db } = await setup(t);
  await handlerAnnuaire(ctx)(JOB, { signal: new AbortController().signal });
  const ligne = db.prepare("SELECT resolution_source_url, resolution_collected_at, resolution_confiance, source_resolution FROM commune WHERE code_insee = '35047'").get();
  assert.match(String(ligne?.resolution_source_url), /data\.gouv_local\.json$/);
  assert.equal(ligne?.resolution_collected_at, new Date(T0).toISOString());
  assert.equal(ligne?.source_resolution, "annuaire_local");
  assert.ok(Number(ligne?.resolution_confiance) > 0);
});

test("une mairie annexe sans site n'efface pas l'URL deja trouvee", async (t) => {
  const { ctx, db } = await setup(t);
  await handlerAnnuaire(ctx)(JOB, { signal: new AbortController().signal });
  const ligne = db.prepare("SELECT url_mairie, statut_resolution FROM commune WHERE code_insee = '35047'").get();
  assert.equal(ligne?.url_mairie, "https://bruz.example");
  assert.equal(ligne?.statut_resolution, "resolue");
});

test("les compteurs de l'etape remontent", async (t) => {
  const { ctx } = await setup(t);
  await handlerAnnuaire(ctx)(JOB, { signal: new AbortController().signal });
  const vues = ctx.counters.snapshot()["annuaire"] ?? {};
  assert.equal(vues["services_lus"], 5);
  assert.equal(vues["urls_resolues"], 1);
  assert.equal(vues["sans_site"], 2);
});

test("le dump est marque termine avec sa taille consommee", async (t) => {
  const { ctx, db } = await setup(t);
  const resultat = await handlerAnnuaire(ctx)(JOB, { signal: new AbortController().signal });
  assert.equal(resultat.kind, "done");
  resultat.commit?.(db);
  const dump = db.prepare("SELECT source, statut, consumed_bytes FROM dump").get();
  assert.equal(dump?.source, "annuaire_local");
  assert.equal(dump?.statut, "termine");
  assert.ok(Number(dump?.consumed_bytes) > 0);
});

test("rejouer le seed ne cree pas de doublon", async (t) => {
  const { ctx, db } = await setup(t);
  await handlerAnnuaire(ctx)(JOB, { signal: new AbortController().signal });
  await handlerAnnuaire(ctx)(JOB, { signal: new AbortController().signal });
  const compte = db.prepare("SELECT count(*) AS n FROM commune").get();
  assert.equal(compte?.n, 2);
});

test("le listing de l'Annuaire est revalide, jamais servi depuis le cache", async (t) => {
  // Un index n'est pas une ressource : il nomme le fichier du jour, et ce fichier
  // tourne quotidiennement. Le mettre en cache revient a demander demain un fichier
  // qui n'existait qu'hier — trois runs consecutifs y ont echoue en production.
  let jour = "2026-08-20_050000";
  const dumpDe = (j: string): string =>
    `{ "service" : [ ${service({ nom: `Mairie - J${j.slice(8, 10)}`, codes: ["35047"], site: `https://j${j.slice(8, 10)}.example`, commune: "Bruz" })} ] }`;

  const server = await startServer(t, {
    "/robots.txt": robotsAllowAll,
    "/all/": (_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<pre><a href="${jour}-data.gouv_local.json">${jour}-data.gouv_local.json</a></pre>`);
    },
    // Seul le dump du jour courant repond : celui de la veille a ete fait tourner,
    // exactement comme le serveur reel s'en debarrasse.
    "/all/2026-08-20_050000-data.gouv_local.json": (_req, res) => {
      if (jour !== "2026-08-20_050000") {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("disparu");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(dumpDe("2026-08-20_050000"));
    },
    "/all/2026-08-21_051500-data.gouv_local.json": text(dumpDe("2026-08-21_051500")),
  });

  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const clock = fixedClock(T0);
  const ctx: ContexteSeed = {
    db,
    client: new HttpClient({
      cache: new HttpCache(makeTempDir(t)),
      throttle: new DomainThrottle({ minDelayMs: 1, lookup: lookupLocal }),
      counters: new Counters(db, null),
      userAgent: buildUserAgent("0.1.0", "https://exemple.example/contact"),
      // Une heure de fraicheur : sans revalidation forcee, le second passage servirait
      // le listing de la veille et irait chercher un dump disparu.
      cacheTtlMs: 3_600_000,
      clock,
    }),
    counters: new Counters(db, null),
    clock,
    logger: new Logger({ console: false }),
    queue: new JobQueue(db, clock),
    runId: null,
    sources: { annuaireListing: `${server.origin}/all/` },
  };

  const premier = await handlerAnnuaire(ctx)(JOB, { signal: new AbortController().signal });
  assert.equal(premier.kind, "done");
  assert.equal(
    (db.prepare("SELECT url_mairie FROM commune WHERE code_insee = '35047'").get() as { url_mairie: string })
      .url_mairie,
    "https://j20.example",
  );

  // Le serveur fait tourner son dump, comme chaque nuit.
  jour = "2026-08-21_051500";

  const second = await handlerAnnuaire(ctx)({ ...JOB, dedupKey: "k2" }, { signal: new AbortController().signal });
  assert.equal(second.kind, "done", "le second passage ne doit pas buter sur un dump disparu");
  assert.equal(
    (db.prepare("SELECT url_mairie FROM commune WHERE code_insee = '35047'").get() as { url_mairie: string })
      .url_mairie,
    "https://j21.example",
    "le listing relu doit designer le dump du jour",
  );
});
