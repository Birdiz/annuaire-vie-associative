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
import { evoqueUnCommerce, evoqueUneStructure } from "../normalisation/plausibilite.ts";
import { designeUnePersonne, estUnNomDePersonne, porteUnePersonne } from "../normalisation/personne.ts";
import type { ContactExtrait } from "./extraction.ts";
import { normaliserNom } from "../texte.ts";
import { SOURCE_EMAIL, SOURCE_TELEPHONE, porteUnNumero } from "./motifs.ts";

/**
 * Constante du code, incrementee des que l'heuristique ci-dessous change. C'est elle qui
 * rend repondable « quels noms sont perimes », et qui sert de marqueur d'idempotence a la
 * passe de rattrapage.
 */
export const VERSION_NOM = 4;

/**
 * Ce que le nommage sait des communes : celle du contact, et toutes celles du departement.
 *
 * Le nom d'une commune voisine lu sur une page — « Coubon » sur le site du Puy, « Malrevers »
 * dans le tableau d'un service intercommunal — passait pour une structure : le filtre ne
 * connaissait que la commune du contact (ADR-035). Une chaine seule reste acceptee, pour les
 * appelants qui n'ont que celle-la.
 */
export type ContexteCommune = {
  nom: string;
  /** Noms normalises (`normaliserNom`) des communes du departement. */
  voisines: ReadonlySet<string>;
};

type Commune = string | ContexteCommune | undefined;

function nomDeLaCommune(commune: Commune): string | undefined {
  return typeof commune === "string" || commune === undefined ? commune : commune.nom;
}

export type NomPressenti = {
  nom: string;
  normalise: string;
  /**
   * D'ou le segment a ete pris : de part et d'autre du contact dans son bloc, ou du titre de
   * sa fiche (ADR-036).
   */
  source: "bloc:avant" | "bloc:apres" | "bloc:titre";
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
 * Les motifs de l'extraction, et non une copie : un numero que l'extraction voit et que
 * l'effacement ne voit pas reste dans le bloc, et devient un candidat au nom.
 */
const CONTACTS = new RegExp(`${SOURCE_EMAIL}|${SOURCE_TELEPHONE}`, "g");

/**
 * Ce qui separe deux informations dans un bloc. Le point n'y est pas : « J.-P. Martin »
 * et « Ste » y perdraient la moitie d'eux-memes.
 *
 * La suite de trois espaces compte parce que l'adaptateur DOM colle les cellules voisines
 * d'un tableau avec des espaces, et non avec une balise.
 */
const SEPARATEURS = /[\n\r|•·–—:;,/]|\s{3,}/;

/**
 * Libelles de champ qui separent deux informations aussi surement qu'un deux-points :
 * « SOCIETE de CHASSE President », « DURANDEL Nadine Tresoriere », « Julien Martinot Tel. ».
 * Une fiche d'annuaire les pose entre le nom de la structure et celui de la personne ; sans
 * eux, les deux faisaient un seul segment, et c'est la personne qu'on livrait. Couper la ou
 * la page change de champ n'est pas tronquer : aucun texte n'est fabrique.
 *
 * Au singulier seulement : « Amicale des secretaires », « Association des presidents » sont
 * des noms. Aucun nom du RNA ne porte l'une de ces formes (mesure sur les 49 118 noms de la
 * base de developpement). « Tel » sans accent ni point, « mail », « contact » n'y sont pas :
 * le RNA en porte — « Association du Mail », « Full Contact ».
 */
const LIBELLES = new RegExp(
  [
    String.raw`(?:\b(?:vice|co)[-\s]?)?\bpr[ée]sidente?\b(?:\s*\(e\))?`,
    String.raw`\bpr[ée]sidence\b`,
    String.raw`\btr[ée]sori(?:er|[èe]re)\b`,
    String.raw`\bsecr[ée]taire\b`,
    String.raw`\bcoordonn[ée]es\b`,
    String.raw`\bcourriel\b`,
    String.raw`\bt[ée]l[ée]phone\b`,
    String.raw`\be-?mail\b`,
    String.raw`\bt[ée]l\.`,
    String.raw`\btél\b`,
  ].join("|"),
  "i",
);

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
  // Releves sur la Loire, ou ils sortaient comme noms de structure : « Retrouvez toutes
  // les informations ICI », « Entrez en contact avec l'association en ecrivant a »,
  // « Toutes demandes doivent etre adressees par mail a la mairie », « Dans tous les
  // cas », « Cette rubrique est au service des associations ».
  "retrouvez",
  "entrez",
  "doivent",
  "tous les cas",
  "au service des",
  "a partir du",
  "est disponible",
  "sont disponibles",
  "n hesitez",
];

/**
 * Debuts de phrase et libelles de champ, testes **en tete** de segment.
 *
 * Releves sur l'Ain et la Haute-Loire, livres comme noms de structure : « Pour plus
 * d'informations », « Nombre d'adherents », « Nom du President(e) », « Par contact
 * telephonique », « Reservation obligatoire au ». En tete, et pas ailleurs : « Sport pour
 * tous », « Maison pour tous », « Culture pour tous » sont des noms du RNA par dizaines.
 * Chaque entree est verifiee contre les 49 118 noms du RNA de la base de developpement :
 * aucun ne commence ainsi.
 */
const PROSE_EN_TETE: readonly string[] = [
  "pour plus", "pour tout", "pour toute", "pour tous", "pour toutes", "pour obtenir",
  "pour en", "pour s", "pour reserver", "pour joindre", "pour la correspondance",
  "par mail", "par e mail", "par email", "par courriel", "par telephone", "par tel",
  "par contact", "par sms", "nombre d", "nombre de", "nom du president",
  "nom de la presidente", "son president", "sa presidente", "n de telephone",
  "numero de telephone", "nouveau tel", "position gps", "heures d ouverture",
  "reservation obligatoire", "sur reservation", "gratuit sur", "hors saison",
  "hors vacances", "durant cette", "consulter le", "consulter la", "situe au",
  "reservation", "ouverture au", "ouverture du", "ouverture de", "ouverture des",
  "inscription", "inscriptions", "plus de", "gratuit", "n d urgence", "horaire",
  "adhesion", "adhesions", "a ce jour",
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
  // Au singulier : la regle admet le pluriel, pas l'inverse. « Renseignement » seul
  // nommait une structure du fichier de la Haute-Loire.
  "renseignement",
  // Fonctions : le bloc nomme qui repond, la structure est ailleurs dans la page.
  "directeur",
  "directrice",
  "vice president",
  "vice presidente",
  "tresoriere",
  "referent",
  "referente",
];

/**
 * Mobilier rejete **seulement s'il est tout le segment**.
 *
 * « Accueil » seul est un lien de navigation ; « Accueil de loisirs », « Accueil
 * periscolaire », « Accueil de jeunes » sont des noms de structure. Le tester en prefixe
 * comme les autres jetait la moitie des accueils de loisirs d'un departement.
 */
const MOBILIER_EXACT: readonly string[] = [
  "accueil", "infos", "informations", "plan", "menu", "retour",
  // Libelles de champ et de lien releves sur les Vosges et la Loire : « Site internet »
  // nommait 47 contacts, « Facebook » 8, « Mobile » et « Telecopie » autant.
  "site", "site internet", "site web", "website", "web",
  "facebook", "page facebook", "instagram", "twitter", "linkedin", "youtube",
  "mobile", "telecopie", "fax", "portable",
  "page brouillon", "brouillon",
  // Rubriques de menu. Elles arrivent seules depuis un fil d'Ariane — « Associations /
  // Sports » se coupe desormais sur la barre — et ne nomment jamais une structure.
  "association", "associations", "sport", "sports", "culture", "loisirs",
  "vie associative", "vie locale", "annuaire", "annuaire des associations",
  "solidarite", "jeunesse", "sante", "education", "ecoles", "commerces", "entreprises",
  "diverses", "sportives", "culturelles", "patriotiques", "sportive", "culturelle",
  "associations sportives", "associations culturelles", "associations diverses",
  "associations patriotiques", "associations sociales", "associations de loisirs",
  "services", "services administratifs", "services techniques",
  // Une region n'est pas une structure. « France Grand Est », lu au bas de trente-sept
  // fiches d'un meme annuaire, y reunissait trente-sept associations en une seule ligne.
  "grand est", "france grand est", "auvergne rhone alpes", "bourgogne franche comte",
  "centre val de loire", "hauts de france", "ile de france", "nouvelle aquitaine",
  "pays de la loire", "provence alpes cote dazur", "bretagne", "normandie", "occitanie",
  "corse",
  "culture animation", "action sociale", "action sociale et solidarite",
  "services a la personne", "astreinte communale",
  // Rubriques de services municipaux. Elles sortaient comme structures des que le nom
  // qui les precedait etait refuse : le segment suivant du bloc prend la place.
  "elections", "assainissement", "logement", "urbanisme", "dechets",
  "ordures menageres", "etat civil", "cimetiere", "recensement", "cantine",
  "periscolaire", "transports", "travaux", "voirie", "auto moto",
  // Un pays n'est pas une structure. Sans cette entree, le « France » qui termine une
  // adresse postale reunissait dans une seule ligne les trente adresses d'une commune.
  "france",
  // Libelles de champ et intertitres de fiche, releves sur l'Ain et la Haute-Loire.
  "important", "presentation", "modalites", "duree", "divers", "bureau",
  "envoi", "repas", "danser", "page instagram", "tel fixe", "tel portable", "telephone fixe",
  "telephone portable", "plus d informations", "informations pratiques",
  // Le lieu-dit du centre de la commune : l'adresse de la moitie des associations rurales.
  "bourg", "le bourg", "centre bourg",
  // Intertitres d'une fiche, que la boucle atteignait une fois le president refuse.
  "membres", "membres du bureau", "le bureau", "composition du bureau",
  "personnes a contacter", "personne a contacter", "adjoint", "adjointe",
  "domaine de l association", "objet du message", "chargement du formulaire",
  "site officiel de la mairie", "direction", "vice", "siege social", "personne referente",
  "personnes referentes", "representant", "representante", "representants",
  "representantes", "co presidents", "copresidents", "bienfaiteur", "bienfaiteurs",
  "artisans et commercants", "le maire", "maire", "delegue", "deleguee", "delegues",
  "deleguees", "chef de section", "animateur", "animatrice", "animateurs", "intervenant",
  "intervenante", "intervenants", "intervenantes", "autre contact", "autres contacts",
  "public", "site web ou facebook", "facebook ou site web",
];

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
  // Aucun nom du RNA ne commence par ceux-la ; « Hameau du Jardin Public » nommait une
  // structure du fichier de la Haute-Loire. « Lotissement » n'y est pas : une association
  // syndicale de lotissement en porte le nom.
  "hameau", "esplanade", "parvis", "za", "zi", "zac", "z a", "z i",
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
/**
 * Un horaire d'ouverture n'est pas un nom.
 *
 * « De 8h30 a 12h », « Lundi - jeudi - vendredi de 09h00 a 12h00 au » : la part de
 * chiffres reste sous le plafond, et la casse ne trahit rien. C'est le « h » colle au
 * nombre qui tranche, et aucun nom d'association du RNA ne l'ecrit ainsi.
 */
function porteUnHoraire(normalise: string): boolean {
  return /\b\d{1,2} ?h(?:\d{2})?\b/.test(normalise);
}

function estUneAdresse(normalise: string): boolean {
  // Le code postal s'ecrit « 35130 » comme « 35 130 » : les deux ouvrent une adresse.
  if (/^\d{5}\b/.test(normalise) || /^\d{2} ?\d{3}\b/.test(normalise)) return true;
  // Il ne l'ouvre pas toujours : « CS 10 032 - 42160 Andrezieux-Boutheon » est une
  // adresse de service, et elle sortait comme nom de structure. Cinq chiffres colles
  // n'apparaissent dans aucun nom d'association du RNA.
  if (/\b\d{5}\b/.test(normalise)) return true;
  const borne = ` ${normalise} `;
  const voie = VOIE.some((mot) => borne.includes(` ${mot} `));
  return voie && (/^\d/.test(normalise) || VOIE.some((mot) => normalise.startsWith(`${mot} `)));
}

/**
 * Une phrase en casse de phrase n'est pas un nom.
 *
 * Le signal : dans un nom de structure, plusieurs mots portent la majuscule — « Les Amis
 * du Vieux Boutheon », « ANDREZIEUX BOUTHEON BADMINTON CLUB ». Dans une phrase, seul le
 * premier la porte : « Organisation de bourses aux vetements », « Cette rubrique est au
 * service des associations ». La regle ne s'applique qu'a partir de cinq mots, ou la
 * difference devient franche, et jamais a un texte qui nomme un groupement — « Association
 * pour la sauvegarde du patrimoine » n'a qu'une majuscule et reste un nom.
 */
function estUnePhrase(segment: string, normalise: string): boolean {
  const mots = segment.split(/\s+/).filter((mot) => mot !== "");
  if (mots.length < 5) return false;
  if (evoqueUneStructure(normalise)) return false;
  const majuscules = mots.filter((mot) => /^\p{Lu}/u.test(mot)).length;
  return majuscules <= 1;
}

/**
 * Un texte casse par un encodage ou une URL n'est pas un nom.
 *
 * « TÃ©l. Fixe » est un « Tel. Fixe » decode de travers, « Comit%C3%A9-Secours-… » un
 * lien que la page affichait en clair. Aucun nom du RNA ne porte l'un ou l'autre.
 *
 * Une parenthese fermante sans ouvrante — « Eleves) », « Baby Gym) » — trahit la fin d'une
 * enumeration coupee par la virgule, et un segment qui s'ouvre sur une parenthese n'est
 * qu'une incise. L'inverse n'est pas vrai : dans « Culture bretonne (danse », la virgule a
 * coupe l'incise mais le nom est entier, et le rejeter perdrait une structure.
 */
function estUnTexteCasse(segment: string): boolean {
  // « Ã » ou « Â » suivis d'autre chose qu'une lettre : « TÃ©l », « DURANDÃ‰ ». « JOÃO » reste
  // un nom.
  if (/Ã[^\sA-Za-z]|Â[^\sA-Za-z]|â€/.test(segment)) return true;
  if (/%[0-9a-f]{2}/i.test(segment)) return true;
  if (segment.trimStart().startsWith("(")) return true;
  let profondeur = 0;
  for (const caractere of segment) {
    if (caractere === "(") profondeur += 1;
    else if (caractere === ")" && --profondeur < 0) return true;
  }
  return false;
}

/** Jours, mois, et les mots qui les accompagnent dans un agenda — rien d'autre. */
const AGENDA: ReadonlySet<string> = new Set([
  "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche",
  "lundis", "mardis", "mercredis", "jeudis", "vendredis", "samedis", "dimanches",
  "janvier", "fevrier", "mars", "avril", "mai", "juin", "juillet", "aout", "septembre",
  "octobre", "novembre", "decembre",
]);
const OUTILS_D_AGENDA: ReadonlySet<string> = new Set(["le", "les", "tous", "toutes", "chaque", "et", "a", "au", "du", "de", "rdv"]);

/**
 * Le segment n'est-il fait que de jours et de mois ? « Samedi », « Tous les lundis »,
 * « Samedi-Dimanche-Lundi », « Mardi rdv a ».
 *
 * Tout le segment, et non son premier mot : « Mardi matin », « Les Jeudis de Rennes » et
 * « Vendredi 13 » sont des noms du RNA.
 */
function estUnAgenda(normalise: string): boolean {
  const mots = normalise.split(" ");
  return mots.some((mot) => AGENDA.has(mot)) && mots.every((mot) => AGENDA.has(mot) || OUTILS_D_AGENDA.has(mot));
}

/**
 * Le segment se reduit-il au nom de la commune ?
 *
 * « Deyvillers », « Fraize », « Andrezieux-Boutheon » nommaient des structures dans les
 * fichiers livres : c'est le pied de page ou l'adresse postale qui les met la. La commune
 * est connue des deux appelants — le crawl et la passe de rattrapage — donc le filtre est
 * exact plutot qu'heuristique.
 */
function estLaCommune(normalise: string, commune: Commune): boolean {
  const nomCommune = nomDeLaCommune(commune);
  if (nomCommune !== undefined && nomCommune !== "") {
    const nom = normaliserNom(nomCommune);
    // L'egalite ne suffit pas : « Plombieres » nommait cinq structures de
    // Plombieres-les-Bains. Le pied de page ecrit le nom court, la base le nom complet.
    if (nom.length >= LONGUEUR_MIN && (normalise === nom || nom.startsWith(`${normalise} `) || normalise.startsWith(`${nom} `))) {
      return true;
    }
  }
  // Une commune voisine : le nom entier, ou sa forme courte — « Le Puy » pour
  // « Le Puy-en-Velay ». Jamais un nom qui ne fait que commencer comme elle : « Coubon
  // Tennis Club » est un club.
  if (typeof commune !== "object") return false;
  if (commune.voisines.has(normalise)) return true;
  for (const voisine of commune.voisines) {
    if (voisine.startsWith(`${normalise} `)) return true;
    // Sa forme longue, aussi : « Vorey sur Arzon » pour « Vorey ».
    if (normalise.startsWith(`${voisine} `) && COMPLEMENT_DE_LIEU.test(normalise.slice(voisine.length + 1))) return true;
  }
  return false;
}

/** Ce qui prolonge un nom de commune sans en faire autre chose : « sur Arzon », « en Velay ». */
const COMPLEMENT_DE_LIEU = /^(?:sur|sous|en|les|lez|le|la|de|du|des|d)\s\S+$/;

/**
 * Le texte serait-il accepte comme nom de structure par l'heuristique **courante** ?
 *
 * Exportee pour la reparation au demarrage. Un nom ecrit par une version anterieure ne se
 * recalcule qu'en relisant la page, et le cache ne la detient pas toujours — mais la
 * question « ce nom-la passerait-il aujourd'hui ? » ne demande que la chaine. C'est ce
 * qui permet d'effacer les « Site internet » et les « France Grand Est » d'une base dont
 * le cache a disparu, sans rien inventer a la place.
 */
export function nomEncoreAcceptable(nom: string, commune?: Commune): boolean {
  // Le decoupage compte aussi : un nom qui porte un libelle de champ — « SOCIETE de CHASSE
  // President » — ne serait plus lu tel quel. La page le recoupera si le cache la detient ;
  // sinon on l'efface, comme tout nom que le filtre courant refuse.
  if (LIBELLES.test(nom)) return false;
  return acceptable(nom, commune);
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
  commune?: Commune,
  titre?: string | undefined,
): NomPressenti | undefined {
  for (const contexte of contextes.slice(0, CONTEXTES_EXAMINES)) {
    const trouve = depuisUnBloc(contexte, empreinte, commune, titre);
    if (trouve !== undefined) return trouve;
  }
  return undefined;
}

/**
 * Le nom d'un contact extrait, blocs puis titre de fiche. **La** porte d'entree du crawl et
 * de la reparation : passer le contact entier, c'est ne pas pouvoir oublier son titre.
 */
export function nomPressentiDuContact(contact: ContactExtrait, commune?: Commune): NomPressenti | undefined {
  return nomPressenti(contact.contextes, contact.empreinte, commune, contact.titre);
}

/**
 * Le titre de la fiche, quand les blocs du contact n'ont rien nomme — le plus souvent parce
 * qu'ils ne portaient que le president. Il passe par le meme filtre : « Contact »,
 * « Informations », « Aines » ne nomment rien, titre ou pas. « CLUB DU MONT - DURAND
 * Paulette » se coupe au tiret, et c'est la structure qui reste.
 */
function depuisLeTitre(titre: string, commune: Commune): NomPressenti | undefined {
  for (const segment of decouper(titre)) {
    if (acceptable(segment, commune)) return { nom: segment, normalise: normaliserNom(segment), source: "bloc:titre" };
  }
  return undefined;
}

/**
 * Le nom lu dans un bloc — ou dans le titre de la fiche, des que le bloc nomme une personne.
 *
 * Le titre ne se lit que dans ce cas-la : c'est celui pour lequel il a ete mesure. Lu
 * partout, il nommait surtout des rubriques — « Nature », « Musique », « Sports divers » —
 * sur le 43 : des lignes fausses la ou il n'y avait qu'une ligne en moins.
 *
 * Et il se lit **des** la personne rencontree, avant les segments suivants du bloc et
 * avant le bloc plus large : sur deux echantillons de trente fiches du 43, les erreurs
 * venaient toutes de ce qui suivait la personne — l'activite (« Jeu de boules »), le
 * hameau de l'ecole, un second membre du bureau au prenom rare.
 */
function depuisUnBloc(
  contexte: string,
  empreinte: string,
  commune: Commune,
  titre: string | undefined,
): NomPressenti | undefined {
  const { texte, coupure } = sansContacts(sansCategorie(contexte), empreinte);
  if (coupure === -1) return undefined;

  // Le plus proche d'abord, en remontant vers la gauche, puis ce qui suit le contact.
  // « Associations sportives — Tennis Club de Bruzou — contact@... » doit rendre le club
  // et non la rubrique, et un contact en tete de bloc doit pouvoir regarder devant lui.
  const avant = decouper(texte.slice(0, coupure));
  const apres = decouper(texte.slice(coupure));
  const candidats: { segment: string; source: NomPressenti["source"]; voisins: readonly string[] }[] = [
    ...avant
      .map((segment, rang) => ({ segment, source: "bloc:avant" as const, voisins: voisinsDe(avant, rang) }))
      .reverse(),
    ...apres.map((segment, rang) => ({ segment, source: "bloc:apres" as const, voisins: voisinsDe(apres, rang) })),
  ];

  let titreLu = false;
  for (const { segment, source, voisins } of candidats) {
    const personne = estUnePersonneCoupee(segment, voisins) || designeUnePersonne(segment);
    if (personne && titre !== undefined && !titreLu) {
      titreLu = true;
      const parLeTitre = depuisLeTitre(titre, commune);
      if (parLeTitre !== undefined) return parLeTitre;
    }
    if (!personne && acceptable(segment, commune)) {
      return { nom: segment, normalise: normaliserNom(segment), source };
    }
  }
  return undefined;
}

function voisinsDe(segments: readonly string[], rang: number): string[] {
  return [segments[rang - 1], segments[rang + 1]].filter((voisin): voisin is string => voisin !== undefined);
}

/**
 * Un nom de famille seul, dont le prenom est la cellule d'a cote : « ROCHE | Sylvie ». Les
 * fiches en formulaire — « Nom : … Prenom : … » — coupent la personne en deux segments, et
 * le nom de famille en capitales passait pour un sigle de structure.
 */
function estUnePersonneCoupee(segment: string, voisins: readonly string[]): boolean {
  if (/\s/.test(segment)) return false;
  return voisins.some(
    (voisin) => !/\s/.test(voisin) && (estUnNomDePersonne(`${segment} ${voisin}`) || estUnNomDePersonne(`${voisin} ${segment}`)),
  );
}

/**
 * La valeur d'un champ de categorie n'est pas un nom : dans « Domaine de l'association :
 * Aines — Paulette X preside cette association », c'est « Aines » que la boucle aurait
 * retenu une fois la presidente refusee. Remplacee par des espaces, a longueur egale, pour
 * que les positions du texte ne bougent pas.
 */
const CHAMP_DE_CATEGORIE =
  /\b(?:domaine(?:\s+d['’]activit[ée]s?|\s+de\s+l['’]association)?|activit[ée]s?|cat[ée]gorie|th[èe]me|discipline|secteur(?:\s+d['’]activit[ée])?)\s*:[^\n|;:]*/giu;

function sansCategorie(contexte: string): string {
  return contexte.replace(CHAMP_DE_CATEGORIE, (champ) => `\n${" ".repeat(champ.length - 1)}`);
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
  const texte = contexte.replace(CONTACTS, (trouve, decalage: number) => {
    // Le premier contact efface fait office de repere quand l'empreinte est un `href`,
    // absent du texte rendu.
    if (coupure === -1) coupure = decalage;
    return " ".repeat(trouve.length);
  });

  return { texte, coupure: direct === -1 ? coupure : direct };
}

const FIN_DE_TOURNURE = /(?:^|\s)(?:du|de|des|la|le|les|d'|l'|d’|l’|au|aux|à|a|par|pour|son|sa|ses|votre|notre)\s*$/i;

function decouper(morceau: string): string[] {
  return morceau
    .split(SEPARATEURS)
    .flatMap((segment) => {
      // Un tiret espace ne coupe que s'il separe une personne d'autre chose : « CLUB DU
      // MONT - DURAND Paulette ». Ailleurs il appartient au nom — le RNA en porte 2 150.
      const parties = segment.split(/\s+-\s+/);
      return parties.length > 1 && parties.some((partie) => designeUnePersonne(partie)) ? parties : [segment];
    })
    .flatMap((segment) => {
      const morceaux = segment.split(LIBELLES);
      // Ce qui precede un libelle et finit sur un mot-outil n'est qu'un debut de phrase :
      // « Nom du President(e) », « Mot de la Presidente », « Son President ».
      return morceaux.length === 1 ? morceaux : morceaux.filter((morceau) => !FIN_DE_TOURNURE.test(morceau));
    })
    .map((segment) => segment.replace(/\s+/g, " ").trim())
    // Puces et chevrons de navigation : « >> Ecole Elementaire » est un nom precede d'un
    // ornement, pas un nom qui commence par « > ».
    // Tout ce qui n'est ni lettre, ni chiffre, ni guillemet, ni parenthese — les puces
    // emoji comprises, « 🔹 Veuves ».
    .map((segment) => segment.replace(/^[^\p{L}\p{N}"'(]+/u, "").trim())
    .map((segment) => segment.replace(/[>«»*+\-–—\u2022\u00b7\s.,;:/(]+$/, "").trim())
    .filter((segment) => segment !== "");
}

/**
 * Un segment est-il un nom de structure plausible ?
 *
 * On **rejette** plutot que de tronquer, toujours : couper un segment trop long
 * fabriquerait un nom qui n'a jamais existe sur aucune page.
 */
function acceptable(segment: string, commune?: Commune): boolean {
  const normalise = normaliserNom(segment);
  if (normalise.length < LONGUEUR_MIN || normalise.length > LONGUEUR_MAX) return false;
  if (normalise.split(" ").length > MOTS_MAX) return false;
  if (!/[a-z]/.test(normalise)) return false;

  const chiffres = (normalise.match(/\d/g) ?? []).length;
  if (chiffres / normalise.length > PART_CHIFFRES_MAX) return false;

  // Ce qui disqualifie un nom meme quand il nomme aussi une structure, donc avant le
  // laissez-passer : un numero — un 06 livre dans la colonne « nom » viole l'invariant 6 —,
  // une personne (ADR-036), un texte casse.
  if (porteUnNumero(segment)) return false;
  if (porteUnePersonne(segment)) return false;
  if (estUnTexteCasse(segment)) return false;

  // Le laissez-passer passe avant les autres filtres : un motif de structure l'emporte sur
  // le mot de mobilier qui le commence.
  if (nommeUneStructure(normalise)) return true;

  if (PROSE.some((marqueur) => ` ${normalise} `.includes(` ${marqueur} `))) return false;
  if (PROSE_EN_TETE.some((debut) => normalise === debut || normalise.startsWith(`${debut} `))) return false;
  if (MOBILIER_EXACT.includes(normalise)) return false;
  if (estUnAgenda(normalise)) return false;
  if (estUnePhrase(segment, normalise)) return false;
  if (porteUnHoraire(normalise)) return false;
  if (estLaCommune(normalise, commune)) return false;
  // Un commerce, une entreprise, une exploitation : le client de la Loire les a refuses
  // en bloc, et il a raison — l'outil dresse un annuaire de la vie associative.
  if (evoqueUnCommerce(normalise)) return false;
  if (CIVILITES.some((mot) => normalise.startsWith(`${mot} `))) return false;
  if (estUneAdresse(normalise)) return false;
  if (estUneUrl(segment)) return false;
  if (commenceParUnChiffre(segment)) return false;
  if (porteUneEntiteHtml(segment)) return false;
  if (segment.includes("@")) return false;
  if (!commenceParUneMajuscule(segment)) return false;
  // La forme d'un nom de personne, jugee apres le laissez-passer : « Comite des fetes -
  // President » reste un nom, « DURANDEL Nadine Tresoriere » n'en est plus un.
  if (estUnNomDePersonne(segment)) return false;
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
