/**
 * Le nom lu dans le bloc qui porte le contact.
 *
 * Deuxieme temps de la cascade de nommage (ADR-033), et le seul qui soit une **lecture**
 * quand le RNA n'a rien su dire. Le rattachement, lui, ne reconnait que des noms qu'il
 * connait deja ; ici on lit ce que la page ecrit, sans pretendre que cela designe une
 * association du registre.
 *
 * **Fonction pure**, sans base ni DOM : le crawl et la passe de rattrapage l'appellent
 * a l'identique. Deux implementations feraient diverger les deux populations de contacts
 * sans que rien ne le signale, et personne ne saurait plus lequel des deux chemins a
 * produit un nom donne.
 *
 * Le plancher de `LONGUEUR_MIN_NOM` du rattachement ne s'applique pas ici. Il existe pour
 * eviter les **faux rattachements** — « ACCA » se trouve dans n'importe quelle page — or
 * le nom pressenti ne rattache rien. Lui imposer huit caracteres jetterait des noms courts
 * parfaitement legitimes.
 */

import { MOTIFS_NOM } from "../normalisation/classification.ts";
import { normaliserNom } from "../texte.ts";

/**
 * Constante du code, incrementee des que l'heuristique ci-dessous change. C'est elle qui
 * rend repondable « quels noms sont perimes », et qui sert de marqueur d'idempotence a la
 * passe de rattrapage.
 */
export const VERSION_NOM = 2;

export type NomPressenti = {
  nom: string;
  normalise: string;
  /** De quel cote du contact le segment a ete pris. */
  source: "bloc:avant" | "bloc:apres";
};

/**
 * On n'examine que les deux blocs les plus etroits.
 *
 * `contextesDe` les trie deja du plus etroit au plus large. Un bloc `article` porte le
 * texte de toute une section : y chercher un nom, c'est ramasser le titre de la page et le
 * coller a chacun des vingt contacts qu'elle contient.
 */
const CONTEXTES_EXAMINES = 2;

const LONGUEUR_MIN = 4;
const LONGUEUR_MAX = 80;
const MOTS_MAX = 10;
/** Au-dela, c'est une adresse postale ou un numero, pas un nom. */
const PART_CHIFFRES_MAX = 0.4;

/**
 * Les motifs d'`extraction.ts`, repris sans le drapeau `g` : on ne s'en sert ici que par
 * leur `source`, pour construire l'expression d'effacement.
 */
const EMAIL = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,24}/;
const TELEPHONE = /(?:\+33[\s.-]?|\b0)[1-9](?:[\s.-]?\d{2}){4}\b/;

/**
 * Ce qui separe deux informations dans un bloc. Le point n'y est pas : « J.-P. Martin »
 * et « Ste » y perdraient la moitie d'eux-memes.
 *
 * La suite de trois espaces compte parce que l'adaptateur DOM colle les cellules voisines
 * d'un tableau avec des espaces, et non avec une balise.
 */
const SEPARATEURS = /[\n\r|•·–—:;,]|\s{3,}/;

/**
 * Marqueurs de prose. Un segment qui en porte un est une phrase adressee au lecteur, pas
 * un nom de structure.
 *
 * **Ne jamais y mettre `pour`, `de`, `la` ni `des`** : « Association pour la sauvegarde du
 * patrimoine » est un nom parfaitement legitime, et c'est exactement le filtre trop zele
 * qui viderait le profil simple sans que personne ne comprenne pourquoi.
 */
const PROSE: readonly string[] = [
  "vous",
  "nous",
  "veuillez",
  "cliquez",
  "contactez",
  "merci",
  "rendez vous",
  "ouvert",
  "permanence",
  "horaires",
  "en savoir",
  "lire la suite",
  "plan du site",
  "mentions legales",
  "tous droits",
];

/**
 * Ce qui nomme une structure a coup sur, et passe donc avant tout filtre.
 *
 * Les motifs de `classification.ts` ne servent pas qu'a donner un type : ils affirment
 * que le texte **nomme une structure**. Sans ce laissez-passer, « Accueil de loisirs Les
 * Petites Mains » etait rejete par le mobilier de page — `accueil` y figure, teste en
 * prefixe — alors que c'est exactement le genre de ligne qu'une collectivite cherche, et
 * que le RNA ne connait jamais. Un test verifie qu'aucun motif n'est masque.
 */
function nommeUneStructure(normalise: string): boolean {
  const borne = ` ${normalise} `;
  return MOTIFS_NOM.some(([motif]) => borne.includes(` ${motif} `));
}

/**
 * Mobilier de page. Teste en **prefixe** et non en inclusion : « Amicale des secretaires »
 * est un nom, « Secretariat : » ne l'est pas.
 *
 * `mairie` et `hotel de ville` y figurent alors que « Mairie de Bruzou » est un nom : c'en
 * est un, mais ce n'est pas une association, et le laisser passer remettrait dans le
 * fichier simple les lignes que la branche « mairie » range deja proprement.
 */
const MOBILIER: readonly string[] = [
  "contact",
  "coordonnees",
  "telephone",
  "tel",
  "portable",
  "courriel",
  "email",
  "e mail",
  "e mails",
  "mail",
  "courrier electronique",
  "adresse",
  "secretariat",
  "president",
  "presidente",
  "secretaire",
  "tresorier",
  "responsable",
  "nous ecrire",
  "nous contacter",
  // Libelles de liens. Ils comptent double : dans « <td>Club de Bruz</td><td><a
  // href="mailto:...">ecrire</a></td> », le texte du lien s'intercale entre le nom et le
  // contact, et deviendrait sans cela le segment le plus proche — donc le nom.
  "ecrire",
  "contacter",
  "envoyer",
  "joindre",
  "cliquer",
  "ici",
  "lien",
  "voir",
  "plus d infos",
  "en savoir plus",
  "mairie",
  "hotel de ville",
  "renseignements",
];

/**
 * Mobilier rejete **seulement s'il est tout le segment**.
 *
 * « Accueil » seul est un lien de navigation ; « Accueil de loisirs », « Accueil
 * periscolaire », « Accueil de jeunes » sont des noms de structure. Le tester en prefixe
 * comme les autres jetait la moitie des accueils de loisirs d'un departement.
 */
const MOBILIER_EXACT: readonly string[] = ["accueil", "infos", "informations", "plan", "menu", "retour"];

/**
 * Civilites. Un bloc de contact nomme souvent la **personne** avant son adresse — « Mr
 * Michel GAUTHIER — gauthier.m6@free.fr ».
 *
 * Les retenir serait la pire combinaison possible : le profil simple ne porte pas la
 * colonne `regime`, et une ligne y presenterait alors le nom d'une personne physique et
 * son adresse personnelle comme s'il s'agissait d'une structure. Sur un departement reel,
 * 43 lignes etaient dans ce cas.
 *
 * Consequence voulue : ces contacts retombent sur le domaine, presque toujours une
 * messagerie grand public, donc hors du fichier simple. Ils restent dans le complet, ou
 * `regime` dit ce qu'ils sont.
 */
const CIVILITES: readonly string[] = [
  "m", "mr", "mme", "mlle", "monsieur", "madame", "mademoiselle", "dr", "pr", "me",
];

/**
 * Voies et lieux-dits. Un bloc de contact porte l'adresse postale a cote de l'adresse
 * electronique, et le segment le plus proche est souvent la premiere.
 */
const VOIE: readonly string[] = [
  "rue", "place", "avenue", "boulevard", "bd", "av", "impasse", "chemin", "route",
  "allee", "allees", "square", "quai", "cours", "lieu dit", "residence", "zone",
];

/**
 * Un nom de structure commence par une majuscule.
 *
 * Le signal le plus rentable trouve sur un departement reel : 16 % des noms retenus
 * commencaient par une minuscule, et c'etaient **tous** des fragments de phrase —
 * « bouquets et compositions vegetales », « participation au suivi de la scolarite ».
 * Aucune heuristique de longueur ou de vocabulaire ne les separait ; la casse, oui.
 *
 * L'article elide est admis : « l'Amicale des Meuniers » est un nom, et le rejeter pour
 * son apostrophe serait payer trop cher une regle par ailleurs juste.
 */
function commenceParUneMajuscule(segment: string): boolean {
  const sansArticle = segment.replace(/^(?:[ldj]'|le |la |les |aux? |du |des )/i, "").trimStart();
  const premiere = sansArticle.match(/\p{L}/u)?.[0];
  if (premiere === undefined) return false;
  return premiere === premiere.toUpperCase();
}

/**
 * Un segment qui commence par un chiffre n'est pas un nom de structure.
 *
 * Mesure sur le departement 88 : 22 des 965 lignes livrees s'appelaient « 8 Lauterupt - »,
 * « 2 Bas de Raumont - », « 12 personnes ». Ce sont des numeros de hameau et des
 * decomptes, jamais des noms.
 *
 * La regle precedente admettait le chiffre en tete pour ne pas perdre un hypothetique
 * « 4L Trophy ». Les donnees ont tranche : l'hypothese ne s'est jamais presentee, les
 * vingt-deux faux noms si.
 */
function commenceParUnChiffre(segment: string): boolean {
  return /^\s*\d/.test(segment);
}

/**
 * Une entite HTML non decodee trahit un fragment, jamais un nom.
 *
 * `&rsquo;` survit a l'analyse, et le `;` etant un separateur, le segment se coupe au
 * milieu de l'entite : « Plus d&rsquo », « a la mise a jour de l&rsquo ».
 */
function porteUneEntiteHtml(segment: string): boolean {
  return /&[a-z]{2,8}$|&[a-z]{2,8};|&#\d/i.test(segment);
}

/**
 * Une URL, un nom d'hote ou un nom de fichier ne nomment pas une structure.
 *
 * Les pages de mairie collent volontiers un lien a cote d'un contact, et le texte du lien
 * est parfois l'URL elle-meme : `//www.baguerpican.fr/wp-content/uploads/LOGO.png`,
 * `betton.echecs35.fr`, `monsite.fr`.
 */
function estUneUrl(segment: string): boolean {
  const bas = segment.toLowerCase();
  if (bas.includes("//") || bas.includes("www.")) return true;
  if (/\.(?:png|jpe?g|gif|svg|pdf|php|html?|aspx?)\b/.test(bas)) return true;
  // Un nom d'hote nu : que des etiquettes et des points, aucune espace.
  return /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(bas);
}

/**
 * Le segment est-il une adresse postale plutot qu'un nom ?
 *
 * Trois signaux, et pas un de plus — le filtre doit rester etroit. « 4L Trophy » et
 * « 1000 Sabords » commencent par un chiffre et sont pourtant des noms : c'est le code
 * postal (cinq chiffres) ou la conjonction numero + voie qui tranche.
 */
function estUneAdresse(normalise: string): boolean {
  // Le code postal s'ecrit « 35130 » comme « 35 130 » : les deux ouvrent une adresse.
  if (/^\d{5}\b/.test(normalise) || /^\d{2} ?\d{3}\b/.test(normalise)) return true;
  const borne = ` ${normalise} `;
  const voie = VOIE.some((mot) => borne.includes(` ${mot} `));
  return voie && (/^\d/.test(normalise) || VOIE.some((mot) => normalise.startsWith(`${mot} `)));
}

/**
 * Le nom que porte le bloc autour du contact, ou `undefined` si rien n'y ressemble.
 *
 * `empreinte` est ce qui a servi a reperer le contact dans la page : le `href` d'un
 * `mailto:`/`tel:`, ou le texte trouve par un motif. Pour un `href`, elle n'apparait pas
 * dans le texte du bloc — on retombe alors sur la position du premier contact efface.
 */
export function nomPressenti(
  contextes: readonly string[],
  empreinte: string,
): NomPressenti | undefined {
  for (const contexte of contextes.slice(0, CONTEXTES_EXAMINES)) {
    const trouve = depuisUnBloc(contexte, empreinte);
    if (trouve !== undefined) return trouve;
  }
  return undefined;
}

function depuisUnBloc(contexte: string, empreinte: string): NomPressenti | undefined {
  const { texte, coupure } = sansContacts(contexte, empreinte);
  if (coupure === -1) return undefined;

  // Le plus proche d'abord, en remontant vers la gauche, puis ce qui suit le contact.
  // « Associations sportives — Tennis Club de Bruzou — contact@... » doit rendre le club
  // et non la rubrique, et un contact en tete de bloc doit pouvoir regarder devant lui.
  const candidats: { segment: string; source: NomPressenti["source"] }[] = [
    ...decouper(texte.slice(0, coupure))
      .reverse()
      .map((segment) => ({ segment, source: "bloc:avant" as const })),
    ...decouper(texte.slice(coupure)).map((segment) => ({ segment, source: "bloc:apres" as const })),
  ];

  for (const { segment, source } of candidats) {
    if (acceptable(segment)) return { nom: segment, normalise: normaliserNom(segment), source };
  }
  return undefined;
}

/**
 * Efface les contacts du texte et rend la position ou se trouvait celui qu'on nomme.
 *
 * Les effacer tous, et pas seulement le notre : un bloc qui porte « Tennis Club —
 * 02 99 00 00 00 — contact@tennis.fr » ne doit pas laisser le numero devenir un candidat
 * au nom de la structure.
 */
function sansContacts(contexte: string, empreinte: string): { texte: string; coupure: number } {
  const direct = empreinte === "" ? -1 : contexte.indexOf(empreinte);

  let coupure = -1;
  const texte = contexte.replace(new RegExp(`${EMAIL.source}|${TELEPHONE.source}`, "g"), (trouve, decalage: number) => {
    // Le premier contact efface fait office de repere quand l'empreinte est un `href`,
    // absent du texte rendu.
    if (coupure === -1) coupure = decalage;
    return " ".repeat(trouve.length);
  });

  return { texte, coupure: direct === -1 ? coupure : direct };
}

function decouper(morceau: string): string[] {
  return morceau
    .split(SEPARATEURS)
    .map((segment) => segment.replace(/\s+/g, " ").trim())
    // Puces et chevrons de navigation : « >> Ecole Elementaire » est un nom precede d'un
    // ornement, pas un nom qui commence par « > ».
    .map((segment) => segment.replace(/^[>»«*+.\-–—\u2022\u00b7\s]+/, "").trim())
    .map((segment) => segment.replace(/[>«»*+\-–—\u2022\u00b7\s.,;:/]+$/, "").trim())
    .filter((segment) => segment !== "");
}

/**
 * Un segment est-il un nom de structure plausible ?
 *
 * On **rejette** plutot que de tronquer, toujours : couper un segment trop long
 * fabriquerait un nom qui n'a jamais existe sur aucune page.
 */
function acceptable(segment: string): boolean {
  const normalise = normaliserNom(segment);
  if (normalise.length < LONGUEUR_MIN || normalise.length > LONGUEUR_MAX) return false;
  if (normalise.split(" ").length > MOTS_MAX) return false;
  if (!/[a-z]/.test(normalise)) return false;

  const chiffres = (normalise.match(/\d/g) ?? []).length;
  if (chiffres / normalise.length > PART_CHIFFRES_MAX) return false;

  // Le laissez-passer passe avant les deux filtres : un motif de structure l'emporte sur
  // le mot de mobilier qui le commence.
  if (nommeUneStructure(normalise)) return true;

  if (PROSE.some((marqueur) => ` ${normalise} `.includes(` ${marqueur} `))) return false;
  if (MOBILIER_EXACT.includes(normalise)) return false;
  if (CIVILITES.some((mot) => normalise.startsWith(`${mot} `))) return false;
  if (estUneAdresse(normalise)) return false;
  if (estUneUrl(segment)) return false;
  if (commenceParUnChiffre(segment)) return false;
  if (porteUneEntiteHtml(segment)) return false;
  if (segment.includes("@")) return false;
  if (!commenceParUneMajuscule(segment)) return false;
  // Le pluriel compte : « Contacts » est le titre d'une rubrique aussi surement que
  // « Contact ».
  return !MOBILIER.some(
    (mot) =>
      normalise === mot ||
      normalise === `${mot}s` ||
      normalise.startsWith(`${mot} `) ||
      normalise.startsWith(`${mot}s `),
  );
}
