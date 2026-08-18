import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import { makeTempDir } from "./helpers/tmp.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
// Le garde-fou anti-reseau vit dans le processus de test ; ces commandes s'executent
// dans un sous-processus, qui doit donc le precharger a son tour.
const GARDE_RESEAU = fileURLToPath(new URL("./helpers/pas-de-reseau.ts", import.meta.url));

type Resultat = { code: number; stdout: string; stderr: string };

function annuaire(
  args: readonly string[],
  env: Record<string, string> = {},
): Promise<Resultat> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", GARDE_RESEAU, CLI, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function dataDir(t: TestContext): string {
  return join(makeTempDir(t), "instance");
}

test("sans commande, l'aide s'affiche et le code de sortie est non nul", async () => {
  const resultat = await annuaire([]);
  assert.equal(resultat.code, 2);
  assert.match(resultat.stdout, /Usage : annuaire/);
});

test("l'aide documente chaque commande", async () => {
  const { stdout, code } = await annuaire(["--help"]);
  assert.equal(code, 0);
  for (const commande of ["init", "run", "status", "metrics", "jobs", "purge", "fetch"]) {
    assert.match(stdout, new RegExp(`\\b${commande}\\b`), `${commande} devrait etre documentee`);
  }
  assert.match(stdout, /ne sont pas configurables/, "l'aide doit dire que les invariants ne se reglent pas");
});

test("une commande inconnue echoue sans rien creer", async (t) => {
  const dir = dataDir(t);
  const resultat = await annuaire(["collecter-tout", "--data-dir", dir]);
  assert.equal(resultat.code, 2);
  assert.match(resultat.stderr, /Commande inconnue/);
});

test("une option inconnue est refusee plutot qu'ignoree", async (t) => {
  const resultat = await annuaire(["run", "--ignorer-robots", "--data-dir", dataDir(t)]);
  assert.equal(resultat.code, 2);
  assert.match(resultat.stderr, /ignorer-robots/);
});

test("init prepare une installation vierge et se rejoue sans dommage", async (t) => {
  const dir = dataDir(t);

  const premier = await annuaire(["init", "--data-dir", dir]);
  assert.equal(premier.code, 0);
  assert.match(premier.stdout, /\(creee\)/);
  assert.ok(existsSync(join(dir, "annuaire.sqlite")));
  assert.ok(existsSync(join(dir, "config.json")));

  const second = await annuaire(["init", "--data-dir", dir]);
  assert.equal(second.code, 0);
  assert.match(second.stdout, /\(existante\)/);
});

test("status fonctionne sur une installation non configuree", async (t) => {
  const dir = dataDir(t);
  await annuaire(["init", "--data-dir", dir]);

  const { code, stdout } = await annuaire(["status", "--data-dir", dir]);
  assert.equal(code, 0);
  assert.match(stdout, /non configure/);
  assert.match(stdout, /pending=0/);
  assert.match(stdout, /Aucun run enregistre/);
});

test("un run sans URL de contact echoue avec un code dedie et un message actionnable", async (t) => {
  const dir = dataDir(t);
  const { code, stderr } = await annuaire(["run", "--departement", "35", "--data-dir", dir]);

  assert.equal(code, 78, "EX_CONFIG");
  assert.match(stderr, /contactUrl est obligatoire/);
  assert.match(stderr, /User-Agent/);
});

test("un departement d'Alsace-Moselle est refuse avec son motif", async (t) => {
  for (const departement of ["57", "67", "68"]) {
    const { code, stderr } = await annuaire(
      ["run", "--departement", departement, "--data-dir", dataDir(t)],
      { ANNUAIRE_CONTACT_URL: "https://exemple.fr/contact" },
    );
    assert.equal(code, 2, departement);
    assert.match(stderr, /hors du champ du RNA/);
  }
});

test("un departement manquant ou mal forme est refuse", async (t) => {
  const dir = dataDir(t);
  const env = { ANNUAIRE_CONTACT_URL: "https://exemple.fr/contact" };

  assert.equal((await annuaire(["run", "--data-dir", dir], env)).code, 2);
  assert.equal((await annuaire(["run", "--departement", "trente-cinq", "--data-dir", dir], env)).code, 2);
});

test("un run se termine proprement meme quand la collecte echoue", async (t) => {
  // Les sources reelles sont hors d'atteinte sous le garde-fou : c'est exactement le
  // cas d'une machine sans reseau, et le run doit s'en sortir sans planter ni bloquer.
  const dir = dataDir(t);
  const { code, stdout } = await annuaire(
    ["run", "--departement", "35", "--data-dir", dir],
    { ANNUAIRE_CONTACT_URL: "https://exemple.fr/contact" },
  );

  assert.equal(code, 0);
  assert.match(stdout, /Aucune commune n'a ete resolue/);

  const status = await annuaire(["status", "--data-dir", dir]);
  assert.match(status.stdout, /#1  dept 35  termine/);
});

test("les commandes du jalon guident vers le run quand la base est vide", async (t) => {
  const dir = dataDir(t);
  await annuaire(["init", "--data-dir", dir]);

  const communes = await annuaire(["communes", "--departement", "35", "--data-dir", dir]);
  assert.equal(communes.code, 0);
  assert.match(communes.stdout, /annuaire run --departement 35/);

  const associations = await annuaire(["associations", "--departement", "35", "--data-dir", dir]);
  assert.equal(associations.code, 0);
  assert.match(associations.stdout, /annuaire run --departement 35/);

  const dumps = await annuaire(["dumps", "--data-dir", dir]);
  assert.equal(dumps.code, 0);
  assert.match(dumps.stdout, /Aucun dump/);
});

test("les commandes du jalon exigent un departement", async (t) => {
  const dir = dataDir(t);
  await annuaire(["init", "--data-dir", dir]);
  assert.equal((await annuaire(["communes", "--data-dir", dir])).code, 2);
  assert.equal((await annuaire(["associations", "--data-dir", dir])).code, 2);
});

test("un fichier RNA inexistant est signale avant tout acces reseau", async (t) => {
  const dir = dataDir(t);
  const { code, stderr } = await annuaire(
    ["run", "--departement", "35", "--rna-file", join(dir, "absent.zip"), "--data-dir", dir],
    { ANNUAIRE_CONTACT_URL: "https://exemple.fr/contact" },
  );
  assert.equal(code, 2);
  assert.match(stderr, /Fichier RNA introuvable/);
});

test("metrics --json produit un document exploitable sans journal parasite", async (t) => {
  const dir = dataDir(t);
  await annuaire(["run", "--departement", "35", "--data-dir", dir], {
    ANNUAIRE_CONTACT_URL: "https://exemple.fr/contact",
  });

  const { code, stdout } = await annuaire(["metrics", "--json", "--data-dir", dir]);
  assert.equal(code, 0);

  const document = JSON.parse(stdout) as { version: string; runs: { run: number; departement: string }[] };
  assert.equal(document.version, "0.1.0");
  assert.equal(document.runs[0]?.departement, "35");
});

test("jobs refuse un etat inconnu", async (t) => {
  const dir = dataDir(t);
  await annuaire(["init", "--data-dir", dir]);

  const { code, stderr } = await annuaire(["jobs", "--state", "zombie", "--data-dir", dir]);
  assert.equal(code, 2);
  assert.match(stderr, /Etat inconnu/);
});

test("purge s'execute et rend compte de sa borne", async (t) => {
  const dir = dataDir(t);
  const { code, stdout } = await annuaire(["purge", "--data-dir", dir]);
  assert.equal(code, 0);
  assert.match(stdout, /Purge jusqu'au \d{4}-\d{2}-\d{2}T/);
});

test("fetch exige une URL", async (t) => {
  const { code, stderr } = await annuaire(["fetch", "--data-dir", dataDir(t)], {
    ANNUAIRE_CONTACT_URL: "https://exemple.fr/contact",
  });
  assert.equal(code, 2);
  assert.match(stderr, /Une URL est requise/);
});

test("une configuration invalide est rapportee sans trace d'exception", async (t) => {
  const dir = dataDir(t);
  const { code, stderr } = await annuaire(["status", "--data-dir", dir], {
    ANNUAIRE_CONTACT_URL: "pas-une-url",
  });

  assert.equal(code, 78);
  assert.match(stderr, /Configuration invalide/);
  assert.ok(!stderr.includes("    at "), "l'utilisateur ne doit pas voir de pile d'appels");
});
