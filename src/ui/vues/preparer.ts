/**
 * Station Preparer (ADR-041) : ce qu'on regle avant de collecter, et qu'on ne touche plus
 * ensuite — l'URL de contact, une fois pour toutes ; le departement, sur la plaque ; le
 * drapeau des mobiles, a chaque session. « Repartir de zero » vit tout en bas, replie, loin
 * de l'usage courant (ADR-031).
 *
 * Aucun bloc de cet ecran ne se rafraichit seul : ils portent tous des champs, et un champ
 * qu'on remplit ne doit pas etre remplace pendant la frappe.
 */

import { echapperHtml, nombre, pluriel, jour } from "../rendu.ts";
import type { Amorce, HistoriqueDepartement } from "../requetes.ts";
import { libelleDepartement } from "../../departements.ts";
import { fragmentReinitialisation } from "./reinitialisation.ts";
import type { DonneesReinitialisation } from "./reinitialisation.ts";

/** Le drapeau des mobiles, tel que l'ecran le presente. Hors du bloc rafraichi. */
export type DonneesMobiles = {
  /** Ce qui s'appliquera au prochain run. */
  actif: boolean;
  /** Pendant un run, le drapeau est fige : le formulaire est rendu inerte. */
  verrouille: boolean;
  refus: string | undefined;
};

export type DonneesReglages = {
  contactUrl: string | undefined;
  /** Fixee par l'environnement : le fichier de configuration n'y peut rien. */
  parEnvironnement: boolean;
  message: string | undefined;
  erreur: string | undefined;
  /**
   * Le departement courant, pour que l'enregistrement mene a l'etape suivante : une URL
   * enregistree au premier lancement n'a de sens que pour aller collecter.
   */
  departement?: string | undefined;
};


/**
 * L'URL de contact (§4.4), demandee la ou l'on en a besoin.
 *
 * Hors du bloc de suivi, et donc hors du rafraichissement automatique : un champ qu'on
 * remplit ne doit pas etre remplace pendant la frappe.
 */
export function fragmentReglages(reglages: DonneesReglages): string {
  const erreur = reglages.erreur === undefined ? "" : `<p class="refus">${echapperHtml(reglages.erreur)}</p>`;
  const suite =
    reglages.departement === undefined
      ? ""
      : ` <a href="/collecter?departement=${encodeURIComponent(reglages.departement)}">Passer à la collecte →</a>`;
  const message =
    reglages.message === undefined ? "" : `<p class="succes">${echapperHtml(reglages.message)}${suite}</p>`;

  if (reglages.parEnvironnement) {
    return `<p class="discret">URL de contact : <code>${echapperHtml(reglages.contactUrl)}</code>,
      fixée par la variable d'environnement <code>ANNUAIRE_CONTACT_URL</code>. Elle l'emporte
      sur le fichier de configuration.</p>`;
  }

  const explication =
    reglages.contactUrl === undefined
      ? `<p class="avis">Aucune URL de contact n'est configurée. Elle est annoncée à chaque page
         visitée pour qu'un webmestre puisse vous joindre, et
         <strong>aucune collecte ne part sans elle</strong>. Une page « contact » ou une adresse de
         service convient.</p>`
      : `<p class="discret">URL de contact annoncée à chaque page visitée :
         <code>${echapperHtml(reglages.contactUrl)}</code>.</p>`;

  return `${explication}${erreur}${message}
<form method="post" action="/reglages" hx-post="/reglages" hx-target="#reglages" class="reglages">
  <label>URL de contact
    <input type="url" name="contactUrl" required placeholder="https://exemple.fr/contact"
           value="${echapperHtml(reglages.contactUrl ?? "")}">
  </label>
  <button type="submit">Enregistrer</button>
</form>`;
}

/**
 * Le drapeau des mobiles (§4.6, invariant 6), avec ce qu'il engage.
 *
 * **Hors du bloc de suivi**, comme les reglages : ce fragment porte une case a cocher, et
 * le suivi est reechange toutes les deux secondes — la case serait decochee pendant la
 * lecture de l'avertissement, ce qui est la meilleure facon de faire cliquer sans lire.
 *
 * **Une case plus un bouton, pas une bascule directe.** Cocher puis valider est deux
 * gestes, et c'est voulu : le premier ouvre un traitement de donnees personnelles dont
 * l'utilisateur repond (ADR-025). Un interrupteur qui bascule au survol ne conviendrait
 * pas a ce qu'il declenche.
 *
 * **Rien n'est persiste** : le drapeau vit en memoire dans le pilote et retombe a
 * « exclus » au prochain lancement de l'interface. L'ecran le dit, sans quoi l'utilisateur
 * croirait avoir regle une fois pour toutes ce qu'il devra re-armer.
 */
export function fragmentMobiles(mobiles: DonneesMobiles): string {
  const refus = mobiles.refus === undefined ? "" : `<p class="refus">${echapperHtml(mobiles.refus)}</p>`;
  const inerte = mobiles.verrouille ? " disabled" : "";

  const explication = mobiles.actif
    ? `<p class="avertissement"><strong>Les numéros mobiles (06/07) sont conservés</strong>,
       en plus des numéros fixes, qui le sont toujours.
       Un mobile publié sur le site d'une commune est presque toujours la ligne personnelle
       d'un bénévole — président, secrétaire — et non le téléphone d'un local associatif. Il
       identifie donc directement une personne physique : la base légale et la mise en
       balance vous incombent, et l'obligation d'informer les personnes concernées
       (art. 14 du RGPD) porte alors sur une donnée qui les désigne. Ce choix ne vaut que
       pour cette session.</p>`
    : `<p class="discret"><strong>Les numéros fixes sont toujours collectés</strong> ; ce
       réglage ne porte que sur les mobiles. Les numéros mobiles (06/07) sont
       <strong>exclus</strong> : un mobile publié sur le site d'une commune est presque
       toujours la ligne personnelle d'un bénévole plutôt que le téléphone d'un local
       associatif, et le conserver ouvre un traitement de données personnelles dont vous
       êtes responsable. Les conserver reste possible, le temps de cette session
       seulement.</p>`;

  const verrou = mobiles.verrouille
    ? `<p class="discret">Figé pendant la collecte : le choix est inscrit dans chaque page à
       visiter dès la planification, le changer maintenant ne changerait rien à ce qui est
       collecté.</p>`
    : "";

  return `${explication}${refus}
<form method="post" action="/mobiles" hx-post="/mobiles" hx-target="#mobiles" class="reglages">
  <label class="bascule">
    <input type="checkbox" name="avecMobiles" value="1"${mobiles.actif ? " checked" : ""}${inerte}>
    Conserver <em>aussi</em> les numéros mobiles 06/07 pendant cette session
  </label>
  <button type="submit"${inerte}>Appliquer</button>
</form>
${verrou}`;
}


export type DonneesPreparer = {
  departement: string;
  departements: readonly string[];
  amorce: Amorce;
  historique: HistoriqueDepartement;
  reglages: DonneesReglages;
  mobiles: DonneesMobiles;
  reinitialisation: DonneesReinitialisation;
};

export function ecranPreparer(donnees: DonneesPreparer): string {
  const departement = libelleDepartement(donnees.departement);

  // Premier lancement : sans URL de contact, rien ne part. L'ecran se reduit alors a ce
  // qui manque, numerote — deux reglages, pas un tableau de bord vide.
  if (donnees.reglages.contactUrl === undefined) {
    return `<p class="surtitre">Avant la première collecte — 2 réglages</p>
<h1>Préparer l'établi</h1>
<ol class="etapes-reglage">
  <li class="carte">
    <h2><span class="numero">1</span> URL de contact</h2>
    <p class="discret">Envoyée aux sites visités, pour qu'un webmestre puisse vous joindre.
    <strong>Sans elle, la collecte ne démarre pas.</strong></p>
    <section id="reglages">
${fragmentReglages(donnees.reglages)}
    </section>
  </li>
  <li class="carte">
    <h2><span class="numero">2</span> Département</h2>
    <p>Département de travail : <strong>${echapperHtml(departement)}</strong>.
    Il se change sur la plaque, en haut à gauche de chaque écran.</p>
    ${donnees.amorce.communes === 0 ? '<p class="discret">Jamais amorcé : la première collecte le remplira depuis le registre national.</p>' : ""}
    <p class="discret">Les numéros mobiles 06/07 sont exclus par défaut. Vous pourrez changer ce réglage ici plus tard.</p>
  </li>
</ol>`;
  }

  return `<h1>Préparer</h1>
<div class="grille-preparer">
<section class="carte bloc-departement">
  <h2>Département</h2>
  ${blocDepartement(donnees)}
</section>

<section class="carte">
  <h2>URL de contact</h2>
  <p class="discret">Envoyée aux sites visités, pour qu'un webmestre puisse vous joindre. À renseigner une fois.</p>
  <div id="reglages">
${fragmentReglages(donnees.reglages)}
  </div>
</section>

<section class="carte">
  <h2>Numéros mobiles 06/07</h2>
  <div id="mobiles">
${fragmentMobiles(donnees.mobiles)}
  </div>
</section>
</div>

<details class="repli-sensible">
  <summary>Repartir de zéro</summary>
  <section id="reinitialisation" class="zone-sensible">
${fragmentReinitialisation(donnees.reinitialisation)}
  </section>
</details>
`;
}

function blocDepartement(donnees: DonneesPreparer): string {
  const autres = donnees.departements.filter((dept) => dept !== donnees.departement);
  const derniere = donnees.historique.derniere;
  const collectes =
    donnees.historique.collectes === 0
      ? "aucune collecte pour l'instant"
      : `collecte${pluriel(donnees.historique.collectes)}${
          derniere === undefined ? "" : `, la dernière le ${jour(derniere.started_at)}`
        }`;

  return `<p class="discret">Département de travail</p>
<p class="grand">${echapperHtml(libelleDepartement(donnees.departement))}</p>
${
  donnees.amorce.communes === 0
    ? '<p class="vide">Jamais amorcé. Le lancer le remplira depuis le registre national.</p>'
    : `<dl class="compteurs">
  <div><dt>associations en base</dt><dd>${nombre(donnees.amorce.associations)}</dd></div>
  <div><dt>${echapperHtml(collectes)}</dt><dd>${nombre(donnees.historique.collectes)}</dd></div>
</dl>`
}
<p class="discret">${
    autres.length === 0
      ? ""
      : `Aussi en base : ${autres.map((dept) => echapperHtml(libelleDepartement(dept))).join(", ")}. `
  }Changer de département ne supprime rien : la plaque, en haut à gauche.</p>`;
}
