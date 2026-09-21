/**
 * Adaptateur DOM. Seul module du projet a importer `node-html-parser` (ADR-011).
 *
 * Le confinement suit la meme logique que la porte de sortie reseau unique : la
 * dependance est bornee a une API de traversee, ce qui la rend remplacable et
 * laisse `css-select`, tire transitivement, entierement inutilise.
 *
 * Les proprietes `.text` de la bibliotheque ne conviennent pas : elles concatenent
 * sans separateur — « Club <b>de</b> Bruz » et « contact<span>@</span>mairie.fr »
 * demandent des traitements opposes — et elles restituent le contenu des `<script>`.
 * La traversee ci-dessous ne separe donc qu'aux frontieres de bloc.
 */

import { parse } from "node-html-parser";

/**
 * Profondeur d'imbrication acceptee. Les sites de mairie tournent autour de trente
 * niveaux ; ce plafond laisse un ordre de grandeur, et borne la recursion de `parcourir`.
 */
const PROFONDEUR_MAX = 500;

/** Document que l'adaptateur refuse de lire. Typee, pour ne pas ressembler a une panne. */
export class HtmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HtmlError";
  }
}

/** Un lien, resolu en absolu. `mailto:` et `tel:` sont conserves tels quels. */
export type Lien = { href: string; ancre: string };

/**
 * Plus petit ensemble structurel susceptible de porter une association et ses
 * coordonnees : une ligne de tableau, un item de liste, un paragraphe. Sert de
 * contexte au rapprochement par nom, pas de decoupage exhaustif de la page.
 */
export type Bloc = { texte: string; liens: readonly Lien[] };

/**
 * La fiche d'une structure : le plus petit element qui porte un titre et ce qui le suit.
 *
 * Le nom d'une structure est tres souvent le **titre** de sa fiche — un `<h4>`, un
 * `<div class="…-titre">` — et ce titre vit hors des `BLOCS` : une carte en `<div>`, dont le
 * contact est dans un paragraphe voisin, ne produit aucun contexte qui le contienne. C'est la
 * ou se trouvait le nom de la moitie des structures que le fichier de la Haute-Loire nommait
 * d'apres leur president (ADR-036).
 */
export type Fiche = {
  titre: string;
  texte: string;
  liens: readonly Lien[];
  /**
   * La branche de la fiche qui porte le titre — l'enfant direct qui le contient. Un titre
   * ne vaut pour les contacts de la fiche que si sa branche n'en porte aucun : c'est un
   * en-tete. Sur une petite page, deux cartes voisines ont un ancetre commun, et le titre
   * de la premiere nommait sinon le contact de la seconde.
   */
  branche: Bloc;
};

export type DocumentAnalyse = {
  texte: string;
  liens: readonly Lien[];
  blocs: readonly Bloc[];
  fiches: readonly Fiche[];
};

/** Elements dont le contenu textuel n'est pas du texte de page. */
const IGNORES = new Set(["script", "style", "noscript", "template", "svg", "head"]);

/** Elements qui imposent une coupure : sans elle, deux cellules se colleraient. */
const COUPURES = new Set([
  "address", "article", "aside", "blockquote", "br", "dd", "div", "dl", "dt",
  "fieldset", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6",
  "header", "hr", "li", "main", "nav", "ol", "option", "p", "pre", "section",
  "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
]);

/** Elements retenus comme blocs de contexte, du plus fin au plus grossier. */
const BLOCS = new Set(["td", "tr", "li", "dd", "p", "article"]);

/**
 * Elements en ligne dont le texte ne se soude pas a celui de ses voisins.
 *
 * Deux liens voisins — une adresse, puis l'URL du site ecrite en toutes lettres — donnaient
 * « club@asso.frhttps », une adresse qui n'existe pas. Le `<span>` n'y est pas, et c'est
 * voulu : `contact<span>@</span>mairie.fr` doit rester une adresse.
 */
const BORNES = new Set(["a", "button", "label"]);

/** Titres de section ; `dt` intitule le `dd` qui le suit. */
const TITRES = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "dt"]);

/**
 * Classe d'un element qui fait office de titre de fiche, sur les CMS qui n'emploient pas
 * les balises de titre : `un-lien-bloc-titre`, `panel-heading`, `entry-title`, `nom-asso`.
 * Comparee aux segments du nom de classe, jamais en sous-chaine : « nombre » n'est pas
 * « nom ».
 */
const CLASSE_DE_TITRE = /(?:^|[-_])(?:titre|title|heading|intitule|nom|name)(?:$|[-_])/i;

/** Au-dela, un titre de classe n'est plus un titre : c'est un conteneur mal nomme. */
const LONGUEUR_MAX_TITRE = 150;

/**
 * Au-dela, un element n'est plus la fiche d'une structure. La borne tient aussi le cout :
 * chaque ancetre d'un titre est une fiche candidate, et son texte n'est construit qu'en
 * deca.
 */
const LONGUEUR_MAX_FICHE = 2_000;

const NOEUD_ELEMENT = 1;
const NOEUD_TEXTE = 3;

/**
 * Vrai si le corps merite d'etre analyse comme du HTML. La couche HTTP ne filtre
 * rien par type de contenu : c'est a l'appelant de refuser un PDF avant de le
 * passer a un parseur. Une reponse sans en-tete est acceptee — le type manquant
 * est frequent et le parseur est permissif.
 */
export function estHtml(contentType: string | null): boolean {
  if (contentType === null) return true;
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return type === "" || type === "text/html" || type === "application/xhtml+xml";
}

/**
 * Decode un corps en texte. Une part notable des sites de mairie est encore servie
 * en ISO-8859-1 ou Windows-1252 : decoder en UTF-8 par defaut y transformerait
 * chaque caractere accentue en U+FFFD, et donc chaque nom d'association.
 *
 * L'ordre suit la specification HTML : en-tete HTTP, puis declaration `<meta>`,
 * puis UTF-8. Node embarque ICU au complet, aucune dependance n'est necessaire.
 */
export function decoder(corps: Buffer, contentType: string | null): string {
  const parBom = charsetDeBom(corps);
  if (parBom !== undefined) return sansBom(decoderAvec(corps, parBom));

  const etiquette = charsetDeContentType(contentType) ?? charsetDeMeta(corps);

  // Une declaration `utf-8` fausse est frequente sur ces sites. Lui faire confiance
  // sans verifier ecrirait des « Ã© » en base, donc dans l'export remis au client :
  // on verifie, et on retombe sur l'encodage occidental le plus probable.
  if (etiquette === undefined || estUtf8(etiquette)) {
    const strict = decoderStrictement(corps);
    return sansBom(strict ?? decoderAvec(corps, "windows-1252"));
  }

  return sansBom(decoderAvec(corps, etiquette));
}

function estUtf8(etiquette: string): boolean {
  return etiquette === "utf-8" || etiquette === "utf8";
}

/** Rend `undefined` si le corps n'est pas de l'UTF-8 valide. */
function decoderStrictement(corps: Buffer): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(corps);
  } catch {
    return undefined;
  }
}

function decoderAvec(corps: Buffer, etiquette: string): string {
  try {
    return new TextDecoder(etiquette).decode(corps);
  } catch {
    // Etiquette inconnue de l'ICU embarque : un repli vaut mieux qu'un job en echec.
    // `latin1` ne peut pas lever, la ou TextDecoder le peut sur un Node small-icu.
    return corps.toString("latin1");
  }
}

function sansBom(texte: string): string {
  return texte.charCodeAt(0) === 0xfeff ? texte.slice(1) : texte;
}

/** Le BOM prime sur toute declaration : c'est l'octet, pas une affirmation. */
function charsetDeBom(corps: Buffer): string | undefined {
  if (corps.length >= 3 && corps[0] === 0xef && corps[1] === 0xbb && corps[2] === 0xbf) return "utf-8";
  if (corps.length >= 2 && corps[0] === 0xff && corps[1] === 0xfe) return "utf-16le";
  if (corps.length >= 2 && corps[0] === 0xfe && corps[1] === 0xff) return "utf-16be";
  return undefined;
}

function charsetDeContentType(contentType: string | null): string | undefined {
  if (contentType === null) return undefined;
  return /charset\s*=\s*"?([\w-]+)"?/i.exec(contentType)?.[1]?.toLowerCase();
}

/**
 * La declaration `<meta>` doit apparaitre tot dans le document ; la chercher au-dela
 * des premiers kilo-octets reviendrait a decoder deux fois toute la page.
 */
function charsetDeMeta(corps: Buffer): string | undefined {
  const debut = corps.subarray(0, 2048).toString("latin1");
  const direct = /<meta[^>]+charset\s*=\s*"?'?([\w-]+)/i.exec(debut)?.[1];
  if (direct !== undefined) return direct.toLowerCase();
  const equiv = /<meta[^>]+http-equiv\s*=\s*"?'?content-type[^>]*content\s*=\s*"[^"]*charset=([\w-]+)/i;
  return equiv.exec(debut)?.[1]?.toLowerCase();
}

/**
 * Analyse un document et rend ce dont les etapes [3] et [5] ont besoin : les liens
 * pour le scoring, le texte pour les motifs de contact, les blocs pour rattacher un
 * contact au nom qui le precede.
 *
 * `base` sert a resoudre les liens relatifs ; un lien qui ne se resout pas est
 * ignore plutot que de faire echouer la page.
 */
export function analyser(html: string, base: string): DocumentAnalyse {
  const racine = parse(html, { comment: false });

  const morceaux: string[] = [];
  const liens: { lien: Lien; position: number }[] = [];
  const blocs: Bloc[] = [];
  const fiches: Fiche[] = [];
  let caracteres = 0;

  const pousser = (morceau: string): void => {
    morceaux.push(morceau);
    caracteres += morceau.length;
  };

  /** Rend le premier titre du sous-arbre, ou `undefined`. */
  const parcourir = (noeud: unknown, profondeur: number): string | undefined => {
    // La descente est recursive, et un HTML profondement imbrique la faisait deborder la
    // pile : un `RangeError` de V8, ni typé ni attendu, rejoue cinq fois avant que le job
    // ne meure. Le plafond transforme cela en un refus net et diagnosticable. Il est pose
    // tres au-dessus de tout document reel — les CMS de mairie tournent autour de 30
    // niveaux — et il vaut mieux qu'une reecriture iterative de la porte d'entree DOM,
    // dont le pre- et le post-traitement par noeud sont la vraie subtilite.
    if (profondeur > PROFONDEUR_MAX) {
      throw new HtmlError(`Document imbrique au-dela de ${PROFONDEUR_MAX} niveaux`);
    }
    const n = noeud as { nodeType: number; rawTagName?: string; rawText?: string; childNodes?: unknown[] };

    if (n.nodeType === NOEUD_TEXTE) {
      const brut = n.rawText ?? "";
      if (brut !== "") pousser(decoderEntites(brut));
      return undefined;
    }
    if (n.nodeType !== NOEUD_ELEMENT) return undefined;

    const balise = (n.rawTagName ?? "").toLowerCase();
    if (IGNORES.has(balise)) return undefined;

    const coupure = COUPURES.has(balise);
    if (coupure) pousser("\n");
    // Une espace avant le lien, sauf apres une apostrophe : « l'<a>Amicale</a> » reste
    // « l'Amicale ».
    const borne = BORNES.has(balise);
    if (borne && !/[\s'’]$/.test(morceaux[morceaux.length - 1] ?? " ")) pousser(" ");

    const debutTexte = morceaux.length;
    const debutCaracteres = caracteres;
    const debutLiens = liens.length;

    if (balise === "a") {
      const href = attribut(n, "href");
      const resolu = href === undefined ? undefined : resoudre(href, base);
      if (resolu !== undefined) {
        // L'ancre n'est connue qu'apres la descente : la position est reservee ici.
        liens.push({ lien: { href: resolu, ancre: "" }, position: morceaux.length });
      }
    }

    let titre: string | undefined;
    let branche = { debutTexte: 0, finTexte: 0, debutLiens: 0, finLiens: 0 };
    for (const enfant of n.childNodes ?? []) {
      const avantTexte = morceaux.length;
      const avantLiens = liens.length;
      const trouve = parcourir(enfant, profondeur + 1);
      if (titre === undefined && trouve !== undefined) {
        titre = trouve;
        branche = { debutTexte: avantTexte, finTexte: morceaux.length, debutLiens: avantLiens, finLiens: liens.length };
      }
    }

    if (balise === "a" && liens.length > debutLiens) {
      const entree = liens[debutLiens];
      if (entree !== undefined) entree.lien = { href: entree.lien.href, ancre: normaliser(morceaux.slice(debutTexte).join("")) };
    }

    if (coupure) pousser("\n");
    if (borne) pousser(" ");

    if (BLOCS.has(balise)) {
      const texte = normaliser(morceaux.slice(debutTexte).join(""));
      if (texte !== "") {
        blocs.push({ texte, liens: liens.slice(debutLiens).map((e) => e.lien) });
      }
    }

    const longueur = caracteres - debutCaracteres;
    if (TITRES.has(balise) || (longueur <= LONGUEUR_MAX_TITRE && CLASSE_DE_TITRE.test(classes(n)))) {
      const propre = normaliser(morceaux.slice(debutTexte).join("")).replace(/\s+/g, " ");
      if (propre !== "") return propre;
    }
    if (titre !== undefined && longueur <= LONGUEUR_MAX_FICHE) {
      const texte = normaliser(morceaux.slice(debutTexte).join(""));
      if (texte.length > titre.length) {
        fiches.push({
          titre,
          texte,
          liens: liens.slice(debutLiens).map((e) => e.lien),
          branche: {
            texte: normaliser(morceaux.slice(branche.debutTexte, branche.finTexte).join("")),
            liens: liens.slice(branche.debutLiens, branche.finLiens).map((e) => e.lien),
          },
        });
      }
    }
    return titre;
  };

  parcourir(racine, 0);

  return {
    texte: normaliser(morceaux.join("")),
    liens: liens.map((e) => e.lien),
    blocs,
    fiches,
  };
}

/** Les noms de classe, un par un : `CLASSE_DE_TITRE` les compare separement. */
function classes(noeud: unknown): string {
  const valeur = attribut(noeud, "class");
  return valeur === undefined ? "" : valeur.split(/\s+/).find((classe) => CLASSE_DE_TITRE.test(classe)) ?? "";
}

function attribut(noeud: unknown, nom: string): string | undefined {
  const n = noeud as { getAttribute?: (nom: string) => string | undefined };
  return typeof n.getAttribute === "function" ? (n.getAttribute(nom) ?? undefined) : undefined;
}

function resoudre(href: string, base: string): string | undefined {
  const brut = href.trim();
  if (brut === "" || brut.startsWith("#")) return undefined;
  try {
    return new URL(brut, base).href;
  } catch {
    return undefined;
  }
}

/**
 * Les espaces horizontaux sont reduits, les sauts de ligne conserves : ce sont eux
 * qui separent deux cellules, et donc deux associations, dans le texte d'un tableau.
 */
function normaliser(texte: string): string {
  return texte.replace(/[^\S\n]+/g, " ").replace(/ *\n[\s\n]*/g, "\n").trim();
}

const ENTITES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  eacute: "é", egrave: "è", ecirc: "ê", agrave: "à", ccedil: "ç",
  ocirc: "ô", ugrave: "ù", icirc: "î", euml: "ë", iuml: "ï", acirc: "â",
  // Lot 12. Une entite non decodee n'est pas qu'une coquille : son `;` coupe le texte en
  // deux segments, et « Association des Parents d&rsquo;Eleves » nommait une structure
  // « Eleves » dans le fichier de la Haute-Loire.
  ucirc: "û", uuml: "ü", ouml: "ö", auml: "ä", oelig: "œ", aelig: "æ",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", laquo: "«", raquo: "»",
  hellip: "…", ndash: "–", mdash: "—", middot: "·", bull: "•", deg: "°", euro: "€",
  copy: "©", reg: "®", trade: "™", shy: "",
};

/** Les capitales accentuees, que la table ci-dessus ecrit en minuscules. */
const ENTITES_CAPITALES: Record<string, string> = {
  Eacute: "É", Egrave: "È", Ecirc: "Ê", Agrave: "À", Ccedil: "Ç", Ocirc: "Ô", Ucirc: "Û",
  Icirc: "Î", Acirc: "Â", OElig: "Œ", AElig: "Æ",
};

function decoderEntites(texte: string): string {
  if (!texte.includes("&")) return texte;
  return texte.replace(/&(#x?[0-9a-f]+|\w+);/gi, (entier, corps: string) => {
    if (corps.startsWith("#")) {
      const code = corps[1]?.toLowerCase() === "x" ? parseInt(corps.slice(2), 16) : parseInt(corps.slice(1), 10);
      // Les demi-surrogates isoles (D800–DFFF) sont acceptes par `fromCodePoint` et
      // produisent une chaine mal formee, qui voyagerait ensuite jusqu'en base et dans
      // l'export CSV. Une entite qui les designe n'est pas decodable : on la laisse telle.
      const decodable =
        Number.isFinite(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
      return decodable ? String.fromCodePoint(code) : entier;
    }
    return ENTITES_CAPITALES[corps] ?? ENTITES[corps.toLowerCase()] ?? entier;
  });
}
