import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../src/version.ts";

/**
 * Regles d'architecture verifiees mecaniquement.
 *
 * Ces tests ne verifient pas un comportement mais une propriete du code source. Ils
 * existent parce que les invariants du §4 ne tiennent que s'ils sont impossibles a
 * contourner par inadvertance : une regle qu'on ne peut violer sans faire echouer la
 * suite de tests vaut mieux qu'une regle ecrite dans un fichier de conventions.
 */

const RACINE = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(RACINE, "src");

function fichiersSource(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entree) => {
    const chemin = join(dir, entree.name);
    if (entree.isDirectory()) return fichiersSource(chemin);
    return entree.isFile() && entree.name.endsWith(".ts") ? [chemin] : [];
  });
}

/** Retire commentaires et chaines, pour ne juger que du code effectif. */
function codeEffectif(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1 ")
    .replace(/`(?:[^`\\]|\\.)*`/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, '""')
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

test("aucun module hors de src/http n'emet de requete reseau", () => {
  const interdits: { fichier: string; motif: string }[] = [];

  // Le `fetch` global uniquement : `client.fetch(...)` est l'usage legitime de la
  // porte de sortie, c'est son contournement que l'on traque.
  const fetchGlobal = /(?<![.\w#])fetch\s*\(/;

  for (const fichier of fichiersSource(SRC)) {
    const relatif = relative(RACINE, fichier);
    if (relatif.startsWith(`src${sep}http${sep}`)) continue;

    const source = readFileSync(fichier, "utf8");
    const code = codeEffectif(source);

    if (fetchGlobal.test(code)) interdits.push({ fichier: relatif, motif: "appel au fetch global" });

    for (const module of ["node:http", "node:https", "node:net", "node:tls", "undici"]) {
      if (source.includes(`"${module}"`) || source.includes(`'${module}'`)) {
        interdits.push({ fichier: relatif, motif: `import de ${module}` });
      }
    }
  }

  assert.deepEqual(
    interdits,
    [],
    "Tout appel reseau doit passer par src/http/, seul endroit ou robots.txt, le " +
      "throttle et le User-Agent sont appliques.",
  );
});

test("le type FetchOutcome ne permet pas d'ignorer un blocage par robots.txt", () => {
  const source = readFileSync(join(SRC, "http", "client.ts"), "utf8");
  assert.match(
    source,
    /kind:\s*"blocked"/,
    "un refus robots doit etre un cas de retour explicite, pas une exception silencieuse",
  );
});

test("les invariants ne sont exposes dans aucune surface de configuration", () => {
  // Sur le code effectif : les commentaires ont le droit d'expliquer pourquoi ces
  // reglages n'existent pas, c'est meme le but.
  const config = codeEffectif(readFileSync(join(SRC, "config.ts"), "utf8"));

  for (const interdit of ["MIN_DELAY", "RETENTION", "robots", "Robots", "delayMs", "crawlDelay", "purge"]) {
    assert.ok(
      !config.includes(interdit),
      `config.ts mentionne « ${interdit} » : le delai entre requetes, le respect de ` +
        "robots.txt et la retention a trois ans ne doivent avoir aucune representation " +
        "configurable (§4).",
    );
  }
});

test("les valeurs des invariants sont bien celles du brief", async () => {
  const invariants = await import("../src/invariants.ts");
  assert.equal(invariants.MIN_DELAY_PER_DOMAIN_MS, 2_000, "§4.3");
  assert.equal(invariants.RETENTION_YEARS, 3, "§4.8");
  assert.deepEqual([...invariants.MOBILE_PREFIXES], ["06", "07"], "§4.6");
});

test("aucune adresse d'infrastructure de l'editeur n'est codee en dur", () => {
  // §5 : aucun appel sortant vers une infra de l'editeur (telemetrie, phone-home).
  const suspects = /https?:\/\/(?!(?:127\.0\.0\.1|localhost)\b)[^\s"'`)]+/g;
  const autorises = [
    "https://www.data.gouv.fr",
    // Sources du lot 2. Le miroir agrege du RNA et le dump du co-marquage sont les
    // seules portes que robots.txt laisse ouvertes (ADR-006).
    "https://data-pipeline-open.s3.sbg.io.cloud.ovh.net",
    "https://lecomarquage.service-public.gouv.fr",
    "https://exemple.fr",
    "https://mairie",
    "https://a.fr",
  ];

  for (const fichier of fichiersSource(SRC)) {
    for (const url of readFileSync(fichier, "utf8").match(suspects) ?? []) {
      assert.ok(
        autorises.some((prefixe) => url.startsWith(prefixe)),
        `URL inattendue dans ${relative(RACINE, fichier)} : ${url}`,
      );
    }
  }
});

test("la version annoncee dans le User-Agent suit celle de package.json", () => {
  const pkg = JSON.parse(readFileSync(join(RACINE, "package.json"), "utf8")) as { version: string };
  assert.equal(
    VERSION,
    pkg.version,
    "src/version.ts est fige a la main parce que l'executable unique ne peut pas lire " +
      "package.json : les deux doivent etre mis a jour ensemble.",
  );
});

test("le code reste en syntaxe effacable, exigee par l'execution directe du TypeScript", () => {
  for (const fichier of fichiersSource(SRC)) {
    const code = codeEffectif(readFileSync(fichier, "utf8"));
    assert.ok(!/\benum\s+\w/.test(code), `${relative(RACINE, fichier)} utilise enum`);
    assert.ok(!/\bnamespace\s+\w/.test(code), `${relative(RACINE, fichier)} utilise namespace`);
  }
});
