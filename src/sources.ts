/**
 * Adresses des donnees ouvertes amorcant le pipeline, et regles de rattachement
 * geographique.
 *
 * Le choix de ces sources n'est pas libre : deux des trois portes evidentes sont
 * fermees par robots.txt, que l'invariant 2 interdit de contourner (cf. ADR-006).
 *   - le dump RNA du ministere, pourtant decoupe par departement, vit sous
 *     media.interieur.gouv.fr/rna/ que son robots.txt interdit ;
 *   - l'API OpenDataSoft de l'Annuaire vit sous /api/, egalement interdit.
 * Restent le miroir agrege publie par data.gouv, et le dump JSON du co-marquage.
 */

export type SourceDump = "rna_waldec" | "rna_import" | "annuaire_local";

/**
 * Miroir agrege national du RNA. Contrepartie du robots.txt du ministere : ce fichier
 * couvre la France entiere, la ou l'original etait decoupe par departement. On le lit
 * donc en flux, en ne retenant que les lignes utiles.
 */
export const URL_RNA_WALDEC = "https://data-pipeline-open.s3.sbg.io.cloud.ovh.net/rna/waldec.csv";

/** Associations sans mouvement declare depuis 2009 : surtout des structures dormantes. */
export const URL_RNA_IMPORT = "https://data-pipeline-open.s3.sbg.io.cloud.ovh.net/rna/import.csv";

/**
 * Repertoire du co-marquage. Le nom du dump porte un horodatage regenere chaque jour :
 * il faut lire le listing pour connaitre le fichier courant.
 */
export const URL_ANNUAIRE_LISTING = "https://lecomarquage.service-public.gouv.fr/donnees_locales_v4/all/";

export function urlDumpRna(source: "rna_waldec" | "rna_import"): string {
  return source === "rna_waldec" ? URL_RNA_WALDEC : URL_RNA_IMPORT;
}

/**
 * Retient le dump le plus recent d'un listing.
 *
 * Une expression reguliere suffit ici : la page est un index de serveur, pas du HTML
 * de mairie. Introduire un parseur DOM pour cela ferait entrer la premiere dependance
 * du projet au mauvais endroit ; elle arrivera au lot 3, face a de vraies pages.
 *
 * L'horodatage `AAAA-MM-JJ_HHMMSS` se trie lexicographiquement dans l'ordre
 * chronologique, ce qui evite d'avoir a le parser.
 */
export function choisirDernierDumpAnnuaire(listing: string, base: string = URL_ANNUAIRE_LISTING): string | undefined {
  const motif = /(\d{4}-\d{2}-\d{2}_\d{6}-data\.gouv_local\.json)/g;
  let meilleur: string | undefined;
  for (const trouve of listing.matchAll(motif)) {
    const nom = trouve[1];
    if (nom === undefined) continue;
    if (meilleur === undefined || nom > meilleur) meilleur = nom;
  }
  return meilleur === undefined ? undefined : new URL(meilleur, base).href;
}

/**
 * Departement portant un code INSEE de commune.
 *
 * Outre-mer, le departement occupe trois caracteres et non deux ; en Corse, deux
 * caracteres dont un alphabetique. Rendre `undefined` sur un code malforme evite de
 * rattacher une association a un departement invente.
 */
export function departementDeCodeInsee(code: string): string | undefined {
  const normalise = code.trim().toUpperCase();
  if (!/^(2[AB]|\d{2})\d{3}$/.test(normalise)) return undefined;
  if (normalise.startsWith("97") || normalise.startsWith("98")) return normalise.slice(0, 3);
  return normalise.slice(0, 2);
}

export function appartientAuDepartement(codeInsee: string, departement: string): boolean {
  const trouve = departementDeCodeInsee(codeInsee);
  return trouve !== undefined && trouve === departement.trim().toUpperCase();
}

/**
 * Reconnait, dans un ZIP RNA fourni par l'utilisateur, l'entree du departement voulu.
 * Les entrees s'appellent `rna_waldec_AAAAMMJJ_dpt_35.csv`.
 */
export function estEntreeRnaDuDepartement(nom: string, departement: string): boolean {
  const suffixe = `_dpt_${departement.trim().toUpperCase()}.csv`;
  return nom.trim().toUpperCase().endsWith(suffixe.toUpperCase());
}
