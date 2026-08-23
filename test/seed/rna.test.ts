import { test } from "node:test";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { openDatabase } from "../../src/db/index.ts";
import { Counters } from "../../src/metrics/counters.ts";
import { HttpCache } from "../../src/http/cache.ts";
import { DomainThrottle } from "../../src/http/throttle.ts";
import type { LookupFn } from "../../src/http/throttle.ts";
import { HttpClient, buildUserAgent } from "../../src/http/client.ts";
import { JobQueue } from "../../src/jobs/queue.ts";
import { Logger } from "../../src/log.ts";
import { fixedClock } from "../../src/clock.ts";
import { convertirLigne, handlerRna } from "../../src/seed/rna.ts";
import { normaliserNom } from "../../src/texte.ts";
import type { ContexteSeed } from "../../src/seed/contexte.ts";
import { indexerColonnes } from "../../src/parse/csv.ts";
import type { Handler } from "../helpers/server.ts";
import { startServer, robotsAllowAll } from "../helpers/server.ts";
import { makeTempDir } from "../helpers/tmp.ts";

const lookupLocal: LookupFn = async () => ({ address: "127.0.0.1", family: 4 });
const T0 = Date.parse("2026-08-18T10:00:00.000Z");

const ENTETE =
  "id,titre,objet,objet_social1,adrs_codeinsee,adrs_libcommune,siteweb,date_disso," +
  "date_creat,date_decla,position,maj_time";

/**
 * Fixture synthetique, ecrite a la main : aucune donnee reelle n'entre dans le depot.
 *
 * Les quatre dernieres colonnes sont celles que l'ADR-013 reclamait. `W351000004` n'a
 * pas de date de declaration : c'est le cas que le seuil de dormance ne pourra pas
 * trancher, et il doit rester visible plutot que d'etre range d'un cote par defaut.
 */
const CSV =
  `${ENTETE}\n` +
  `W351000001,Club de Bruz,"Sport, loisirs et culture",006090,35047,Bruz,https://club-bruz.example,0001-01-01,1998-03-02,2024-06-14,A,2024-06-14T09:00:00\n` +
  `W351000002,Amicale du Ferré,Entraide,023000,35111,Le Ferré,,0001-01-01,2005-09-01,2011-02-03,A,2011-02-03T14:20:00\n` +
  `W291000003,Club de Quimper,Voile,006090,29232,Quimper,,0001-01-01,2001-04-04,2020-01-09,A,2020-01-09T08:00:00\n` +
  `W351000004,Comité dissous,Ancien comité,006090,35047,Bruz,,2019-06-30,1990-01-01,0001-01-01,D,2019-06-30T00:00:00\n` +
  `W351000005,Association sans commune connue,Divers,023000,35999,Lieu-Inconnu,exemple-asso.example,0001-01-01,2015-01-01,2023-05-05,A,2023-05-05T11:00:00\n`;

function servirCsv(corps: string): Handler {
  const octets = Buffer.from(corps, "utf8");
  return (req, res) => {
    const plage = /^bytes=(\d+)-$/.exec(String(req.headers["range"] ?? ""));
    if (plage?.[1] !== undefined) {
      const debut = Number(plage[1]);
      const fragment = octets.subarray(debut);
      res.writeHead(206, {
        "content-type": "text/csv",
        etag: '"rna-v1"',
        "content-length": String(fragment.length),
        "content-range": `bytes ${debut}-${octets.length - 1}/${octets.length}`,
      });
      res.end(fragment);
      return;
    }
    res.writeHead(200, { "content-type": "text/csv", etag: '"rna-v1"', "content-length": String(octets.length) });
    res.end(octets);
  };
}

async function setup(t: TestContext, corps: string = CSV) {
  const server = await startServer(t, { "/robots.txt": robotsAllowAll, "/waldec.csv": servirCsv(corps) });
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
    sources: { rnaWaldec: `${server.origin}/waldec.csv` },
  };
  return { server, ctx, db };
}

function job(payload: Record<string, unknown>) {
  return { id: 1, runId: null, type: "rna_seed", dedupKey: "k", payload, attempts: 1, maxAttempts: 5 };
}

const SIGNAL = () => ({ signal: new AbortController().signal });

test("normalise les noms pour le rapprochement ulterieur", () => {
  assert.equal(normaliserNom("Comité des Fêtes de Saint-Méen"), "comite des fetes de saint meen");
  assert.equal(normaliserNom("  A.S.  Bruz  "), "a s bruz");
});

test("convertit une ligne du departement", () => {
  const lire = indexerColonnes(ENTETE.split(","));
  const ligne = convertirLigne(
    lire(["W351000001", "Club", "Objet", "006090", "35047", "Bruz", "", "0001-01-01", "1998-03-02", "2024-06-14", "A", "2024-06-14T09:00:00"]),
    "35",
  );
  assert.equal(ligne?.rnaId, "W351000001");
  assert.equal(ligne?.codeInsee, "35047");
  assert.equal(ligne?.dateDissolution, undefined);
});

test("ecarte une ligne d'un autre departement", () => {
  const lire = indexerColonnes(ENTETE.split(","));
  assert.equal(convertirLigne(lire(["W29", "Club", "", "", "29232", "Quimper", "", "0001-01-01", "", "", "", ""]), "35"), undefined);
});

test("retient la date de dissolution reelle", () => {
  const lire = indexerColonnes(ENTETE.split(","));
  const ligne = convertirLigne(lire(["W35", "Ancien", "", "", "35047", "Bruz", "", "2019-06-30", "", "", "", ""]), "35");
  assert.equal(ligne?.dateDissolution, "2019-06-30");
});

test("complete un site web declare sans schema", () => {
  const lire = indexerColonnes(ENTETE.split(","));
  const ligne = convertirLigne(lire(["W35", "X", "", "", "35047", "Bruz", "exemple-asso.example", "0001-01-01", "", "", "", ""]), "35");
  assert.equal(ligne?.siteWeb, "https://exemple-asso.example");
});

test("les champs temporels du RNA sont retenus (ADR-013)", () => {
  const lire = indexerColonnes(ENTETE.split(","));
  const ligne = convertirLigne(
    lire(["W35", "Club", "", "", "35047", "Bruz", "", "0001-01-01", "1998-03-02", "2024-06-14", "A", "2024-06-14T09:00:00"]),
    "35",
  );
  assert.equal(ligne?.dateCreation, "1998-03-02");
  assert.equal(ligne?.dateDeclaration, "2024-06-14");
  assert.equal(ligne?.positionRna, "A");
  assert.equal(ligne?.majRna, "2024-06-14T09:00:00");
});

test("la sentinelle du RNA et la chaine vide disent la meme absence", () => {
  const lire = indexerColonnes(ENTETE.split(","));
  // « 0001-01-01 » n'est pas une date : la laisser entrer ferait passer une absence
  // pour l'an 1, et le seuil de dormance rangerait ces lignes du mauvais cote.
  const sentinelle = convertirLigne(
    lire(["W35", "Club", "", "", "35047", "Bruz", "", "0001-01-01", "0001-01-01", "0001-01-01", "", ""]),
    "35",
  );
  assert.equal(sentinelle?.dateCreation, undefined);
  assert.equal(sentinelle?.dateDeclaration, undefined);
  assert.equal(sentinelle?.positionRna, undefined);
  assert.equal(sentinelle?.majRna, undefined);
});

test("amorce les associations du departement depuis le miroir", async (t) => {
  const { ctx, db } = await setup(t);
  const resultat = await handlerRna(ctx)(job({ departement: "35" }), SIGNAL());
  assert.equal(resultat.kind, "done");

  const noms = db.prepare("SELECT rna_id FROM association ORDER BY rna_id").all().map((l) => l.rna_id);
  assert.deepEqual(noms, ["W351000001", "W351000002", "W351000004", "W351000005"]);
});

test("une association d'un autre departement n'entre pas en base", async (t) => {
  const { ctx, db } = await setup(t);
  await handlerRna(ctx)(job({ departement: "35" }), SIGNAL());
  const compte = db.prepare("SELECT count(*) AS n FROM association WHERE rna_id = 'W291000003'").get();
  assert.equal(compte?.n, 0);
});

test("un code INSEE inconnu de l'Annuaire cree une commune minimale plutot que de perdre la ligne", async (t) => {
  const { ctx, db } = await setup(t);
  await handlerRna(ctx)(job({ departement: "35" }), SIGNAL());
  const commune = db.prepare("SELECT nom, statut_resolution FROM commune WHERE code_insee = '35999'").get();
  assert.equal(commune?.nom, "Lieu-Inconnu");
  assert.equal(commune?.statut_resolution, "inconnu");
  const asso = db.prepare("SELECT code_insee FROM association WHERE rna_id = 'W351000005'").get();
  assert.equal(asso?.code_insee, "35999");
});

test("la dissolution est enregistree", async (t) => {
  const { ctx, db } = await setup(t);
  await handlerRna(ctx)(job({ departement: "35" }), SIGNAL());
  const ligne = db.prepare("SELECT date_dissolution FROM association WHERE rna_id = 'W351000004'").get();
  assert.equal(ligne?.date_dissolution, "2019-06-30");
});

test("les compteurs de l'etape remontent", async (t) => {
  const { ctx } = await setup(t);
  await handlerRna(ctx)(job({ departement: "35" }), SIGNAL());
  const vues = ctx.counters.snapshot()["rna"] ?? {};
  assert.equal(vues["lignes_lues"], 5);
  assert.equal(vues["associations_ecrites"], 4);
  assert.equal(vues["hors_departement"], 1);
  assert.equal(vues["dissoutes"], 1);
});

test("rejouer l'amorce ne cree pas de doublon", async (t) => {
  const { ctx, db } = await setup(t);
  await handlerRna(ctx)(job({ departement: "35" }), SIGNAL());
  db.prepare("UPDATE dump SET statut = 'termine' WHERE source = 'rna_waldec'").run();
  await handlerRna(ctx)(job({ departement: "35" }), SIGNAL());
  const compte = db.prepare("SELECT count(*) AS n FROM association").get();
  assert.equal(compte?.n, 4);
});

test("une association devenue dissoute est mise a jour, pas dupliquee", async (t) => {
  const { ctx, db } = await setup(t);
  await handlerRna(ctx)(job({ departement: "35" }), SIGNAL());
  const avant = db.prepare("SELECT date_dissolution FROM association WHERE rna_id = 'W351000001'").get();
  assert.equal(avant?.date_dissolution, null);

  const majore = CSV.replace(
    "W351000001,Club de Bruz,\"Sport, loisirs et culture\",006090,35047,Bruz,https://club-bruz.example,0001-01-01",
    "W351000001,Club de Bruz,\"Sport, loisirs et culture\",006090,35047,Bruz,https://club-bruz.example,2026-01-15",
  );
  const suite = await setup(t, majore);
  await handlerRna(suite.ctx)(job({ departement: "35" }), SIGNAL());
  const apres = suite.db.prepare("SELECT date_dissolution FROM association WHERE rna_id = 'W351000001'").get();
  assert.equal(apres?.date_dissolution, "2026-01-15");
});

test("lit un ZIP fourni par l'utilisateur plutot que le miroir", async (t) => {
  const { ctx, db, server } = await setup(t);
  const chemin = join(makeTempDir(t), "rna.zip");
  writeFileSync(chemin, construireZip("rna_waldec_20260801_dpt_35.csv", Buffer.from(CSV, "utf8")));

  const resultat = await handlerRna(ctx)(job({ departement: "35", rnaFile: chemin }), SIGNAL());
  assert.equal(resultat.kind, "done");
  const compte = db.prepare("SELECT count(*) AS n FROM association").get();
  assert.equal(compte?.n, 4);
  // Le miroir n'a pas ete sollicite : le fichier local remplace tout acces reseau.
  assert.equal(server.countOf("/waldec.csv"), 0);
});

test("un ZIP sans entree pour le departement est signale", async (t) => {
  const { ctx } = await setup(t);
  const chemin = join(makeTempDir(t), "rna.zip");
  writeFileSync(chemin, construireZip("rna_waldec_20260801_dpt_29.csv", Buffer.from(CSV, "utf8")));
  const resultat = await handlerRna(ctx)(job({ departement: "35", rnaFile: chemin }), SIGNAL());
  assert.equal(resultat.kind, "skipped");
});

function construireZip(nom: string, contenu: Buffer): Buffer {
  const nomOctets = Buffer.from(nom, "utf8");
  const donnees = deflateRawSync(contenu);
  const somme = crc32(contenu);
  const entete = Buffer.alloc(30);
  entete.writeUInt32LE(0x04034b50, 0);
  entete.writeUInt16LE(20, 4);
  entete.writeUInt16LE(8, 8);
  entete.writeUInt32LE(somme, 14);
  entete.writeUInt32LE(donnees.length, 18);
  entete.writeUInt32LE(contenu.length, 22);
  entete.writeUInt16LE(nomOctets.length, 26);
  const fiche = Buffer.alloc(46);
  fiche.writeUInt32LE(0x02014b50, 0);
  fiche.writeUInt16LE(20, 4);
  fiche.writeUInt16LE(20, 6);
  fiche.writeUInt16LE(8, 10);
  fiche.writeUInt32LE(somme, 16);
  fiche.writeUInt32LE(donnees.length, 20);
  fiche.writeUInt32LE(contenu.length, 24);
  fiche.writeUInt16LE(nomOctets.length, 28);
  fiche.writeUInt32LE(0, 42);
  const corps = Buffer.concat([entete, nomOctets, donnees]);
  const cd = Buffer.concat([fiche, nomOctets]);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0);
  fin.writeUInt16LE(1, 8);
  fin.writeUInt16LE(1, 10);
  fin.writeUInt32LE(cd.length, 12);
  fin.writeUInt32LE(corps.length, 16);
  return Buffer.concat([corps, cd, fin]);
}
