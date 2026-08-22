/**
 * Etape [8] du §6 : le score de confiance qui alimente l'ecran de revue humaine.
 *
 * **Pourquoi il ne remplace pas `confiance`.** `confiance` dit comment le contact a ete
 * *lu* : 0,9 pour un lien `mailto:` que l'auteur de la page a ecrit lui-meme, 0,45 pour
 * une forme desobfusquee que nous avons reconstruite (ADR-012). C'est une provenance,
 * elle ne bouge plus. Le score ci-dessous dit si le contact vaut d'etre *publie*, ce qui
 * depend aussi du MX de son domaine, du regime juridique de l'adresse et de la page d'ou
 * elle vient. Ecraser l'une par l'autre perdrait la provenance au premier reglage.
 *
 * **Pourquoi il est multiplicatif.** Chaque signal repond a « qu'est-ce que ceci retire
 * a une lecture parfaite ». Un produit de facteurs se lit facteur par facteur — « le
 * domaine n'a pas de MX » retire toujours la meme proportion, quelle que soit la
 * qualite de lecture — la ou une somme de poids demanderait de connaitre le total pour
 * interpreter un terme.
 *
 * **Pourquoi les motifs sont persistes.** Un score qu'on ne peut pas expliquer n'est pas
 * revisable : la personne qui arbitre doit voir *ce qui* a fait descendre le chiffre,
 * pas seulement le chiffre. Meme argument que `prefiltre_motif` au lot 4.
 *
 * Tout est pur et testable sans base ni reseau.
 */

/**
 * Incrementee des que le bareme change. Ecrite sur chaque ligne notee.
 *
 * 2 au lot 6 : la revue humaine entre dans le bareme. Une valeur corrigee a la main ne
 * peut pas rester plafonnee par la qualite de lecture de la machine — c'est justement
 * cette lecture que l'humain vient de corriger.
 */
export const VERSION_SCORE = 2;

export type SignalScore = {
  /** Nom du signal, stable : c'est lui qui s'affichera en revue. */
  signal: string;
  /** Facteur applique, dans ]0, 1]. */
  facteur: number;
  /** Ce qui a ete observe, en clair. */
  detail: string;
};

export type Motifs = {
  base: number;
  signaux: readonly SignalScore[];
};

export type Note = { score: number; motifs: Motifs };

/**
 * Etat d'un contact au moment de la notation. Volontairement plat et sans identifiant :
 * la fonction ne doit rien pouvoir faire d'autre que calculer.
 */
export type ContactANoter = {
  kind: "email" | "phone";
  /**
   * Verdict de la validation syntaxique. Faux annule le score : une adresse qui n'est
   * pas une adresse ne vaut rien, quelle qu'ait ete la qualite de sa lecture.
   */
  syntaxeValide: boolean;
  /** Qualite de lecture heritee de l'extraction [5]. */
  confiance: number;
  /** §4.7 — 1 generique, 0 nominatif, `null` indetermine. */
  isGenerique: 0 | 1 | null;
  /** Vrai si le contact est rattache a une association nommee, faux s'il ne l'est qu'a la commune. */
  rattache: boolean;
  /** Verdict MX du domaine : 1 present, 0 absent, `null` echec ou domaine jamais verifie. */
  mx: 0 | 1 | null;
  /** Verdict du pre-filtre [4] sur la page source, `null` si la page n'a pas ete jugee. */
  prefiltreVerdict: "retenue" | "ecartee" | null;
  /** Vrai si un humain a reecrit la valeur en revue (lot 6). */
  corrigeEnRevue: boolean;
};

/**
 * Une valeur qui n'a pas la forme d'une adresse ni d'un numero n'est pas un contact.
 * Le facteur est nul, et non seulement bas : il n'y a rien a arbitrer en revue, et un
 * score residuel la ferait remonter au-dessus de contacts parfaitement lisibles.
 */
const FACTEUR_SYNTAXE_INVALIDE = 0;

/**
 * Un domaine sans MX ne recoit pas de courrier : l'adresse est inexploitable telle
 * quelle. Le facteur est severe mais pas nul — la ligne garde sa valeur de trace, et
 * c'est une decision humaine, pas la notre, de la rejeter.
 */
const FACTEUR_SANS_MX = 0.3;
/** Ni confirme ni infirme : on retire un peu, on ne condamne pas. */
const FACTEUR_MX_INCONNU = 0.9;

/**
 * Une adresse nominative est plus fragile qu'une adresse de fonction : la personne
 * change de role, l'adresse meurt avec. Elle releve en outre d'un regime juridique plus
 * strict (§4.7), ce qui en fait exactement le genre de ligne qu'un humain doit voir.
 */
const FACTEUR_NOMINATIF = 0.8;
const FACTEUR_REGIME_INDETERMINE = 0.95;

/** Un contact au niveau commune reste exploitable, il est simplement moins precis. */
const FACTEUR_NON_RATTACHE = 0.85;

/** La page etait jugee peu prometteuse : ce qu'on y a lu merite un regard de plus. */
const FACTEUR_PAGE_ECARTEE = 0.9;
const FACTEUR_PAGE_NON_JUGEE = 0.95;

/**
 * Base d'un contact corrige en revue. Elle remplace `confiance` au lieu de s'y
 * multiplier : la correction ne s'ajoute pas a la lecture de la machine, elle la
 * remplace. Une adresse desobfusquee a la main garderait sinon la base de 0,45 de
 * l'ADR-012 et tout seuil d'export continuerait a l'ecarter — la revue ne servirait
 * a rien.
 *
 * 0,95 et non 1 : l'humain a lu la meme page que nous, il a pu se tromper aussi. Les
 * facteurs qui suivent — MX, regime, rattachement — s'appliquent normalement par
 * dessus, et c'est voulu : corriger une adresse ne prouve pas que son domaine recoit
 * du courrier.
 */
const CONFIANCE_REVUE_HUMAINE = 0.95;

export function noter(contact: ContactANoter): Note {
  const signaux: SignalScore[] = [];
  const base = contact.corrigeEnRevue ? CONFIANCE_REVUE_HUMAINE : borner(contact.confiance);
  let score = base;

  // Pousse directement : `appliquer` ignore les facteurs de 1, et celui-ci n'en est pas
  // un — c'est une mention, pour que l'ecran dise d'ou vient une base inhabituelle.
  if (contact.corrigeEnRevue) {
    signaux.push({ signal: "revue", facteur: 1, detail: "valeur corrigee en revue humaine" });
  }

  const appliquer = (signal: string, facteur: number, detail: string): void => {
    if (facteur === 1) return;
    signaux.push({ signal, facteur, detail });
    score *= facteur;
  };

  // La syntaxe passe avant tout le reste, et court-circuite : appliquer un facteur de
  // MX a une chaine qui n'est pas une adresse produirait un motif absurde.
  if (!contact.syntaxeValide) {
    appliquer("syntaxe", FACTEUR_SYNTAXE_INVALIDE, "la valeur n'a pas la forme attendue");
    return { score: 0, motifs: { base, signaux } };
  }

  // Le MX est un fait de domaine et ne concerne que le courrier : l'appliquer a un
  // numero de telephone n'aurait aucun sens.
  if (contact.kind === "email") {
    if (contact.mx === 0) appliquer("mx", FACTEUR_SANS_MX, "le domaine n'annonce aucun MX");
    else if (contact.mx === null) appliquer("mx", FACTEUR_MX_INCONNU, "MX non verifie");

    if (contact.isGenerique === 0) appliquer("regime", FACTEUR_NOMINATIF, "adresse nominative (§4.7)");
    else if (contact.isGenerique === null) {
      appliquer("regime", FACTEUR_REGIME_INDETERMINE, "regime indetermine");
    }
  }

  if (!contact.rattache) {
    appliquer("rattachement", FACTEUR_NON_RATTACHE, "rattache a la commune seule");
  }

  if (contact.prefiltreVerdict === "ecartee") {
    appliquer("page", FACTEUR_PAGE_ECARTEE, "page ecartee par le pre-filtre [4]");
  } else if (contact.prefiltreVerdict === null) {
    appliquer("page", FACTEUR_PAGE_NON_JUGEE, "page non jugee par le pre-filtre [4]");
  }

  // Deux decimales : le schema stocke un REEL, mais un score affiche a quinze chiffres
  // suggererait une precision que ce bareme n'a pas.
  return { score: Math.round(borner(score) * 100) / 100, motifs: { base, signaux } };
}

function borner(valeur: number): number {
  if (!Number.isFinite(valeur)) return 0;
  return Math.min(1, Math.max(0, valeur));
}
