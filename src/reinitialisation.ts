/**
 * Effacer un departement pour le recollecter a neuf.
 *
 * Le besoin est celui d'une mise au point : on veut relancer une collecte sur des
 * donnees fraiches, sans trainer ce qu'une version anterieure de l'extraction avait
 * ecrit. C'est l'inverse d'une reparation retroactive — on ne corrige rien, on refait.
 *
 * **Ce que cette commande n'est pas.** Ni `purge`, qui efface ce qui a plus de trois ans
 * quel que soit le departement (invariant 8) ; ni `oublier`, qui honore un droit et dont
 * l'effet doit survivre a toutes les collectes suivantes (invariant 10). Trois verbes,
 * trois raisons d'effacer, et ils ne doivent pas se confondre.
 *
 * **Ce a quoi elle ne touche pas**, et c'est le coeur du module :
 *
 * - **`exclusion`** — l'invariant 10 serait retourne. Une personne qui a demande a etre
 *   effacee l'a ete pour de bon ; si reinitialiser levait son exclusion, la collecte
 *   suivante la remettrait en base sans que personne ne s'en apercoive. C'est le seul
 *   endroit du projet ou « tout effacer » doit s'arreter net.
 * - **`dump`** — le registre est national, partage par tous les departements, et le
 *   reprendre couterait 1,25 Go pour rien.
 * - **`domaine_mail`** — les verdicts MX sont indexes par domaine, pas par departement :
 *   `orange.fr` sert des associations partout. C'est un cache, il se revalide seul.
 * - **les compteurs globaux** (`metric` sans `run_id`) — ils comptent la purge et la
 *   maintenance, qui n'appartiennent a aucun departement.
 *
 * **La suppression est explicite, et ne s'en remet pas aux cascades.** `contact` et
 * `page` cascadent bien depuis `commune`, mais `association.code_insee` est en
 * `ON DELETE SET NULL` : effacer les communes y laisserait des associations orphelines,
 * rattachees a rien, invisibles de toutes les requetes par departement et impossibles a
 * retrouver ensuite. L'ordre ci-dessous les prend avant.
 */

import { transaction } from "./db/index.ts";
import type { Database } from "./db/index.ts";
import type { Counters } from "./metrics/counters.ts";
import { ETAPE } from "./metrics/counters.ts";

export type Bilan = {
  departement: string;
  communes: number;
  associations: number;
  contacts: number;
  pages: number;
  runs: number;
  /** Entrees du cache HTTP effacees. Zero en simulation. */
  entreesCache: number;
  /** Vrai quand rien n'a ete ecrit : `--simulation`. */
  simulation: boolean;
};

/** Ce que la base contient pour ce departement, sans rien ecrire. */
export function compter(db: Database, departement: string): Omit<Bilan, "entreesCache" | "simulation"> {
  const un = (sql: string): number =>
    Number((db.prepare(sql).get(departement) as { n?: number } | undefined)?.n ?? 0);

  return {
    departement,
    communes: un("SELECT count(*) AS n FROM commune WHERE departement = ?"),
    associations: un(
      "SELECT count(*) AS n FROM association a JOIN commune c ON c.code_insee = a.code_insee WHERE c.departement = ?",
    ),
    contacts: un(
      "SELECT count(*) AS n FROM contact ct JOIN commune c ON c.code_insee = ct.code_insee WHERE c.departement = ?",
    ),
    pages: un(
      "SELECT count(*) AS n FROM page p JOIN commune c ON c.code_insee = p.code_insee WHERE c.departement = ?",
    ),
    runs: un("SELECT count(*) AS n FROM run WHERE departement = ?"),
  };
}

/** Les copies de pages gardees sur le disque pour ce departement. */
function cheminsCache(db: Database, departement: string): string[] {
  const lignes = db
    .prepare(
      `SELECT p.cache_path FROM page p
         JOIN commune c ON c.code_insee = p.code_insee
        WHERE c.departement = ? AND p.cache_path IS NOT NULL`,
    )
    .all(departement) as unknown as { cache_path: string }[];
  return lignes.map((ligne) => ligne.cache_path);
}

export type OptionsReinitialisation = {
  /** Ne rien ecrire : compter ce qui partirait. */
  simulation?: boolean;
  /** Efface une entree du cache HTTP, designee par le chemin relatif de `page.cache_path`. */
  supprimerCache?: (cheminRelatif: string) => boolean;
};

/**
 * Efface tout ce qui appartient a un departement.
 *
 * **Le cache disque part avant la base**, et l'ordre n'est pas indifferent : les chemins
 * ne sont connus que par `page.cache_path`, donc les lignes supprimees d'abord les
 * rendraient introuvables et les fichiers survivraient sans que rien ne puisse les
 * designer. Dans l'autre sens, une interruption laisse au pire des lignes dont le cache
 * manque — ce qu'un crawl traite comme un cache froid, c'est-a-dire comme la normale.
 *
 * Les suppressions en base tiennent dans **une transaction** : un departement a moitie
 * efface ferait repartir une collecte sur une base incoherente, la ou l'invariant 9
 * promet qu'une reprise ne perd ni ne double rien.
 */
export function reinitialiser(
  db: Database,
  counters: Counters,
  departement: string,
  options: OptionsReinitialisation = {},
): Bilan {
  const simulation = options.simulation === true;
  const avant = compter(db, departement);

  if (simulation) return { ...avant, entreesCache: 0, simulation: true };

  let entreesCache = 0;
  if (options.supprimerCache !== undefined) {
    for (const chemin of cheminsCache(db, departement)) {
      if (options.supprimerCache(chemin)) entreesCache += 1;
    }
  }

  transaction(db, () => {
    // Les contacts d'abord : ils cascaderaient depuis `commune` comme depuis
    // `association`, mais les compter suppose de les prendre pendant que leur commune
    // existe encore.
    db.prepare(
      `DELETE FROM contact WHERE code_insee IN (SELECT code_insee FROM commune WHERE departement = ?)`,
    ).run(departement);

    // `association.code_insee` est en ON DELETE SET NULL : sans cette ligne, effacer les
    // communes laisserait des associations rattachees a rien, hors de portee de toutes
    // les requetes par departement.
    db.prepare(
      `DELETE FROM association WHERE code_insee IN (SELECT code_insee FROM commune WHERE departement = ?)`,
    ).run(departement);

    db.prepare(
      `DELETE FROM page WHERE code_insee IN (SELECT code_insee FROM commune WHERE departement = ?)`,
    ).run(departement);

    db.prepare("DELETE FROM commune WHERE departement = ?").run(departement);

    // Cascade sur `job` et sur `metric` porteurs d'un run_id. Les compteurs globaux,
    // eux, ne designent aucun departement et restent.
    db.prepare("DELETE FROM run WHERE departement = ?").run(departement);

    counters.inc(ETAPE.purge, "contacts_reinitialises", avant.contacts);
  });

  return { ...avant, entreesCache, simulation: false };
}
