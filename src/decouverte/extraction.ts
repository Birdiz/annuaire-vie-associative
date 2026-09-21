/**
 * Etape [5] du §6 : tirer les contacts du DOM, sans aucune inference couteuse.
 *
 * Deux invariants du brief s'appliquent ici et nulle part ailleurs :
 *
 * - §4.6 les mobiles 06/07 sont ecartes par defaut. Le drapeau qui les rappelle
 *   voyage dans le payload du job et non dans la configuration : il est ainsi
 *   persiste avec le travail auquel il s'applique, et une reprise le retrouve.
 * - §4.7 un email generique et un email nominatif ne relevent pas du meme regime
 *   juridique. La distinction est donc portee par le modele, pas deduite a l'export.
 *
 * La confiance n'est pas decorative : c'est elle qui alimentera l'ecran de revue de
 * l'etape [8]. Un lien `mailto:` est une declaration de l'auteur de la page ; un
 * motif trouve dans du texte libre est une lecture de notre part ; une forme
 * desobfusquee est une reconstruction. Les trois ne se valent pas.
 */

import { MOBILE_PREFIXES } from "../invariants.ts";
import { SOURCE_EMAIL, SOURCE_TELEPHONE } from "./motifs.ts";
import { estEtiquetteDeMessagerie } from "../normalisation/messageries.ts";
import { normaliserNom } from "../texte.ts";
import type { Bloc, DocumentAnalyse, Fiche } from "../parse/html.ts";

export type KindContact = "email" | "phone";

export type ContactExtrait = {
  kind: KindContact;
  valeur: string;
  valeurNormalisee: string;
  /** §4.7 — 1 generique, 0 nominatif, null indetermine. */
  isGenerique: 0 | 1 | null;
  methode: string;
  confiance: number;
  /**
   * Textes des blocs qui portent le contact, du plus etroit au plus large. Le
   * rattachement les parcourt dans cet ordre : la cellule d'un tableau ne contient
   * que l'adresse, c'est la ligne qui porte aussi le nom de l'association.
   *
   * **Les blocs qui portent plusieurs contacts en sont exclus** — voir
   * `CONTACTS_MAX_PAR_BLOC`. Un bloc qui en porte vingt ne nomme aucun des vingt.
   */
  contextes: readonly string[];
  /**
   * Ce qui a servi a reperer le contact dans la page : le `href` d'un `mailto:`/`tel:`,
   * ou le texte trouve par un motif.
   *
   * Elle etait jusqu'ici passee a `contextesDe` puis jetee. La garder evite a
   * `nomPressenti` de redeviner ou le contact se trouve dans le bloc — et redeviner,
   * c'est se tromper sur les blocs qui portent deux adresses.
   */
  empreinte: string;
  /**
   * Le titre de la plus etroite fiche qui porte le contact, quand elle ne depasse pas
   * `CONTACTS_MAX_PAR_BLOC` contacts : le nom de la structure, le plus souvent, quand le
   * bloc du contact ne nomme que son president (ADR-036). Absent sinon.
   */
  titre?: string | undefined;
};

export type ResultatExtraction = {
  contacts: readonly ContactExtrait[];
  mobilesExclus: number;
};

const CONFIANCE_DOM = 0.9;
const CONFIANCE_MOTIF = 0.6;
const CONFIANCE_OBFUSQUE = 0.45;

/**
 * Un `mailto:` dont la seule arobase est masquee par un litteral.
 *
 * Entre les deux valeurs voisines, et pas par gout du milieu. La page **declare** un lien
 * de courriel : c'est le meme signal que `CONFIANCE_DOM`, le plus fort dont on dispose.
 * Mais l'adresse rendue n'est pas celle qui est ecrite dans la page, et une provenance
 * honnete ne peut pas donner a une reconstruction la note d'une lecture. Elle reste
 * nettement au-dessus de `CONFIANCE_OBFUSQUE`, qui paie une inference autrement plus
 * hardie : la, on devine l'arobase *et* le point a partir de mots de prose.
 *
 * Le chiffre a une consequence directe : `base` du score vaut `confiance`, et le score ne
 * fait ensuite que descendre. A 0,45 ces adresses resteraient sous le seuil d'export
 * courant de 0,6 — reparees, mais toujours absentes du fichier livre.
 */
const CONFIANCE_DOM_REPARE = 0.75;

/** Voir `motifs.ts` : le bornage des quantificateurs et la fin du suffixe y sont expliques. */
const EMAIL = new RegExp(SOURCE_EMAIL, "g");

/**
 * Formes obfusquees courantes sur les sites de mairie : « nom [at] domaine [dot] fr ».
 * Reconstruire une adresse est une inference, d'ou la confiance la plus basse.
 *
 * Memes bornes que `EMAIL`, et pour la meme raison : ce motif-ci coutait 4,7 s sur
 * 40 000 caracteres.
 */
const EMAIL_OBFUSQUE =
  /([A-Za-z0-9._%+-]{1,64})\s{0,8}(?:\[|\()?\s{0,8}(?:at|arobase|chez)\s{0,8}(?:\]|\))?\s{0,8}([A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})*?)\s{0,8}(?:\[|\()?\s{0,8}(?:dot|point)\s{0,8}(?:\]|\))?\s{0,8}([A-Za-z]{2,24})/gi;

/**
 * L'arobase remplacee par un litteral, dans le `href` d'un `mailto:`.
 *
 * Un CMS repandu chez les petites communes ecrit `abcdanse[^@]gmail.com` et laisse un
 * script de la page reposer l'arobase cote client. Nous n'executons pas de script
 * (invariant 1), et le lot 5 a mesure 138 adresses ainsi cassees sur le seul
 * Ille-et-Vilaine : acceptees par le motif large de l'extraction, refusees par la
 * validation syntaxique, notees zero, et deversees dans la file de revue ou il fallait
 * les reparer une par une.
 *
 * **Pourquoi celui-la se repare sans rien deviner.** Ni `[` ni `]` n'ont le droit de
 * figurer dans une partie locale non guillemetee : la substitution ne peut donc pas
 * abimer une adresse valide, puisqu'aucune adresse valide ne contient ce motif. C'est ce
 * qui la distingue d'une desobfuscation generale — deduire une arobase du mot « at »
 * dans de la prose reste une inference, et garde sa confiance basse.
 *
 * On ne reconnait **que ce litteral**, et non toute paire de crochets : l'ADR-017 avait
 * laisse la desobfuscation ouverte, et l'ouvrir en grand n'est pas la refermer.
 */
const AROBASE_MASQUEE = "[^@]";

/**
 * Rend l'adresse reparee, ou `undefined` si elle n'a pas ce defaut — ou si la reparation
 * ne donne pas exactement une arobase, auquel cas on a affaire a autre chose et on ne
 * touche a rien.
 */
export function reparerArobaseMasquee(brut: string): string | undefined {
  if (!brut.includes(AROBASE_MASQUEE)) return undefined;
  const repare = brut.replace(AROBASE_MASQUEE, "@");
  return repare.split("@").length === 2 ? repare : undefined;
}

/** Fixe francais ou mobile. Voir `motifs.ts` : ses bornes sont des chiffres, pas des mots. */
const TELEPHONE = new RegExp(SOURCE_TELEPHONE, "g");

/**
 * Au-dela, un bloc n'est plus la fiche d'une structure : c'est le conteneur qui les
 * empile, et il ne nomme aucune d'entre elles.
 *
 * Sans ce plafond, un contact dont la cellule ne porte que « Mr Frederic SCHNEIDER »
 * retombait sur le bloc suivant — la section entiere, 4 582 caracteres et vingt et un
 * contacts — ou `rattacher` trouvait le premier nom du RNA venu et le lui donnait. Sur un
 * departement reel : 90 adresses livrees sous « BADMINTON CLUB SAINT-DIE-DES-VOSGES »,
 * 53 sous « BIBLIOTHEQUE PATRIMONIALE DU DIOCESE », 21 sous « SOCIETE DE CHASSE
 * COMMUNALE ARCHETTES-VOSGES ». Une ligne qui nomme une association et livre les adresses
 * de vingt autres est plus trompeuse qu'une ligne « Garage Pupier » : elle est fausse au
 * lieu d'etre hors sujet.
 *
 * **Trois, mesure sur les Vosges.** La fiche d'une structure porte souvent un fixe, un
 * mobile et une adresse ; au-dela, on n'a jamais trouve de fiche. Le balayage des 1 184
 * pages visitees donne, selon le plafond : 1 → 40 rattachements, 2 → 179, 3 → 236,
 * 4 → 270 mais sept conteneurs reviennent, sans plafond → 906 dont un groupe de 147.
 * Le plafond ecarte 382 des 506 rattachements de la base ; verifies un par un sur un
 * echantillon, ils etaient faux.
 */
export const CONTACTS_MAX_PAR_BLOC = 3;

/**
 * Parties locales qui designent une fonction et non une personne.
 *
 * La liste est comparee aux **jetons** de la partie locale — les segments separes par
 * `.`, `-` ou `_` — et non a la chaine compactee. La recherche par inclusion classait
 * « p.deville » en generique parce que « pdeville » porte « ville », et « m.lecole »
 * parce qu'il porte « ecole » : des adresses nominatives rangees sous le regime le plus
 * permissif, soit exactement le risque que l'invariant 7 existe pour ecarter.
 */
const RACINES_GENERIQUES: readonly string[] = [
  "contact", "mairie", "secretariat", "secretaire", "accueil", "info", "communication",
  "associ", "club", "sport", "culture", "jeunesse", "service", "direction",
  "administration", "courrier", "webmaster", "bureau", "president", "tresorier",
  "inscription", "reservation", "ecole", "cantine", "commune", "ville", "hoteldeville",
  "noreply", "nepasrepondre", "postmaster", "abuse",
];

/** Faux positifs frequents : un nom de fichier lu comme une adresse. */
const EXTENSIONS_IMAGE = /\.(?:png|jpe?g|gif|webp|svg|css|js)$/i;

export function extraireContacts(
  doc: DocumentAnalyse,
  options: { avecMobiles: boolean },
): ResultatExtraction {
  const trouves: ContactExtrait[] = [];
  let mobilesExclus = 0;

  // Compte une fois par page, et non une fois par contact : les blocs sont imbriques, et
  // un `article` se relirait autant de fois qu'il porte d'adresses.
  const porteurs = compterContactsParBloc(doc.blocs);
  const porteursDeFiche = compterContactsParBloc(doc.fiches);
  // Un titre n'est un en-tete que si sa branche ne porte aucun contact.
  const titresSeuls = compterContactsParBloc(doc.fiches.map((fiche) => fiche.branche)).map((n) => n === 0);

  const ajouterEmail = (brut: string, methode: string, confiance: number, empreinte: string): void => {
    const valeur = nettoyerEmail(brut);
    if (valeur === undefined) return;
    trouves.push({
      kind: "email",
      valeur,
      valeurNormalisee: valeur.toLowerCase(),
      isGenerique: classerEmail(valeur),
      methode,
      confiance,
      contextes: contextesDe(doc.blocs, empreinte, porteurs),
      empreinte,
      titre: titreDe(doc.fiches, empreinte, porteursDeFiche, titresSeuls),
    });
  };

  const ajouterTelephone = (brut: string, methode: string, confiance: number, empreinte: string): void => {
    const normalise = normaliserTelephone(brut);
    if (normalise === undefined) return;
    if (!options.avecMobiles && estMobile(normalise)) {
      mobilesExclus += 1;
      return;
    }
    trouves.push({
      kind: "phone",
      valeur: brut.trim(),
      valeurNormalisee: normalise,
      isGenerique: null,
      methode,
      confiance,
      contextes: contextesDe(doc.blocs, empreinte, porteurs),
      empreinte,
      titre: titreDe(doc.fiches, empreinte, porteursDeFiche, titresSeuls),
    });
  };

  // 1. Ce que la page declare elle-meme.
  for (const lien of doc.liens) {
    const bas = lien.href.toLowerCase();
    if (bas.startsWith("mailto:")) {
      const adresse = decoderSansEchec(lien.href.slice("mailto:".length)).split("?")[0] ?? "";
      for (const part of adresse.split(",")) {
        // La reparation est tentee avant le nettoyage : `nettoyerEmail` accepte
        // `nom[^@]domaine.fr` — il y voit une arobase et du texte de part et d'autre — et
        // l'adresse partait en base telle quelle pour n'etre refusee qu'a la validation.
        const repare = reparerArobaseMasquee(part);
        if (repare === undefined) ajouterEmail(part, "dom:mailto", CONFIANCE_DOM, lien.href);
        else ajouterEmail(repare, "dom:mailto+repare", CONFIANCE_DOM_REPARE, lien.href);
      }
    } else if (bas.startsWith("tel:")) {
      ajouterTelephone(decoderSansEchec(lien.href.slice("tel:".length)), "dom:tel", CONFIANCE_DOM, lien.href);
    }
  }

  // 2. Ce qu'on lit dans le texte.
  for (const trouve of doc.texte.matchAll(EMAIL)) {
    ajouterEmail(trouve[0], "texte:motif", CONFIANCE_MOTIF, trouve[0]);
  }
  for (const trouve of doc.texte.matchAll(TELEPHONE)) {
    ajouterTelephone(trouve[0], "texte:motif", CONFIANCE_MOTIF, trouve[0]);
  }

  // 3. Ce qu'on reconstruit.
  for (const trouve of doc.texte.matchAll(EMAIL_OBFUSQUE)) {
    const entier = trouve[0];
    const local = trouve[1];
    const domaine = trouve[2];
    const tld = trouve[3];
    if (local === undefined || domaine === undefined || tld === undefined) continue;
    ajouterEmail(`${local}@${domaine}.${tld}`, "texte:obfusque", CONFIANCE_OBFUSQUE, entier);
  }

  return { contacts: dedupliquer(trouves), mobilesExclus };
}

/**
 * Un meme contact est presque toujours vu plusieurs fois : dans un `mailto:` et dans
 * le texte du lien. On garde la lecture la plus sure, et a confiance egale le
 * contexte le plus etroit — c'est lui qui portera le nom de l'association.
 */
function dedupliquer(contacts: readonly ContactExtrait[]): ContactExtrait[] {
  const parCle = new Map<string, ContactExtrait>();
  for (const contact of contacts) {
    const cle = `${contact.kind} ${contact.valeurNormalisee}`;
    const connu = parCle.get(cle);
    if (connu === undefined) {
      parCle.set(cle, contact);
      continue;
    }
    const meilleur =
      contact.confiance > connu.confiance ||
      (contact.confiance === connu.confiance && contexteUtile(contact, connu));
    if (meilleur) parCle.set(cle, contact);
  }
  return [...parCle.values()];
}

function contexteUtile(candidat: ContactExtrait, connu: ContactExtrait): boolean {
  return candidat.contextes.length > connu.contextes.length;
}

/**
 * Tous les blocs qui portent l'empreinte **et ne portent qu'elle, ou presque**, du plus
 * etroit au plus large.
 *
 * On ne tranche toujours pas entre les niveaux retenus — le bon est celui qui contiendra
 * un nom d'association, et seul le rattachement le sait. Mais on sait dire, ici et sans
 * rien deviner, lesquels ne peuvent designer personne : ceux qui empilent plus de
 * `CONTACTS_MAX_PAR_BLOC` contacts.
 */
function contextesDe(
  blocs: readonly Bloc[],
  empreinte: string,
  porteurs: readonly number[],
): readonly string[] {
  if (empreinte === "") return [];
  const portants: string[] = [];
  blocs.forEach((bloc, rang) => {
    if ((porteurs[rang] ?? 1) > CONTACTS_MAX_PAR_BLOC) return;
    if (bloc.texte.includes(empreinte) || bloc.liens.some((lien) => lien.href === empreinte)) {
      portants.push(bloc.texte);
    }
  });
  return portants.sort((a, b) => a.length - b.length);
}

/**
 * Le titre de la plus etroite fiche qui porte l'empreinte, sous le meme plafond que les
 * blocs : une fiche qui porte plus de `CONTACTS_MAX_PAR_BLOC` contacts est une rubrique, et
 * son titre — « Aines », « Sport » — ne nomme aucune des structures qu'elle range.
 */
function titreDe(
  fiches: readonly Fiche[],
  empreinte: string,
  porteurs: readonly number[],
  titresSeuls: readonly boolean[],
): string | undefined {
  if (empreinte === "") return undefined;
  let retenue: Fiche | undefined;
  fiches.forEach((fiche, rang) => {
    if ((porteurs[rang] ?? 1) > CONTACTS_MAX_PAR_BLOC) return;
    if (titresSeuls[rang] !== true) return;
    if (!fiche.texte.includes(empreinte) && !fiche.liens.some((lien) => lien.href === empreinte)) return;
    if (retenue === undefined || fiche.texte.length < retenue.texte.length) retenue = fiche;
  });
  return retenue?.titre;
}

/**
 * Combien de contacts distincts chaque bloc porte.
 *
 * Les memes motifs que l'extraction, plus les `mailto:`/`tel:` du bloc : compter autrement
 * ferait diverger le plafond de ce qu'il est cense compter. Les valeurs sont reduites a
 * leur forme comparable — minuscules pour une adresse, chiffres seuls pour un numero —
 * pour qu'un `mailto:` et le texte du lien qui le repete ne comptent qu'une fois.
 */
function compterContactsParBloc(blocs: readonly (Bloc | Fiche)[]): number[] {
  return blocs.map((bloc) => {
    const vus = new Set<string>();
    for (const trouve of bloc.texte.matchAll(EMAIL)) vus.add(decollerEmail(trouve[0]).toLowerCase());
    for (const trouve of bloc.texte.matchAll(TELEPHONE)) vus.add(trouve[0].replace(/\D/g, ""));
    for (const lien of bloc.liens) {
      const bas = lien.href.toLowerCase();
      if (bas.startsWith("mailto:")) vus.add((bas.slice("mailto:".length).split("?")[0] ?? "").trim());
      else if (bas.startsWith("tel:")) vus.add(bas.slice("tel:".length).replace(/\D/g, ""));
    }
    return vus.size;
  });
}

function decoderSansEchec(valeur: string): string {
  try {
    return decodeURIComponent(valeur);
  } catch {
    return valeur;
  }
}

/**
 * Exportee au lot 6 : la revue humaine doit nettoyer une adresse saisie a la main
 * exactement comme l'extraction nettoie une adresse lue. Deux regles de forme
 * differentes produiraient deux populations de contacts que rien ne distinguerait en
 * base.
 */
export function nettoyerEmail(brut: string): string | undefined {
  const valeur = brut
    .trim()
    .replace(/^[<("']+/, "")
    // Le schema d'URL n'appartient pas a l'adresse. Il survivait par deux chemins : un
    // `href="mailto:mailto:club@asso.fr"` — le prefixe pose deux fois par un CMS, dont
    // l'extraction ne retire que le premier — et un lien colle tel quel dans la case de
    // correction de la revue. Dans les deux cas l'adresse partait en base avec son
    // prefixe, echouait a la validation syntaxique (`:` n'a pas droit de cite dans une
    // partie locale), tombait a zero et revenait en revue.
    .replace(/^(?:mailto:)+/i, "")
    .replace(/[>)"',.;]+$/, "");
  if (!/^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(valeur)) return undefined;
  if (EXTENSIONS_IMAGE.test(valeur)) return undefined;
  if (valeur.length > 254) return undefined;
  return decollerEmail(valeur);
}

/**
 * Suffixes au-dela desquels une colle se reconnait. Liste courte et volontairement
 * incomplete : elle ne sert qu'a **decoller**, jamais a valider. Une adresse dont le
 * suffixe n'y figure pas passe intacte.
 */
const SUFFIXES_COURANTS: readonly string[] = [
  "info", "com", "net", "org", "biz", "bzh", "fr", "eu", "be", "ch", "lu", "de", "es", "it", "uk", "io", "re",
];

/** Ce qu'un CMS colle a une adresse, sans espace, quand le lien suivant est une URL. */
const COLLES: readonly string[] = ["http", "www"];

/**
 * L'adresse, debarrassee du texte que le CMS lui a soude.
 *
 * `analyser` ne coupe le texte qu'aux frontieres de bloc — c'est ce qui garde entier
 * `contact<span>@</span>mairie.fr` — et deux elements en ligne voisins s'y collent donc
 * sans espace. Sur la Haute-Loire, 69 adresses du fichier livre en portaient la trace :
 * `…@cidff43.frhttps`, `…@hotmail.comwww.aappma-….e-monsite.com`, `…@laposte.netJudo`.
 * Chacune doublait l'adresse vraie, et l'export la nommait d'apres son domaine casse —
 * « Hotmail », « Gmail », « Orange ».
 *
 * Trois regles, et pas une de plus, parce qu'une coupe fausse fabriquerait une adresse :
 *
 * 1. une **messagerie** suivie d'autre chose que son suffixe — `gmail.comhbcbrioude…` :
 *    une messagerie n'a pas de sous-domaine au nom d'un club ;
 * 2. un suffixe courant suivi de `http`, `https` ou `www` ;
 * 3. un suffixe courant **en minuscules** suivi d'une capitale, en fin d'adresse — la
 *    casse d'origine le trahit, « netJudo ».
 *
 * Elle ne coupe jamais « suffixe courant + minuscules » : `.co` precede `.coop`, `.in`
 * precede `.info`, et `.com` precede `.community`.
 *
 * Exportee pour la reparation au demarrage : les bases ecrites avant ce decollage portent
 * ces adresses, et elles se reparent avec **cette** fonction — une seconde implementation
 * en SQL finirait par ne plus rendre ce que l'extraction rend.
 */
export function decollerEmail(adresse: string): string {
  const arobase = adresse.lastIndexOf("@");
  if (arobase <= 0) return adresse;
  const domaine = adresse.slice(arobase + 1);
  const decolle = domaineDecolle(domaine);
  return decolle === domaine ? adresse : `${adresse.slice(0, arobase)}@${decolle}`;
}

function domaineDecolle(domaine: string): string {
  const etiquettes = domaine.split(".");
  if (etiquettes.length < 2) return domaine;

  const premiere = etiquettes[0] ?? "";
  const seconde = etiquettes[1] ?? "";
  const enTete = suffixeEnTete(seconde.toLowerCase());
  if (enTete !== undefined && seconde.length > enTete.length && estEtiquetteDeMessagerie(premiere)) {
    return `${premiere}.${seconde.slice(0, enTete.length)}`;
  }

  for (let rang = 1; rang < etiquettes.length; rang += 1) {
    const etiquette = etiquettes[rang] ?? "";
    const bas = etiquette.toLowerCase();
    const suffixe = suffixeEnTete(bas);
    if (suffixe !== undefined && COLLES.some((colle) => bas.startsWith(`${suffixe}${colle}`))) {
      return [...etiquettes.slice(0, rang), etiquette.slice(0, suffixe.length)].join(".");
    }
  }

  const derniere = etiquettes[etiquettes.length - 1] ?? "";
  const suffixe = suffixeEnTete(derniere);
  if (suffixe !== undefined && /^[A-Z]/.test(derniere.slice(suffixe.length))) {
    return [...etiquettes.slice(0, -1), suffixe].join(".");
  }
  return domaine;
}

/** Le plus long suffixe courant qui ouvre l'etiquette, compare tel quel. */
function suffixeEnTete(etiquette: string): string | undefined {
  let trouve: string | undefined;
  for (const suffixe of SUFFIXES_COURANTS) {
    if (etiquette.startsWith(suffixe) && (trouve === undefined || suffixe.length > trouve.length)) trouve = suffixe;
  }
  return trouve;
}

/**
 * §4.7 — 1 generique, 0 nominatif, null quand la forme ne tranche pas.
 *
 * L'ordre des tests est le sujet de cette fonction. L'ADR-012 pose que « quand la forme
 * designe une personne, c'est le regime le plus strict qui s'applique » ; le code faisait
 * l'inverse, en cherchant d'abord une racine de fonction. Quatre regles, dans cet ordre :
 *
 * 1. **Initiale puis patronyme** — « p.deville », « j.dupont ». La forme designe une
 *    personne, et rien ne la deloge : c'est le cas que l'ADR nomme.
 * 2. **Mot de fonction en tete** — « contact », « secretariat.mairie ». C'est ainsi que
 *    s'ecrit une adresse de service.
 * 3. **Mot de fonction ailleurs**, mais *derive* — « vie.associative » porte
 *    « associative », qui prolonge la racine « associ ». Un derive ne se rencontre pas
 *    comme patronyme : generique.
 * 4. **Mot de fonction ailleurs, et mot exact** — « jean.bureau ». « Bureau » est un
 *    patronyme francais courant autant qu'un mot de fonction. On ne tranche pas :
 *    `null`, ce que l'export rend par « indetermine ». Mieux vaut avouer le doute que
 *    ranger une personne sous le regime des adresses de service.
 *
 * La partie locale passe par `normaliserNom` : sans cela « emilie.dupont » et
 * « francois.martin » — qui entrent bel et bien en base, `nettoyerEmail` les accepte et
 * un `mailto:` percent-encode est decode en UTF-8 avant — tombaient en indetermine.
 */
export function classerEmail(adresse: string): 0 | 1 | null {
  const jetons = normaliserNom(adresse.split("@")[0] ?? "")
    .split(" ")
    .filter((jeton) => jeton !== "");
  if (jetons.length === 0) return null;

  if ((jetons[0] ?? "").length === 1 && jetons.length >= 2) return 0;

  const fonctions = jetons.map((jeton) => RACINES_GENERIQUES.some((racine) => jeton.startsWith(racine)));
  if (fonctions[0] === true) return 1;

  const indexFonction = fonctions.indexOf(true);
  if (indexFonction !== -1) {
    const jeton = jetons[indexFonction] ?? "";
    return RACINES_GENERIQUES.includes(jeton) ? null : 1;
  }

  return jetons.length >= 2 ? 0 : null;
}

/** Rend la forme internationale `+33XXXXXXXXX`, ou `undefined` si ce n'est pas un numero. */
export function normaliserTelephone(brut: string): string | undefined {
  const chiffres = brut.replace(/[^\d+]/g, "");
  let national: string;
  if (chiffres.startsWith("+33")) national = `0${chiffres.slice(3)}`;
  else if (chiffres.startsWith("0033")) national = `0${chiffres.slice(4)}`;
  else if (chiffres.startsWith("0")) national = chiffres;
  else return undefined;
  if (!/^0[1-9]\d{8}$/.test(national)) return undefined;
  return `+33${national.slice(1)}`;
}

/** §4.6 — les prefixes viennent de `invariants.ts`, ils ne sont pas reglables. */
export function estMobile(normalise: string): boolean {
  const national = `0${normalise.slice(3)}`;
  return MOBILE_PREFIXES.some((prefixe) => national.startsWith(prefixe));
}
