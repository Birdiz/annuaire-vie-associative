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

/**
 * Taille lisible. Partagee par la CLI et par les scripts d'emballage : deux formatages
 * distincts pour la meme grandeur donnaient deux chiffres differents selon l'outil qui
 * imprimait, ce que personne ne peut recouper.
 */
export function formaterOctets(valeur: number): string {
  if (valeur < 1024) return `${valeur} o`;
  if (valeur < 1024 * 1024) return `${(valeur / 1024).toFixed(1)} Ko`;
  if (valeur < 1024 * 1024 * 1024) return `${(valeur / (1024 * 1024)).toFixed(1)} Mo`;
  return `${(valeur / (1024 * 1024 * 1024)).toFixed(2)} Go`;
}
