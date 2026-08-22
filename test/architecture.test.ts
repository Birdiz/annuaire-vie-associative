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

/**
 * Porte d'entree de l'UI (lot 6). La regle ci-dessous vise le trafic **sortant** :
 * robots.txt, le delai de deux secondes et le User-Agent n'ont de sens que pour ce qui
 * part de la machine. Un serveur qui ecoute sur la boucle locale n'en releve pas — mais
 * il ne doit pas devenir un client par la bande, d'ou le test qui suit.
 */
const PORTE_ENTREE = join("src", "ui", "serveur.ts");

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

    // `node:dns` est entre dans cette liste au lot 5 : la resolution MX de l'etape [7]
    // est une seconde sortie reseau, et elle doit rester dans src/http/ pour la meme
    // raison que la premiere — un seul endroit ou l'on sait ce qui part de la machine.
    for (const module of ["node:http", "node:https", "node:net", "node:tls", "node:dns", "undici"]) {
      // Seule exception, et elle est nominative : la porte d'entree a besoin de
      // `node:http` pour ecouter. Le test suivant verifie qu'elle ne s'en sert pas pour
      // appeler. Une allowlist d'un seul fichier reste une allowlist : y ajouter une
      // seconde ligne devrait couter la meme discussion que la premiere.
      if (relatif === PORTE_ENTREE && module === "node:http") continue;
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

test("la porte d'entree ecoute, et n'appelle jamais", () => {
  const code = codeEffectif(readFileSync(join(RACINE, PORTE_ENTREE), "utf8"));

  // `createServer` est le seul usage legitime de node:http ici. `request` et `get`
  // emettraient une requete sortante hors de src/http/, donc sans robots.txt, sans
  // throttle et sans User-Agent identifiable.
  assert.match(code, /createServer/, "la porte d'entree doit servir a ecouter");
  for (const interdit of [/\brequest\s*\(/, /\bhttp\.get\s*\(/, /(?<![.\w#])fetch\s*\(/]) {
    assert.doesNotMatch(
      code,
      interdit,
      "src/ui/serveur.ts ne doit qu'ecouter : tout appel sortant passe par src/http/",
    );
  }
});

test("l'UI ne reference aucune ressource distante", () => {
  // htmx est servi depuis cette machine. Un `<script src="https://...">` ferait sortir
  // l'outil sur le reseau a l'ouverture d'un ecran — ce que le local-first interdit — et
  // laisserait chez un tiers la trace de chaque consultation.
  const distante = /(?:src|href)\s*=\s*["'](?:https?:)?\/\//;

  for (const fichier of fichiersSource(join(SRC, "ui"))) {
    const source = readFileSync(fichier, "utf8");
    assert.doesNotMatch(
      source,
      distante,
      `${relative(RACINE, fichier)} pointe vers une ressource distante : l'UI est hors ligne`,
    );
  }
});

test("node-html-parser n'est importe que par l'adaptateur DOM", () => {
  // Meme logique que la porte de sortie reseau : la dependance reste remplacable, et
  // `css-select`, tire transitivement, n'est jamais atteint. Ses accesseurs `.text`
  // restituent en outre le contenu des <script> et collent deux cellules voisines, ce
  // qui peut fabriquer un numero de telephone inexistant.
  const adaptateur = join("src", "parse", "html.ts");
  const interdits: string[] = [];

  for (const fichier of fichiersSource(SRC)) {
    const relatif = relative(RACINE, fichier);
    if (relatif === adaptateur) continue;
    const source = readFileSync(fichier, "utf8");
    if (source.includes('"node-html-parser"') || source.includes("'node-html-parser'")) {
      interdits.push(relatif);
    }
  }

  assert.deepEqual(interdits, [], "Le parseur DOM ne s'importe que depuis src/parse/html.ts.");
});

test("la resolution MX passe par l'objet du module dns, seul que setServers reconfigure", () => {
  // `node:dns/promises` porte ses methodes sur un objet ; `resolveMx` s'en sert par
  // `this`. Importee en binding nomme, elle retombe sur les serveurs du systeme et
  // echappe a `setServers` — donc au garde-fou de test/helpers/pas-de-reseau.ts, qui
  // pointe le resolveur par defaut vers un port mort. La suite de tests sortirait alors
  // reellement sur Internet en se croyant confinee : c'est precisement le genre de
  // regression qu'aucun test de comportement ne rattrape.
  const source = readFileSync(join(SRC, "http", "dns.ts"), "utf8");

  assert.doesNotMatch(
    source,
    /import\s*\{[^}]*\b(?:resolveMx|setServers)\b[^}]*\}\s*from\s*["']node:dns/,
    "importer l'objet du module, pas la fonction nue",
  );
  assert.match(
    source,
    /import\s+\w+\s+from\s+["']node:dns\/promises["']/,
    "l'import par defaut est ce qui rend le garde-fou de test efficace",
  );

  const garde = readFileSync(join(RACINE, "test", "helpers", "pas-de-reseau.ts"), "utf8");
  assert.match(
    garde,
    /\.setServers\(/,
    "le garde-fou doit reconfigurer le resolveur par defaut, et le faire sur l'objet",
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
    // Lot 6 : la porte d'entree annonce sa propre adresse d'ecoute, qui est la constante
    // definie juste au-dessus dans le meme fichier. L'entree est nominative pour que
    // l'exception reste visible — elle ne couvre pas une interpolation quelconque.
    "http://${ADRESSE_ECOUTE}",
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
