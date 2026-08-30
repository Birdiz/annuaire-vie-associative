/**
 * Ecran de revue humaine — le destinataire que le lot 5 designait sans qu'il existe.
 *
 * **Les moins surs d'abord.** L'ordre n'est pas cosmetique : c'est la que la decision
 * humaine apporte quelque chose. Les 138 adresses cassees par un CMS que l'ADR-017 a
 * trouvees remontent ainsi d'elles-memes en tete de file — notees zero, elles sont
 * exactement le cas ou desobfusquer *a la main* repond a la question que l'ADR laissait
 * ouverte, sans trancher la desobfuscation automatique.
 *
 * **Le score s'explique.** Chaque carte deplie les motifs persistes a la notation. Un
 * score qu'on ne peut pas expliquer n'est pas revisable : la personne doit voir ce qui a
 * fait descendre le chiffre, pas seulement le chiffre.
 */

import { echapperHtml, lienSur, nombre, choixDepartement, banniereRun, dateHeure } from "../rendu.ts";
import type { EtatCollecte } from "../rendu.ts";
import type { ContactARevoir, DistributionRevue } from "../requetes.ts";
import type { Motifs } from "../../normalisation/score.ts";

export type DonneesRevue = {
  departement: string;
  departements: readonly string[];
  file: readonly ContactARevoir[];
  distribution: DistributionRevue;
  /** Message d'un arbitrage refuse, a afficher en tete. */
  refus?: string | undefined;
  /** Une collecte en cours change la file sous les yeux de qui arbitre. */
  collecte: EtatCollecte;
};

export function ecranRevue(donnees: DonneesRevue): string {
  return `${choixDepartement("/revue", donnees.departements, donnees.departement)}
<h2>Revue</h2>
<section id="file">
${fragmentFile(donnees)}
</section>`;
}

/** Cible des swaps htmx : chaque arbitrage renvoie la file recalculee. */
export function fragmentFile(donnees: DonneesRevue): string {
  const { distribution: d } = donnees;

  const refus =
    donnees.refus === undefined ? "" : `<p class="refus">${echapperHtml(donnees.refus)}</p>\n`;

  // `aRevoir` compte aussi les lignes que l'etape [8] n'a pas encore notees, et celles-la
  // n'entrent pas dans la file. Afficher le total brut a cote de « Rien a arbitrer »
  // donnait deux phrases qui se contredisaient a l'ecran — 418 a arbitrer, rien a
  // arbitrer. C'est le nombre de contacts *pretes* qui compte ici.
  const prets = Math.max(0, d.aRevoir - d.nonNotes);

  const compteur =
    `<p class="discret">${nombre(prets)} pret(s) a arbitrer · ${nombre(d.nonNotes)} en attente de notation · ` +
    `${nombre(d.valides)} valides · ${nombre(d.rejetes)} rejetes · ${nombre(d.corriges)} corriges</p>`;

  const attente =
    d.nonNotes === 0
      ? ""
      : `<p class="discret">${nombre(d.nonNotes)} contacts ne sont pas encore notes et ` +
        "n'apparaissent pas ici : arbitrer avant l'etape [8] reviendrait a juger sans le " +
        `seul element que l'outil apporte. ${
          donnees.collecte.kind === "inactif"
            ? `Lancez <code>annuaire normaliser --departement ${echapperHtml(donnees.departement)}</code>.`
            : "La normalisation est la derniere passe du run : ces lignes seront notees sans que vous ayez rien a faire."
        }</p>`;

  const aRenoter =
    d.correctionsANoter === 0
      ? ""
      : `<p class="discret">${nombre(d.correctionsANoter)} correction(s) attendent une renotation : ` +
        "une valeur corrigee n'est pas notee par cet ecran, c'est l'etape [8] qui repasse. " +
        `<code>annuaire normaliser --departement ${echapperHtml(donnees.departement)}</code></p>`;

  const banniere = banniereRun(
    donnees.collecte,
    "La file se remplit au fur et a mesure : ce qui est arbitre maintenant reste arbitre, mais " +
      "l'essentiel des contacts n'est pas encore note. Revenir a la fin du run evite de repasser deux fois.",
  );

  const entete = `${refus}${banniere}\n${compteur}\n${attente}\n${aRenoter}`;

  if (donnees.file.length === 0) {
    // Trois raisons de n'avoir rien a montrer, et elles n'appellent pas la meme suite.
    const explication =
      donnees.collecte.kind !== "inactif"
        ? "Rien a arbitrer pour l'instant : le run en cours n'a pas encore note de contact. Cet ecran se remplira tout seul."
        : d.nonNotes > 0
          ? "Rien a arbitrer tant que l'etape [8] n'est pas passee sur les contacts ci-dessus."
          : "Rien a arbitrer pour ce departement.";
    return `${entete}\n<p>${explication}</p>`;
  }

  return `${entete}\n${donnees.file.map((contact) => carte(contact, donnees.departement)).join("\n")}`;
}

function carte(contact: ContactARevoir, departement: string): string {
  const cible =
    contact.association === null
      ? `${echapperHtml(contact.commune)} <span class="discret">(commune, sans association rattachee)</span>`
      : `${echapperHtml(contact.association)} <span class="discret">— ${echapperHtml(contact.commune)}</span>`;

  const regime =
    contact.kind !== "email"
      ? ""
      : contact.is_generique === 1
        ? '<span class="discret">adresse generique</span>'
        : contact.is_generique === 0
          ? '<span class="alerte">adresse nominative (§4.7)</span>'
          : '<span class="discret">regime indetermine</span>';

  const source = lienSur(contact.source_url);
  const lien =
    source === undefined
      ? `<span class="source discret">${echapperHtml(contact.source_url)}</span>`
      : `<a class="source" href="${source}" rel="noreferrer noopener" target="_blank">${source}</a>`;

  const cheminAction = `/revue/${contact.id}?departement=${encodeURIComponent(departement)}`;

  return `<article class="contact" id="contact-${contact.id}">
  <span class="score">score ${contact.score === null ? "—" : contact.score.toFixed(2)} · lu ${contact.confiance.toFixed(2)}</span>
  <div class="valeur">${echapperHtml(contact.valeur)}</div>
  <div>${cible}</div>
  <div class="discret">${regime} · ${echapperHtml(contact.methode_extraction)} · vu le ${dateHeure(contact.collected_at)}</div>
  ${motifsHtml(contact.score_motifs)}
  <div>${lien}</div>
  <!-- method/action en plus de hx-post : sans JS le formulaire part quand meme, et le
       serveur repond alors par une redirection plutot qu'un fragment. L'ecran de revue
       reste utilisable meme si htmx ne se charge pas. -->
  <form class="arbitrage" method="post" action="${cheminAction}"
        hx-post="${cheminAction}" hx-target="#file" hx-swap="innerHTML">
    <button type="submit" name="action" value="valide">Valider</button>
    <button type="submit" name="action" value="rejete">Rejeter</button>
    <input type="text" name="valeur" placeholder="valeur corrigee" aria-label="valeur corrigee">
    <button type="submit" name="action" value="corrige">Corriger</button>
    <input type="text" name="note" placeholder="note (motif requis pour oublier)" aria-label="note de revue">
    <!-- Oublier n'est pas rejeter. Rejeter ecrit un statut, que l'export sait remettre
         et que le run suivant recouvre ; oublier supprime la ligne, efface la copie en
         cache et inscrit l'exclusion (art. 17 et 21). D'ou le motif obligatoire, et la
         mise en garde portee par le titre du bouton. -->
    <button type="submit" name="action" value="oublie" class="danger"
            title="Supprime definitivement ce contact et l'empeche de revenir. Le motif, saisi dans la note, est obligatoire.">
      Oublier
    </button>
  </form>
</article>`;
}

/**
 * Les motifs sont du JSON ecrit par la notation. Un JSON illisible n'est pas une raison
 * de ne pas rendre la carte : la revue doit rester possible meme sur une ligne dont
 * l'explication a ete perdue.
 */
function motifsHtml(brut: string | null): string {
  if (brut === null) return "";
  let motifs: Motifs;
  try {
    motifs = JSON.parse(brut) as Motifs;
  } catch {
    return '<p class="discret">Motifs du score illisibles.</p>';
  }
  if (!Array.isArray(motifs.signaux) || motifs.signaux.length === 0) {
    return `<p class="discret">Base ${Number(motifs.base ?? 0).toFixed(2)}, aucun signal retire.</p>`;
  }
  const lignes = motifs.signaux
    .map(
      (signal) =>
        `<li>${echapperHtml(signal.signal)} × ${Number(signal.facteur).toFixed(2)} — ${echapperHtml(signal.detail)}</li>`,
    )
    .join("");
  return `<ul>${lignes}</ul>`;
}
