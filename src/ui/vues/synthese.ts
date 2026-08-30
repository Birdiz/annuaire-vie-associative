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

import {
  echapperHtml,
  nombre,
  pourcent,
  tableau,
  choixDepartement,
  barre,
  dateHeure,
  duree,
  ecart,
  jour,
} from "../rendu.ts";
import type { LigneRun, DistributionRevue } from "../requetes.ts";
import type { EtatPilote } from "../pilote.ts";
import { PHASES_RUN } from "../../pipeline.ts";
import type { PhaseRun } from "../../pipeline.ts";
import type { DistributionPrefiltre } from "../../decouverte/rejeu.ts";
import type { DistributionNormalisation } from "../../normalisation/rejeu.ts";
import type { Couverture } from "../../metrics/couverture.ts";
import type { Dormance } from "../../metrics/dormance.ts";
import type { JobState } from "../../jobs/queue.ts";
import { ETATS_JOB } from "../../jobs/queue.ts";

/**
 * Ou en est le run, et de combien.
 *
 * La phase seule ne repondait pas a la question : « phase decouverte » et « 4 218 jobs a
 * traiter » disent qu'il se passe quelque chose, pas s'il en reste dix minutes ou une
 * heure — et le nombre de jobs monte autant qu'il descend, puisque chaque page visitee en
 * enfile de nouvelles. D'ou deux choses distinctes : l'etape, qui dit **ou**, et
 * l'avancement, qui dit **de combien**.
 *
 * `avancement` manque pendant l'amorce : rien n'y donne un denominateur honnete — le
 * nombre de communes du departement n'est connu qu'une fois le dump de l'Annuaire lu.
 * Une barre inventee pour cette passe serait pire qu'aucune barre.
 */
export type Progression = {
  phase: PhaseRun;
  avancement:
    | {
        faits: number;
        total: number;
        /** Ce que comptent `faits` et `total`, au pluriel : « communes explorees ». */
        unite: string;
        /** Chiffre d'appoint, sans denominateur fiable. */
        detail: string | undefined;
      }
    | undefined;
};

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
  /** Avancement du run ouvert en base, absent quand il n'y en a pas. */
  progression: Progression | undefined;
  /**
   * Le drapeau §4.6 qui s'appliquera au lancement. Redit ici, alors qu'il se regle dans
   * un bloc a part : c'est ici qu'est le bouton, et un opt-in sur une donnee personnelle
   * doit etre visible a l'instant du clic, pas seulement a l'instant ou on le coche.
   */
  mobilesActifs: boolean;
  /**
   * Instant du rendu, en millisecondes. Passe plutot que lu : le calcul du temps ecoule
   * doit tomber sur l'horloge injectee, sans quoi il ne se teste pas.
   */
  maintenant: number;
};

/** Le drapeau §4.6, tel que l'ecran le presente. Hors du bloc rafraichi. */
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
};

export type DonneesSynthese = {
  departement: string;
  departements: readonly string[];
  suivi: DonneesSuivi;
  reglages: DonneesReglages;
  mobiles: DonneesMobiles;
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
        `demarre le ${dateHeure(enCours.started_at)}${ecoule(enCours.started_at, suivi.maintenant)}` +
        ` — ${nombre(actifs)} jobs a traiter.</p>`;

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
    ["run", "departement", "statut", "debut", "duree"],
    suivi.runs.map((run) => [
      `#${run.id}`,
      echapperHtml(run.departement),
      echapperHtml(run.statut),
      dateHeure(run.started_at),
      dureeRun(run, suivi.maintenant),
    ]),
  );

  return `${commandes(suivi)}\n${orphelin}\n${entete}\n${progression(suivi.progression)}\n${file}
<h3>Derniers runs</h3>\n${runs}`;
}

/** « (il y a 12 min) », ou rien si l'horodatage est illisible. */
function ecoule(debut: string, maintenant: number): string {
  const millisecondes = ecart(debut, maintenant);
  if (millisecondes === undefined || millisecondes < 0) return "";
  return ` <span class="discret">(il y a ${duree(millisecondes)})</span>`;
}

/**
 * La duree d'un run, prise sur sa fin s'il en a une et sur l'instant courant sinon.
 *
 * Un run interrompu par un `kill -9` n'a pas de fin : sa ligne reste ouverte, et compter
 * jusqu'a maintenant afficherait « 3 j 14 h » pour un run mort depuis longtemps. Ces
 * lignes-la ne sont pas chronometrees — l'entete au-dessus dit deja qu'elles sont
 * orphelines.
 */
function dureeRun(run: LigneRun, maintenant: number): string {
  if (run.finished_at !== null) {
    const millisecondes = ecart(run.started_at, run.finished_at);
    return millisecondes === undefined ? "—" : duree(millisecondes);
  }
  if (run.statut !== "en_cours") return "—";
  const millisecondes = ecart(run.started_at, maintenant);
  return millisecondes === undefined || millisecondes < 0 ? "—" : `${duree(millisecondes)}…`;
}

/**
 * Ou en est le run : l'etape, puis la barre.
 *
 * L'indicateur d'etape se lit meme sans la barre — c'est le cas pendant l'amorce — et
 * c'est deja plus que ce que disait le compteur de jobs, qui montait quand le crawl
 * decouvrait des liens et descendait quand il les visitait, sans jamais dire ou l'on en
 * etait.
 */
function progression(progression: Progression | undefined): string {
  if (progression === undefined) return "";

  const rang = PHASES_RUN.indexOf(progression.phase);
  const etapes = PHASES_RUN.map((phase, index) => {
    const etat = index < rang ? "faite" : index === rang ? "courante" : "a_venir";
    return `<li class="${etat}">${echapperHtml(phase)}</li>`;
  }).join("");

  const avancement = progression.avancement;
  if (avancement === undefined) {
    return `<ol class="etapes">${etapes}</ol>
<p class="discret">Cette passe n'a pas de decompte : le nombre de communes du departement
n'est connu qu'une fois le dump de l'Annuaire lu.</p>`;
  }

  const detail =
    avancement.detail === undefined ? "" : `\n<p class="discret">${echapperHtml(avancement.detail)}</p>`;
  return `<ol class="etapes">${etapes}</ol>
${barre(avancement.faits, avancement.total, avancement.unite)}${detail}`;
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
${mentionMobiles(suivi.pilote.avecMobiles, "Ce run conserve")}${refus}`;
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
${mentionMobiles(suivi.mobilesActifs, "Ce run conservera")}${issue}${refus}`;
}

/**
 * Le rappel du drapeau §4.6 a cote du bouton.
 *
 * Rendu seulement quand il est arme : une ligne « les mobiles sont exclus » a chaque
 * rafraichissement finirait par ne plus etre lue, et c'est justement la ligne qu'il faut
 * voir quand elle dit le contraire.
 */
function mentionMobiles(actif: boolean, verbe: string): string {
  if (!actif) return "";
  return `<p class="avertissement">${echapperHtml(verbe)} les numeros mobiles (06/07). Ils
    designent presque toujours une personne physique : vous en etes responsable de
    traitement.</p>`;
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
    ? `<p class="avertissement"><strong>Les numeros mobiles (06/07) sont conserves.</strong>
       Un mobile publie sur le site d'une commune est presque toujours la ligne personnelle
       d'un benevole — president, secretaire — et non le telephone d'un local associatif. Il
       identifie donc directement une personne physique : la base legale et la mise en
       balance vous incombent, et l'information des personnes (art. 14) porte sur une donnee
       qui les designe (ADR-025). Ce choix ne vaut que pour cette session.</p>`
    : `<p class="discret">Les numeros mobiles (06/07) sont <strong>exclus</strong>, comme le
       veut le §4.6. Un mobile publie sur le site d'une commune est presque toujours la ligne
       personnelle d'un benevole plutot que le telephone d'un local associatif : le conserver
       ouvre un traitement dont vous etes responsable (ADR-025). Les conserver reste possible,
       le temps de cette session seulement.</p>`;

  const verrou = mobiles.verrouille
    ? `<p class="discret">Fige pendant le run : chaque job de page porte le drapeau depuis la
       planification, le changer maintenant ne changerait rien a ce qui est collecte.</p>`
    : "";

  return `${explication}${refus}
<form method="post" action="/mobiles" hx-post="/mobiles" hx-target="#mobiles" class="reglages">
  <label class="bascule">
    <input type="checkbox" name="avecMobiles" value="1"${mobiles.actif ? " checked" : ""}${inerte}>
    Conserver les numeros mobiles 06/07 pendant cette session
  </label>
  <button type="submit"${inerte}>Appliquer</button>
</form>
${verrou}`;
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
        `dont ${nombre(dormance.nonDormantes)} ayant declare depuis le ${jour(dormance.borne)}`,
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
<section id="mobiles">
${fragmentMobiles(donnees.mobiles)}
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
