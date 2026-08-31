import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import { makeTempDir } from "./helpers/tmp.ts";
import { SIGNAUX_POSIX } from "./helpers/plateforme.ts";
import { VERSION } from "../src/version.ts";

const CLI = fileURLToPath(new URL("../src/bin.ts", import.meta.url));
// Le garde-fou anti-reseau vit dans le processus de test ; ces commandes s'executent
// dans un sous-processus, qui doit donc le precharger a son tour.
// Une URL `file://`, et non un chemin : `--import` traite son argument comme un
// specifieur de module, et sous Windows un chemin absolu commence par `D:\\`, que
// Node lit comme un schema d'URL inconnu — ERR_UNSUPPORTED_ESM_URL_SCHEME.
const GARDE_RESEAU = new URL("./helpers/pas-de-reseau.ts", import.meta.url).href;

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

  // La liste est **derivee de la source**, et non recopiee. Recopiee, elle en comptait
  // quatorze quand `src/cli.ts` en offrait dix-neuf : le nom du test promettait une
  // exhaustivite qu'il n'avait pas, et cinq commandes — dont `decouvrir`, vers laquelle
  // trois messages d'erreur renvoient — pouvaient disparaitre de l'aide sans rien casser.
  const source = readFileSync(fileURLToPath(new URL("../src/cli.ts", import.meta.url)), "utf8");
  // Le seul aiguillage qui nous interesse est celui des commandes : `cli.ts` en contient
  // d'autres, sur des etats de reponse par exemple.
  const debut = source.indexOf("switch (commande) {");
  assert.notEqual(debut, -1, "l'aiguillage des commandes doit etre reperable");
  const aiguillage = source.slice(debut, source.indexOf("\n    }", debut));
  const commandes = [...aiguillage.matchAll(/^\s*case "([a-z-]+)":/gm)]
    .map((trouve) => trouve[1])
    .filter((nom): nom is string => nom !== undefined && nom !== "help");
  const uniques = [...new Set(commandes)];
  assert.ok(uniques.length >= 19, `seules ${uniques.length} commandes reperees dans la source`);

  for (const commande of uniques) {
    assert.match(stdout, new RegExp(`\\b${commande}\\b`), `${commande} devrait etre documentee`);
  }
  assert.match(stdout, /--sans-navigateur/, "le drapeau du lot 8 doit etre documente");
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
      { ANNUAIRE_CONTACT_URL: "https://exemple.example/contact" },
    );
    assert.equal(code, 2, departement);
    assert.match(stderr, /hors du champ du RNA/);
  }
});

test("un departement manquant ou mal forme est refuse", async (t) => {
  const dir = dataDir(t);
  const env = { ANNUAIRE_CONTACT_URL: "https://exemple.example/contact" };

  assert.equal((await annuaire(["run", "--data-dir", dir], env)).code, 2);
  assert.equal((await annuaire(["run", "--departement", "trente-cinq", "--data-dir", dir], env)).code, 2);
});

test("un run se termine proprement meme quand la collecte echoue", async (t) => {
  // Les sources reelles sont hors d'atteinte sous le garde-fou : c'est exactement le
  // cas d'une machine sans reseau, et le run doit s'en sortir sans planter ni bloquer.
  const dir = dataDir(t);
  const { code, stdout } = await annuaire(
    ["run", "--departement", "35", "--data-dir", dir],
    { ANNUAIRE_CONTACT_URL: "https://exemple.example/contact" },
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
  assert.equal((await annuaire(["pages", "--data-dir", dir])).code, 2);
  assert.equal((await annuaire(["dormance", "--data-dir", dir])).code, 2);
  assert.equal((await annuaire(["prefiltrer", "--data-dir", dir])).code, 2);
});

test("prefiltrer sur une base sans page dit quoi lancer, plutot que de ne rien dire", async (t) => {
  const dir = dataDir(t);
  await annuaire(["init", "--data-dir", dir]);

  const { code, stderr } = await annuaire(["prefiltrer", "--departement", "35", "--data-dir", dir]);
  assert.equal(code, 2);
  assert.match(stderr, /Aucune page exploree/);
  assert.match(stderr, /annuaire decouvrir --departement 35/);
});

test("un seuil de pre-filtre non entier est une erreur d'usage, pas d'execution", async (t) => {
  const dir = dataDir(t);
  await annuaire(["init", "--data-dir", dir]);

  const { code, stderr } = await annuaire(
    ["prefiltrer", "--departement", "35", "--seuil", "beaucoup", "--data-dir", dir],
  );
  assert.equal(code, 2);
  assert.match(stderr, /--seuil attend un entier/);
});

test("pages refuse un verdict qui n'existe pas", async (t) => {
  const dir = dataDir(t);
  await annuaire(["init", "--data-dir", dir]);

  const { code, stderr } = await annuaire(
    ["pages", "--departement", "35", "--verdict", "peut-etre", "--data-dir", dir],
  );
  assert.equal(code, 2);
  assert.match(stderr, /retenue/);
});

test("pages et dormance sur une base vierge orientent vers la commande manquante", async (t) => {
  const dir = dataDir(t);
  await annuaire(["init", "--data-dir", dir]);

  const pages = await annuaire(["pages", "--departement", "35", "--data-dir", dir]);
  assert.equal(pages.code, 0);
  assert.match(pages.stdout, /annuaire decouvrir --departement 35/);

  const dormance = await annuaire(["dormance", "--departement", "35", "--data-dir", dir]);
  assert.equal(dormance.code, 0);
  assert.match(dormance.stdout, /annuaire run --departement 35/);
});

test("dormance --json expose le critere avec le chiffre qu'il produit", async (t) => {
  const dir = dataDir(t);
  await annuaire(["init", "--data-dir", dir]);

  const { code, stdout } = await annuaire(["dormance", "--departement", "35", "--json", "--data-dir", dir]);
  assert.equal(code, 0);

  const document = JSON.parse(stdout) as {
    seuilAnnees: number;
    borne: string;
    actives: number;
    nonDormantes: number;
    sansDate: number;
  };
  // Le seuil et la borne voyagent avec la mesure : un pourcentage de dormance sans son
  // critere ne veut rien dire, et l'ADR-013 refuse precisement ce genre de chiffre nu.
  assert.ok(document.seuilAnnees > 0);
  assert.match(document.borne, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(document.actives, 0);
  assert.equal(document.sansDate, 0);
});

test("normaliser sur une base sans contact dit quoi lancer, plutot que de ne rien dire", async (t) => {
  const dir = dataDir(t);
  await annuaire(["init", "--data-dir", dir]);
  const resultat = await annuaire(["normaliser", "--departement", "35", "--data-dir", dir]);
  assert.equal(resultat.code, 2);
  assert.match(resultat.stderr, /Aucun contact collecte/);
  assert.match(resultat.stderr, /annuaire decouvrir --departement 35/);
});

test("exporter sur une base vide n'ecrit pas un fichier trompeur", async (t) => {
  const dir = dataDir(t);
  await annuaire(["init", "--data-dir", dir]);
  const fichier = join(dir, "annuaire-35.csv");
  const resultat = await annuaire([
    "exporter", "--departement", "35", "--data-dir", dir, "--fichier", fichier,
  ]);
  assert.equal(resultat.code, 1);
  assert.match(resultat.stderr, /Aucun contact a exporter/);
  assert.equal(existsSync(fichier), false, "un CSV vide vaudrait un annuaire vide livre sans le dire");
});

test("un score minimal hors de [0, 1] est une erreur d'usage, pas d'execution", async (t) => {
  const dir = dataDir(t);
  await annuaire(["init", "--data-dir", dir]);
  // Forme collee : `--score-min -1` est refuse par parseArgs lui-meme, qui y voit une
  // option. C'est deja une erreur d'usage, mais pas celle qu'on veut verifier ici.
  for (const valeur of ["2", "-1", "beaucoup"]) {
    const resultat = await annuaire([
      "exporter", "--departement", "35", "--data-dir", dir, `--score-min=${valeur}`,
    ]);
    assert.equal(resultat.code, 2, `--score-min ${valeur}`);
    assert.match(resultat.stderr, /--score-min attend un nombre entre 0 et 1/);
  }
});

test("un fichier RNA inexistant est signale avant tout acces reseau", async (t) => {
  const dir = dataDir(t);
  const { code, stderr } = await annuaire(
    ["run", "--departement", "35", "--rna-file", join(dir, "absent.zip"), "--data-dir", dir],
    { ANNUAIRE_CONTACT_URL: "https://exemple.example/contact" },
  );
  assert.equal(code, 2);
  assert.match(stderr, /Fichier RNA introuvable/);
});

test("metrics --json produit un document exploitable sans journal parasite", async (t) => {
  const dir = dataDir(t);
  await annuaire(["run", "--departement", "35", "--data-dir", dir], {
    ANNUAIRE_CONTACT_URL: "https://exemple.example/contact",
  });

  const { code, stdout } = await annuaire(["metrics", "--json", "--data-dir", dir]);
  assert.equal(code, 0);

  const document = JSON.parse(stdout) as { version: string; runs: { run: number; departement: string }[] };
  // Compare a la constante, pas a un litteral : fige en dur, cette assertion casse a
  // chaque montee de version alors qu'elle ne dit rien de plus.
  assert.equal(document.version, VERSION);
  assert.equal(document.runs[0]?.departement, "35");
});

test("requeue exige une cible et refuse un etat inconnu", async (t) => {
  const dir = dataDir(t);
  await annuaire(["init", "--data-dir", dir]);

  const sansCible = await annuaire(["requeue", "--data-dir", dir]);
  assert.equal(sansCible.code, 2);
  assert.match(sansCible.stderr, /Un job est requis/);

  const etat = await annuaire(["requeue", "--state", "zombie", "--data-dir", dir]);
  assert.equal(etat.code, 2);
  assert.match(etat.stderr, /Etat inconnu/);
});

test("requeue sur un job introuvable explique pourquoi rien n'a bouge", async (t) => {
  const dir = dataDir(t);
  await annuaire(["init", "--data-dir", dir]);

  const { code, stdout } = await annuaire(["requeue", "4242", "--data-dir", dir]);
  assert.equal(code, 1);
  assert.match(stdout, /Aucun job remis en attente/);
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
    ANNUAIRE_CONTACT_URL: "https://exemple.example/contact",
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

/**
 * L'interface locale, lancee comme un utilisateur la lancerait — a une chose pres.
 * `--sans-navigateur` est obligatoire ici : depuis le lot 8, `annuaire ui` ouvre le
 * navigateur du poste, et une suite de tests qui en ouvrirait un par cas serait
 * insupportable. Le sous-processus precharge le garde-fou anti-reseau comme les autres :
 * le port ephemere sur lequel il ecoute est sur la boucle locale, seul hote autorise.
 */
function lancerUi(t: TestContext, args: readonly string[]): Promise<{ url: string; arreter: () => Promise<number> }> {
  const child = spawn(process.execPath, ["--import", GARDE_RESEAU, CLI, "ui", "--sans-navigateur", ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const fin = new Promise<number>((resolve) => child.on("close", (code) => resolve(code ?? -1)));
  t.after(async () => {
    child.kill("SIGINT");
    await fin;
  });

  return new Promise((resolve, reject) => {
    let stdout = "";
    child.stdout.on("data", (morceau: Buffer) => {
      stdout += morceau.toString();
      const trouve = /(http:\/\/127\.0\.0\.1:\d+\/\?jeton=[\w-]+)/.exec(stdout);
      if (trouve?.[1] !== undefined) {
        resolve({
          url: trouve[1],
          arreter: () => {
            child.kill("SIGINT");
            return fin;
          },
        });
      }
    });
    child.on("error", reject);
    child.on("close", () => reject(new Error(`l'interface n'a pas demarre : ${stdout}`)));
  });
}

test("annuaire ui sert l'interface sur la boucle locale, et s'arrete sur SIGINT", async (t) => {
  const dir = dataDir(t);
  const { url, arreter } = await lancerUi(t, ["--port", "0", "--data-dir", dir]);

  const refuse = await fetch(new URL(url).origin + "/");
  assert.equal(refuse.status, 401, "le jeton n'est pas decoratif");

  const ouverte = await fetch(url, { redirect: "manual" });
  assert.equal(ouverte.status, 303);

  const sortie = await arreter();
  if (SIGNAUX_POSIX) {
    assert.equal(sortie, 0, "Ctrl+C doit rendre la main proprement");
  }
  // Sous Windows, aucun process ne peut delivrer un Ctrl+C a un autre depuis Node : le
  // `kill` y devient un `TerminateProcess`, qui ne declenche pas la sortie propre et
  // n'aurait donc rien a verifier. Tout ce qui precede — l'interface sert, le jeton n'est
  // pas decoratif — reste teste ici sur les deux systemes, et l'arret propre lui-meme est
  // couvert partout par les tests du pilote, qui l'exercent en memoire (« arreter propage
  // le signal, et l'interruption n'est pas un echec »).
});

test("un port invalide echoue avant d'ouvrir quoi que ce soit", async (t) => {
  const resultat = await annuaire(["ui", "--port", "quatre-vingt", "--data-dir", dataDir(t)]);
  assert.equal(resultat.code, 2);
  assert.match(resultat.stderr, /--port attend un entier/);
});

test("INVARIANT §4.8 : une commande qui n'est pas « purge » purge quand meme au demarrage", async (t) => {
  // L'appel vivait dans cinq fonctions sur dix-neuf, et `exporter` n'en faisait pas
  // partie — la seule commande dont la sortie quitte la machine pouvait donc livrer un
  // CSV portant des contacts de plus de trois ans. Ce test vise `exporter` justement
  // parce que c'est celle-la, et qu'aucune liste tenue a la main ne doit plus decider.
  const dir = dataDir(t);
  const init = await annuaire(["init", "--data-dir", dir]);
  assert.equal(init.code, 0, init.stderr);

  const { openDatabase } = await import("../src/db/index.ts");
  const { toIso } = await import("../src/clock.ts");
  const base = join(dir, "annuaire.sqlite");

  const db = openDatabase(base);
  const vieux = toIso(Date.now() - 4 * 365 * 86_400_000);
  const recent = toIso(Date.now());
  db.prepare(
    "INSERT INTO commune (code_insee, nom, departement, created_at, updated_at) VALUES ('35001', 'X', '35', ?, ?)",
  ).run(recent, recent);
  for (const [valeur, date] of [["vieux@x.example", vieux], ["recent@x.example", recent]] as const) {
    db.prepare(
      `INSERT INTO contact (code_insee, kind, valeur, valeur_normalisee, source_url,
                            methode_extraction, confiance, collected_at)
       VALUES ('35001', 'email', ?, ?, 'https://mairie.example/a', 'dom:mailto', 0.8, ?)`,
    ).run(valeur, valeur, date);
  }
  db.close();

  const exporter = await annuaire(["exporter", "--departement", "35", "--data-dir", dir]);
  assert.equal(exporter.code, 0, exporter.stderr);

  const relu = openDatabase(base);
  const restants = relu
    .prepare("SELECT valeur_normalisee FROM contact ORDER BY valeur_normalisee")
    .all() as { valeur_normalisee: string }[];
  relu.close();

  assert.deepEqual(
    restants.map((ligne) => ligne.valeur_normalisee),
    ["recent@x.example"],
    "le contact de plus de trois ans devait disparaitre sans qu'on ait lance « purge »",
  );
  assert.doesNotMatch(exporter.stdout, /vieux@x\.example/);
});

test("INTERDIT §5 : « annuaire fetch » refuse un reseau social", async (t) => {
  // Les trois chemins de crawl ecartent bien ces hotes ; cette commande de diagnostic,
  // elle, les laissait passer — et ce qu'elle telecharge entre dans le cache, d'ou le
  // rejeu peut le relire. Le refus doit tomber avant toute requete.
  const dir = dataDir(t);
  for (const url of [
    "https://www.facebook.com/mairie",
    "https://fr.linkedin.com/company/x",
    "https://www.instagram.com/x/",
  ]) {
    const resultat = await annuaire(["fetch", url, "--data-dir", dir]);
    assert.equal(resultat.code, 2, `${url} aurait du etre refuse`);
    assert.match(resultat.stderr, /reseau social/);
  }
});

test("« decouvrir » refuse un departement hors du champ du RNA, comme « run »", async (t) => {
  // Cette commande collecte, et elle passait par un controle de forme qui avait perdu le
  // refus d'Alsace-Moselle : le motif etait recopie au lieu d'etre partage.
  const dir = dataDir(t);
  await annuaire(["init", "--data-dir", dir]);
  const resultat = await annuaire(["decouvrir", "--departement", "67", "--data-dir", dir]);
  assert.equal(resultat.code, 2);
  assert.match(resultat.stderr, /droit local d'Alsace-Moselle/);
});

test("« decouvrir » sur une base sans mairie oriente vers l'amorce", async (t) => {
  const dir = dataDir(t);
  await annuaire(["init", "--data-dir", dir]);
  const resultat = await annuaire(["decouvrir", "--departement", "35", "--data-dir", dir]);
  assert.equal(resultat.code, 2);
  assert.match(resultat.stderr, /Aucune URL de mairie/);
  assert.match(resultat.stderr, /annuaire run --departement 35/);
});

test("« contacts » liste ce qui a ete collecte, avec sa provenance", async (t) => {
  const dir = dataDir(t);
  await annuaire(["init", "--data-dir", dir]);

  const { openDatabase } = await import("../src/db/index.ts");
  const db = openDatabase(join(dir, "annuaire.sqlite"));
  db.prepare(
    "INSERT INTO commune (code_insee, nom, departement, created_at, updated_at) " +
      "VALUES ('35047', 'Bruz', '35', 't', 't')",
  ).run();
  db.prepare(
    `INSERT INTO contact (code_insee, kind, valeur, valeur_normalisee, source_url,
                          methode_extraction, confiance, collected_at)
     VALUES ('35047', 'email', 'contact@asso.example', 'contact@asso.example',
             'https://bruz.example/assos', 'dom:mailto', 0.9, '2026-08-01T00:00:00.000Z')`,
  ).run();
  db.close();

  const texte = await annuaire(["contacts", "--departement", "35", "--data-dir", dir]);
  assert.equal(texte.code, 0, texte.stderr);
  assert.match(texte.stdout, /contact@asso\.example/);

  const json = await annuaire(["contacts", "--departement", "35", "--json", "--data-dir", dir]);
  assert.equal(json.code, 0, json.stderr);
  const lignes = JSON.parse(json.stdout) as { source_url: string; methode_extraction: string }[];
  assert.equal(lignes[0]?.source_url, "https://bruz.example/assos", "la provenance doit sortir (§4.5)");
  assert.equal(lignes[0]?.methode_extraction, "dom:mailto");
});
