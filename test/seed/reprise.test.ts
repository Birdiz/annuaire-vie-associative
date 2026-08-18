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
import { handlerRna } from "../../src/seed/rna.ts";
import type { ContexteSeed } from "../../src/seed/contexte.ts";
import type { Handler } from "../helpers/server.ts";
import { startServer, robotsAllowAll } from "../helpers/server.ts";
import { makeTempDir } from "../helpers/tmp.ts";

const lookupLocal: LookupFn = async () => ({ address: "127.0.0.1", family: 4 });
const T0 = Date.parse("2026-08-18T10:00:00.000Z");
const ENTETE = "id,titre,objet,objet_social1,adrs_codeinsee,adrs_libcommune,siteweb,date_disso";
const NB_LIGNES = 5_000;

/**
 * Fixture synthetique volumineuse : il faut depasser plusieurs tranches d'ecriture pour
 * qu'une coupure tombe apres un commit, la ou la reprise a quelque chose a reprendre.
 */
function csvSynthetique(nb: number): Buffer {
  const lignes = [ENTETE];
  for (let i = 1; i <= nb; i++) {
    const numero = String(i).padStart(6, "0");
    lignes.push(`W35${numero},Association ${numero},Objet ${numero},006090,35047,Bruz,,0001-01-01`);
  }
  return Buffer.from(`${lignes.join("\n")}\n`, "utf8");
}

const CORPS = csvSynthetique(NB_LIGNES);

/** Sert le CSV en honorant `Range`, mais coupe la connexion apres `coupure` octets. */
function servirEnCoupant(etat: { coupure: number | null; etag: string }): Handler {
  return (req, res) => {
    const plage = /^bytes=(\d+)-$/.exec(String(req.headers["range"] ?? ""));
    const debut = plage?.[1] === undefined ? 0 : Number(plage[1]);
    const fragment = CORPS.subarray(debut);
    const entetes: Record<string, string> = {
      "content-type": "text/csv",
      etag: etat.etag,
      "content-length": String(fragment.length),
    };
    if (debut > 0) entetes["content-range"] = `bytes ${debut}-${CORPS.length - 1}/${CORPS.length}`;
    res.writeHead(debut > 0 ? 206 : 200, entetes);

    if (etat.coupure === null) {
      res.end(fragment);
      return;
    }
    // La coupure doit intervenir apres que les octets ont ete remis au socket, sinon
    // le client ne recoit rien et il n'y a aucune tranche commitee a reprendre.
    res.write(fragment.subarray(0, etat.coupure), () => {
      setTimeout(() => res.destroy(), 25);
    });
  };
}

async function setup(t: TestContext, etat: { coupure: number | null; etag: string }) {
  const server = await startServer(t, { "/robots.txt": robotsAllowAll, "/waldec.csv": servirEnCoupant(etat) });
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const clock = fixedClock(T0);
  const ctx: ContexteSeed = {
    db,
    client: new HttpClient({
      cache: new HttpCache(makeTempDir(t)),
      throttle: new DomainThrottle({ minDelayMs: 1, lookup: lookupLocal }),
      counters: new Counters(db, null),
      userAgent: buildUserAgent("0.1.0", "https://exemple.fr/contact"),
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
  return { ctx, db, etat };
}

const JOB = { id: 1, runId: null, type: "rna_seed", dedupKey: "k", payload: { departement: "35" }, attempts: 1, maxAttempts: 5 };
const SIGNAL = () => ({ signal: new AbortController().signal });

function compter(db: ReturnType<typeof openDatabase>, sql: string): number {
  return Number((db.prepare(sql).get() as { n?: number })?.n ?? 0);
}

test("une coupure en cours de flux laisse un offset de reprise coherent", async (t) => {
  const { ctx, db } = await setup(t, { coupure: Math.floor(CORPS.length * 0.6), etag: '"v1"' });

  await assert.rejects(() => handlerRna(ctx)(JOB, SIGNAL()));

  const dump = db.prepare("SELECT statut, consumed_bytes FROM dump WHERE source = 'rna_waldec'").get();
  assert.equal(dump?.statut, "en_cours", "le dump reste ouvert pour etre repris");
  const offset = Number(dump?.consumed_bytes);
  assert.ok(offset > 0, "des tranches ont ete commitees avant la coupure");

  // L'offset et les donnees sont d'accord : il designe une frontiere de ligne, et le
  // nombre d'associations correspond exactement a ce que ces octets contiennent.
  const ecrites = compter(db, "SELECT count(*) AS n FROM association");
  const attendues = CORPS.subarray(0, offset).toString("utf8").split("\n").filter((l) => l.startsWith("W35")).length;
  assert.equal(ecrites, attendues);
  assert.equal(CORPS[offset - 1], 0x0a, "l'offset tombe juste apres une fin de ligne");
});

test("la reprise repart de l'offset et ne perd ni ne duplique aucune ligne", async (t) => {
  const etat = { coupure: Math.floor(CORPS.length * 0.6) as number | null, etag: '"v1"' };
  const { ctx, db } = await setup(t, etat);

  await assert.rejects(() => handlerRna(ctx)(JOB, SIGNAL()));
  const apresCoupure = compter(db, "SELECT count(*) AS n FROM association");
  assert.ok(apresCoupure > 0 && apresCoupure < NB_LIGNES);

  // Le serveur ne coupe plus : c'est la relance apres incident.
  etat.coupure = null;
  const resultat = await handlerRna(ctx)(JOB, SIGNAL());
  assert.equal(resultat.kind, "done");

  assert.equal(compter(db, "SELECT count(*) AS n FROM association"), NB_LIGNES, "aucune perte");
  assert.equal(
    compter(db, "SELECT count(DISTINCT rna_id) AS n FROM association"),
    NB_LIGNES,
    "aucun doublon",
  );
  assert.equal(ctx.counters.snapshot()["dump"]?.["reprises"], 1);
});

test("la reprise relit l'en-tete memorise plutot que de le redemander", async (t) => {
  const etat = { coupure: Math.floor(CORPS.length * 0.6) as number | null, etag: '"v1"' };
  const { ctx, db } = await setup(t, etat);
  await assert.rejects(() => handlerRna(ctx)(JOB, SIGNAL()));

  const entete = db.prepare("SELECT entete FROM dump WHERE source = 'rna_waldec'").get();
  assert.equal(entete?.entete, ENTETE);

  etat.coupure = null;
  await handlerRna(ctx)(JOB, SIGNAL());
  // Sans en-tete memorise, la reprise aurait lu des colonnes decalees et rien insere.
  const echantillon = db.prepare("SELECT nom FROM association WHERE rna_id = 'W35005000'").get();
  assert.equal(echantillon?.nom, "Association 005000");
});

test("un dump modifie entre deux passages fait repartir de zero", async (t) => {
  const etat = { coupure: Math.floor(CORPS.length * 0.6) as number | null, etag: '"v1"' };
  const { ctx, db } = await setup(t, etat);
  await assert.rejects(() => handlerRna(ctx)(JOB, SIGNAL()));

  // Le miroir n'honore pas If-Range : c'est la comparaison cote client qui doit
  // detecter le changement, sans quoi on recollerait deux moities incompatibles.
  etat.coupure = null;
  etat.etag = '"v2"';
  const resultat = await handlerRna(ctx)(JOB, SIGNAL());
  assert.equal(resultat.kind, "done");

  assert.equal(compter(db, "SELECT count(*) AS n FROM association"), NB_LIGNES);
  assert.equal(compter(db, "SELECT count(DISTINCT rna_id) AS n FROM association"), NB_LIGNES);
  assert.equal(ctx.counters.snapshot()["dump"]?.["redemarrages"], 1);
  assert.equal(ctx.counters.snapshot()["dump"]?.["reprises"], undefined);
});
