/**
 * Taux de couverture du §8 : la part d'associations joignables.
 *
 * Le chiffre etait jusqu'ici recalcule a la main a chaque mesure. Il est la premiere
 * ligne des metriques que le brief declare non optionnelles, et l'ecran de synthese du
 * lot 6 doit l'afficher : autant qu'une seule requete en fasse foi.
 *
 * **Trois numerateurs, pas un.** « Au moins un email » n'est pas « au moins un email
 * exploitable » : le lot 5 a trouve 138 adresses cassees par un CMS, syntaxiquement
 * fausses, qui gonflaient le premier chiffre sans joindre personne. Et un email dont le
 * domaine n'annonce aucun MX ne recoit pas de courrier. Les trois sont rendus cote a
 * cote parce que leur ecart *est* le resultat : c'est lui qui dit si la couverture basse
 * vient d'adresses mortes ou de communes qui ne publient rien.
 *
 * Le denominateur reste les associations non dissoutes, comme l'ADR-015 l'a fige apres
 * avoir montre que la dormance n'expliquait pas le plafond.
 */

import type { Database } from "../db/index.ts";

export type Couverture = {
  departement: string;
  /** Associations non dissoutes : le denominateur. */
  actives: number;
  /** Actives creditees d'au moins un email, quel qu'il soit. */
  avecEmail: number;
  /** ... dont l'adresse a au moins la forme d'une adresse (score non nul). */
  avecEmailExploitable: number;
  /** ... dont le domaine annonce un MX (ADR-017). */
  avecEmailJoignable: number;
  /**
   * Numerateur du taux qualifie de l'ADR-013 — actives non dormantes creditees d'au
   * moins un email. `undefined` quand aucune borne de dormance n'est fournie.
   *
   * Il vit ici et non dans `cli.ts` pour une raison de fond : la CLI en tenait sa propre
   * requete, sans le filtre sur les contacts rejetes en revue. Des qu'un humain
   * arbitrait, `annuaire run` et l'ecran de synthese annoncaient deux taux differents
   * pour la meme base — sur la metrique que le §8 designe comme celle qui fera le README.
   */
  avecEmailNonDormantes: number | undefined;
};

const SQL_ACTIVES =
  "SELECT count(*) AS n FROM association a JOIN commune c ON c.code_insee = a.code_insee " +
  "WHERE c.departement = ? AND a.date_dissolution IS NULL";

const SQL_AVEC_EMAIL =
  "SELECT count(DISTINCT a.id) AS n FROM association a " +
  "JOIN commune c ON c.code_insee = a.code_insee " +
  "JOIN contact ct ON ct.association_id = a.id AND ct.kind = 'email' " +
  "LEFT JOIN domaine_mail d " +
  "  ON d.domaine = substr(ct.valeur_normalisee, instr(ct.valeur_normalisee, '@') + 1) " +
  "WHERE c.departement = ? AND a.date_dissolution IS NULL AND ct.review_statut <> 'rejete'";

export function mesurerCouverture(db: Database, departement: string, borneDormance?: string): Couverture {
  const un = (sql: string, ...extra: readonly string[]): number =>
    Number((db.prepare(sql).get(departement, ...extra) as { n?: number } | undefined)?.n ?? 0);

  return {
    departement,
    actives: un(SQL_ACTIVES),
    avecEmail: un(SQL_AVEC_EMAIL),
    avecEmailNonDormantes:
      borneDormance === undefined
        ? undefined
        : un(`${SQL_AVEC_EMAIL} AND a.date_declaration >= ?`, borneDormance),
    // `coalesce(score, 1)` : un contact jamais note n'est pas un contact invalide. Le
    // condamner ici ferait baisser la couverture au seul motif que la normalisation
    // n'est pas encore passee.
    avecEmailExploitable: un(`${SQL_AVEC_EMAIL} AND coalesce(ct.score, 1) > 0`),
    avecEmailJoignable: un(`${SQL_AVEC_EMAIL} AND coalesce(ct.score, 1) > 0 AND d.mx = 1`),
  };
}
