/**
 * Etape [7] du §6 : la validation syntaxique, en amont du controle MX.
 *
 * Elle n'existait pas avant ce lot, et son absence coutait cher. `nettoyerEmail` de
 * l'etape [5] ne verifie qu'une forme tres large — « du texte, une arobase, du texte, un
 * point, deux lettres » — parce qu'a l'extraction il vaut mieux retenir trop que pas
 * assez. Le tri fin appartient a la normalisation.
 *
 * **Ce que la mesure a montre.** Sur l'Ille-et-Vilaine, 138 contacts portaient une
 * adresse de la forme `abcdanse[^@]gmail.com` : un CMS repandu chez les petites communes
 * remplace l'arobase de ses `mailto:` par ce littéral, qu'un script du navigateur repare
 * cote client. Le motif large les acceptait, et elles comptaient dans le taux de
 * couverture. C'est le controle MX qui les a fait sortir — 41 domaines en EBADNAME —
 * ce qui dit assez qu'une validation syntaxique ne se remplace pas par un motif permissif.
 *
 * **Ce module ne repare rien.** Reconstruire ces adresses serait une desobfuscation,
 * donc une decision d'extraction [5] et non de normalisation. Ici on constate, on dit
 * pourquoi, et le score en tire les consequences.
 */

/** Longueurs de la RFC 5321 : 64 pour la partie locale, 255 pour le domaine. */
const LOCALE_MAX = 64;
const DOMAINE_MAX = 255;

/** Caracteres admis dans une partie locale non guillemetee (RFC 5322, forme courante). */
const LOCALE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;

/** Etiquette de domaine : alphanumerique, tirets a l'interieur seulement. */
const ETIQUETTE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/** Le domaine de tete est alphabetique : pas de `.123`, pas de `.co-uk`. */
const TLD = /^[A-Za-z]{2,63}$/;

export type Validation = { valide: boolean; motif: string | undefined };

const VALIDE: Validation = { valide: true, motif: undefined };

function invalide(motif: string): Validation {
  return { valide: false, motif };
}

/**
 * Verdict syntaxique sur une adresse deja normalisee en minuscules. Le motif est
 * conserve : « invalide » sans raison n'est ni discutable en revue, ni corrigible.
 */
export function validerEmail(adresse: string): Validation {
  if (adresse.length === 0 || adresse.length > 254) return invalide("longueur");

  const arobase = adresse.lastIndexOf("@");
  if (arobase <= 0 || arobase === adresse.length - 1) return invalide("arobase");

  const locale = adresse.slice(0, arobase);
  const domaine = adresse.slice(arobase + 1);

  // Une seconde arobase signale presque toujours une obfuscation mal lue, du genre
  // `nom[^@]domaine.fr` ou `nom@@domaine.fr`.
  if (locale.includes("@")) return invalide("arobase");
  if (locale.length > LOCALE_MAX) return invalide("longueur");
  if (!LOCALE.test(locale)) return invalide("partie_locale");

  if (domaine.length > DOMAINE_MAX) return invalide("longueur");
  const etiquettes = domaine.split(".");
  if (etiquettes.length < 2) return invalide("domaine");
  for (const etiquette of etiquettes) {
    if (!ETIQUETTE.test(etiquette)) return invalide("domaine");
  }
  const tld = etiquettes[etiquettes.length - 1];
  if (tld === undefined || !TLD.test(tld)) return invalide("domaine_de_tete");

  return VALIDE;
}

/**
 * Verdict sur un numero deja normalise par l'etape [5]. Celle-ci rend la forme
 * internationale ou rien, donc le controle se resume a verifier qu'elle l'a bien fait —
 * une ligne ecrite avant ce lot, ou modifiee a la main, peut ne pas l'avoir.
 */
export function validerTelephone(numero: string): Validation {
  return /^\+33[1-9]\d{8}$/.test(numero) ? VALIDE : invalide("forme");
}

export function valider(kind: "email" | "phone", valeurNormalisee: string): Validation {
  return kind === "email" ? validerEmail(valeurNormalisee) : validerTelephone(valeurNormalisee);
}
