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

/**
 * Specifieurs importes par un module, quelle que soit la forme : `import ... from`,
 * `import(...)` dynamique, `require(...)`.
 *
 * Comparer la source a la chaine `"node:dns"` — guillemets compris — etait le trou le
 * plus serieux de ce fichier : `import dns from "node:dns/promises"` ne la contient pas,
 * et c'est precisement le module de la seconde porte de sortie (ADR-017). On extrait
 * donc le specifieur, et on le compare au module **et a son prefixe de sous-chemin**.
 */
function specifieursImportes(source: string): string[] {
  const trouves: string[] = [];
  const motif = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']([^"']+)["']/g;
  for (const trouve of source.matchAll(motif)) {
    if (trouve[1] !== undefined) trouves.push(trouve[1]);
  }
  return trouves;
}

function importe(source: string, module: string): boolean {
  return specifieursImportes(source).some((spec) => spec === module || spec.startsWith(`${module}/`));
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

    // Le lookbehind ci-dessus laisse passer `client.fetch(...)`, ce qui est voulu — mais
    // il laissait passer `globalThis.fetch(...)` du meme geste, soit la porte de sortie
    // contournee en un mot.
    for (const detour of [/\bglobalThis\s*\.\s*fetch\b/, /\bglobalThis\s*\[\s*""\s*\]/]) {
      if (detour.test(code)) interdits.push({ fichier: relatif, motif: "acces indirect a fetch" });
    }

    // `node:dns` est entre dans cette liste au lot 5 : la resolution MX de l'etape [7]
    // est une seconde sortie reseau, et elle doit rester dans src/http/ pour la meme
    // raison que la premiere — un seul endroit ou l'on sait ce qui part de la machine.
    // `node:http2` et `node:dgram` manquaient : `http2.connect()` sort tout autant sur
    // Internet, et passait le test comme le garde-fou de la suite.
    for (const module of [
      "node:http",
      "node:https",
      "node:http2",
      "node:net",
      "node:tls",
      "node:dns",
      "node:dgram",
      "undici",
    ]) {
      // Seule exception, et elle est nominative : la porte d'entree a besoin de
      // `node:http` pour ecouter. Le test suivant verifie qu'elle ne s'en sert pas pour
      // appeler. Une allowlist d'un seul fichier reste une allowlist : y ajouter une
      // seconde ligne devrait couter la meme discussion que la premiere.
      if (relatif === PORTE_ENTREE && module === "node:http") continue;
      if (importe(source, module)) {
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

test("INVARIANT §4.3 : le plancher de deux secondes ne se parametre pas depuis src/", () => {
  // `DomainThrottle` accepte `minDelayMs`, et son commentaire dit que c'est « pour les
  // tests ». Un commentaire n'empeche rien : `new DomainThrottle({ minDelayMs: 200 })`
  // dans src/app.ts laissait les 460 tests verts. Idem pour `fetchImpl`, qui permettrait
  // de court-circuiter la porte de sortie sans jamais l'importer.
  for (const fichier of fichiersSource(SRC)) {
    const code = codeEffectif(readFileSync(fichier, "utf8"));
    const relatif = relative(RACINE, fichier);
    assert.doesNotMatch(
      code,
      /new\s+DomainThrottle\s*\(\s*\{/,
      `${relatif} : le delai entre requetes est un invariant, il ne se passe pas au constructeur`,
    );
    assert.doesNotMatch(
      code,
      /fetchImpl\s*:/,
      `${relatif} : l'implementation de fetch n'est substituable que depuis les tests`,
    );
  }
});

test("le detecteur d'imports reseau attrape toutes les formes", () => {
  // Ce detecteur est le seul gardien de la porte de sortie ; il n'etait teste sur rien.
  const formes = [
    'import dns from "node:dns/promises";',
    "const h = await import('node:https');",
    'const n = require("node:net");',
    'import { connect } from "node:http2";',
    "import dgram from 'node:dgram';",
  ];
  for (const forme of formes) {
    const module = /["']([^"']+)["']/.exec(forme)?.[1]?.split("/")[0] ?? "";
    const racine = forme.includes("node:dns") ? "node:dns" : module;
    assert.ok(importe(forme, racine), `forme non detectee : ${forme}`);
  }
  assert.equal(importe('import { x } from "./voisin.ts";', "node:net"), false);
});

test("tout sous-processus de la suite precharge le garde-fou anti-reseau", () => {
  // `npm test` precharge `pas-de-reseau.ts`, mais un `spawn` ouvre un processus neuf qui
  // n'en herite pas. Deux fichiers l'avaient oublie ; les fixtures visees ne sortaient
  // pas sur le reseau, mais c'etait une propriete du moment, ecrite nulle part. Ce test
  // est ce qui empeche le prochain oubli.
  const manquants: string[] = [];
  for (const fichier of fichiersSource(join(RACINE, "test"))) {
    const relatif = relative(RACINE, fichier);
    const code = codeEffectif(readFileSync(fichier, "utf8"));
    if (!/\b(?:spawn|fork|execFile)\s*\(/.test(code)) continue;
    // La chaine du chemin disparait avec `codeEffectif` : on relit la source brute.
    const source = readFileSync(fichier, "utf8");
    if (!source.includes("pas-de-reseau.ts")) manquants.push(relatif);
  }

  assert.deepEqual(
    manquants,
    [],
    "Un sous-processus qui ne precharge pas test/helpers/pas-de-reseau.ts peut sortir sur Internet.",
  );
});

test("la porte d'entree ecoute, et n'appelle jamais", () => {
  const code = codeEffectif(readFileSync(join(RACINE, PORTE_ENTREE), "utf8"));

  // `createServer` est le seul usage legitime de node:http ici. `request` et `get`
  // emettraient une requete sortante hors de src/http/, donc sans robots.txt, sans
  // throttle et sans User-Agent identifiable.
  assert.match(code, /createServer/, "la porte d'entree doit servir a ecouter");
  // La destructuration echappait aux motifs : `const { get, request } = http;` puis
  // `get(url)` n'est ni `http.get(` ni `request(`.
  assert.doesNotMatch(
    code,
    /\{[^}]*\b(?:get|request)\b[^}]*\}\s*=\s*\w*http/,
    "src/ui/serveur.ts ne doit pas extraire de client de node:http",
  );
  for (const interdit of [/\brequest\s*\(/, /\bhttp\.get\s*\(/, /(?<![.\w#])fetch\s*\(/]) {
    assert.doesNotMatch(
      code,
      interdit,
      "src/ui/serveur.ts ne doit qu'ecouter : tout appel sortant passe par src/http/",
    );
  }
});

/**
 * Porte de sortie **processus** (lot 8). Ouvrir le navigateur de l'utilisateur est la
 * seule chose que l'outil demande au systeme d'executer, et il n'y a pas de raison que
 * cela se repande : un `spawn` egare est un contournement possible de tout le reste.
 */
const PORTE_PROCESSUS = join("src", "ui", "navigateur.ts");

test("un seul module lance un processus, et jamais a travers un shell", () => {
  const interdits: string[] = [];

  for (const fichier of fichiersSource(SRC)) {
    const relatif = relative(RACINE, fichier);
    const source = readFileSync(fichier, "utf8");
    for (const module of ["node:child_process", "node:worker_threads"]) {
      // L'exemption est nominative **par module**, et non par fichier : sauter le
      // fichier entier laissait la porte importer `node:worker_threads` sans etre vue.
      if (relatif === PORTE_PROCESSUS && module === "node:child_process") continue;
      if (importe(source, module)) {
        interdits.push(`${relatif} importe ${module}`);
      }
    }
  }

  assert.deepEqual(
    interdits,
    [],
    `Lancer un processus passe par ${PORTE_PROCESSUS}, seul endroit ou l'on sait ce qui est execute.`,
  );

  // `cmd /c start "" <url>` est la recette repandue sous Windows, et sa citation est un
  // piege : un `&` dans l'URL y devient un separateur de commandes. L'argument doit
  // arriver au systeme sans passer par un interpreteur.
  const code = codeEffectif(readFileSync(join(RACINE, PORTE_PROCESSUS), "utf8"));
  assert.doesNotMatch(code, /shell\s*:/, "aucun shell : l'URL serait interpretee");
  assert.doesNotMatch(code, /\bexec\s*\(|\bexecSync\s*\(/, "exec passe par un shell");
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
    // Ces trois-la decrivent ce que `src/` contient — des exemples imprimes a
    // l'utilisateur, jamais des cibles de requete. Elles ne suivent donc pas le
    // renommage du corpus de test vers `.example`.
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

/**
 * Regles du lot 7. Le bundle CommonJS qui sert les trois emballages (ADR-022) impose deux
 * proprietes au code source ; les verifier ici les rend impossibles a perdre par
 * inadvertance, alors qu'un build casse ne se remarquerait qu'au moment d'une release.
 */
test("aucun await de premier niveau : le bundle CommonJS n'en accepterait pas", () => {
  // esbuild refuse de convertir un `await` de premier niveau vers le format CommonJS, et
  // l'outillage SEA execute son script principal comme un module CommonJS.
  const premierNiveau = /^await\s/m;
  const coupables: string[] = [];

  for (const fichier of fichiersSource(SRC)) {
    if (premierNiveau.test(codeEffectif(readFileSync(fichier, "utf8")))) {
      coupables.push(relative(RACINE, fichier));
    }
  }

  assert.deepEqual(
    coupables,
    [],
    "src/bin.ts appelle main() en .then() pour cette raison : un await de premier niveau " +
      "casserait la construction de l'executable et du paquet npm.",
  );
});

test("le point d'entree annonce par package.json est celui que la construction produit", () => {
  const pkg = JSON.parse(readFileSync(join(RACINE, "package.json"), "utf8")) as {
    bin: Record<string, string>;
    files: string[];
    scripts: Record<string, string>;
  };

  // `bin` ne peut pas pointer une source TypeScript : Node refuse de retirer les types
  // d'un fichier situe sous node_modules, ce qui est exactement le cas apres `npx`.
  assert.equal(pkg.bin["annuaire"], "./dist/annuaire.cjs");
  assert.ok(!pkg.bin["annuaire"].endsWith(".ts"), "npx ne sait pas executer du TypeScript");
  // `dist` en bloc emballerait aussi le node.exe vendorise et l'executable Windows :
  // 71 Mo publies au lieu de 124 Ko. Le paquet nomme ce qu'il embarque.
  assert.deepEqual(pkg.files, ["dist/annuaire.cjs", "dist/assets"]);
  assert.ok(pkg.files.includes(pkg.bin["annuaire"].replace("./", "")), "le bundle doit etre publie");
  assert.match(pkg.scripts["prepack"] ?? "", /build/, "npm pack doit reconstruire le bundle");
});

test("l'image Docker execute le bundle, et n'annonce aucun port", () => {
  const dockerfile = readFileSync(join(RACINE, "Dockerfile"), "utf8");
  const pkg = JSON.parse(readFileSync(join(RACINE, "package.json"), "utf8")) as {
    engines: { node: string };
  };

  const majeur = (pkg.engines.node.match(/(\d+)/) ?? [])[1];
  for (const image of dockerfile.match(/^FROM\s+node:(\S+)/gm) ?? []) {
    assert.match(image, new RegExp(`node:${majeur}`), `${image} s'ecarte de engines.node`);
  }

  assert.match(dockerfile, /ENTRYPOINT \["node", "\/app\/annuaire\.cjs"\]/);
  // Un EXPOSE annoncerait un port que l'ecoute sur 127.0.0.1 rend inatteignable depuis
  // l'hote : mieux vaut ne rien promettre que de promettre a faux (ADR-023).
  assert.doesNotMatch(dockerfile, /^EXPOSE/m, "l'image ne publie pas l'interface");
});

test("un seul script de construction sort sur le reseau, et seulement vers nodejs.org", () => {
  // La porte de sortie de src/http/ vaut pour le produit. La construction de l'executable
  // Windows telecharge le node.exe officiel : cette sortie est nominative, elle a lieu au
  // moment d'emballer, et ni src/ ni la suite de tests n'importent ce module (ADR-022).
  const scripts = join(RACINE, "scripts");
  const fetchGlobal = /(?<![.\w#])fetch\s*\(/;
  const coupables: string[] = [];

  for (const fichier of fichiersSource(scripts)) {
    const relatif = relative(RACINE, fichier);
    const source = readFileSync(fichier, "utf8");
    if (!fetchGlobal.test(codeEffectif(source))) continue;
    if (relatif !== join("scripts", "sea.ts")) {
      coupables.push(relatif);
      continue;
    }
    for (const url of source.match(/https?:\/\/[^\s"'`$]+/g) ?? []) {
      assert.ok(url.startsWith("https://nodejs.org/dist"), `URL inattendue dans ${relatif} : ${url}`);
    }
  }

  assert.deepEqual(coupables, [], "seul scripts/sea.ts peut telecharger, et seulement node.exe");
});

test("le code reste en syntaxe effacable, exigee par l'execution directe du TypeScript", () => {
  for (const fichier of fichiersSource(SRC)) {
    const code = codeEffectif(readFileSync(fichier, "utf8"));
    assert.ok(!/\benum\s+\w/.test(code), `${relative(RACINE, fichier)} utilise enum`);
    assert.ok(!/\bnamespace\s+\w/.test(code), `${relative(RACINE, fichier)} utilise namespace`);
  }
});
