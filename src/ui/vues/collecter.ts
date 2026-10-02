/**
 * Station Collecter (ADR-041) : la machine tourne, et l'ecran dit ou elle en est. Le
 * bilan de couverture — le §8 du brief a l'ecran — vit ici, sous la collecte.
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
  pluriel,
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
import { libelleDepartement } from "../../departements.ts";
import type { ActiviteCollecte, PageRecente } from "../requetes.ts";
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
  /** Compteurs de la campagne en cours ; absents quand aucune n'est ouverte. */
  activite: ActiviteCollecte | undefined;
  /** Les dernieres pages traitees, pour « En ce moment ». */
  recentes: readonly PageRecente[];
  /**
   * Contacts deja prets a relire. La collecte les note a mesure (ADR-039) : l'attente de
   * plusieurs heures peut devenir du temps de relecture, et l'ecran le propose.
   */
  aRelire: number;
  /** Rien en base pour ce departement : l'ecran presente la collecte au lieu de la suivre. */
  jamaisAmorce: boolean;
};

export type DonneesCollecter = {
  departement: string;
  suivi: DonneesSuivi;
  couverture: Couverture;
  dormance: Dormance;
  prefiltre: DistributionPrefiltre | undefined;
  normalisation: DistributionNormalisation;
  revue: DistributionRevue;
};


/**
 * Fragment rafraichi par htmx. Rendu isolement pour qu'un rafraichissement ne recalcule
 * pas les distributions du departement entier toutes les deux secondes.
 *
 * Il porte aussi les commandes : ce ne sont que des boutons, et le bouton change avec
 * l'etat — « Arreter » pendant la collecte, « Reprendre » apres un arret. Aucun champ de
 * saisie, en revanche : une valeur en cours de frappe serait effacee au rafraichissement.
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
        ` — ${nombre(actifs)} travaux à traiter. <span class="discret">Actualisé toutes les 2 s.</span></p>`;

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
      echapperHtml(LIBELLE_STATUT[run.statut] ?? run.statut),
      dateHeure(run.started_at),
      dureeRun(run, suivi.maintenant),
    ]),
  );

  const principal =
    enCours === undefined && suivi.jamaisAmorce
      ? presentation(suivi.departement)
      : `<h2>${echapperHtml(titre(suivi, enCours))}</h2>
${entete}
${orphelin}
${progression(suivi.progression)}
${enCours === undefined ? "" : compteurs(suivi)}
${enCours === undefined ? "" : journal(suivi.recentes)}`;

  return `<div class="suivi-grille">
<div class="suivi-principal">
${principal}
</div>
<div class="suivi-cote">
<div class="bloc-commandes">
${commandes(suivi)}
</div>
${inviteRelire(suivi, enCours !== undefined)}
<div class="bloc-historique">
<h3>Dernières collectes</h3>
${runs}
<details class="detail-file"><summary>File de travail</summary>
${file}
</details>
</div>
</div>
</div>`;
}

/** Le titre du bloc : ce que la machine fait, ou ce qu'elle a fait en dernier. */
function titre(suivi: DonneesSuivi, enCours: LigneRun | undefined): string {
  if (enCours !== undefined) {
    const phase = suivi.progression?.phase ?? enCours.phase;
    return (phase === null ? undefined : TITRE_PHASE[phase]) ?? "Collecte en cours";
  }
  const derniere = derniereDuDepartement(suivi);
  if (derniere?.statut === "interrompu") return "Collecte arrêtée";
  if (derniere?.statut === "echec") return "La collecte s'est interrompue";
  if (derniere?.statut === "termine") return "Collecte terminée";
  return "Collecte";
}

/** Ce que fait chaque passe, dit a qui la regarde — et non le nom interne de la phase. */
const TITRE_PHASE: Record<string, string> = {
  amorce: "Lecture du registre national",
  decouverte: "Découverte des sites de mairie",
  normalisation: "Normalisation et notation",
};

/** Les valeurs de `run.statut` sont des valeurs de colonne, pas des mots. */
const LIBELLE_STATUT: Record<string, string> = {
  en_cours: "en cours",
  termine: "terminée",
  interrompu: "arrêtée",
  echec: "interrompue",
};

function derniereDuDepartement(suivi: DonneesSuivi): LigneRun | undefined {
  return suivi.runs.find((run) => run.departement === suivi.departement);
}

/**
 * Un departement jamais collecte : on presente ce qui va se passer, plutot qu'un suivi
 * sans rien a suivre.
 */
function presentation(departement: string): string {
  return `<h2>${echapperHtml(libelleDepartement(departement))} n'a jamais été collecté</h2>
<p>La collecte commence par lire le registre national des associations du département, puis
visite les sites des mairies. <strong>Comptez plusieurs heures</strong> ; vous pourrez relire dès
les premiers contacts.</p>
<ol class="etapes etapes-presentees">
  <li class="a_venir">Amorce <span class="discret">lecture du registre</span></li>
  <li class="a_venir">Découverte <span class="discret">sites des mairies</span></li>
  <li class="a_venir">Normalisation <span class="discret">nettoyage, score</span></li>
</ol>`;
}

/**
 * Les compteurs de la campagne. Des etats, pas des restes a faire : la file grandit a
 * chaque lien retenu, et l'ecran n'annonce aucune duree qu'il ne sait pas calculer.
 */
function compteurs(suivi: DonneesSuivi): string {
  const activite = suivi.activite;
  if (activite === undefined) return "";
  const avancement = suivi.progression?.phase === "decouverte" ? suivi.progression.avancement : undefined;
  const sites =
    avancement === undefined
      ? ""
      : `<div><dt>sites de mairie explorés</dt><dd>${nombre(avancement.faits)} / ${nombre(avancement.total)}</dd></div>`;
  return `<dl class="compteurs">
  ${sites}
  <div><dt>pages en file d'attente</dt><dd>${nombre(activite.enFile)}</dd></div>
  <div><dt>contacts extraits</dt><dd>${nombre(activite.contacts)}</dd></div>
  <div><dt>pages refusées par robots.txt</dt><dd>${nombre(activite.bloquees)}</dd></div>
</dl>`;
}

/**
 * « En ce moment » : les dernieres pages traitees. Lues dans la base, comme le reste du
 * suivi — une collecte lancee dans un terminal s'y voit aussi.
 */
function journal(recentes: readonly PageRecente[]): string {
  if (recentes.length === 0) return "";
  const lignes = recentes
    .map((page) => {
      const resultat =
        page.statut === "bloquee"
          ? "page interdite, ignorée"
          : page.statut === "erreur"
            ? "page en erreur"
            : page.statut === "hors_type"
              ? "pas une page web, ignorée"
              : `${nombre(page.contacts_extraits ?? 0)} contact${pluriel(page.contacts_extraits ?? 0)}`;
      return `<li><time>${heure(page.fetched_at)}</time> <span class="url">${echapperHtml(sansSchema(page.url))}</span> · ${resultat}</li>`;
    })
    .join("\n");
  return `<h3>En ce moment</h3>
<ul class="journal">
${lignes}
</ul>`;
}

/** « 10:53:12 », dans le fuseau de la machine, comme `dateHeure`. */
function heure(valeur: string): string {
  const date = new Date(valeur);
  if (Number.isNaN(date.getTime())) return echapperHtml(valeur);
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

function sansSchema(url: string): string {
  return url.replace(/^https?:\/\//i, "");
}

/** Relire n'attend pas la fin de la collecte (ADR-039). L'ecran le propose quand c'est vrai. */
function inviteRelire(suivi: DonneesSuivi, enCours: boolean): string {
  if (suivi.aRelire === 0) return "";
  const dept = encodeURIComponent(suivi.departement);
  return `<div class="invite-relire">
  <p><strong>${nombre(suivi.aRelire)} contact${pluriel(suivi.aRelire)}</strong> attend${
    suivi.aRelire >= 2 ? "ent" : ""
  }${enCours ? " déjà" : ""} une relecture.</p>
  ${enCours ? '<p class="discret">Pas besoin d\'attendre la fin : la collecte continue pendant que vous relisez.</p>' : ""}
  <a class="bouton" href="/relire?departement=${dept}">${enCours ? "Commencer à relire" : "Relire"}</a>
</div>`;
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
    return `<p class="avis">Renseignez l'URL de contact dans
<a href="/preparer?departement=${encodeURIComponent(suivi.departement)}">Préparer</a> pour pouvoir lancer une collecte.</p>
${issue}${refus}`;
  }

  // Apres un arret, le meme bouton reprend : la file garde ses jobs et l'amorce son offset,
  // rien ne sera refait (invariant 9). Le dire evite de croire qu'on repart de zero.
  const derniere = derniereDuDepartement(suivi);
  const libelle =
    derniere?.statut === "interrompu"
      ? "Reprendre la collecte"
      : derniere?.statut === "echec"
        ? "Réessayer la collecte"
        : "Lancer la collecte complète";

  // Le libelle ne redit pas le departement : la plaque, en haut de page, est le seul
  // endroit ou il se lit — et le seul ou il se change. La duree est celle du run
  // entier ; « une quarantaine de minutes » etait le chiffre de la seule decouverte, et
  // lu devant un run complet il faisait croire a un mode d'essai.
  return `<form method="post" action="/run" hx-post="/run" hx-target="#suivi" class="commandes">
  <input type="hidden" name="departement" value="${departement}">
  <button type="submit" class="primaire">${libelle}</button>
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

export function ecranCollecter(donnees: DonneesCollecter): string {
  const dept = encodeURIComponent(donnees.departement);
  return `<h1 class="masque">Collecter</h1>
<section id="suivi" class="carte suivi" hx-get="/suivi?departement=${dept}"
         hx-trigger="every 2s" hx-swap="innerHTML">
${fragmentSuivi(donnees.suivi)}
</section>

<section id="chiffres" class="carte" hx-get="/chiffres?departement=${dept}"
         hx-trigger="every 10s" hx-swap="innerHTML">
${fragmentChiffres(donnees)}
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
export function fragmentChiffres(donnees: DonneesCollecter): string {
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
<p class="discret">Sur ${nombre(couverture.actives)} associations actives · actualisé toutes les 10 s.</p>
<div class="cartes cartes-couverture">
${chiffre(pourcent(couverture.avecEmail, couverture.actives), "au moins un email")}
${chiffre(pourcent(couverture.avecEmailExploitable, couverture.actives), "… exploitable")}
${chiffre(pourcent(couverture.avecEmailJoignable, couverture.actives), "… dont le domaine reçoit du courrier")}
${chiffre(nombre(couverture.actives), "associations actives")}
</div>
<p class="discret">
Les trois taux se lisent ensemble : leur écart dit si la couverture tient à des adresses
mortes ou à ce que les communes publient.
</p>

<details class="detail-chiffres">
<summary>Voir le détail : entonnoir, messagerie, relecture, classification</summary>

<h3>Entonnoir</h3>
${entonnoir}

<h3>Messagerie</h3>
${mx}

<h3>Revue humaine</h3>
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

<h3>Classification</h3>
${types}
</details>
`;
}
