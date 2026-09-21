/**
 * Ce que l'outil repare tout seul quand il ouvre une base ecrite par une version
 * anterieure.
 *
 * Deux mecanismes se partagent le travail, et la difference tient a ce dont ils ont
 * besoin.
 *
 * **Ce qui se repare en SQL vit dans une migration** — le detachement des rattachements
 * de conteneur, migration 12. Une migration s'applique a l'ouverture, sans rien demander
 * a personne, et sans le cache : elle reste vraie sur un poste dont le cache a ete purge.
 *
 * **Ce qui demande de relire la page vit ici.** Le nom lu dans un bloc n'est pas
 * recalculable depuis la base : il faut le corps de la page, que seul le cache disque
 * detient. `remplirNoms` sait le faire sans reseau (ADR-033) — mais c'etait jusqu'ici une
 * commande a taper. Un client qui installe la nouvelle version et exporte aussitot
 * recevait un fichier portant encore les « Site internet » et les « France » de
 * l'ancienne heuristique, sans savoir qu'une commande les aurait effaces.
 *
 * **Un marqueur, et non un balayage.** La reparation s'execute au plus une fois par
 * version de l'heuristique : `metric(reparation, nom_pressenti_version)` retient la
 * derniere version appliquee. Sans lui, une base dont le cache a disparu repasserait sur
 * ses contacts a chaque commande — `remplirNoms` ne marque deliberement pas les lignes
 * dont le corps manque, pour qu'elles repassent quand il revient (ADR-033), et cette
 * respiration-la n'a de sens que dans une commande explicite.
 */

import { lecteurDeCommunes, remplirNoms } from "./decouverte/noms.ts";
import { VERSION_NOM, nomEncoreAcceptable } from "./decouverte/nom-pressenti.ts";
import { classerEmail, decollerEmail } from "./decouverte/extraction.ts";
import { SQL_EST_EXCLU } from "./oubli.ts";
import { transaction } from "./db/index.ts";
import type { Database } from "./db/index.ts";
import type { App } from "./app.ts";
import type { ResultatNoms } from "./decouverte/noms.ts";

const ETAPE = "reparation";
const MARQUEUR = "nom_pressenti_version";

/**
 * Version de la regle de decollage appliquee aux adresses deja en base. Son propre marqueur,
 * et non celui des noms : les deux reparations ne vieillissent pas au meme rythme.
 */
export const VERSION_ADRESSES = 1;
const MARQUEUR_ADRESSES = "adresses_version";

const SQL_LIRE = "SELECT valeur FROM metric WHERE run_id IS NULL AND etape = ? AND nom = ?";

const SQL_ECRIRE = `
  INSERT INTO metric (run_id, etape, nom, valeur) VALUES (NULL, ?, ?, ?)
  ON CONFLICT (etape, nom) WHERE run_id IS NULL DO UPDATE SET valeur = excluded.valeur
`;

export type ResultatReparation = {
  /** Adresses que la reparation a decollees — corrigees, fondues avec leur jumelle ou effacees. */
  adressesDecollees: number;
  /** Absent quand la base etait deja a jour : la reparation n'a alors rien lu. */
  noms: ResultatNoms | undefined;
  /** Noms effaces faute de passer le filtre courant, page absente du cache. */
  nomsInvalides: number;
  versionAppliquee: number;
};

/**
 * Rejoue le nommage si la base porte des noms d'une heuristique perimee.
 *
 * Appelee par la porte commune de la CLI, comme la purge : « au demarrage » ne veut pas
 * dire « par les commandes qui y pensent ». Sur une base a jour elle coute une lecture
 * d'une ligne de `metric`.
 */
export function reparerApresMiseAJour(app: App): ResultatReparation {
  // Les adresses d'abord : le rejeu des noms retrouve chaque contact dans sa page par sa
  // valeur, et une valeur encore collee — « …@cidff43.frhttps » — n'y serait plus.
  const adressesDecollees = decollerLesAdresses(app.db);
  if (adressesDecollees > 0) {
    app.logger.info("Reparation des adresses collees apres mise a jour", {
      version: VERSION_ADRESSES,
      decollees: adressesDecollees,
    });
  }

  const ligne = app.db.prepare(SQL_LIRE).get(ETAPE, MARQUEUR) as { valeur?: number } | undefined;
  if (Number(ligne?.valeur ?? 0) === VERSION_NOM) {
    return { adressesDecollees, noms: undefined, nomsInvalides: 0, versionAppliquee: VERSION_NOM };
  }

  const noms = remplirNoms(app.db, app.cache, app.clock, {});
  const nomsInvalides = effacerLesNomsQuiNePassentPlus(app.db);
  app.db.prepare(SQL_ECRIRE).run(ETAPE, MARQUEUR, VERSION_NOM);

  if (noms.examines > 0 || nomsInvalides > 0) {
    app.logger.info("Reparation des noms apres mise a jour", {
      version: VERSION_NOM,
      examines: noms.examines,
      nommes: noms.nommes,
      sans_nom: noms.sansNom,
      sans_cache: noms.sansCache,
      effaces: nomsInvalides,
    });
  }
  return { adressesDecollees, noms, nomsInvalides, versionAppliquee: VERSION_NOM };
}

const SQL_ADRESSES = `
  SELECT id, association_id, code_insee, valeur, valeur_normalisee, valeur_corrigee, review_statut
    FROM contact
   WHERE kind = 'email'
`;

const SQL_JUMELLE = `
  SELECT id, review_statut FROM contact
   WHERE kind = 'email' AND valeur_normalisee = ?1 AND id <> ?4
     AND ((?2 IS NOT NULL AND association_id = ?2)
          OR (?2 IS NULL AND association_id IS NULL AND code_insee = ?3))
`;

/**
 * Decolle les adresses qu'une version anterieure a ecrites soudees au mot suivant (ADR-036).
 *
 * **La meme fonction que l'extraction**, `decollerEmail`, et non une migration SQL : en SQL,
 * ce serait une seconde implementation de ses regles — la casse d'origine, qui trahit
 * « netJudo », ne s'y exprime qu'au prix de centaines de motifs —, et le rejeu des noms,
 * qui retrouve chaque contact dans sa page par sa valeur, ne retrouverait pas une valeur
 * reparee autrement que l'extraction ne la produit. La frontiere de l'ADR-035 s'enrichit
 * d'un troisieme cas : ce qui se repare sans la page mais par une regle du code vit ici,
 * sous son propre marqueur, et appelle cette regle.
 *
 * Pour chaque adresse que le decollage change :
 *
 * - **une correction humaine** en revue l'emporte : la ligne n'est pas touchee ;
 * - **l'adresse decollee est exclue** (`oublier`, invariant 10) : la ligne est supprimee,
 *   sans quoi elle rentrerait par la reparation dans l'annuaire dont on l'avait sortie ;
 * - **sa jumelle existe** sous la meme cle d'unicite — la copie propre, lue dans le
 *   `mailto:` : la ligne collee est supprimee, la jumelle garde sa propre provenance et
 *   herite d'une validation humaine qu'elle n'avait pas ;
 * - **sinon**, la valeur est corrigee en place. La provenance ne bouge pas ; le score et son
 *   regime sont recalcules, puisqu'ils jugeaient une adresse qui n'existait pas.
 *
 * Une exclusion inscrite sous la forme collee est doublee de la forme decollee : la
 * personne qui a demande a sortir de l'annuaire en sort sous les deux.
 *
 * Une transaction, marqueur compris : relancee apres un arret brutal, la reparation reprend
 * du debut et ne trouve plus rien a faire sur ce qu'elle a deja fait.
 */
function decollerLesAdresses(db: Database): number {
  const ligne = db.prepare(SQL_LIRE).get(ETAPE, MARQUEUR_ADRESSES) as { valeur?: number } | undefined;
  if (Number(ligne?.valeur ?? 0) === VERSION_ADRESSES) return 0;

  return transaction(db, () => {
    let decollees = 0;
    const exclu = db.prepare(SQL_EST_EXCLU);
    const jumelle = db.prepare(SQL_JUMELLE);
    const supprimer = db.prepare("DELETE FROM contact WHERE id = ?");
    const valider = db.prepare("UPDATE contact SET review_statut = 'valide' WHERE id = ? AND review_statut = 'a_revoir'");
    const corriger = db.prepare(
      `UPDATE contact
          SET valeur = ?, valeur_normalisee = ?, is_generique = ?,
              score = NULL, score_motifs = NULL, score_version = NULL, score_at = NULL,
              nom_pressenti_version = NULL
        WHERE id = ?`,
    );

    const adresses = db.prepare(SQL_ADRESSES).all() as unknown as {
      id: number;
      association_id: number | null;
      code_insee: string | null;
      valeur: string;
      valeur_normalisee: string;
      valeur_corrigee: string | null;
      review_statut: string;
    }[];
    for (const adresse of adresses) {
      const decollee = decollerEmail(adresse.valeur);
      const normalisee = decollee.toLowerCase();
      if (normalisee === adresse.valeur_normalisee) continue;
      if (adresse.valeur_corrigee !== null) continue;
      decollees += 1;

      if (exclu.get(normalisee, adresse.code_insee) !== undefined) {
        supprimer.run(adresse.id);
        continue;
      }
      const copie = jumelle.get(normalisee, adresse.association_id, adresse.code_insee, adresse.id) as
        | { id: number; review_statut: string }
        | undefined;
      if (copie !== undefined) {
        if (adresse.review_statut === "valide") valider.run(copie.id);
        supprimer.run(adresse.id);
        continue;
      }
      corriger.run(decollee, normalisee, classerEmail(decollee), adresse.id);
    }

    const exclusions = db.prepare("SELECT valeur, motif, origine, created_at FROM exclusion WHERE portee = 'contact'").all() as {
      valeur: string;
      motif: string;
      origine: string;
      created_at: string;
    }[];
    const inscrire = db.prepare(
      "INSERT OR IGNORE INTO exclusion (portee, valeur, motif, origine, created_at) VALUES ('contact', ?, ?, ?, ?)",
    );
    for (const exclusion of exclusions) {
      const decollee = decollerEmail(exclusion.valeur).toLowerCase();
      if (decollee !== exclusion.valeur) inscrire.run(decollee, exclusion.motif, exclusion.origine, exclusion.created_at);
    }

    db.prepare(SQL_ECRIRE).run(ETAPE, MARQUEUR_ADRESSES, VERSION_ADRESSES);
    return decollees;
  });
}

const SQL_NOMS_ANCIENS = `
  SELECT ct.id, ct.nom_pressenti, ct.code_insee, c.nom AS commune
    FROM contact ct
    JOIN commune c ON c.code_insee = ct.code_insee
   WHERE ct.nom_pressenti IS NOT NULL
     AND (ct.nom_pressenti_version IS NULL OR ct.nom_pressenti_version <> ?)
`;

const SQL_EFFACER_LE_NOM = `
  UPDATE contact
     SET nom_pressenti = NULL, nom_pressenti_normalise = NULL, nom_pressenti_source = NULL
   WHERE id = ?
`;

/**
 * Efface les noms qu'une version anterieure a ecrits et que le filtre courant refuse.
 *
 * Le rattrapage par le cache ne les atteint pas tous : il lui faut la ligne `page` **et**
 * le corps en cache, or l'un comme l'autre se purgent. Ces contacts gardaient donc
 * indefiniment leur « Site internet » et leur « France Grand Est » — et le profil simple
 * les livrait comme des structures.
 *
 * On ne recalcule rien ici, on ne fait que **retirer** : la question posee est « ce nom
 * passerait-il aujourd'hui ? », et elle ne demande que la chaine. Un nom retire laisse le
 * contact a la branche suivante de la cascade (domaine, puis mairie), exactement comme
 * s'il n'avait jamais ete lu.
 *
 * **La version n'est pas touchee.** Elle dit ce que la derniere lecture de page a donne ;
 * ce nettoyage n'est pas une lecture. La laisser en l'etat garde ces contacts eligibles au
 * rattrapage par le cache, le jour ou la page y revient.
 */
function effacerLesNomsQuiNePassentPlus(db: Database): number {
  const lignes = db.prepare(SQL_NOMS_ANCIENS).all(VERSION_NOM) as unknown as {
    id: number;
    nom_pressenti: string;
    code_insee: string;
    commune: string;
  }[];
  const communes = lecteurDeCommunes(db);
  const perimes = lignes.filter((l) => !nomEncoreAcceptable(l.nom_pressenti, communes(l.code_insee) ?? l.commune));
  if (perimes.length === 0) return 0;

  transaction(db, () => {
    const effacer = db.prepare(SQL_EFFACER_LE_NOM);
    for (const ligne of perimes) effacer.run(ligne.id);
  });
  return perimes.length;
}
