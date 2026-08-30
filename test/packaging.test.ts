import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../src/version.ts";
import { nomsAssets } from "../src/ui/assets.ts";
import { SIGNAUX_POSIX } from "./helpers/plateforme.ts";

/**
 * L'emballage du lot 7, verifie sur le vrai artefact.
 *
 * Le bundle est construit ici puis execute en sous-processus : c'est la seule facon de
 * savoir que `node:sqlite`, les migrations inlinees, la configuration et les fichiers
 * statiques de l'UI survivent tous a la construction. Un typecheck ne dit rien de cela,
 * et une regression ne se verrait qu'au moment d'une release.
 *
 * Le sous-processus precharge le garde-fou anti-reseau, comme `test/cli.test.ts` : le
 * bundle contient le meme client HTTP que les sources.
 */

const RACINE = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
// Une URL `file://`, et non un chemin : `--import` traite son argument comme un
// specifieur de module, et sous Windows un chemin absolu commence par `D:\\`, que
// Node lit comme un schema d'URL inconnu — ERR_UNSUPPORTED_ESM_URL_SCHEME.
const GARDE_RESEAU = new URL("./helpers/pas-de-reseau.ts", import.meta.url).href;

let dossier: string | undefined;
let bundle: string | undefined;

after(() => {
  if (dossier !== undefined) rmSync(dossier, { recursive: true, force: true });
});

/**
 * Vrai quand le paquet declare la dependance. Elle doit alors etre installee : son
 * absence est un environnement casse, et cela se dit.
 */
function declareeDansPackageJson(nom: string): boolean {
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as {
    devDependencies?: Record<string, string>;
  };
  return pkg.devDependencies?.[nom] !== undefined;
}

/** Construit une fois pour tout le fichier : esbuild coute quelques centaines de ms. */
async function construireUneFois(): Promise<{ dossier: string; bundle: string } | undefined> {
  if (dossier !== undefined && bundle !== undefined) return { dossier, bundle };

  let build: typeof import("../scripts/build.ts");
  try {
    build = await import("../scripts/build.ts");
  } catch (cause) {
    // Une dependance declaree mais absente est une installation incomplete, pas une
    // dispense. Sauter en silence rendait `npm test` vert alors qu'un pan entier de
    // l'ADR-022 n'avait pas ete verifie : format CommonJS du bundle, shebang, bit
    // d'execution, absence d'`import.meta`, survie de node:sqlite et des migrations,
    // liste blanche des assets. Rien dans la sortie ne le disait.
    if (declareeDansPackageJson("esbuild")) {
      throw new Error(
        "esbuild est declare dans les devDependencies mais introuvable : lancez `npm ci`.\n" +
          `  Cause : ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    return undefined;
  }

  dossier = mkdtempSync(join(tmpdir(), "annuaire-pack-"));
  const resultat = await build.construireBundle(dossier);
  bundle = resultat.fichier;
  return { dossier, bundle };
}

type Resultat = { code: number; stdout: string; stderr: string };

function lancer(bundle: string, args: readonly string[]): Promise<Resultat> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", GARDE_RESEAU, bundle, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

test("le bundle est un executable CommonJS, shebang compris", async (t) => {
  const construit = await construireUneFois();
  if (construit === undefined) return t.skip("esbuild n'est pas installe");

  const source = readFileSync(construit.bundle, "utf8");
  assert.match(source.slice(0, 40), /^#!\/usr\/bin\/env node\n/, "npx a besoin du shebang");
  // NTFS n'a pas de bit d'execution, et npm ne s'en sert pas sous Windows — il y ecrit un
  // `.cmd` a la place. La propriete visee est celle de la cible POSIX de `npx`, et le job
  // Linux la verifie a chaque push.
  if (SIGNAUX_POSIX) {
    assert.ok((statSync(construit.bundle).mode & 0o111) !== 0, "le bit d'execution doit etre pose");
  }
  assert.ok(!source.includes("import.meta.dirname"), "import.meta n'existe pas en CommonJS");
});

test("le bundle rend la meme version que les sources", async (t) => {
  const construit = await construireUneFois();
  if (construit === undefined) return t.skip("esbuild n'est pas installe");

  const version = await lancer(construit.bundle, ["--version"]);
  assert.equal(version.code, 0);
  assert.equal(version.stdout.trim(), VERSION);

  const aide = await lancer(construit.bundle, ["--help"]);
  assert.equal(aide.code, 0);
  for (const commande of ["init", "run", "exporter", "ui", "metrics"]) {
    assert.match(aide.stdout, new RegExp(`\\b${commande}\\b`));
  }
});

test("le bundle ouvre une base : node:sqlite et les migrations ont survecu", async (t) => {
  const construit = await construireUneFois();
  if (construit === undefined) return t.skip("esbuild n'est pas installe");

  const instance = join(construit.dossier, "instance");
  const init = await lancer(construit.bundle, ["init", "--data-dir", instance]);
  assert.equal(init.code, 0, init.stderr);
  assert.ok(existsSync(join(instance, "annuaire.sqlite")), "la base doit etre creee");
  assert.ok(existsSync(join(instance, "config.json")), "le gabarit de configuration aussi");

  const status = await lancer(construit.bundle, ["status", "--data-dir", instance]);
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /Schema\s+: version \d+/);

  // Une base vide n'exporte rien, et le dit : la surface d'erreur est la meme qu'en source.
  const exporter = await lancer(construit.bundle, ["exporter", "--departement", "35", "--data-dir", instance]);
  assert.equal(exporter.code, 1);
  assert.match(exporter.stderr, /Aucun contact a exporter/);
});

test("les fichiers statiques voyagent a cote du bundle, et sont exactement la liste blanche", async (t) => {
  const construit = await construireUneFois();
  if (construit === undefined) return t.skip("esbuild n'est pas installe");

  const presents = readdirSync(join(construit.dossier, "assets")).sort();
  assert.deepEqual(presents, [...nomsAssets()].sort());
});

test("la configuration SEA declare exactement les ressources que l'UI sait servir", async (t) => {
  let sea: typeof import("../scripts/sea.ts");
  try {
    sea = await import("../scripts/sea.ts");
  } catch (cause) {
    if (declareeDansPackageJson("postject")) {
      throw new Error(
        "postject est declare dans les devDependencies mais introuvable : lancez `npm ci`.\n" +
          `  Cause : ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    return t.skip("postject n'est pas installe");
  }

  const config = sea.construireConfigSea(join(RACINE, "dist"));
  assert.deepEqual(Object.keys(config.assets).sort(), [...nomsAssets()].sort());
  assert.match(config.main, /annuaire\.cjs$/);

  // Cache de code et instantane sont propres a la plateforme qui les produit : les
  // activer pour une cible Windows depuis un autre poste ferait un executable mort-ne.
  assert.equal(config.useCodeCache, false);
  assert.equal(config.useSnapshot, false);
});

/**
 * Les deux manipulations binaires de `scripts/sea.ts` se testent sur un PE **synthetique**,
 * fabrique ici a la main : le vrai `node.exe` fait 88 Mo, il n'a rien a faire dans le
 * depot, et sa presence dependrait d'un telechargement — donc du reseau, que la suite
 * s'interdit. Ces deux fonctions sont precisement celles qu'aucun typecheck ne protege :
 * elles lisent des decalages dans un format binaire, et une erreur d'un octet y produit
 * un executable mort-ne que ce poste ne peut pas lancer.
 */
function pePourTest(options: { certificat?: Buffer; malPlace?: boolean } = {}): Buffer {
  const DEBUT_PE = 0x100;
  const OPTIONNEL = DEBUT_PE + 24;
  const ENTREE_CERTIFICATS = OPTIONNEL + 112 + 4 * 8;
  const corps = Buffer.alloc(ENTREE_CERTIFICATS + 8 + 64);

  corps.writeUInt16LE(0x5a4d, 0); // « MZ »
  corps.writeUInt32LE(DEBUT_PE, 0x3c);
  corps.writeUInt32LE(0x00004550, DEBUT_PE); // « PE\0\0 »
  corps.writeUInt16LE(0x20b, OPTIONNEL); // PE32+
  corps.write("NODE_SEA_FUSE_0123456789abcdef:0\0", ENTREE_CERTIFICATS + 8, "latin1");

  if (options.certificat === undefined) return corps;

  const decalage = options.malPlace === true ? 8 : corps.length;
  corps.writeUInt32LE(decalage, ENTREE_CERTIFICATS);
  corps.writeUInt32LE(options.certificat.length, ENTREE_CERTIFICATS + 4);
  return Buffer.concat([corps, options.certificat]);
}

test("la signature Authenticode est retiree, et l'en-tete cesse d'en annoncer une", async (t) => {
  let sea: typeof import("../scripts/sea.ts");
  try {
    sea = await import("../scripts/sea.ts");
  } catch (cause) {
    if (declareeDansPackageJson("postject")) {
      throw new Error(
        "postject est declare dans les devDependencies mais introuvable : lancez `npm ci`.\n" +
          `  Cause : ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    return t.skip("postject n'est pas installe");
  }

  const certificat = Buffer.alloc(48, 0xab);
  const signe = pePourTest({ certificat });
  const { binaire, octetsRetires } = sea.retirerSignature(signe);

  assert.equal(octetsRetires, certificat.length);
  assert.equal(binaire.length, signe.length - certificat.length);
  assert.ok(!binaire.includes(certificat), "le certificat ne doit plus etre dans le fichier");

  // Injecter sans remettre le repertoire a zero produirait un binaire qui se declare
  // signe et corrompu, ce qui est pire pour Windows qu'un binaire non signe.
  const { binaire: deuxieme, octetsRetires: rien } = sea.retirerSignature(binaire);
  assert.equal(rien, 0, "l'operation est idempotente");
  assert.equal(deuxieme.length, binaire.length);

  // Un certificat ailleurs qu'en fin de fichier sort de la specification PE : on refuse
  // plutot que de tronquer au hasard.
  assert.throws(() => sea.retirerSignature(pePourTest({ certificat, malPlace: true })), /fin de fichier/);
  assert.throws(() => sea.retirerSignature(Buffer.alloc(64)), /MZ absent/);
});

test("la sentinelle SEA est lue dans le binaire, jamais recopiee de la documentation", async (t) => {
  let sea: typeof import("../scripts/sea.ts");
  try {
    sea = await import("../scripts/sea.ts");
  } catch (cause) {
    if (declareeDansPackageJson("postject")) {
      throw new Error(
        "postject est declare dans les devDependencies mais introuvable : lancez `npm ci`.\n" +
          `  Cause : ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    return t.skip("postject n'est pas installe");
  }

  // La valeur reelle de Node 24.17 differe de celle que montre la documentation : la lire
  // est ce qui rend la construction robuste au changement de version.
  assert.equal(sea.lireSentinelle(pePourTest()), "NODE_SEA_FUSE_0123456789abcdef");
  assert.throws(() => sea.lireSentinelle(Buffer.from("aucune sentinelle ici")), /introuvable/);
});
