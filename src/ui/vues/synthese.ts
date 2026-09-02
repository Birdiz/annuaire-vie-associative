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
import { fragmentReinitialisation } from "./reinitialisation.ts";
import type { DonneesReinitialisation } from "./reinitialisation.ts";
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
 * Chaque passe a son denominateur : les octets du dump pendant l'amorce, les communes
 * pendant la decouverte, les contacts pendant la notation. `avancement` ne manque que
 * lorsque la base n'a pas encore de quoi le calculer — une barre inventee serait pire
 * qu'aucune barre.
 */
export type Progression = {
  phase: PhaseRun;
  avancement:
    | {
        faits: number;
        total: number;
        /** Ce que comptent `faits` et `total`, au pluriel : « communes explorees ». */
        unite: string;
        /**
         * Remplace « N sur M unite » quand le decompte ne se lit pas tel quel. Les octets
         * du dump en sont le cas : « 340 Mo sur 1,25 Go » se lit, le compte brut non.
         */
        phrase: string | undefined;
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
  /** Sans URL de contact, aucune collecte ne part : le bouton n'a pas lieu d'etre. */
  collecteConfiguree: boolean;
  /** Avancement du run ouvert en base, absent quand il n'y en a pas. */
  progression: Progression | undefined;
  /**
   * Le drapeau des mobiles qui s'appliquera au lancement. Redit ici, alors qu'il se regle dans
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
};

export type DonneesSynthese = {
  departement: string;
  /** Hors du suivi : un ecran de confirmation ne doit pas disparaitre en le lisant. */
  reinitialisation: DonneesReinitialisation;
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
      ? `<p class="discret">Aucune collecte en cours.${
          actifs > 0 ? ` ${nombre(actifs)} travaux restent en attente dans la file.` : ""
        }</p>`
      : `<p><strong>Collecte n° ${enCours.id}</strong> sur le département ${echapperHtml(enCours.departement)}, ` +
        `démarrée le ${dateHeure(enCours.started_at)}${ecoule(enCours.started_at, suivi.maintenant)}` +
        ` — ${nombre(actifs)} travaux à traiter.</p>`;

  // Une ligne restee 'en_cours' apres un kill -9 ne doit pas condamner l'interface : on
  // le dit, et on laisse relancer. C'est vrai par l'invariant 9, pas par optimisme.
  const orphelin =
    enCours !== undefined && pilote.kind !== "en_cours"
      ? `<p class="avis">Cette collecte n'est pas pilotée depuis cette interface. Si elle tourne
         dans un terminal, laissez-la finir ; si elle a été interrompue brutalement, relancer est
         sans risque — rien ne sera rejoué.</p>`
      : "";

  const file = tableau(ETATS_JOB, [ETATS_JOB.map((etat) => `<span class="n">${nombre(suivi.jobs[etat])}</span>`)]);

  const runs = tableau(
    ["collecte", "département", "statut", "début", "durée"],
    suivi.runs.map((run) => [
      `n° ${run.id}`,
      echapperHtml(run.departement),
      echapperHtml(run.statut),
      dateHeure(run.started_at),
      dureeRun(run, suivi.maintenant),
    ]),
  );

  return `${commandes(suivi)}\n${orphelin}\n${entete}\n${progression(suivi.progression)}\n${file}
<h3>Dernières collectes</h3>\n${runs}`;
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
    return `<li class="${etat}">${echapperHtml(LIBELLE_PHASE[phase] ?? phase)}</li>`;
  }).join("");

  const avancement = progression.avancement;
  if (avancement === undefined) {
    return `<ol class="etapes">${etapes}</ol>
<p class="discret">Cette étape n'a pas encore de décompte : elle vient de commencer, et la
base n'a pas de quoi en calculer un qui ne soit pas inventé.</p>`;
  }

  const detail =
    avancement.detail === undefined ? "" : `\n<p class="discret">${echapperHtml(avancement.detail)}</p>`;
  return `<ol class="etapes">${etapes}</ol>
${barre(avancement.faits, avancement.total, avancement.unite, avancement.phrase)}${detail}`;
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
  <button type="submit">Arrêter la collecte</button>
  <span class="discret">Les requêtes en cours vont finir : rien ne sera perdu, et relancer reprendra où l'on s'arrête.</span>
</form>
${mentionMobiles(suivi.pilote.avecMobiles, "Cette collecte conserve")}${refus}`;
  }

  const issue =
    suivi.pilote.kind === "fini"
      ? `<p class="${suivi.pilote.issue === "echec" ? "refus" : "discret"}">Dernière collecte pilotée d'ici,
         sur le département ${echapperHtml(suivi.pilote.departement)} : ${echapperHtml(LIBELLE_ISSUE[suivi.pilote.issue] ?? suivi.pilote.issue)}${
           suivi.pilote.message === undefined ? "" : ` — ${echapperHtml(suivi.pilote.message)}`
         }.</p>`
      : "";

  if (!suivi.collecteConfiguree) {
    return `<p class="avis">Renseignez l'URL de contact ci-dessus pour pouvoir lancer une collecte.</p>
${issue}${refus}`;
  }

  // Le libelle ne redit pas le departement : la barre de portee, en haut de page, est le
  // seul endroit ou il se lit — et le seul ou il se change. La duree est celle du run
  // entier ; « une quarantaine de minutes » etait le chiffre de la seule decouverte, et
  // lu devant un run complet il faisait croire a un mode d'essai.
  return `<form method="post" action="/run" hx-post="/run" hx-target="#suivi" class="commandes">
  <input type="hidden" name="departement" value="${departement}">
  <button type="submit" class="primaire">Lancer la collecte complète</button>
  <span class="discret">Les trois étapes à la suite : lecture du registre national des associations,
  découverte des sites de mairie (20 pages par commune), puis normalisation et notation.
  <strong>Comptez plusieurs heures</strong> — le délai de 2 s entre deux requêtes vers un même
  site en fixe le plancher. La collecte se reprend où elle s'arrête : fermer l'outil ne perd rien.</span>
</form>
<p class="discret">Le registre national fait 1,25 Go et n'est <strong>pas conservé sur cette
machine</strong> : il est lu au fil de l'eau et seules les lignes de ce département sont gardées.
Une interruption reprend à l'octet où elle s'est arrêtée, mais ouvrir un autre département
relit le registre depuis le début.</p>
${mentionMobiles(suivi.mobilesActifs, "Cette collecte conservera")}${issue}${refus}`;
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
  return `<p class="avertissement">${echapperHtml(verbe)} les numéros mobiles (06/07), en plus
    des numéros fixes. Ils désignent presque toujours une personne physique : vous en êtes
    responsable de traitement.</p>`;
}

/** Le libelle des passes du run, en francais plutot qu'en nom de phase interne. */
const LIBELLE_PHASE: Record<string, string> = {
  amorce: "Amorce",
  decouverte: "Découverte",
  normalisation: "Normalisation",
};

/** Meme raison : `echec` et `interrompu` sont des valeurs de colonne, pas des mots. */
const LIBELLE_ISSUE: Record<string, string> = {
  termine: "terminée",
  interrompu: "interrompue",
  echec: "échec",
};

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

export function ecranSynthese(donnees: DonneesSynthese): string {
  return `<h2>Collecte</h2>
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

<section id="chiffres" hx-get="/chiffres?departement=${encodeURIComponent(donnees.departement)}"
         hx-trigger="every 10s" hx-swap="innerHTML">
${fragmentChiffres(donnees)}
</section>

<h2>Repartir de zéro</h2>
<section id="reinitialisation" class="zone-sensible">
${fragmentReinitialisation(donnees.reinitialisation)}
</section>
`;
}

/**
 * Tout ce qu'un run fait bouger, dans un bloc qui se rafraichit seul.
 *
 * Seul le suivi se rafraichissait. Couverture, entonnoir, messagerie et classification
 * restaient ceux du chargement de la page : devant un run de plusieurs heures, l'ecran
 * donnait l'impression que rien n'avancait, et il fallait recharger pour voir un chiffre
 * bouger.
 *
 * Dix secondes, et non deux comme le suivi : ces chiffres sont des agregats sur toute la
 * base, la ou le suivi ne lit que des compteurs de file. Aucun champ de saisie ici non
 * plus — un bloc qui se remplace efface ce qu'on est en train d'y taper.
 */
export function fragmentChiffres(donnees: DonneesSynthese): string {
  const { couverture, normalisation, prefiltre, revue, dormance } = donnees;

  const chiffre = (valeur: string, libelle: string): string =>
    `<div class="chiffre"><b>${valeur}</b><span>${echapperHtml(libelle)}</span></div>`;

  const entonnoir = tableau(
    ["étage", "volume", "commentaire"],
    [
      [
        "associations actives",
        `<span class="n">${nombre(couverture.actives)}</span>`,
        `dont ${nombre(dormance.nonDormantes)} ayant déclaré depuis le ${jour(dormance.borne)}`,
      ],
      [
        "pages explorées",
        `<span class="n">${nombre(prefiltre?.total ?? 0)}</span>`,
        prefiltre === undefined ? "aucune campagne de découverte" : "dernière campagne",
      ],
      [
        "pages retenues",
        `<span class="n">${nombre(prefiltre?.retenues ?? 0)}</span>`,
        prefiltre === undefined
          ? "—"
          : `${pourcent(prefiltre.retenues, prefiltre.jugees)} des pages jugées`,
      ],
      [
        "contacts extraits",
        `<span class="n">${nombre(normalisation.contacts)}</span>`,
        `${nombre(normalisation.invalides)} sans forme exploitable`,
      ],
      [
        "contacts notés",
        `<span class="n">${nombre(normalisation.notes)}</span>`,
        `${nombre(revue.arbitres)} arbitrés en revue`,
      ],
    ],
  );

  const mx = tableau(
    ["le domaine reçoit-il du courrier ?", "emails"],
    [
      ["oui, il annonce un serveur", `<span class="n">${nombre(normalisation.emailsAvecMx)}</span>`],
      ["non, il n'en annonce aucun", `<span class="n">${nombre(normalisation.emailsSansMx)}</span>`],
      ["non vérifié", `<span class="n">${nombre(normalisation.emailsMxInconnu)}</span>`],
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

  return `<h2>Couverture</h2>
<div class="cartes">
${chiffre(pourcent(couverture.avecEmail, couverture.actives), "au moins un email")}
${chiffre(pourcent(couverture.avecEmailExploitable, couverture.actives), "… exploitable")}
${chiffre(pourcent(couverture.avecEmailJoignable, couverture.actives), "… dont le domaine reçoit du courrier")}
${chiffre(nombre(couverture.actives), "associations actives")}
</div>
<p class="discret">
Les trois taux se lisent ensemble : leur écart dit si la couverture tient à des adresses
mortes ou à ce que les communes publient.
</p>

<h2>Entonnoir</h2>
${entonnoir}

<h2>Messagerie</h2>
${mx}

<h2>Revue humaine</h2>
<div class="cartes">
${chiffre(nombre(revue.aRevoir), "à arbitrer")}
${chiffre(nombre(revue.valides), "validés")}
${chiffre(nombre(revue.rejetes), "rejetés")}
${chiffre(nombre(revue.corriges), "corrigés")}
${chiffre(pourcent(revue.corriges, revue.arbitres), "taux de correction")}
</div>
<p class="discret">
Le taux de correction est la seule mesure de précision d'extraction dont l'outil dispose :
la part des contacts arbitrés qu'un humain a dû corriger. Il se lit sur l'état des lignes
et non sur un compteur d'événements — changer d'avis sur un contact ne le compte pas deux
fois.
</p>

<h2>Classification</h2>
${types}
`;
}
