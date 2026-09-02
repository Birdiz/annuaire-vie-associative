/**
 * Export CSV de l'annuaire, en deux profils.
 *
 * **La provenance est obligatoire en base, et disponible a l'export.** Chaque contact
 * porte son URL source, sa date de collecte, sa methode d'extraction et son score —
 * l'invariant §4.5 est une contrainte `NOT NULL` du schema, et il reste entier. Le
 * profil `complet` est le porteur de cette provenance dans le fichier : c'est lui,
 * l'artefact auditable, et c'est le defaut de la ligne de commande.
 *
 * Le profil `simple` est un **extrait explicitement derive** : cinq colonnes, une ligne
 * par structure, pour la personne qui doit passer des appels et non auditer une
 * collecte. Il abandonne la provenance et le regime juridique, et l'ecran d'export le
 * dit au moment ou le fichier quitte l'outil (ADR-032). Ce qui serait fautif, ce n'est
 * pas d'offrir cet extrait : c'est de le presenter comme l'export de reference.
 *
 * **Ecrit a la main, sans dependance.** Le projet a une seule dependance runtime, entree
 * au lot 3 apres mesure (ADR-011) ; ce seuil ne se franchit pas pour un serialiseur de
 * trente lignes.
 *
 * Le rendu vise le tableur : separateur `;`, BOM UTF-8, fins de ligne CRLF. C'est ce qui
 * fait qu'un fichier ouvert d'un double-clic en France affiche ses accents et ses
 * colonnes, plutot qu'une seule colonne de mojibake.
 */

import {
  SQL_FOURNISSEURS_PUBLICS,
  domaineDuContact,
  estDomaineDeMairie,
  estDomaineSpecifique,
  hoteDeLUrl,
  libelleDepuisDomaine,
} from "./domaine.ts";
import { classer } from "../normalisation/classification.ts";
import type { Database } from "../db/index.ts";

export const SEPARATEUR = ";";
const FIN_DE_LIGNE = "\r\n";
/** Sans lui, Excel lit un CSV UTF-8 en ANSI et massacre le premier accent venu. */
export const BOM = "﻿";

/** Ce qui separe deux valeurs reunies dans une meme cellule du profil simple. */
export const LIAISON = " / ";

export type ProfilExport = "simple" | "complet";

/**
 * Une colonne se declare avec sa cellule.
 *
 * Auparavant la liste des noms et le tableau des valeurs vivaient cote a cote, couples
 * **par position** et sans aucune garde : inserer une colonne au milieu de l'un decalait
 * silencieusement toutes les cellules de l'autre. Les tenir ensemble rend ce decalage
 * impossible par construction, et non plus surveille.
 */
type Colonne<L> = { readonly nom: string; readonly cellule: (ligne: L) => string };

// ---------------------------------------------------------------------------
// Profil complet
// ---------------------------------------------------------------------------

type LigneComplet = {
  code_insee: string;
  commune: string;
  rna_id: string | null;
  association: string | null;
  type_classifie: string | null;
  kind: string;
  valeur: string;
  valeur_corrigee: string | null;
  is_generique: number | null;
  score: number | null;
  confiance: number;
  methode_extraction: string;
  source_url: string;
  collected_at: string;
  review_statut: string;
  nom_pressenti: string | null;
  valeur_normalisee: string;
  url_mairie: string | null;
};

/**
 * Les seize colonnes historiques, dans leur ordre historique, puis deux ajoutees en
 * queue au lot 10. Ajouter en fin de fichier ne decale aucune colonne deja livree, et
 * sans ces deux-la **aucun export ne dirait d'ou vient un nom** : le profil simple peut
 * afficher un libelle deduit d'un domaine, et une deduction qui ne se signale pas se lit
 * comme une lecture.
 */
export const COLONNES_COMPLET: readonly Colonne<LigneComplet>[] = [
  { nom: "code_insee", cellule: (l) => l.code_insee },
  { nom: "commune", cellule: (l) => l.commune },
  { nom: "rna_id", cellule: (l) => l.rna_id ?? "" },
  { nom: "association", cellule: (l) => l.association ?? "" },
  { nom: "type", cellule: (l) => l.type_classifie ?? "" },
  { nom: "kind", cellule: (l) => l.kind },
  { nom: "valeur", cellule: (l) => l.valeur },
  { nom: "valeur_corrigee", cellule: (l) => l.valeur_corrigee ?? "" },
  { nom: "valeur_publiable", cellule: (l) => l.valeur_corrigee ?? l.valeur },
  { nom: "regime", cellule: regime },
  { nom: "score", cellule: (l) => (l.score === null ? "" : l.score.toFixed(2)) },
  { nom: "confiance", cellule: (l) => l.confiance.toFixed(2) },
  { nom: "methode_extraction", cellule: (l) => l.methode_extraction },
  { nom: "source_url", cellule: (l) => l.source_url },
  { nom: "collected_at", cellule: (l) => l.collected_at },
  { nom: "review_statut", cellule: (l) => l.review_statut },
  { nom: "nom_pressenti", cellule: (l) => l.nom_pressenti ?? "" },
  { nom: "nom_source", cellule: sourceDuNomComplet },
];

// ---------------------------------------------------------------------------
// Profil simple
// ---------------------------------------------------------------------------

/**
 * Six colonnes, et pas une de plus : c'est la forme du fichier qu'un agent de
 * collectivite tient deja a la main. « nom » plutot que « association » parce que la
 * cascade peut y mettre autre chose qu'une association du RNA.
 *
 * `type` porte les six valeurs du §6.7 (ADR-018), non accentuees comme toute valeur de
 * colonne. Vide quand rien ne l'etablit — c'est la meme discipline que `regime`, qui
 * refuse de trancher plutot que de deviner.
 */
export const COLONNES_SIMPLE: readonly Colonne<Groupe>[] = [
  { nom: "departement", cellule: (g) => g.departement },
  { nom: "commune", cellule: (g) => g.commune },
  { nom: "nom", cellule: (g) => g.nom },
  { nom: "type", cellule: (g) => g.type },
  { nom: "telephone", cellule: (g) => [...g.telephones].join(LIAISON) },
  { nom: "email", cellule: (g) => [...g.emails].join(LIAISON) },
];

/**
 * Un contact `rejete` ne sort pas : c'est le seul filtre de cette requete qu'un humain a
 * pose lui-meme, ligne par ligne. Le rendre optionnel dans l'autre sens — sortir les
 * rejetes sauf demande — ferait du travail de revue une decoration.
 */
const FILTRE_REVUE = "(? = 1 OR ct.review_statut <> 'rejete')";

const FILTRES = `
   WHERE c.departement = ?
     AND (? IS NULL OR (ct.score IS NOT NULL AND ct.score >= ?))
     AND ${FILTRE_REVUE}
`;

const SQL_CONTACTS = `
  SELECT ct.code_insee, c.nom AS commune, a.rna_id, a.nom AS association,
         a.type_classifie, ct.kind, ct.valeur, ct.valeur_corrigee, ct.is_generique,
         ct.score, ct.confiance, ct.methode_extraction, ct.source_url, ct.collected_at,
         ct.review_statut, ct.nom_pressenti, ct.valeur_normalisee, c.url_mairie
    FROM contact ct
    JOIN commune c ON c.code_insee = ct.code_insee
    LEFT JOIN association a ON a.id = ct.association_id
  ${FILTRES}
   ORDER BY c.nom, a.nom, ct.kind, ct.valeur
`;

/**
 * L'URL de la mairie reduite a son hote, en trois expressions plutot qu'une : le schema,
 * puis le chemin, puis un `www.` de tete. Empilees dans une seule, elles donnaient une
 * ligne que personne ne relit.
 *
 * La meme transformation existe en TypeScript dans `hoteDeLUrl` — les deux doivent se
 * ressembler assez pour se relire ensemble.
 *
 * Pas de `LIKE` nulle part dans ce module : `_` y serait un joker, et un nom de domaine
 * en contient.
 */
const URL_NUE = `
  replace(replace(lower(coalesce(c.url_mairie, '')), 'https://', ''), 'http://', '')
`;

const HOTE_BRUT = `
  substr(url_nue, 1,
         CASE WHEN instr(url_nue, '/') = 0
              THEN length(url_nue)
              ELSE instr(url_nue, '/') - 1 END)
`;

const HOTE_MAIRIE = `
  CASE WHEN substr(hote_brut, 1, 4) = 'www.' THEN substr(hote_brut, 5) ELSE hote_brut END
`;

/** Le domaine est-il celui de la mairie, ou l'un de ses sous-domaines ? */
const DOMAINE_DE_MAIRIE = `
  (hote_mairie <> ''
   AND (domaine = hote_mairie
        OR substr(domaine, -(length(hote_mairie) + 1)) = '.' || hote_mairie))
`;

/**
 * Un domaine mal forme, c'est-a-dire portant autre chose que `[a-z0-9.-]`.
 *
 * Le miroir SQL de `bienForme`. Il n'est pas theorique : un CMS qui masque l'arobase
 * laisse en base des valeurs comme `club[^@]gmail.com`, dont le domaine `]gmail.com`
 * echappe a la liste des fournisseurs publics — elle compare des chaines exactes — et
 * sortait nomme « ]gmail ». `GLOB` et non `LIKE` : lui seul a des classes de caracteres.
 */
const ADRESSE_MALFORMEE = "domaine GLOB '*[^abcdefghijklmnopqrstuvwxyz0-9.-]*'";

/** Un domaine qui peut porter le nom d'une structure. Voir `estDomaineSpecifique`. */
const DOMAINE_SPECIFIQUE = `
  (domaine IS NOT NULL
   AND instr(domaine, '.') > 0
   AND instr(domaine, 'xn--') = 0
   AND NOT ${ADRESSE_MALFORMEE}
   AND domaine NOT IN (${SQL_FOURNISSEURS_PUBLICS})
   AND NOT ${DOMAINE_DE_MAIRIE})
`;

/**
 * La cascade de nommage, exprimee en SQL parce que c'est elle qui fixe la **cle de
 * groupe**, donc l'ordre de tri, donc la contiguite des groupes que le generateur
 * consomme.
 *
 * La cle porte toujours le `code_insee`, y compris pour une association rattachee :
 * l'index unique des contacts est `(association_id, kind, valeur_normalisee)`, sans la
 * commune. Rien n'empeche donc un groupe de chevaucher deux communes, et la colonne
 * `commune` du fichier n'aurait plus de valeur coherente.
 *
 * La branche `M:` est clee par **adresse** et non par commune : une mairie a souvent
 * six adresses de service, et les reunir dans une cellule unique rendrait la ligne
 * inutilisable. Consequence a assumer — un numero de telephone n'a pas de domaine, donc
 * une ligne « Mairie de ... » sort sans telephone. C'est le nom lu dans le bloc qui les
 * reunira.
 *
 * Les conditions de forme du domaine sont ici **et** dans `domaine.ts`. Cette redite est
 * le prix a payer pour que `compterLignes` et `lignesCsv` acceptent exactement les memes
 * lignes : un ecran qui annonce un nombre que le fichier ne tient pas est pire qu'un
 * ecran muet.
 */
const CLE_GROUPE = `
  CASE
    WHEN association_id IS NOT NULL
      THEN 'A:' || code_insee || ':' || association_id
    WHEN nom_pressenti_normalise IS NOT NULL AND nom_pressenti_normalise <> ''
      THEN 'P:' || code_insee || ':' || nom_pressenti_normalise
    WHEN ${DOMAINE_SPECIFIQUE}
      THEN 'D:' || code_insee || ':' || domaine
    WHEN domaine IS NOT NULL AND NOT ${ADRESSE_MALFORMEE} AND ${DOMAINE_DE_MAIRIE}
      THEN 'M:' || code_insee || ':' || valeur_normalisee
  END
`;

/**
 * Ce sur quoi les groupes se trient entre eux dans une commune. Distinct de la cle :
 * la cle doit separer, le tri doit ranger. Les deux restent coherents — la cle
 * determine le tri — donc le tri raffine le groupe sans jamais le couper.
 */
const NOM_TRI = `
  CASE
    WHEN association_id IS NOT NULL THEN nom_normalise
    WHEN nom_pressenti_normalise IS NOT NULL AND nom_pressenti_normalise <> ''
      THEN nom_pressenti_normalise
    ELSE coalesce(domaine, '')
  END
`;

/**
 * La regle de `normalisation/dedup.ts`, appliquee **a la lecture**.
 *
 * Les deux index uniques partiels — un par association, un par commune — ne se voient pas
 * l'un l'autre : la meme adresse lue une fois dans un bloc qui nommait une association et
 * une fois dans un bloc anonyme fait deux lignes, toutes deux legitimes au regard des
 * contraintes. L'etape [7] supprime la seconde, et le fichier etait donc propre pour qui
 * avait pense a lancer la normalisation.
 *
 * Rien ne l'y oblige, et jusqu'au lot 10 l'oubli passait presque inapercu : la ligne en
 * trop sortait sans nom, donc dans le bruit. Depuis que la cascade la nomme, elle prend
 * l'apparence d'une **seconde structure** — un doublon nomme se lit comme un fait, pas
 * comme un residu. Le profil simple refuse donc de la rendre, base normalisee ou non.
 *
 * `EXISTS` plutot qu'une jointure, pour la meme raison que dans `dedup.ts` : la ligne
 * s'ecarte une fois, quel que soit le nombre d'associations qui portent l'adresse.
 */
const SANS_DOUBLON_DE_COMMUNE = `
  (ct.association_id IS NOT NULL
   OR NOT EXISTS (
     SELECT 1 FROM contact rattache
      WHERE rattache.association_id IS NOT NULL
        AND rattache.code_insee = ct.code_insee
        AND rattache.kind = ct.kind
        AND rattache.valeur_normalisee = ct.valeur_normalisee
   ))
`;

const SQL_GROUPES = `
  WITH base AS (
    SELECT ct.association_id, ct.code_insee, ct.kind,
           c.departement, c.nom AS commune,
           a.nom AS nom_association, a.nom_normalise, a.type_classifie,
           ct.nom_pressenti, ct.nom_pressenti_normalise,
           coalesce(ct.valeur_corrigee, ct.valeur) AS publiable,
           ct.valeur_normalisee, ct.is_generique, ct.score, ct.confiance,
           CASE WHEN ct.kind = 'email' AND instr(ct.valeur_normalisee, '@') > 0
                THEN substr(ct.valeur_normalisee, instr(ct.valeur_normalisee, '@') + 1)
           END AS domaine,
           ${URL_NUE} AS url_nue
      FROM contact ct
      JOIN commune c ON c.code_insee = ct.code_insee
      LEFT JOIN association a ON a.id = ct.association_id
    ${FILTRES}
     AND ${SANS_DOUBLON_DE_COMMUNE}
  ),
  hotes AS (
    SELECT base.*, ${HOTE_BRUT} AS hote_brut FROM base
  ),
  avec_hote AS (
    SELECT hotes.*, ${HOTE_MAIRIE} AS hote_mairie FROM hotes
  ),
  groupes AS (
    SELECT avec_hote.*, ${CLE_GROUPE} AS cle, ${NOM_TRI} AS nom_tri FROM avec_hote
  )
`;

const SQL_SIMPLE = `
  ${SQL_GROUPES}
  SELECT * FROM groupes
   WHERE cle IS NOT NULL
   ORDER BY commune, nom_tri, cle,
            score DESC, is_generique DESC, confiance DESC, valeur_normalisee
`;

type LigneGroupe = {
  cle: string;
  departement: string;
  commune: string;
  kind: string;
  publiable: string;
  valeur_normalisee: string;
  nom_association: string | null;
  type_classifie: string | null;
  nom_pressenti: string | null;
  domaine: string | null;
  hote_mairie: string;
};

/** Un groupe en cours d'accumulation : une structure, ses numeros, ses adresses. */
type Groupe = {
  cle: string;
  departement: string;
  commune: string;
  nom: string;
  type: string;
  /** `Set` et non tableau : deux graphies d'une meme valeur ne sortent pas deux fois. */
  telephones: Set<string>;
  emails: Set<string>;
};

export type OptionsExport = {
  departement: string;
  /**
   * Defaut `complet`, qui est la valeur historique : tout appelant non modifie continue
   * de produire exactement le meme fichier. Les defauts metier — `complet` en ligne de
   * commande, `simple` a l'ecran — sont poses par les appelants, pas ici.
   */
  profil?: ProfilExport | undefined;
  /** Ne retient que les contacts notes au moins a cette valeur. */
  scoreMin?: number | undefined;
  /** Sort aussi les contacts qu'un humain a rejetes en revue. Faux par defaut. */
  avecRejetes?: boolean | undefined;
};

/**
 * Rend les lignes du fichier, en-tete comprise, une par une. Un generateur plutot qu'une
 * chaine : un departement entier tient largement en memoire, la France entiere non, et
 * le §1 du brief demande que le pipeline reste correct a cette echelle.
 *
 * La lecture est un **curseur** (`iterate`) et non un `all()`. Avec `all()`, la promesse
 * de l'alinea precedent n'etait tenue qu'a moitie : la retro-pression fonctionnait cote
 * ecriture, mais l'integralite du resultat etait chargee avant la premiere ligne rendue.
 * Contrepartie assumee : la lecture reste ouverte pendant tout le telechargement, ce qui
 * ne gene pas — SQLite en WAL laisse un lecteur et un ecrivain coexister.
 *
 * Le profil simple garde ce curseur et **rompt sur le changement de cle** : la memoire
 * retenue est celle d'un seul groupe, pas d'une commune ni d'un departement.
 */
export function* lignesCsv(db: Database, options: OptionsExport): Generator<string> {
  if ((options.profil ?? "complet") === "simple") {
    yield* lignesSimples(db, options);
    return;
  }

  yield entete(COLONNES_COMPLET);
  const lignes = db
    .prepare(SQL_CONTACTS)
    .iterate(...parametres(options)) as unknown as Iterable<LigneComplet>;
  for (const ligne of lignes) yield rendre(COLONNES_COMPLET, ligne);
}

function* lignesSimples(db: Database, options: OptionsExport): Generator<string> {
  yield entete(COLONNES_SIMPLE);
  for (const groupe of groupesSimples(db, options)) yield rendre(COLONNES_SIMPLE, groupe);
}

/**
 * Les groupes du profil simple, un par structure.
 *
 * **Un seul chemin decide ce qu'est une ligne**, et `compterLignes` consomme ce meme
 * generateur. La premiere version comptait en SQL et rendait en JS : pour que les deux
 * tombent d'accord, le rendu devait accepter tout ce que la requete acceptait, et je
 * l'avais garanti par un repli — faute de libelle presentable, le domaine brut faisait
 * office de nom. Sur un departement reel, cela livrait des lignes nommees « ffr.fr »,
 * « mac.com », « mailo.com ». La garantie etait tenue, et le fichier mauvais.
 *
 * Un groupe que la cascade ne sait pas nommer est donc simplement **abandonne**, et il
 * l'est pour les deux usages puisqu'il n'y a plus qu'un endroit qui en decide. Le
 * comptage parcourt le curseur au lieu d'un `count(*)` : sur quelques milliers de
 * groupes deja agreges, c'est quelques millisecondes.
 */
function* groupesSimples(db: Database, options: OptionsExport): Generator<Groupe> {
  const lignes = db
    .prepare(SQL_SIMPLE)
    .iterate(...parametres(options)) as unknown as Iterable<LigneGroupe>;

  let courant: Groupe | undefined;
  for (const ligne of lignes) {
    if (courant !== undefined && courant.cle !== ligne.cle) {
      yield courant;
      courant = undefined;
    }
    if (courant === undefined) {
      const ouvert = ouvrirGroupe(ligne);
      // Rien ne le nomme : la ligne ne se travaille pas, on ne la rend pas.
      if (ouvert === undefined) continue;
      courant = ouvert;
    }
    if (ligne.kind === "phone") courant.telephones.add(ligne.publiable);
    else courant.emails.add(ligne.publiable);
  }
  if (courant !== undefined) yield courant;
}

/**
 * Le nom du groupe, decide par sa cle — la premiere ligne suffit, l'ordre etant total.
 *
 * `undefined` quand rien ne le nomme de facon presentable. Le groupe est alors abandonne,
 * pour le rendu comme pour le comptage : c'est le meme generateur qui en decide.
 */
function ouvrirGroupe(ligne: LigneGroupe): Groupe | undefined {
  const nom = nomDuGroupe(ligne);
  if (nom === undefined) return undefined;
  return {
    cle: ligne.cle,
    departement: ligne.departement,
    commune: ligne.commune,
    nom,
    type: typeDuGroupe(ligne, nom),
    telephones: new Set<string>(),
    emails: new Set<string>(),
  };
}

function nomDuGroupe(ligne: LigneGroupe): string | undefined {
  switch (ligne.cle.charAt(0)) {
    case "A":
      return ligne.nom_association ?? undefined;
    case "P":
      return ligne.nom_pressenti ?? undefined;
    case "D":
      // Pas de repli sur le domaine brut : « ffr.fr » n'est pas un nom de structure.
      return libelleDepuisDomaine(ligne.domaine ?? "");
    default:
      return `Mairie ${elision(ligne.commune)}`;
  }
}

/**
 * « de Bruzou », mais « d'Algrange ».
 *
 * Une ligne sur deux d'un departement porte ce libelle, et « Mairie de Algrange » se lit
 * comme une faute de l'outil. Le texte affiche s'accentue et se conjugue — la regle du
 * CLAUDE.md ne portait que sur les identifiants.
 *
 * Limite connue et assumee : les communes a article — « Le Mans », « La Rochelle » —
 * demanderaient « Mairie du Mans », que cette regle ne produit pas. Les traiter suppose de
 * connaitre le genre de l'article, que `commune` ne stocke pas ; « Mairie de Le Mans » est
 * fautif mais lisible, une contraction fausse le serait moins.
 */
function elision(commune: string): string {
  const premiere = commune.normalize("NFD").replace(/\p{Diacritic}/gu, "").charAt(0).toLowerCase();
  return "aeiouyh".includes(premiere) ? `d'${commune}` : `de ${commune}`;
}

/**
 * Le type §6.7 du groupe, ou vide quand rien ne l'etablit.
 *
 * Deux chemins, et l'ecart entre eux est le sujet.
 *
 * **Une association du RNA** porte le type que l'etape [7] lui a calcule, code objet a
 * l'appui (ADR-018). C'est une lecture de registre, on la reprend telle quelle — `diverses`
 * compris, qui est un fourre-tout **assume** : le code a ete lu, il ne rentrait dans aucun
 * des cinq autres types.
 *
 * **Tout le reste** — un nom lu dans un bloc, deduit d'un domaine, ou une mairie — n'a
 * aucun code objet. `classer(null, nom)` y retomberait sur `diverses` par defaut, et ce
 * `diverses`-la ne dirait pas la meme chose : non pas « le code a ete lu et ne dit rien de
 * plus », mais « on n'a rien lu du tout ». Les confondre ferait passer une ignorance pour
 * un classement. On ne retient donc que les verdicts venus d'un **motif de nom** — les
 * seuls qui reposent sur un signal reel — et la cellule reste vide sinon.
 *
 * Ce n'est pas un detail de forme : ce sont precisement les structures qui interessent une
 * collectivite — periscolaire, accueil de loisirs — qui ne sont jamais au RNA, donc jamais
 * rattachees. Sans ce second chemin, leur colonne serait vide par construction.
 */
function typeDuGroupe(ligne: LigneGroupe, nom: string): string {
  if (ligne.cle.startsWith("A:")) return ligne.type_classifie ?? "";
  const { type, source } = classer(null, nom);
  return source.startsWith("nom:") ? type : "";
}

/** Nombre de lignes qu'un export produirait, en-tete exclue. */
export function compterLignes(db: Database, options: OptionsExport): number {
  if ((options.profil ?? "complet") === "simple") {
    let total = 0;
    for (const _ of groupesSimples(db, options)) total += 1;
    return total;
  }
  const ligne = db
    .prepare(
      "SELECT count(*) AS n FROM contact ct JOIN commune c ON c.code_insee = ct.code_insee " +
        FILTRES,
    )
    .get(...parametres(options)) as { n?: number } | undefined;
  return Number(ligne?.n ?? 0);
}

/**
 * Contacts que le profil simple ecarte faute de nom.
 *
 * Ce n'est pas un ornement : sans ce compte, l'exclusion est silencieuse et la personne
 * qui compare les deux fichiers conclut a une perte de donnees. Il alimente le message
 * de la CLI et l'ecran d'export.
 *
 * Il compte les contacts **absents du fichier** : ceux qu'aucune branche de la cascade
 * n'a retenus, et ceux dont le groupe a ete abandonne faute de libelle presentable.
 */
export function compterSansNom(db: Database, options: OptionsExport): number {
  const retenus = db
    .prepare(`${SQL_GROUPES} SELECT count(*) AS n FROM groupes WHERE cle IS NOT NULL`)
    .get(...parametres(options)) as { n?: number } | undefined;
  const sansCle = db
    .prepare(`${SQL_GROUPES} SELECT count(*) AS n FROM groupes WHERE cle IS NULL`)
    .get(...parametres(options)) as { n?: number } | undefined;

  let rendus = 0;
  for (const groupe of groupesSimples(db, options)) {
    rendus += groupe.telephones.size + groupe.emails.size;
  }
  return Number(sansCle?.n ?? 0) + Math.max(0, Number(retenus?.n ?? 0) - rendus);
}

/** Les quatre parametres lies, dans l'ordre attendu par toutes les requetes de ce module. */
function parametres(options: OptionsExport): [string, number | null, number | null, number] {
  const seuil = options.scoreMin ?? null;
  return [options.departement, seuil, seuil, options.avecRejetes === true ? 1 : 0];
}

function entete<L>(colonnes: readonly Colonne<L>[]): string {
  return `${BOM}${colonnes.map((c) => c.nom).join(SEPARATEUR)}${FIN_DE_LIGNE}`;
}

function rendre<L>(colonnes: readonly Colonne<L>[], ligne: L): string {
  return `${colonnes
    .map((colonne) => echapper(colonne.cellule(ligne)))
    .join(SEPARATEUR)}${FIN_DE_LIGNE}`;
}

/**
 * §4.7 — le regime juridique est une colonne a part entiere, pas une deduction laissee
 * au lecteur du fichier. Un telephone n'en a pas.
 */
function regime(ligne: LigneComplet): string {
  if (ligne.kind !== "email") return "";
  if (ligne.is_generique === 1) return "generique";
  if (ligne.is_generique === 0) return "nominatif";
  return "indetermine";
}

/**
 * D'ou vient le nom que le profil simple afficherait pour ce contact.
 *
 * `rna` et `bloc` sont des lectures ; `domaine` et `mairie` sont des **inferences**, et
 * c'est tout l'interet de cette colonne. Un fichier qui ne les distingue pas presente
 * une deduction comme un fait — et la personne qui repondra a une demande d'acces n'a
 * que le fichier sous les yeux.
 *
 * La cascade est ici en TypeScript et dans `CLE_GROUPE` en SQL. Les deux doivent dire la
 * meme chose ; un test compare les deux colonnes sur un corpus qui couvre les cinq cas.
 */
function sourceDuNomComplet(ligne: LigneComplet): string {
  if (ligne.association !== null) return "rna";
  if (ligne.nom_pressenti !== null && ligne.nom_pressenti !== "") return "bloc";
  if (ligne.kind !== "email") return "aucun";

  const domaine = domaineDuContact(ligne.valeur_normalisee);
  if (domaine === undefined) return "aucun";

  const hote = hoteDeLUrl(ligne.url_mairie);
  if (estDomaineSpecifique(domaine, hote)) return "domaine";
  return estDomaineDeMairie(domaine, hote) ? "mairie" : "aucun";
}

/**
 * RFC 4180. Le guillemet interne se double, et la valeur se guillemette des qu'elle
 * contient un separateur, un guillemet ou un saut de ligne.
 *
 * Une precaution de plus, absente de la RFC : une valeur commencant par `=`, `+`, `-` ou
 * `@` est prefixee d'une apostrophe. Un tableur y verrait sinon une formule, et un nom
 * d'association venu d'une page web est une donnee dont on ne controle pas la forme.
 */
export function echapper(valeur: string): string {
  const desamorce = /^[=+\-@\t\r]/.test(valeur) ? `'${valeur}` : valeur;
  if (!/[";\r\n]/.test(desamorce)) return desamorce;
  return `"${desamorce.replace(/"/g, '""')}"`;
}
