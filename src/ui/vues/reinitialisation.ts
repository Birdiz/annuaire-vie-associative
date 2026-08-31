/**
 * Repartir de zéro sur un département, depuis l'écran.
 *
 * **En deux temps, et c'est tout le sujet.** Un bouton qui efface au clic serait un piège
 * dans un outil dont les utilisateurs sont des agents de collectivité. Un bouton qui
 * commence par montrer ce qu'il emporte n'en est pas un : le premier geste ne fait que
 * compter, le second seul supprime, et entre les deux on lit.
 *
 * **Pas de `confirm()`.** La CSP du serveur est `default-src 'self'` : aucun script en
 * ligne ne s'exécute, et une boîte de dialogue du navigateur est de toute façon le genre
 * de chose qu'on renvoie sans lire. La confirmation est un aller-retour serveur, donc un
 * écran qu'il faut regarder.
 *
 * **L'état vit dans le fragment rendu, pas en mémoire.** htmx remplace ce bloc par la
 * réponse : la réponse *est* l'état. Un rechargement de page revient donc au repos, ce
 * qui est le sens de lecture le plus sûr pour une opération irréversible. Et ce bloc est
 * **hors du suivi**, qui se remplace toutes les deux secondes — un écran de confirmation
 * qui disparaît pendant qu'on le lit serait la meilleure façon de faire cliquer sans
 * comprendre.
 */

import { echapperHtml, nombre, pluriel } from "../rendu.ts";
import type { Bilan } from "../../reinitialisation.ts";

export type DonneesReinitialisation = {
  departement: string;
  /** Le décompte, quand la simulation vient d'être demandée. */
  simulation: Bilan | undefined;
  /** Le bilan de l'effacement, quand il vient d'avoir lieu. */
  fait: Bilan | undefined;
  /** Une collecte tourne : effacer sous elle laisserait des lignes recréées juste après. */
  collecteEnCours: boolean;
  refus: string | undefined;
};

/** Ce qui survit à l'effacement, dit à l'endroit où on s'apprête à effacer. */
function ceQuiReste(): string {
  return `<ul class="reste">
  <li><strong>Les effacements déjà demandés par des personnes</strong> restent inscrits : quelqu'un
    qui s'est opposé ne reviendra pas dans la base à la collecte suivante.</li>
  <li><strong>Le registre national</strong> déjà lu n'est pas repris — il est commun à tous les
    départements.</li>
  <li><strong>Les autres départements</strong> ne sont pas touchés.</li>
</ul>`;
}

export function fragmentReinitialisation(donnees: DonneesReinitialisation): string {
  const departement = echapperHtml(donnees.departement);
  const refus = donnees.refus === undefined ? "" : `<p class="refus">${echapperHtml(donnees.refus)}</p>`;

  if (donnees.fait !== undefined) {
    const bilan = donnees.fait;
    return `${refus}<p class="avis"><strong>Le département ${departement} est vide.</strong>
${nombre(bilan.communes)} commune${pluriel(bilan.communes)},
${nombre(bilan.associations)} association${pluriel(bilan.associations)},
${nombre(bilan.contacts)} contact${pluriel(bilan.contacts)} et
${nombre(bilan.pages)} page${pluriel(bilan.pages)} ont été effacés, ainsi que
${nombre(bilan.entreesCache)} copie${pluriel(bilan.entreesCache)} de page gardée${pluriel(bilan.entreesCache)}
sur cette machine.</p>
<p class="discret">Lancez la collecte ci-dessus pour le reconstituer. Elle repartira du registre
national, comme au premier jour.</p>`;
  }

  if (donnees.simulation !== undefined) {
    const bilan = donnees.simulation;
    const vide =
      bilan.communes === 0 && bilan.associations === 0 && bilan.contacts === 0 && bilan.pages === 0;

    if (vide) {
      return `${refus}<p class="discret">Il n'y a rien à effacer pour le département ${departement} :
la base ne contient aucune donnée pour lui.</p>
${boutonRepos(departement, "Revenir")}`;
    }

    return `${refus}<p class="avertissement"><strong>Ceci effacera définitivement, pour le
département ${departement} :</strong></p>
<ul class="bilan">
  <li>${nombre(bilan.communes)} commune${pluriel(bilan.communes)}</li>
  <li>${nombre(bilan.associations)} association${pluriel(bilan.associations)}</li>
  <li>${nombre(bilan.contacts)} contact${pluriel(bilan.contacts)},
    <strong>y compris les arbitrages déjà rendus en revue</strong></li>
  <li>${nombre(bilan.pages)} page${pluriel(bilan.pages)} explorée${pluriel(bilan.pages)}, et les
    copies gardées sur cette machine</li>
  <li>${nombre(bilan.runs)} collecte${pluriel(bilan.runs)} passée${pluriel(bilan.runs)}, et leur historique</li>
</ul>
${ceQuiReste()}
<p class="discret">Il n'y a pas de retour en arrière : une nouvelle collecte prendra plusieurs
heures pour reconstituer ces données.</p>
<form method="post" action="/reinitialiser/confirmer" hx-post="/reinitialiser/confirmer"
      hx-target="#reinitialisation" class="commandes">
  <input type="hidden" name="departement" value="${departement}">
  <button type="submit" class="danger">Oui, effacer le département ${departement}</button>
</form>
${boutonRepos(departement, "Annuler")}`;
  }

  if (donnees.collecteEnCours) {
    // Le refus dit déjà ce qui vient de se passer et quoi faire : le doubler d'un état
    // général ferait deux fois la même phrase.
    if (refus !== "") return refus;
    return `<p class="discret">Une collecte est en cours : elle écrit des communes et des pages en
continu, et effacer sous elle laisserait des lignes recréées juste après. Arrêtez-la ou attendez
sa fin.</p>`;
  }

  return `${refus}<p class="discret">Efface toutes les données du département ${departement} pour
le recollecter à neuf. Utile après une mise à jour de l'outil, quand on veut repartir de données
fraîches plutôt que de corriger l'existant. <strong>Rien n'est effacé au premier clic</strong> :
vous verrez d'abord ce qui partirait.</p>
<form method="post" action="/reinitialiser" hx-post="/reinitialiser" hx-target="#reinitialisation"
      class="commandes">
  <input type="hidden" name="departement" value="${departement}">
  <button type="submit">Voir ce qui serait effacé</button>
</form>`;
}

/** Le retour au repos : un POST, pour que le bloc se réaffiche sans recharger la page. */
function boutonRepos(departement: string, libelle: string): string {
  return `<form method="post" action="/reinitialiser/annuler" hx-post="/reinitialiser/annuler"
      hx-target="#reinitialisation" class="commandes">
  <input type="hidden" name="departement" value="${departement}">
  <button type="submit">${echapperHtml(libelle)}</button>
</form>`;
}
