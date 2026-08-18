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

/** Un lien, resolu en absolu. `mailto:` et `tel:` sont conserves tels quels. */
export type Lien = { href: string; ancre: string };

/**
 * Plus petit ensemble structurel susceptible de porter une association et ses
 * coordonnees : une ligne de tableau, un item de liste, un paragraphe. Sert de
 * contexte au rapprochement par nom, pas de decoupage exhaustif de la page.
 */
export type Bloc = { texte: string; liens: readonly Lien[] };

export type DocumentAnalyse = {
  texte: string;
  liens: readonly Lien[];
  blocs: readonly Bloc[];
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

  const parcourir = (noeud: unknown): void => {
    const n = noeud as { nodeType: number; rawTagName?: string; rawText?: string; childNodes?: unknown[] };

    if (n.nodeType === NOEUD_TEXTE) {
      const brut = n.rawText ?? "";
      if (brut !== "") morceaux.push(decoderEntites(brut));
      return;
    }
    if (n.nodeType !== NOEUD_ELEMENT) return;

    const balise = (n.rawTagName ?? "").toLowerCase();
    if (IGNORES.has(balise)) return;

    const coupure = COUPURES.has(balise);
    if (coupure) morceaux.push("\n");

    const debutTexte = morceaux.length;
    const debutLiens = liens.length;

    if (balise === "a") {
      const href = attribut(n, "href");
      const resolu = href === undefined ? undefined : resoudre(href, base);
      if (resolu !== undefined) {
        // L'ancre n'est connue qu'apres la descente : la position est reservee ici.
        liens.push({ lien: { href: resolu, ancre: "" }, position: morceaux.length });
      }
    }

    for (const enfant of n.childNodes ?? []) parcourir(enfant);

    if (balise === "a" && liens.length > debutLiens) {
      const entree = liens[debutLiens];
      if (entree !== undefined) entree.lien = { href: entree.lien.href, ancre: normaliser(morceaux.slice(debutTexte).join("")) };
    }

    if (coupure) morceaux.push("\n");

    if (BLOCS.has(balise)) {
      const texte = normaliser(morceaux.slice(debutTexte).join(""));
      if (texte !== "") {
        blocs.push({ texte, liens: liens.slice(debutLiens).map((e) => e.lien) });
      }
    }
  };

  parcourir(racine);

  return {
    texte: normaliser(morceaux.join("")),
    liens: liens.map((e) => e.lien),
    blocs,
  };
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
};

function decoderEntites(texte: string): string {
  if (!texte.includes("&")) return texte;
  return texte.replace(/&(#x?[0-9a-f]+|\w+);/gi, (entier, corps: string) => {
    if (corps.startsWith("#")) {
      const code = corps[1]?.toLowerCase() === "x" ? parseInt(corps.slice(2), 16) : parseInt(corps.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entier;
    }
    return ENTITES[corps.toLowerCase()] ?? entier;
  });
}
