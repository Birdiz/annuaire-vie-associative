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

import { echapperHtml, lienSur, nombre, pluriel, banniereRun, dateHeure } from "../rendu.ts";
import type { EtatCollecte } from "../rendu.ts";
import type { ContactARevoir, DistributionRevue } from "../requetes.ts";
import type { Motifs } from "../../normalisation/score.ts";

export type DonneesRevue = {
  departement: string;
  file: readonly ContactARevoir[];
  distribution: DistributionRevue;
  /** Message d'un arbitrage refuse, a afficher en tete. */
  refus?: string | undefined;
  /** Une collecte en cours change la file sous les yeux de qui arbitre. */
  collecte: EtatCollecte;
  /** Page affichee, 1-based, deja bornee par le routeur. */
  page: number;
  /** Nombre de pages que la file remplit, au moins 1. */
  pages: number;
};

/**
 * L'en-tete de l'ecran, et il n'est pas decoratif.
 *
 * L'ecran affichait une valeur nue au-dessus de quatre boutons, sans jamais dire de quoi
 * il s'agissait ni ce qui etait attendu du lecteur : devant `mairie@exemple.fr`, rien ne
 * disait s'il fallait juger l'adresse, la commune a laquelle elle est rattachee, ou le
 * fait qu'elle n'ait pas d'association. La legende des quatre boutons est repliee — elle
 * se lit une fois, pas a chaque contact — mais le rappel de ce qu'est une carte, lui,
 * reste visible.
 */
function introduction(): string {
  return `<p class="intro">Chaque carte porte <strong>une valeur de contact lue sur une page de
site communal</strong> — une adresse email ou un numéro de téléphone — que l'outil n'a pas su
valider seul. <strong>Les moins sûres d'abord</strong> : c'est là qu'un arbitrage humain apporte
quelque chose. Les motifs sous la valeur disent ce qui a fait baisser le score, et le lien mène à
la page où elle a été lue — c'est là qu'on vérifie.</p>
<details class="legende">
  <summary>Que font les quatre boutons ?</summary>
  <dl>
    <dt>Valider</dt><dd>La valeur est bonne. Elle sort dans l'export.</dd>
    <dt>Rejeter</dt><dd>La valeur est fausse ou hors sujet. Elle reste en base mais l'export
      l'exclut par défaut.</dd>
    <dt>Corriger</dt><dd>La valeur lue est presque bonne — une adresse cassée par un site,
      typiquement. La version corrigée sort à côté de la version lue, et repasse à la notation.</dd>
    <dt>Oublier</dt><dd>Suppression définitive : la ligne, sa copie dans le cache, et une
      exclusion qui l'empêche de revenir à la collecte suivante. Le motif est obligatoire.</dd>
  </dl>
</details>`;
}

export function ecranRevue(donnees: DonneesRevue): string {
  return `<h2>Revue</h2>
${introduction()}
<section id="file">
${fragmentFile(donnees)}
</section>`;
}

/** Ce qu'est la valeur affichee. Sans cette etiquette, la carte montre une chaine nue. */
const LIBELLE_KIND: Record<string, string> = {
  email: "Adresse email",
  phone: "Numéro de téléphone",
};

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
    `<p class="discret">${nombre(prets)} prêt${pluriel(prets)} à arbitrer · ${nombre(d.nonNotes)} en attente de notation · ` +
    `${nombre(d.valides)} validés · ${nombre(d.rejetes)} rejetés · ${nombre(d.corriges)} corrigés</p>`;

  const attente =
    d.nonNotes === 0
      ? ""
      : `<p class="discret">${nombre(d.nonNotes)} contacts ne sont pas encore notés et ` +
        "n'apparaissent pas ici : arbitrer avant la notation reviendrait à juger sans le " +
        `seul élément que l'outil apporte. ${
          donnees.collecte.kind === "inactif"
            ? `Lancez <code>annuaire normaliser --departement ${echapperHtml(donnees.departement)}</code>.`
            : "La normalisation est la dernière étape de la collecte : ces lignes seront notées sans que vous ayez rien à faire."
        }</p>`;

  const aRenoter =
    d.correctionsANoter === 0
      ? ""
      : `<p class="discret">${nombre(d.correctionsANoter)} correction${pluriel(d.correctionsANoter)} attend${pluriel(d.correctionsANoter)} une renotation : ` +
        "une valeur corrigée n'est pas notée par cet écran, c'est l'étape de notation qui repasse. " +
        `<code>annuaire normaliser --departement ${echapperHtml(donnees.departement)}</code></p>`;

  const banniere = banniereRun(
    donnees.collecte,
    "La file se remplit au fur et à mesure : ce qui est arbitré maintenant reste arbitré, mais " +
      "l'essentiel des contacts n'est pas encore noté. Revenir à la fin de la collecte évite de repasser deux fois.",
  );

  const entete = `${refus}${banniere}\n${compteur}\n${attente}\n${aRenoter}`;

  const navigation = pagination(donnees);

  if (donnees.file.length === 0) {
    // Trois raisons de n'avoir rien a montrer, et elles n'appellent pas la meme suite.
    const explication =
      donnees.collecte.kind !== "inactif"
        ? "Rien à arbitrer pour l'instant : la collecte en cours n'a pas encore noté de contact. Cet écran se remplira tout seul."
        : d.nonNotes > 0
          ? "Rien à arbitrer tant que la notation n'est pas passée sur les contacts ci-dessus."
          : "Rien à arbitrer pour ce département.";
    return `${entete}\n<p>${explication}</p>`;
  }

  return `${entete}\n${navigation}\n${donnees.file
    .map((contact) => carte(contact, donnees.departement, donnees.page))
    .join("\n")}\n${navigation}`;
}

/**
 * Les liens de page.
 *
 * Ils portent `page` **et** `departement` : sans le second, changer de page renverrait au
 * departement par defaut. Ce sont des liens ordinaires, pas des boutons htmx — une page
 * de revue doit pouvoir se partager, se recharger et se rouvrir apres coup.
 */
function pagination(donnees: DonneesRevue): string {
  if (donnees.pages <= 1) return "";

  const lien = (page: number, libelle: string): string =>
    page === donnees.page
      ? `<span class="discret">${libelle}</span>`
      : `<a href="/revue?departement=${encodeURIComponent(donnees.departement)}&page=${page}">${libelle}</a>`;

  const precedent = Math.max(1, donnees.page - 1);
  const suivant = Math.min(donnees.pages, donnees.page + 1);

  return `<nav class="pages">
  ${lien(1, "« première")}
  ${lien(precedent, "‹ précédente")}
  <span class="discret">page ${nombre(donnees.page)} sur ${nombre(donnees.pages)}</span>
  ${lien(suivant, "suivante ›")}
  ${lien(donnees.pages, "dernière »")}
</nav>`;
}

/**
 * Une carte d'arbitrage.
 *
 * **Le type de la valeur est dit.** Une chaine nue au-dessus de quatre boutons laissait
 * deviner s'il s'agissait d'une adresse, d'un numero, ou du nom de la commune juste
 * en dessous.
 *
 * **Les actions sont groupees par intention**, et non alignees bout a bout : valider ou
 * rejeter ne demande rien, corriger demande une valeur, oublier demande un motif. Un seul
 * rang de boutons et de champs laissait croire que le champ voisin allait avec le bouton
 * precedent.
 *
 * **Aucune des quatre n'est mise en avant.** « Valider » en bouton plein, repete sur dix
 * cartes, fabrique un rang de boutons bleus qui appelle le clic — or l'ecran existe
 * precisement pour que la decision soit prise contact par contact. Seul « Oublier » se
 * distingue, et vers le bas : il supprime definitivement.
 */
function carte(contact: ContactARevoir, departement: string, page: number): string {
  const cible =
    contact.association === null
      ? `${echapperHtml(contact.commune)} <span class="discret">(commune, sans association rattachée)</span>`
      : `${echapperHtml(contact.association)} <span class="discret">— ${echapperHtml(contact.commune)}</span>`;

  const regime =
    contact.kind !== "email"
      ? ""
      : contact.is_generique === 1
        ? '<span class="etiquette bonne">adresse de fonction</span>'
        : contact.is_generique === 0
          ? '<span class="etiquette alerte">adresse nominative — elle désigne une personne</span>'
          : '<span class="etiquette">régime indéterminé</span>';

  const source = lienSur(contact.source_url);
  const lien =
    source === undefined
      ? `<span class="source discret">${echapperHtml(contact.source_url)}</span>`
      : `<a class="source" href="${source}" rel="noreferrer noopener" target="_blank">${source}</a>`;

  // La page voyage avec l'action : sans elle, arbitrer depuis la page 4 renverrait la
  // premiere, et on perdrait sa place a chaque clic.
  const cheminAction = `/revue/${contact.id}?departement=${encodeURIComponent(departement)}&page=${page}`;
  const type = LIBELLE_KIND[contact.kind] ?? contact.kind;

  return `<article class="contact" id="contact-${contact.id}">
  <div class="chapeau">
    <span class="type">${echapperHtml(type)}</span>
    <span class="score">score ${contact.score === null ? "—" : contact.score.toFixed(2)}
      <span class="discret">· lu ${contact.confiance.toFixed(2)}</span></span>
  </div>
  <div class="valeur">${echapperHtml(contact.valeur)}</div>
  <div class="cible">${cible}</div>
  <div class="meta">${regime}<span class="discret">extraction ${echapperHtml(contact.methode_extraction)}</span><span class="discret">vue le ${dateHeure(contact.collected_at)}</span></div>
  ${motifsHtml(contact.score_motifs)}
  <div class="lien-source">Lue sur ${lien}</div>
  <!-- method/action en plus de hx-post : sans JS le formulaire part quand meme, et le
       serveur repond alors par une redirection plutot qu'un fragment. L'ecran de revue
       reste utilisable meme si htmx ne se charge pas. -->
  <form class="arbitrage" method="post" action="${cheminAction}"
        hx-post="${cheminAction}" hx-target="#file" hx-swap="innerHTML">
    <div class="groupe">
      <button type="submit" name="action" value="valide">Valider</button>
      <button type="submit" name="action" value="rejete">Rejeter</button>
    </div>
    <div class="groupe">
      <input type="text" name="valeur" placeholder="valeur corrigée" aria-label="valeur corrigée">
      <button type="submit" name="action" value="corrige">Corriger</button>
    </div>
    <!-- Oublier n'est pas rejeter. Rejeter ecrit un statut, que l'export sait remettre
         et que le run suivant recouvre ; oublier supprime la ligne, efface la copie en
         cache et inscrit l'exclusion. D'ou le motif obligatoire, et la mise en garde
         portee par le titre du bouton. -->
    <div class="groupe">
      <input type="text" name="note" placeholder="motif, obligatoire pour oublier" aria-label="note de revue">
      <button type="submit" name="action" value="oublie" class="danger"
              title="Supprime définitivement ce contact et l'empêche de revenir. Le motif, saisi à côté, est obligatoire.">
        Oublier
      </button>
    </div>
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
    return `<p class="discret">Base ${Number(motifs.base ?? 0).toFixed(2)}, aucun signal retiré.</p>`;
  }
  const lignes = motifs.signaux
    .map(
      (signal) =>
        `<li>${echapperHtml(signal.signal)} × ${Number(signal.facteur).toFixed(2)} — ${echapperHtml(signal.detail)}</li>`,
    )
    .join("");
  return `<ul>${lignes}</ul>`;
}
