/**
 * Normalisation de texte, partagee par l'amorce et la decouverte.
 *
 * Elle vit ici plutot que dans `seed/` parce que le rapprochement d'un contact avec
 * une association compare un texte de page a un nom venu du RNA : les deux cotes
 * doivent passer par exactement la meme fonction, sans quoi le rapprochement echoue
 * sur des differences invisibles — une apostrophe typographique, un tiret cadratin.
 */

/**
 * Minuscules, accents retires, tout le reste reduit a une espace simple. Le resultat
 * se prete a une recherche par inclusion sur limites de mots : ` ${texte} ` contient
 * ` ${nom} ` si et seulement si le nom y apparait comme suite de mots entiers.
 */
export function normaliserNom(nom: string): string {
  return nom
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
