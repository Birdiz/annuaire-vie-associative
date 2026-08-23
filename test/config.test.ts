import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadConfig,
  requireContactUrl,
  writeConfigTemplate,
  ecrireContactUrl,
  validerContactUrl,
  ConfigError,
} from "../src/config.ts";
import { makeTempDir } from "./helpers/tmp.ts";

function writeConfig(dir: string, content: unknown): string {
  const file = join(dir, "config.json");
  writeFileSync(file, JSON.stringify(content), "utf8");
  return file;
}

test("une installation non configuree charge des valeurs par defaut sans echouer", (t) => {
  const config = loadConfig(join(makeTempDir(t), "absent.json"), {});
  assert.equal(config.contactUrl, undefined);
  assert.equal(config.concurrency, 8);
  assert.deepEqual(config.llm, { provider: "none" });
});

test("l'environnement l'emporte sur le fichier", (t) => {
  const file = writeConfig(makeTempDir(t), { contactUrl: "https://fichier.example", concurrency: 2 });
  const config = loadConfig(file, { ANNUAIRE_CONTACT_URL: "https://env.example" });
  assert.equal(config.contactUrl, "https://env.example/");
  assert.equal(config.concurrency, 2);
});

test("requireContactUrl echoue tant que l'URL de contact manque", (t) => {
  const config = loadConfig(join(makeTempDir(t), "absent.json"), {});
  assert.throws(() => requireContactUrl(config), ConfigError);

  const ok = loadConfig(join(makeTempDir(t), "absent.json"), {
    ANNUAIRE_CONTACT_URL: "https://exemple.example/contact",
  });
  assert.equal(requireContactUrl(ok), "https://exemple.example/contact");
});

test("une URL de contact non absolue ou non http est refusee", (t) => {
  const dir = makeTempDir(t);
  for (const value of ["pas-une-url", "ftp://exemple.example", "mailto:a@b.example"]) {
    assert.throws(
      () => loadConfig(writeConfig(dir, { contactUrl: value }), {}),
      ConfigError,
      `${value} aurait du etre refusee`,
    );
  }
});

test("la concurrence est bornee", (t) => {
  const dir = makeTempDir(t);
  assert.throws(() => loadConfig(writeConfig(dir, { concurrency: 0 }), {}), ConfigError);
  assert.throws(() => loadConfig(writeConfig(dir, { concurrency: 99 }), {}), ConfigError);
  assert.throws(() => loadConfig(writeConfig(dir, { concurrency: 1.5 }), {}), ConfigError);
  assert.equal(loadConfig(writeConfig(dir, { concurrency: 16 }), {}).concurrency, 16);
});

test("tous les problemes de configuration sont rapportes en une fois", (t) => {
  const file = writeConfig(makeTempDir(t), { contactUrl: "pas-une-url", concurrency: 0 });
  try {
    loadConfig(file, {});
    assert.fail("aurait du echouer");
  } catch (error) {
    assert.ok(error instanceof ConfigError);
    assert.equal(error.problems.length, 2);
  }
});

test("le provider anthropic exige une cle, sinon le LLM reste desactive", (t) => {
  const dir = makeTempDir(t);
  assert.throws(() => loadConfig(writeConfig(dir, { llm: { provider: "anthropic" } }), {}), ConfigError);

  const config = loadConfig(writeConfig(dir, { llm: { provider: "anthropic", apiKey: "sk-test" } }), {});
  assert.deepEqual(config.llm, {
    provider: "anthropic",
    apiKey: "sk-test",
    model: "claude-haiku-4-5-20251001",
  });
});

test("un JSON invalide produit un message utilisable, pas une exception brute", (t) => {
  const file = join(makeTempDir(t), "config.json");
  writeFileSync(file, "{ pas du json", "utf8");
  assert.throws(() => loadConfig(file, {}), (error: unknown) => {
    assert.ok(error instanceof ConfigError);
    assert.match(error.message, /n'est pas un JSON valide/);
    return true;
  });
});

test("le gabarit de configuration n'ecrase jamais un fichier existant", (t) => {
  const file = join(makeTempDir(t), "config.json");

  assert.equal(writeConfigTemplate(file), true);
  const first = readFileSync(file, "utf8");

  assert.equal(writeConfigTemplate(file), false);
  assert.equal(readFileSync(file, "utf8"), first);

  // Le gabarit doit rester chargeable tel quel, sans URL de contact renseignee.
  assert.equal(loadConfig(file, {}).contactUrl, undefined);
});

/**
 * Lot 8 : l'URL de contact se renseigne depuis l'interface, sur une installation qui n'a
 * jamais vu d'editeur de texte. Ce qui compte est que le fichier n'y perde rien.
 */

test("ecrire l'URL de contact preserve le reste du fichier", (t) => {
  const file = join(makeTempDir(t), "config.json");
  writeConfigTemplate(file);

  const resultat = ecrireContactUrl(file, "  https://exemple.example/nous-ecrire  ");

  assert.deepEqual(resultat, { url: "https://exemple.example/nous-ecrire" });
  const relu = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  assert.equal(relu["contactUrl"], "https://exemple.example/nous-ecrire");
  assert.ok(Array.isArray(relu["_aide"]), "l'aide du gabarit ne doit pas disparaitre");
  assert.deepEqual(relu["llm"], { provider: "none" });
  assert.equal(loadConfig(file, {}).contactUrl, "https://exemple.example/nous-ecrire");
});

test("ecrire l'URL de contact cree le fichier quand il n'existe pas encore", (t) => {
  const file = join(makeTempDir(t), "config.json");

  assert.deepEqual(ecrireContactUrl(file, "https://exemple.example/contact"), {
    url: "https://exemple.example/contact",
  });
  assert.equal(loadConfig(file, {}).contactUrl, "https://exemple.example/contact");
});

test("une URL de contact invalide est refusee sans toucher au fichier", (t) => {
  const file = join(makeTempDir(t), "config.json");
  writeConfigTemplate(file);
  const avant = readFileSync(file, "utf8");

  // Le meme controle que le chargement : un User-Agent qui ne mene nulle part vaut un
  // User-Agent anonyme, que le §4.4 interdit.
  for (const saisie of ["mairie-de-bruzou", "ftp://exemple.example/contact", ""]) {
    const resultat = ecrireContactUrl(file, saisie);
    assert.ok("erreur" in resultat, saisie);
  }
  assert.equal(readFileSync(file, "utf8"), avant);
});

test("INVARIANT §4.4 : une URL de contact qui ne mene nulle part est refusee", () => {
  // Le controle ne portait que sur la forme absolue et le schema. Une adresse locale
  // rendait le User-Agent syntaxiquement conforme et fonctionnellement anonyme, ce qui
  // vide l'invariant de son objet : personne ne peut ecrire a « http://localhost ».
  for (const valeur of [
    "http://localhost",
    "http://localhost:8080/contact",
    "http://127.0.0.1/contact",
    "https://192.168.1.10/contact",
    "https://10.0.0.5/",
    "https://172.16.3.1/",
    "http://intranet",
    "http://[::1]/",
  ]) {
    const resultat = validerContactUrl(valeur);
    assert.ok("erreur" in resultat, `${valeur} aurait du etre refusee`);
  }
});

test("une URL de contact publique reste acceptee", () => {
  for (const valeur of ["https://mairie-bruz.example/contact", "http://exemple.example", "https://93.184.216.34/x"]) {
    const resultat = validerContactUrl(valeur);
    assert.ok("url" in resultat, `${valeur} aurait du etre acceptee`);
  }
});
