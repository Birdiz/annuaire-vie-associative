/**
 * Ecran de synthese : le §8 du brief a l'ecran.
 *
 * « Prevoir un export de ces metriques en JSON et un ecran de synthese » — le JSON est
 * `annuaire metrics --json` depuis le lot 1, cet ecran est l'autre moitie. Il ne calcule
 * rien qui lui soit propre : il affiche ce que les distributions des lots 4 et 5
 * produisent deja, plus le suivi de la file de jobs.
 *
 * Le bloc de suivi se rafraichit tout seul. Le WAL fait qu'un `annuaire run` lance dans
 * un autre terminal est vu avancer d'ici, sans que rien ne coordonne les deux process.
 */

import { echapperHtml, nombre, pourcent, tableau, choixDepartement } from "../rendu.ts";
import type { LigneRun, DistributionRevue } from "../requetes.ts";
import type { EtatPilote } from "../pilote.ts";
import type { DistributionPrefiltre } from "../../decouverte/rejeu.ts";
import type { DistributionNormalisation } from "../../normalisation/rejeu.ts";
import type { Couverture } from "../../metrics/couverture.ts";
import type { Dormance } from "../../metrics/dormance.ts";
import type { JobState } from "../../jobs/queue.ts";
import { ETATS_JOB } from "../../jobs/queue.ts";

export type DonneesSuivi = {
  runs: readonly LigneRun[];
  jobs: Record<JobState, number>;
  departement: string;
  /** Etat du run pilote par cette interface, distinct de ce que dit la base. */
  pilote: EtatPilote;
  /** Dernier refus du pilote, ou `undefined`. */
  refus: string | undefined;
  /** Sans URL de contact, aucune collecte ne part (§4.4) : le bouton n'a pas lieu d'etre. */
  collecteConfiguree: boolean;
};

export type DonneesReglages = {
  contactUrl: string | undefined;
  /** Fixee par l'environnement : le fichier de configuration n'y peut rien. */
  parEnvironnement: boolean;
  message: string | undefined;
  erreur: string | undefined;
};

export type DonneesSynthese = {
  departement: string;
  departements: readonly string[];
  suivi: DonneesSuivi;
  reglages: DonneesReglages;
  couverture: Couverture;
  dormance: Dormance;
  prefiltre: DistributionPrefiltre | undefined;
  normalisation: DistributionNormalisation;
  revue: DistributionRevue;
};


/**
 * Fragment rafraichi par htmx. Rendu isolement pour qu'un rafraichissement ne recalcule
 * pas les distributions du departement entier toutes les deux secondes.
 */
export function fragmentSuivi(suivi: DonneesSuivi): string {
  const enCours = suivi.runs.find((run) => run.statut === "en_cours");
  const actifs = suivi.jobs.pending + suivi.jobs.leased;
  const pilote = suivi.pilote;

  const entete =
    enCours === undefined
      ? `<p class="discret">Aucun run en cours.${
          actifs > 0 ? ` ${nombre(actifs)} jobs restent en attente dans la file.` : ""
        }</p>`
      : `<p><strong>Run #${enCours.id}</strong> sur le departement ${echapperHtml(enCours.departement)}, ` +
        `demarre le ${echapperHtml(enCours.started_at)}${
          enCours.phase === null ? "" : ` — phase ${echapperHtml(enCours.phase)}`
        } — ${nombre(actifs)} jobs a traiter.</p>`;

  // Une ligne restee 'en_cours' apres un kill -9 ne doit pas condamner l'interface : on
  // le dit, et on laisse relancer. C'est vrai par l'invariant 9, pas par optimisme.
  const orphelin =
    enCours !== undefined && pilote.kind !== "en_cours"
      ? `<p class="avis">Ce run n'est pas pilote depuis cette interface. S'il tourne dans un
         terminal, laissez-le finir ; s'il a ete interrompu brutalement, relancer est sans
         risque — rien ne sera rejoue.</p>`
      : "";

  const file = tableau(ETATS_JOB, [ETATS_JOB.map((etat) => `<span class="n">${nombre(suivi.jobs[etat])}</span>`)]);

  const runs = tableau(
    ["run", "departement", "statut", "debut", "fin"],
    suivi.runs.map((run) => [
      `#${run.id}`,
      echapperHtml(run.departement),
      echapperHtml(run.statut),
      echapperHtml(run.started_at),
      echapperHtml(run.finished_at ?? "—"),
    ]),
  );

  return `${commandes(suivi)}\n${orphelin}\n${entete}\n${file}\n<h3>Derniers runs</h3>\n${runs}`;
}

/**
 * Le bouton, et ce qu'il faut savoir avant de le presser.
 *
 * Aucun champ de saisie ici : ce fragment est reechange toutes les deux secondes, et
 * une valeur en cours de frappe y serait effacee. Le departement vient du selecteur de
 * l'ecran, qui recharge la page — d'ou le champ cache plutot qu'une seconde liste.
 */
function commandes(suivi: DonneesSuivi): string {
  const departement = echapperHtml(suivi.departement);
  const refus = suivi.refus === undefined ? "" : `<p class="refus">${echapperHtml(suivi.refus)}</p>`;

  if (suivi.pilote.kind === "en_cours") {
    return `<form method="post" action="/run/arret" hx-post="/run/arret" hx-target="#suivi" class="commandes">
  <button type="submit">Arreter le run</button>
  <span class="discret">Les requetes en cours vont finir : rien ne sera perdu, et relancer reprendra ou l'on s'arrete.</span>
</form>
${refus}`;
  }

  const issue =
    suivi.pilote.kind === "fini"
      ? `<p class="${suivi.pilote.issue === "echec" ? "refus" : "discret"}">Dernier run pilote d'ici sur le
         departement ${echapperHtml(suivi.pilote.departement)} : ${echapperHtml(suivi.pilote.issue)}${
           suivi.pilote.message === undefined ? "" : ` — ${echapperHtml(suivi.pilote.message)}`
         }.</p>`
      : "";

  if (!suivi.collecteConfiguree) {
    return `<p class="avis">Renseignez l'URL de contact ci-dessus pour pouvoir lancer une collecte.</p>
${issue}${refus}`;
  }

  return `<form method="post" action="/run" hx-post="/run" hx-target="#suivi" class="commandes">
  <input type="hidden" name="departement" value="${departement}">
  <button type="submit">Lancer un run sur le departement ${departement}</button>
  <span class="discret">Amorce, decouverte, puis normalisation. Comptez une quarantaine de minutes par departement.</span>
</form>
${issue}${refus}`;
}

/**
 * L'URL de contact (§4.4), demandee la ou l'on en a besoin.
 *
 * Hors du bloc de suivi, et donc hors du rafraichissement automatique : un champ qu'on
 * remplit ne doit pas etre remplace pendant la frappe.
 */
export function fragmentReglages(reglages: DonneesReglages): string {
  const erreur = reglages.erreur === undefined ? "" : `<p class="refus">${echapperHtml(reglages.erreur)}</p>`;
  const message = reglages.message === undefined ? "" : `<p class="discret">${echapperHtml(reglages.message)}</p>`;

  if (reglages.parEnvironnement) {
    return `<p class="discret">URL de contact : <code>${echapperHtml(reglages.contactUrl)}</code>,
      fixee par la variable d'environnement <code>ANNUAIRE_CONTACT_URL</code>. Elle l'emporte
      sur le fichier de configuration.</p>`;
  }

  const explication =
    reglages.contactUrl === undefined
      ? `<p class="avis">Aucune URL de contact n'est configuree. Elle est annoncee dans le
         User-Agent de chaque requete pour qu'un webmestre puisse vous joindre, et
         <strong>aucune collecte ne part sans elle</strong>. Une page « contact » ou une adresse
         de service convient.</p>`
      : `<p class="discret">URL de contact annoncee dans le User-Agent :
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

export function ecranSynthese(donnees: DonneesSynthese): string {
  const { couverture, normalisation, prefiltre, revue, dormance } = donnees;

  const chiffre = (valeur: string, libelle: string): string =>
    `<div class="chiffre"><b>${valeur}</b><span>${echapperHtml(libelle)}</span></div>`;

  const entonnoir = tableau(
    ["etage", "volume", "commentaire"],
    [
      [
        "[1] associations actives",
        `<span class="n">${nombre(couverture.actives)}</span>`,
        `dont ${nombre(dormance.nonDormantes)} ayant declare depuis le ${echapperHtml(dormance.borne)}`,
      ],
      [
        "[3] pages explorees",
        `<span class="n">${nombre(prefiltre?.total ?? 0)}</span>`,
        prefiltre === undefined ? "aucune campagne de decouverte" : "derniere campagne",
      ],
      [
        "[4] pages retenues",
        `<span class="n">${nombre(prefiltre?.retenues ?? 0)}</span>`,
        prefiltre === undefined
          ? "—"
          : `${pourcent(prefiltre.retenues, prefiltre.jugees)} des pages jugees`,
      ],
      [
        "[5] contacts extraits",
        `<span class="n">${nombre(normalisation.contacts)}</span>`,
        `${nombre(normalisation.invalides)} sans forme exploitable`,
      ],
      [
        "[8] contacts notes",
        `<span class="n">${nombre(normalisation.notes)}</span>`,
        `${nombre(revue.arbitres)} arbitres en revue`,
      ],
    ],
  );

  const mx = tableau(
    ["verdict MX du domaine", "emails"],
    [
      ["annonce un MX", `<span class="n">${nombre(normalisation.emailsAvecMx)}</span>`],
      ["n'en annonce aucun", `<span class="n">${nombre(normalisation.emailsSansMx)}</span>`],
      ["non verifie", `<span class="n">${nombre(normalisation.emailsMxInconnu)}</span>`],
    ],
  );

  const types = tableau(
    ["type", "associations", "part"],
    normalisation.parType.map((ligne) => [
      echapperHtml(ligne.type),
      `<span class="n">${nombre(ligne.associations)}</span>`,
      pourcent(ligne.associations, normalisation.associations),
    ]),
  );

  return `${choixDepartement("/", donnees.departements, donnees.departement)}
<h2>Collecte</h2>
<section id="reglages">
${fragmentReglages(donnees.reglages)}
</section>

<h2>Suivi</h2>
<section id="suivi" hx-get="/suivi?departement=${encodeURIComponent(donnees.departement)}"
         hx-trigger="every 2s" hx-swap="innerHTML">
${fragmentSuivi(donnees.suivi)}
</section>

<h2>Couverture</h2>
<div class="cartes">
${chiffre(pourcent(couverture.avecEmail, couverture.actives), "au moins un email")}
${chiffre(pourcent(couverture.avecEmailExploitable, couverture.actives), "... exploitable")}
${chiffre(pourcent(couverture.avecEmailJoignable, couverture.actives), "... dont le domaine recoit du courrier")}
${chiffre(nombre(couverture.actives), "associations actives")}
</div>
<p class="discret">
Les trois taux se lisent ensemble : leur ecart dit si la couverture tient a des adresses
mortes ou a ce que les communes publient.
</p>

<h2>Entonnoir</h2>
${entonnoir}

<h2>Messagerie</h2>
${mx}

<h2>Revue humaine</h2>
<div class="cartes">
${chiffre(nombre(revue.aRevoir), "a arbitrer")}
${chiffre(nombre(revue.valides), "valides")}
${chiffre(nombre(revue.rejetes), "rejetes")}
${chiffre(nombre(revue.corriges), "corriges")}
${chiffre(pourcent(revue.corriges, revue.arbitres), "taux de correction (§8)")}
</div>
<p class="discret">
Le taux de correction est le seul proxy de precision d'extraction que le brief demande.
Il se lit sur l'etat des lignes, pas sur un compteur d'evenements : changer d'avis sur un
contact ne doit pas le compter deux fois.
</p>

<h2>Classification</h2>
${types}
`;
}
