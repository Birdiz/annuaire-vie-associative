/**
 * Rattrapage du nom pressenti sur une base deja collectee, sans reseau.
 *
 * Le nom lu dans le bloc n'existe en base que depuis le lot 10 : tout ce qui a ete
 * collecte avant est anonyme, et recrawler un departement coute treize minutes plancher
 * (ADR-013) plus autant de requetes vers de vraies mairies. Ce module relit les corps
 * depuis le cache disque — `HttpCache.get`, pas `client.fetch` : c'est une lecture de
 * fichier, elle ne passe donc pas par la porte de sortie reseau.
 *
 * **Une commande a part, et non une option de `prefiltrer`.** La tentation est forte :
 * `rejouerPrefiltre` fait deja tout le travail couteux — lire le cache, decoder, analyser,
 * extraire — et jette les contextes. Y greffer l'ecriture serait pourtant un piege :
 * il **saute les pages dont `prefiltre_version` est a jour**. Sur une base deja
 * pre-filtree, le rattrapage ne ferait silencieusement rien, sauf a passer `--tout`,
 * c'est-a-dire a recalculer des verdicts qu'on n'avait pas demande de toucher. Deux
 * versions independantes dans un meme marqueur de reprise ne cohabitent pas.
 *
 * **Cette passe n'insere aucun contact.** Elle ne fait qu'apparier ceux qui sont deja en
 * base avec le texte de leur page. Un test le verrouille : sans cela, elle deviendrait
 * une porte derobee a l'invariant 6.
 *
 * **Reprise** : le calcul est une fonction pure du corps en cache et de `VERSION_NOM`,
 * ecrit par tranches de pages entieres. Un `kill -9` laisse les pages non commitees a
 * `nom_pressenti_version IS NULL` : la relance les refait a l'identique, les autres sont
 * sautees par le filtre de version. Aucun etat de reprise a tenir.
 *
 * **Aucun compteur cumulatif**, pour la meme raison que les deux autres rejeux : ce
 * module repond a « que dit l'heuristique actuelle de ce corpus », pas a « que s'est-il
 * passe pendant les runs ».
 */

import { toIso } from "../clock.ts";
import { transaction } from "../db/index.ts";
import { analyser, decoder, estHtml } from "../parse/html.ts";
import { extraireContacts } from "./extraction.ts";
import { VERSION_NOM, nomPressenti } from "./nom-pressenti.ts";
import type { Clock } from "../clock.ts";
import type { Database } from "../db/index.ts";
import type { HttpCache } from "../http/cache.ts";
import type { NomPressenti } from "./nom-pressenti.ts";

/** Meme raison qu'au rejeu du pre-filtre : une page relue coute une lecture et un DOM. */
const TAILLE_TRANCHE = 200;

/**
 * Les contacts a nommer, joints a leur page.
 *
 * La provenance d'un contact nomme la page **atteinte** ; `page.url` reste la page
 * **demandee**, qui porte la cle de planification. D'ou le `coalesce` — sans lui, tout
 * contact venu d'une page redirigee perdrait sa page, donc sa chance d'etre nomme.
 *
 * La sous-requete sur `max(campagne)` n'est pas cosmetique : une meme URL revisitee a
 * deux campagnes a deux lignes `page`, et sans elle chaque contact serait traite autant
 * de fois qu'il y a eu de campagnes.
 *
 * **Le filtre porte sur la version, jamais sur la presence d'un nom.** La premiere
 * ecriture de ce module ajoutait `nom_pressenti IS NULL`, ce qui paraissait econome et
 * rendait `VERSION_NOM` inutile : un nom deja ecrit n'etait plus jamais revu, et toute
 * correction de l'heuristique n'atteignait que les contacts encore anonymes. Un
 * departement livre gardait donc ses « E-mail » et ses « 8 Lauterupt - » jusqu'a une
 * recollecte complete. Meme discipline que `prefiltre_version` : ce qui ne porte pas la
 * version courante est refait.
 */
const SQL_A_NOMMER = `
  SELECT ct.id, ct.kind, ct.valeur_normalisee, ct.code_insee,
         p.url_hash, p.url
    FROM contact ct
    JOIN commune c ON c.code_insee = ct.code_insee
    JOIN page p
      ON coalesce(p.final_url, p.url) = ct.source_url
     AND p.code_insee = ct.code_insee
     AND p.statut = 'visitee'
     AND p.campagne = (SELECT max(p2.campagne) FROM page p2
                        WHERE coalesce(p2.final_url, p2.url) = ct.source_url
                          AND p2.code_insee = ct.code_insee)
   WHERE c.departement = ?
     AND ct.association_id IS NULL
     AND (? = 1 OR ct.nom_pressenti_version IS NULL OR ct.nom_pressenti_version <> ?)
   ORDER BY p.code_insee, p.url_hash, ct.id
`;

const SQL_ECRIRE = `
  UPDATE contact
     SET nom_pressenti = ?, nom_pressenti_normalise = ?, nom_pressenti_source = ?,
         nom_pressenti_at = ?, nom_pressenti_version = ?
   WHERE id = ?
`;

export type ResultatNoms = {
  /** Contacts candidats, c'est-a-dire non rattaches et encore sans nom. */
  examines: number;
  /** Un nom a ete trouve. */
  nommes: number;
  /** Page relue, aucun nom plausible autour du contact. */
  sansNom: number;
  /** Corps absent du cache : purge, oubli, ou reinitialisation. */
  sansCache: number;
  /** Deja evalues par la version courante de l'heuristique. */
  aJour: number;
};

export type OptionsNoms = {
  departement: string;
  /** Reevalue aussi ce que la version courante a deja regarde. */
  tout?: boolean | undefined;
  /** Meme role qu'au rejeu du pre-filtre : journal detaille, et point de crash testable. */
  onTranche?: ((ecrites: number) => void) | undefined;
};

type LigneANommer = {
  id: number;
  kind: string;
  valeur_normalisee: string;
  code_insee: string;
  url_hash: string;
  url: string;
};

type Ecriture = readonly [string | null, string | null, string | null, string, number, number];

export function remplirNoms(
  db: Database,
  cache: HttpCache,
  clock: Clock,
  options: OptionsNoms,
): ResultatNoms {
  const tout = options.tout === true;
  const lignes = db
    .prepare(SQL_A_NOMMER)
    .all(options.departement, tout ? 1 : 0, VERSION_NOM) as unknown as LigneANommer[];
  const aJour = tout ? 0 : compterAJour(db, options.departement);

  let examines = 0;
  let nommes = 0;
  let sansNom = 0;
  let sansCache = 0;
  let tranche: Ecriture[] = [];

  const vider = (): void => {
    if (tranche.length === 0) return;
    const lot = tranche;
    tranche = [];
    transaction(db, () => {
      const ecrire = db.prepare(SQL_ECRIRE);
      for (const ligne of lot) ecrire.run(...ligne);
    });
    options.onTranche?.(nommes + sansNom);
  };

  // On analyse chaque page **une fois**, pour tous les contacts qu'elle porte : les
  // lignes sont triees par `url_hash` precisement pour cela.
  let pageCourante: string | undefined;
  let noms: Map<string, NomPressenti> | undefined;

  for (const ligne of lignes) {
    examines += 1;

    if (ligne.url_hash !== pageCourante) {
      pageCourante = ligne.url_hash;
      noms = nomsDeLaPage(cache, ligne.url);
    }

    // Un cache froid n'est pas un verdict : la ligne n'est **pas** marquee, elle
    // repassera quand le corps sera de nouveau la.
    if (noms === undefined) {
      sansCache += 1;
      continue;
    }

    const trouve = noms.get(`${ligne.kind} ${ligne.valeur_normalisee}`);
    if (trouve === undefined) {
      // Marquer quand meme, avec un nom nul. C'est ce qui empeche le balayage sans fin :
      // un contact dont la valeur n'apparait plus dans la page — l'extraction a change,
      // la page a bouge — serait sinon rescanne a chaque passage, eternellement.
      sansNom += 1;
      tranche.push([null, null, null, toIso(clock.now()), VERSION_NOM, ligne.id]);
    } else {
      nommes += 1;
      tranche.push([
        trouve.nom,
        trouve.normalise,
        trouve.source,
        toIso(clock.now()),
        VERSION_NOM,
        ligne.id,
      ]);
    }
    if (tranche.length >= TAILLE_TRANCHE) vider();
  }

  vider();
  return { examines, nommes, sansNom, sansCache, aJour };
}

/**
 * Les contacts que la version courante a deja regardes.
 *
 * Compte a part plutot que filtre dans la boucle : `SQL_A_NOMMER` les a deja ecartes, et
 * c'est bien la version — non un nom vide — qui sert de marqueur. Un contact regarde sans
 * resultat garde `nom_pressenti` a `NULL` et recoit sa version : il ne repassera pas, sauf
 * sous `--tout`. C'est ce qui fait converger la passe.
 */
function compterAJour(db: Database, departement: string): number {
  const ligne = db
    .prepare(
      "SELECT count(*) AS n FROM contact ct JOIN commune c ON c.code_insee = ct.code_insee " +
        "WHERE c.departement = ? AND ct.association_id IS NULL AND ct.nom_pressenti IS NULL " +
        "AND ct.nom_pressenti_version = ?",
    )
    .get(departement, VERSION_NOM) as { n?: number } | undefined;
  return Number(ligne?.n ?? 0);
}

/**
 * Les noms que porte une page, indexes par contact.
 *
 * `avecMobiles: true` est **intentionnel**, et ce n'est pas une entorse au §4.6 : on
 * n'ecrit ici aucun contact, on nomme des lignes deja en base. Le filtre des mobiles
 * s'applique a la collecte ; a `false`, un mobile legitimement collecte sous
 * `--avec-mobiles` ne retrouverait jamais son contexte, et resterait anonyme sans raison.
 *
 * Le cache est adresse par l'URL **demandee**, comme partout ailleurs.
 */
function nomsDeLaPage(cache: HttpCache, url: string): Map<string, NomPressenti> | undefined {
  const entree = cache.get(url);
  if (entree === undefined) return undefined;
  if (!estHtml(entree.meta.contentType)) return undefined;

  const doc = analyser(decoder(entree.body, entree.meta.contentType), entree.meta.finalUrl);
  const extraction = extraireContacts(doc, { avecMobiles: true });

  const noms = new Map<string, NomPressenti>();
  for (const contact of extraction.contacts) {
    const trouve = nomPressenti(contact.contextes, contact.empreinte);
    if (trouve !== undefined) noms.set(`${contact.kind} ${contact.valeurNormalisee}`, trouve);
  }
  return noms;
}
