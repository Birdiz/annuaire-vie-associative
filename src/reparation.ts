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

import { remplirNoms } from "./decouverte/noms.ts";
import { VERSION_NOM, nomEncoreAcceptable } from "./decouverte/nom-pressenti.ts";
import { transaction } from "./db/index.ts";
import type { Database } from "./db/index.ts";
import type { App } from "./app.ts";
import type { ResultatNoms } from "./decouverte/noms.ts";

const ETAPE = "reparation";
const MARQUEUR = "nom_pressenti_version";

const SQL_LIRE = "SELECT valeur FROM metric WHERE run_id IS NULL AND etape = ? AND nom = ?";

const SQL_ECRIRE = `
  INSERT INTO metric (run_id, etape, nom, valeur) VALUES (NULL, ?, ?, ?)
  ON CONFLICT (etape, nom) WHERE run_id IS NULL DO UPDATE SET valeur = excluded.valeur
`;

export type ResultatReparation = {
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
  const ligne = app.db.prepare(SQL_LIRE).get(ETAPE, MARQUEUR) as { valeur?: number } | undefined;
  if (Number(ligne?.valeur ?? 0) === VERSION_NOM) {
    return { noms: undefined, nomsInvalides: 0, versionAppliquee: VERSION_NOM };
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
  return { noms, nomsInvalides, versionAppliquee: VERSION_NOM };
}

const SQL_NOMS_ANCIENS = `
  SELECT ct.id, ct.nom_pressenti, c.nom AS commune
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
    commune: string;
  }[];
  const perimes = lignes.filter((l) => !nomEncoreAcceptable(l.nom_pressenti, l.commune));
  if (perimes.length === 0) return 0;

  transaction(db, () => {
    const effacer = db.prepare(SQL_EFFACER_LE_NOM);
    for (const ligne of perimes) effacer.run(ligne.id);
  });
  return perimes.length;
}
