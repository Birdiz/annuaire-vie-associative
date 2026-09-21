/**
 * Les motifs d'une adresse et d'un numero, en un seul endroit.
 *
 * Ils servent a trois usages — extraire les contacts, compter ceux d'un bloc, les effacer
 * d'un bloc avant d'y chercher un nom — et vivaient en deux copies, celle de
 * `nom-pressenti.ts` suivant celle d'`extraction.ts` par discipline. C'est ainsi qu'un
 * numero colle a une lettre echappait aux trois a la fois : deux chemins qui doivent
 * s'accorder finissent toujours par diverger.
 *
 * Exportes par leur **source** et non comme expressions : chaque usage choisit ses
 * drapeaux, et une expression globale partagee garderait son `lastIndex` d'un appel a
 * l'autre.
 */

/**
 * **Les quantificateurs sont bornes, et ce n'est pas de la coquetterie.**
 *
 * Un `+` gourmand sur une classe large, ancre par un caractere qui n'arrive jamais dans
 * du texte ordinaire, coute O(reste) a chaque position de depart : le balayage devient
 * quadratique. Mesure sur du texte sans aucune adresse, avant bornage — 20 000
 * caracteres : 1,5 s ; 40 000 : 6 s ; 160 000 : 97 s. Or `MAX_RESPONSE_BYTES` vaut 5 Mo
 * et `estHtml(null)` rend `true` : une page de mairie verbeuse suffisait a bloquer
 * l'event loop plusieurs minutes, une page hostile plusieurs heures — et depuis
 * l'ADR-024 le worker tourne dans le process de l'interface, qui gele avec lui.
 *
 * Les bornes ne sont pas arbitraires : RFC 5321 §4.5.3.1 fixe la partie locale a 64
 * octets et chaque label de domaine a 63. Apres bornage, un million de caracteres se
 * balaient en 227 ms.
 *
 * **Le suffixe ne change pas de casse en chemin.** Un CMS colle volontiers la cellule
 * suivante a l'adresse, sans espace : « …@laposte.netJudo », « …@gmail.comInstagram ».
 * `[A-Za-z]{2,24}` avalait le mot colle, et le domaine devenait « netjudo » — une adresse
 * qui n'existe pas, en double de la vraie, et que l'export nommait « Laposte ». Un suffixe
 * s'ecrit en minuscules, en capitales, ou avec une capitale initiale : c'est le changement
 * de casse qui marque la fin de l'adresse. Une colle toute en minuscules (« comhttps »)
 * ne se voit pas ici ; `decollerEmail` s'en charge.
 */
export const SOURCE_EMAIL = String.raw`[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})*\.(?:[a-z]{2,24}|[A-Z][a-z]{1,23}|[A-Z]{2,24})`;

/**
 * Fixe francais ou mobile, avec les separateurs usuels, ou forme internationale.
 *
 * **Borne par des chiffres, et non par des mots.** Un `\b` de part et d'autre echouait des
 * que le numero touchait une lettre : « … 06 98 00 00 00Albert », deux cellules collees
 * par le CMS. Le numero n'etait alors ni extrait, ni exclu s'il etait mobile, ni efface du
 * bloc — et il finissait dans le **nom** de la structure, livre au client en violation de
 * l'invariant 6.
 *
 * A droite, une minuscule arrete encore le motif : « 01.02.2023 14h30 » est une date et
 * une heure, pas un numero. Une capitale ne l'arrete pas, c'est le debut de la cellule
 * suivante.
 */
export const SOURCE_TELEPHONE = String.raw`(?<![\d+])(?:\+33[\s.-]?|0)[1-9](?:[\s.-]?\d{2}){4}(?![\da-zà-ÿ])`;

const TELEPHONE = new RegExp(SOURCE_TELEPHONE);

/**
 * Le texte porte-t-il un numero ? Un numero de telephone, ou dix chiffres a la suite — un
 * identifiant colle dans un lien, « …-de-Brioude-100083325431850 ».
 *
 * Sert a refuser un **nom** qui en contient un. L'effacement des contacts du bloc precede
 * la recherche du nom, mais un nom deja ecrit en base par une version anterieure ne l'a
 * pas subi, et l'export ne doit jamais livrer un 06 dans une colonne qui n'est pas celle
 * des telephones (invariant 6).
 */
export function porteUnNumero(texte: string): boolean {
  if (TELEPHONE.test(texte) || /(?:\d[\s.-]?){9}\d/.test(texte)) return true;
  // Le debut d'un numero que la cellule suivante a coupe : « Veronique X au 06 98 ». Un
  // fragment de mobile reste une donnee personnelle.
  // Separateurs exiges : « LA PAROLE 0702 » est un nom du RNA.
  return /(?:^|\s)0[1-9](?:[\s.-]\d{2}){1,3}\s*$/.test(texte);
}
