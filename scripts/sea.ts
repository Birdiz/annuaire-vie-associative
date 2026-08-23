/**
 * Executable Windows portable — l'emballage que le brief place en premier (§2).
 *
 * La recette est celle de l'outillage officiel Single Executable Application retenu par
 * l'ADR-001 : un bundle CommonJS (`scripts/build.ts`), une preparation en « blob », puis
 * l'injection de ce blob dans une copie de `node.exe` par `postject`.
 *
 * **Ce script sort sur le reseau, et c'est le seul du depot a le faire.** Il telecharge
 * le `node.exe` officiel de la version de Node qui l'execute, et verifie son empreinte
 * contre le `SHASUMS256.txt` publie a cote. Cette sortie a lieu a la construction, jamais
 * a l'execution de l'outil ni dans la suite de tests — qui n'importe pas ce module. La
 * porte de sortie de `src/http/` reste donc la seule qui existe pour le produit lui-meme
 * (ADR-022).
 *
 * **Pas de cache de code, pas d'instantane.** Les deux sont propres a la plateforme et a
 * l'architecture ou ils ont ete produits : les activer depuis un poste macOS pour une
 * cible Windows fabriquerait un executable qui echoue au demarrage.
 */
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { inject } from "postject";
import { construireBundle, DIST, NOM_BUNDLE } from "./build.ts";
import { formaterOctets } from "../src/texte.ts";
import { nomsAssets } from "../src/ui/assets.ts";

/**
 * La sentinelle est **lue dans le binaire cible**, jamais recopiee depuis la
 * documentation. Elle vaut `NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2` sur Node
 * 24.17 alors que la doc en montre une forme abregee : une constante figee ici aurait
 * fait echouer l'injection sur un message obscur, et se serait perimee a la version
 * suivante.
 */
export function lireSentinelle(binaire: Buffer): string {
  const trouvees = new Set(binaire.toString("latin1").match(/NODE_SEA_FUSE_[0-9a-f]+(?=:)/g) ?? []);
  if (trouvees.size !== 1) {
    throw new Error(
      `Sentinelle SEA introuvable ou ambigue dans le binaire (${trouvees.size} candidates)`,
    );
  }
  return [...trouvees][0] as string;
}

const PLATEFORME = "win-x64";

export type ConfigSea = {
  main: string;
  output: string;
  disableExperimentalSEAWarning: boolean;
  useSnapshot: boolean;
  useCodeCache: boolean;
  assets: Record<string, string>;
};

/**
 * Les ressources declarees sont exactement celles que `src/ui/assets.ts` sait servir : la
 * liste blanche du serveur et celle de l'executable sont la meme, et un test le verifie.
 * L'executable n'a pas de fichiers voisins a lire, c'est `sea.getAsset()` qui les rend.
 */
export function construireConfigSea(destination: string = DIST): ConfigSea {
  return {
    main: join(destination, NOM_BUNDLE),
    output: join(destination, "annuaire.blob"),
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    assets: Object.fromEntries(nomsAssets().map((nom) => [nom, join(destination, "assets", nom)])),
  };
}

/**
 * Retire la signature Authenticode d'un binaire PE.
 *
 * `node.exe` est signe par la fondation Node.js. Injecter le blob invalide cette
 * signature sans la supprimer : l'executable produit se presenterait alors a Windows
 * comme signe *et* corrompu, ce qui est pire qu'un executable simplement non signe. La
 * documentation de Node recommande de la retirer avant injection ; `signtool` n'existant
 * que sous Windows, on le fait ici, ou la table des certificats est par construction en
 * fin de fichier (specification PE).
 *
 * La fonction verifie ce qu'elle touche et refuse tout ce qui s'ecarte de la forme
 * attendue : mieux vaut ne pas produire d'executable que d'en produire un mutile.
 */
export function retirerSignature(binaire: Buffer): { binaire: Buffer; octetsRetires: number } {
  if (binaire.readUInt16LE(0) !== 0x5a4d) throw new Error("Ce fichier n'est pas un binaire PE (MZ absent)");

  const debutPe = binaire.readUInt32LE(0x3c);
  if (binaire.readUInt32LE(debutPe) !== 0x00004550) throw new Error("En-tete PE introuvable");

  // 4 octets de signature + 20 d'en-tete COFF, puis l'en-tete optionnel.
  const optionnel = debutPe + 24;
  const magie = binaire.readUInt16LE(optionnel);
  if (magie !== 0x20b) throw new Error(`Binaire PE32+ attendu, magie ${magie.toString(16)}`);

  // Repertoire de donnees no 4 : table des certificats. Son premier champ est un
  // decalage dans le fichier, et non une adresse virtuelle — c'est le seul du lot.
  const entree = optionnel + 112 + 4 * 8;
  const decalage = binaire.readUInt32LE(entree);
  const taille = binaire.readUInt32LE(entree + 4);
  if (decalage === 0 || taille === 0) return { binaire, octetsRetires: 0 };
  if (decalage + taille !== binaire.length) {
    throw new Error("La table des certificats n'est pas en fin de fichier : abandon");
  }

  const propre = Buffer.from(binaire.subarray(0, decalage));
  propre.writeUInt32LE(0, entree);
  propre.writeUInt32LE(0, entree + 4);
  return { binaire: propre, octetsRetires: taille };
}

async function telechargerNodeExe(version: string, cache: string): Promise<string> {
  const fichier = join(cache, `node-${version}-${PLATEFORME}.exe`);
  const base = `https://nodejs.org/dist/${version}`;

  const sommes = await (await fetch(`${base}/SHASUMS256.txt`)).text();
  const ligne = sommes.split("\n").find((l) => l.trim().endsWith(`${PLATEFORME}/node.exe`));
  if (ligne === undefined) throw new Error(`Aucune empreinte publiee pour ${version}/${PLATEFORME}`);
  const attendue = ligne.trim().split(/\s+/)[0];

  if (existsSync(fichier) && sha256(readFileSync(fichier)) === attendue) {
    process.stdout.write(`node.exe ${version} deja en cache, empreinte verifiee.\n`);
    return fichier;
  }

  process.stdout.write(`Telechargement de node.exe ${version} (${PLATEFORME})...\n`);
  const reponse = await fetch(`${base}/${PLATEFORME}/node.exe`);
  if (!reponse.ok) throw new Error(`Telechargement refuse : statut ${reponse.status}`);
  const octets = Buffer.from(await reponse.arrayBuffer());

  const obtenue = sha256(octets);
  if (obtenue !== attendue) {
    throw new Error(`Empreinte inattendue : ${obtenue} au lieu de ${attendue}`);
  }
  mkdirSync(cache, { recursive: true });
  writeFileSync(fichier, octets);
  process.stdout.write(`Empreinte verifiee : ${obtenue}\n`);
  return fichier;
}

function sha256(octets: Buffer): string {
  return createHash("sha256").update(octets).digest("hex");
}

async function construireExecutable(): Promise<void> {
  const bundle = await construireBundle(DIST);
  process.stdout.write(`Bundle : ${formaterOctets(bundle.octets)}\n`);

  const config = construireConfigSea(DIST);
  const cheminConfig = join(DIST, "sea-config.json");
  writeFileSync(cheminConfig, `${JSON.stringify(config, null, 2)}\n`);

  execFileSync(process.execPath, ["--experimental-sea-config", cheminConfig], { stdio: "inherit" });

  const version = `v${process.versions.node}`;
  const nodeExe = await telechargerNodeExe(version, join(DIST, "vendor"));

  const exe = join(DIST, "annuaire.exe");
  const signe = readFileSync(nodeExe);
  const nu = retirerSignature(signe);
  writeFileSync(exe, nu.binaire);
  chmodSync(exe, 0o755);
  process.stdout.write(`Signature Authenticode retiree : ${formaterOctets(nu.octetsRetires)}\n`);

  const sentinelle = lireSentinelle(nu.binaire);
  process.stdout.write(`Sentinelle lue dans le binaire : ${sentinelle}\n`);
  await inject(exe, "NODE_SEA_BLOB", readFileSync(config.output), { sentinelFuse: sentinelle });

  const octets = statSync(exe).size;
  process.stdout.write(
    `\n${exe}\n${formaterOctets(octets)} — Node ${version}, ${PLATEFORME}\n` +
      `SHA-256 : ${sha256(readFileSync(exe))}\n\n` +
      "Cet executable n'est pas signe : Windows SmartScreen previendra au premier lancement.\n",
  );
}

if (lanceDirectement()) {
  await construireExecutable();
}

/**
 * Vrai quand ce module est le point d'entree. La comparaison passe par `realpathSync` :
 * atteint par un lien symbolique — un `node_modules` lie, un depot range ailleurs —
 * `import.meta.filename` et `process.argv[1]` ne designent pas la meme chaine, et le
 * script se taisait sans rien dire.
 */
function lanceDirectement(): boolean {
  const argv = process.argv[1];
  if (argv === undefined) return false;
  try {
    return realpathSync(import.meta.filename) === realpathSync(argv);
  } catch {
    return import.meta.filename === argv;
  }
}
