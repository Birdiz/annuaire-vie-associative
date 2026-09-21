/**
 * Generation de la liste de prenoms embarquee — `src/normalisation/prenoms.ts`.
 *
 * Outil de developpement, hors du bundle, comme `build.ts`. Il **ne telecharge rien** :
 * `sea.ts` reste le seul script qui sorte sur le reseau. Le fichier source se recupere a la
 * main et se range sous `data/prenoms/`, que `.gitignore` exclut :
 *
 *   https://www.insee.fr/fr/statistiques/fichier/8595130/prenoms-2025-nat_csv.zip
 *
 * C'est un fichier **statistique** — des effectifs de naissances par prenom, arrondis par
 * l'INSEE au multiple de 5 — et non une donnee collectee sur des personnes. Il est diffuse
 * sous Licence Ouverte 2.0 ; la mention de source vit dans la constante produite, et dans
 * le README.
 *
 * Usage : `node scripts/prenoms.ts [--seuil <n>] [--source <csv>] [--sortie <fichier.ts>]`
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { normaliserNom } from "../src/texte.ts";
import { MOTS_DE_COMMERCE, MOTS_DE_STRUCTURE } from "../src/normalisation/plausibilite.ts";

const RACINE = fileURLToPath(new URL("..", import.meta.url));

/** L'edition lue, et son empreinte : une autre edition se regenere explicitement. */
export const SOURCE = "INSEE, Fichier des prénoms, édition 2025 (naissances 1900-2025), Licence Ouverte 2.0";
export const SOURCE_SHA256 = "5ec80c06cd9266cc5680885c6a219148bcdfaa53d65086f4ea9d2c584431fbfd";
const SOURCE_PAR_DEFAUT = join(RACINE, "data", "prenoms", "prenoms-2025-nat.csv");
const SORTIE_PAR_DEFAUT = join(RACINE, "src", "normalisation", "prenoms.ts");

/**
 * Naissances cumulees en deca desquelles un prenom n'entre pas dans la liste. Fixe par la
 * mesure du lot 12 (ADR-036) : le plus petit seuil qui ne fasse rejeter aucun nom du RNA,
 * a poids tenable.
 */
export const SEUIL_PAR_DEFAUT = 2000;

/**
 * Prenoms qui sont aussi des mots de structure ou de lieu, et qu'une page ecrit seuls pour
 * nommer autre chose qu'une personne : « Harmonie » est une fanfare avant d'etre une
 * prenommee, « Esperance » un club de football, « Avril » un mois.
 *
 * Les listes de vocabulaire de `plausibilite.ts` s'y ajoutent a la generation : un mot qui
 * annonce une structure ne peut pas, en meme temps, designer une personne.
 */
export const EXCLUS: readonly string[] = [
  // Vertus et mots qui nomment des clubs, des fanfares, des patronages.
  "harmonie", "esperance", "etoile", "victoire", "aurore", "concorde", "renaissance", "liberte",
  "avenir", "union", "amitie", "alliance", "joie", "paix", "fraternite", "constance", "prudence",
  // Pays, regions, mers.
  "france", "marine", "normandie", "bretagne", "provence", "savoie", "corse",
  // Mois : « Avril », « Mai », « Juin » ouvrent des libelles d'agenda.
  "janvier", "fevrier", "mars", "avril", "mai", "juin", "juillet", "aout", "septembre",
  "octobre", "novembre", "decembre",
];

/** Jours de la semaine : aucun n'est un prenom repandu, mais la regle se garde seule. */
const JOURS: readonly string[] = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];

export type Generation = { prenoms: string[]; seuil: number; sourceSha256: string };

/**
 * Lit le fichier national et rend la liste, triee, sans doublon.
 *
 * Les prenoms composes (« JEAN-PIERRE ») n'y entrent pas : leurs parties y sont, et c'est
 * sur elles que la detection raisonne. Les variantes accentuees se confondent apres
 * normalisation — « ANDRÉ » et « ANDRE » cumulent leurs naissances.
 */
export function generer(csv: string, seuil: number): string[] {
  const totaux = new Map<string, number>();
  for (const ligne of csv.split(/\r?\n/).slice(1)) {
    if (ligne === "") continue;
    const [, prenom = "", , valeur = "0"] = ligne.split(";");
    // `_PRENOMS_RARES` regroupe ce que le secret statistique masque : ce n'est pas un nom.
    if (prenom.startsWith("_")) continue;
    const normalise = normaliserNom(prenom);
    if (!/^[a-z]{3,}$/.test(normalise)) continue;
    totaux.set(normalise, (totaux.get(normalise) ?? 0) + Number(valeur));
  }

  const exclus = new Set<string>([...EXCLUS, ...JOURS]);
  for (const mot of [...MOTS_DE_STRUCTURE, ...MOTS_DE_COMMERCE]) {
    if (!mot.includes(" ")) exclus.add(mot);
  }

  return [...totaux]
    .filter(([prenom, total]) => total >= seuil && !exclus.has(prenom))
    .map(([prenom]) => prenom)
    .sort();
}

/** Le module TypeScript produit. Une ligne de texte par centaine de caracteres, pour la revue. */
export function rendreModule(prenoms: readonly string[], seuil: number, sourceSha256: string): string {
  const liste = prenoms.join(" ");
  const empreinte = createHash("sha256").update(liste, "utf8").digest("hex");
  const lignes: string[] = [];
  let courante = "";
  for (const prenom of prenoms) {
    if (courante !== "" && courante.length + prenom.length + 1 > 96) {
      lignes.push(courante);
      courante = prenom;
    } else {
      courante = courante === "" ? prenom : `${courante} ${prenom}`;
    }
  }
  if (courante !== "") lignes.push(courante);

  return `/**
 * Prenoms frequents en France. **Fichier genere** par \`node scripts/prenoms.ts\` : ne pas
 * le modifier a la main, le regenerer.
 *
 * Il sert a une seule question — ce segment nomme-t-il une personne ? — et c'est ce qui
 * justifie son poids (ADR-036) : sans lui, « Christophe Durand » ne se distingue pas de
 * « Trail Urbain », ni « Pierre » seul d'un nom de club.
 *
 * Source : ${SOURCE}. Effectifs cumules sur toutes les annees, prenoms d'au moins
 * ${seuil} naissances, normalises (minuscules, sans accents), composes exclus — leurs
 * parties y sont —, et sans les prenoms qui sont aussi des mots de structure (voir
 * \`EXCLUS\` dans le script).
 *
 * Un test recalcule \`PRENOMS_SHA256\` : une retouche a la main, accidentelle ou non, fait
 * echouer \`npm run check\` plutot que de passer inapercue dans une liste que personne ne
 * relit.
 */
export const PRENOMS_SOURCE = ${JSON.stringify(SOURCE)};
export const PRENOMS_SOURCE_SHA256 = "${sourceSha256}";
export const PRENOMS_SEUIL = ${seuil};
export const PRENOMS_SHA256 = "${empreinte}";

export const PRENOMS = \`
${lignes.join("\n")}
\`.trim().replace(/\\s+/g, " ");
`;
}

function main(): void {
  const { values } = parseArgs({
    options: {
      seuil: { type: "string" },
      source: { type: "string" },
      sortie: { type: "string" },
    },
  });
  const seuil = values.seuil === undefined ? SEUIL_PAR_DEFAUT : Number(values.seuil);
  if (!Number.isInteger(seuil) || seuil < 1) throw new Error(`Seuil invalide : ${values.seuil}`);

  const chemin = values.source ?? SOURCE_PAR_DEFAUT;
  const brut = readFileSync(chemin);
  const empreinte = createHash("sha256").update(brut).digest("hex");
  if (empreinte !== SOURCE_SHA256) {
    throw new Error(
      `Le fichier ${chemin} n'est pas l'edition attendue (SHA-256 ${empreinte}). ` +
        "Une autre edition se declare dans ce script, SOURCE et SOURCE_SHA256 compris.",
    );
  }

  const prenoms = generer(brut.toString("utf8"), seuil);
  const sortie = values.sortie ?? SORTIE_PAR_DEFAUT;
  writeFileSync(sortie, rendreModule(prenoms, seuil, empreinte));
  process.stdout.write(`${prenoms.length} prenoms au seuil ${seuil} -> ${sortie}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
