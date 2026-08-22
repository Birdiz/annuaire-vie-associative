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
import type { DistributionPrefiltre } from "../../decouverte/rejeu.ts";
import type { DistributionNormalisation } from "../../normalisation/rejeu.ts";
import type { Couverture } from "../../metrics/couverture.ts";
import type { Dormance } from "../../metrics/dormance.ts";
import type { JobState } from "../../jobs/queue.ts";

export type DonneesSuivi = {
  runs: readonly LigneRun[];
  jobs: Record<JobState, number>;
};

export type DonneesSynthese = {
  departement: string;
  departements: readonly string[];
  suivi: DonneesSuivi;
  couverture: Couverture;
  dormance: Dormance;
  prefiltre: DistributionPrefiltre | undefined;
  normalisation: DistributionNormalisation;
  revue: DistributionRevue;
};

const ETATS: readonly JobState[] = ["pending", "leased", "done", "failed", "dead", "skipped"];

/**
 * Fragment rafraichi par htmx. Rendu isolement pour qu'un rafraichissement ne recalcule
 * pas les distributions du departement entier toutes les deux secondes.
 */
export function fragmentSuivi(suivi: DonneesSuivi): string {
  const enCours = suivi.runs.find((run) => run.statut === "en_cours");
  const actifs = suivi.jobs.pending + suivi.jobs.leased;

  const entete =
    enCours === undefined
      ? `<p class="discret">Aucun run en cours.${
          actifs > 0 ? ` ${nombre(actifs)} jobs restent en attente dans la file.` : ""
        }</p>`
      : `<p><strong>Run #${enCours.id}</strong> sur le departement ${echapperHtml(enCours.departement)}, ` +
        `demarre le ${echapperHtml(enCours.started_at)} — ${nombre(actifs)} jobs a traiter.</p>`;

  const file = tableau(ETATS, [ETATS.map((etat) => `<span class="n">${nombre(suivi.jobs[etat])}</span>`)]);

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

  return `${entete}\n${file}\n<h3>Derniers runs</h3>\n${runs}`;
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
