/**
 * Station Relire (ADR-041) — une carte a la fois, la preuve a cote de la decision.
 *
 * **Les moins surs d'abord.** L'ordre n'est pas cosmetique : c'est la que la decision
 * humaine apporte quelque chose. Les 138 adresses cassees par un CMS que l'ADR-017 a
 * trouvees remontent ainsi d'elles-memes en tete de file — notees zero, elles sont
 * exactement le cas ou desobfusquer *a la main* repond a la question que l'ADR laissait
 * ouverte, sans trancher la desobfuscation automatique.
 *
 * **Le score s'explique, et la preuve se montre.** La carte deplie les motifs persistes a
 * la notation, et l'extrait de la page ou la valeur a ete lue, surlignee (ADR-040). Un
 * score qu'on ne peut pas expliquer n'est pas revisable ; une valeur qu'on ne peut pas
 * replacer dans sa page ne se juge pas.
 *
 * **Une carte, pas dix.** Dix cartes et quarante boutons appelaient le survol ; la file a
 * gauche dit ce qui reste, la carte au centre est la seule decision a l'ecran. Le mode
 * liste reste offert a qui veut parcourir, sans decision groupee.
 */

import {
  echapperHtml,
  lienSur,
  nombre,
  pluriel,
  banniereRun,
  dateHeure,
  barre,
  jauge,
  motConfiance,
  decimal,
} from "../rendu.ts";
import type { EtatCollecte } from "../rendu.ts";
import type { ContactARevoir, DistributionRevue } from "../requetes.ts";
import type { Motifs } from "../../normalisation/score.ts";

export type ModeRelire = "carte" | "liste";

export type DonneesRelire = {
  departement: string;
  mode: ModeRelire;
  /**
   * En mode carte, le haut de la file, pour la colonne de gauche ; en mode liste, la page
   * affichee.
   */
  file: readonly ContactARevoir[];
  /** La carte ouverte, en mode carte : celle demandee par son lien, ou la premiere de la file. */
  courant: ContactARevoir | undefined;
  distribution: DistributionRevue;
  /** Message d'un arbitrage refuse, a afficher en tete. */
  refus?: string | undefined;
  /**
   * Ce qui avait ete tape quand l'arbitrage a ete refuse, rendu dans les champs de la
   * carte : un refus pour une virgule ne doit pas faire retaper une adresse entiere. Il
   * voyage dans le corps de la reponse, jamais dans l'URL.
   */
  saisie?: { valeur: string; note: string } | undefined;
  /**
   * Page de la liste d'ou la carte a ete ouverte (« Corriger… »), pour y revenir apres la
   * decision. Absent quand la carte a ete ouverte en mode carte.
   */
  retourListe?: number | undefined;
  /** Une collecte en cours change la file sous les yeux de qui arbitre. */
  collecte: EtatCollecte;
  /** Page affichee en mode liste, 1-based, deja bornee par le routeur. */
  page: number;
  /** Nombre de pages de la liste, au moins 1. */
  pages: number;
};

/**
 * L'en-tete de l'ecran, et il n'est pas decoratif.
 *
 * L'ecran affichait une valeur nue au-dessus de quatre boutons, sans jamais dire de quoi
 * il s'agissait ni ce qui etait attendu du lecteur. Le rappel de ce qu'est une carte reste
 * visible ; la legende des quatre boutons, elle, se replie dans la carte.
 */
function introduction(): string {
  return `<p class="intro">Chaque carte porte <strong>une valeur de contact lue sur une page de
site communal</strong> — une adresse email ou un numéro de téléphone — que l'outil n'a pas su
valider seul. <strong>Les moins sûres d'abord</strong> : c'est là qu'un arbitrage humain apporte
quelque chose.</p>`;
}

function legende(): string {
  return `<details class="legende">
  <summary>Que font les quatre boutons ?</summary>
  <dl>
    <dt>Valider</dt><dd>La valeur est bonne. Elle pourra sortir dans l'export, selon le score
      minimum choisi.</dd>
    <dt>Rejeter</dt><dd>La valeur est fausse ou hors sujet. Elle reste en base mais l'export
      l'exclut par défaut.</dd>
    <dt>Corriger</dt><dd>La valeur lue est presque bonne — une adresse cassée par un site,
      typiquement. La version corrigée sort à côté de la version lue, et repasse à la notation.</dd>
    <dt>Oublier</dt><dd>Suppression définitive : la ligne, sa copie dans le cache, et une
      exclusion qui l'empêche de revenir à la collecte suivante. Le motif est obligatoire.</dd>
  </dl>
</details>`;
}

export function ecranRelire(donnees: DonneesRelire): string {
  const dept = encodeURIComponent(donnees.departement);
  const onglet = (mode: ModeRelire, libelle: string): string =>
    donnees.mode === mode
      ? `<span class="actif" aria-current="true">${libelle}</span>`
      : `<a href="/relire?departement=${dept}${mode === "liste" ? "&amp;mode=liste" : ""}">${libelle}</a>`;

  return `<div class="entete-relire">
  <h1>Relire</h1>
  <nav class="bascule-mode" aria-label="Affichage">${onglet("carte", "Carte")}${onglet("liste", "Liste")}</nav>
</div>
${introduction()}
<section id="atelier">
${fragmentAtelier(donnees)}
</section>`;
}

/** Ce qu'est la valeur affichee. Sans cette etiquette, la carte montre une chaine nue. */
const LIBELLE_KIND: Record<string, string> = {
  email: "Adresse email",
  phone: "Numéro de téléphone",
};

/** Cible des swaps htmx : chaque arbitrage renvoie l'atelier recalcule — la file et la carte suivante. */
export function fragmentAtelier(donnees: DonneesRelire): string {
  const { distribution: d } = donnees;

  const refus =
    donnees.refus === undefined ? "" : `<p class="refus" role="alert" tabindex="-1">${echapperHtml(donnees.refus)}</p>\n`;

  // `aRevoir` compte aussi les lignes que l'etape [8] n'a pas encore notees, et celles-la
  // n'entrent pas dans la file. Afficher le total brut a cote de « Rien a arbitrer »
  // donnait deux phrases qui se contredisaient a l'ecran — 418 a arbitrer, rien a
  // arbitrer. C'est le nombre de contacts *prets* qui compte ici.
  const prets = Math.max(0, d.aRevoir - d.nonNotes);

  const compteur =
    `<p class="discret compteur-relecture">${nombre(prets)} prêt${pluriel(prets)} à arbitrer · ${nombre(d.nonNotes)} en attente de notation · ` +
    `${nombre(d.valides)} validés · ${nombre(d.rejetes)} rejetés · ${nombre(d.corriges)} corrigés</p>`;

  // Depuis l'ADR-039 le crawl note a mesure : ces lignes ne sont plus que celles d'une base
  // collectee par une version anterieure, avant sa normalisation.
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
    "La file se remplit au fur et à mesure, et ce qui est arbitré maintenant reste arbitré. Les scores " +
      "restent provisoires jusqu'à la fin : le domaine des adresses n'est vérifié qu'à la normalisation.",
  );

  const entete = `${refus}${banniere}\n${compteur}\n${attente}\n${aRenoter}`;

  if (donnees.mode === "liste") return `${entete}\n${atelierListe(donnees)}`;

  if (donnees.courant === undefined) return `${entete}\n${fileVide(donnees, prets)}`;

  return `${entete}
<div class="atelier">
${colonneFile(donnees, prets)}
${carte(donnees.courant, donnees)}
</div>`;
}

/** Trois raisons de n'avoir rien a montrer, et elles n'appellent pas la meme suite. */
function fileVide(donnees: DonneesRelire, prets: number): string {
  const d = donnees.distribution;
  if (prets === 0 && d.nonNotes === 0 && d.arbitres > 0 && donnees.collecte.kind === "inactif") {
    const total = d.valides + d.rejetes + d.corriges;
    return `<div class="carte file-vide">
  <h2>Plus rien à relire</h2>
  <p>Les ${nombre(total)} contacts du département ${echapperHtml(donnees.departement)} ont reçu une
  décision. Les prochaines collectes rempliront à nouveau la file.</p>
  <dl class="compteurs">
    <div><dt>validés</dt><dd>${nombre(d.valides)}</dd></div>
    <div><dt>rejetés</dt><dd>${nombre(d.rejetes)}</dd></div>
    <div><dt>corrigés</dt><dd>${nombre(d.corriges)}</dd></div>
  </dl>
  <a class="bouton" href="/exporter?departement=${encodeURIComponent(donnees.departement)}">Aller à l'export</a>
</div>`;
  }
  const explication =
    donnees.collecte.kind !== "inactif"
      ? "Rien à arbitrer pour l'instant : la collecte en cours n'a pas encore trouvé de contact. Cet écran se remplira tout seul."
      : d.nonNotes > 0
        ? "Rien à arbitrer tant que la notation n'est pas passée sur les contacts ci-dessus."
        : "Rien à arbitrer pour ce département.";
  return `<p>${explication}</p>`;
}

/**
 * La file, a gauche : ce qui reste, dans l'ordre ou on le relira. Chaque entree est un
 * lien ordinaire vers sa carte — une carte se partage, se recharge et se rouvre.
 */
function colonneFile(donnees: DonneesRelire, prets: number): string {
  const d = donnees.distribution;
  const dept = encodeURIComponent(donnees.departement);
  const relus = d.arbitres;
  const items = donnees.file
    .map((contact) => {
      const actuel = contact.id === donnees.courant?.id;
      const cible = contact.association ?? `${contact.commune}, sans association rattachée`;
      return `<li><a class="item${actuel ? " actuel" : ""}" href="/relire?departement=${dept}&amp;contact=${contact.id}"${
        actuel ? ' aria-current="true"' : ""
      }><span class="type">${echapperHtml(LIBELLE_KIND[contact.kind] ?? contact.kind)}</span>
<span class="valeur-courte">${echapperHtml(contact.valeur)}</span>
<span class="cible-courte">${echapperHtml(cible)}</span>
<span class="discret">score ${contact.score === null ? "—" : decimal(contact.score)}</span></a></li>`;
    })
    .join("\n");
  const autres = prets - donnees.file.length;

  return `<aside class="file-relecture" aria-label="File de relecture">
  <h2>File de relecture <span class="discret">${nombre(prets)} restant${pluriel(prets)}</span></h2>
  ${relus + prets === 0 ? "" : barre(relus, relus + prets, "relus")}
  <p class="discret">Les moins sûrs d'abord</p>
  <ol class="file-items">
${items}
  </ol>
  ${autres > 0 ? `<p class="discret">… ${nombre(autres)} autre${pluriel(autres)}</p>` : ""}
</aside>`;
}

/**
 * Le chemin d'une decision : la page ou le mode voyagent avec l'action, sans quoi arbitrer
 * depuis la page 4 de la liste renverrait a la premiere, et on perdrait sa place a chaque
 * clic.
 *
 * En mode carte, le contact voyage aussi : un refus rend la page sur place, et sans lui le
 * routeur rouvrirait la premiere carte de la file — le message d'erreur se serait affiche
 * au-dessus d'un autre contact que celui qu'on venait de corriger. Apres une decision
 * acceptee, le contact n'est plus a relire, et le routeur passe de lui-meme au suivant.
 */
function cheminAction(contact: ContactARevoir, donnees: DonneesRelire): string {
  const dept = encodeURIComponent(donnees.departement);
  const suite =
    donnees.mode === "liste"
      ? `&mode=liste&page=${donnees.page}`
      : `&contact=${contact.id}${donnees.retourListe === undefined ? "" : `&retour=liste&page=${donnees.retourListe}`}`;
  return `/relire/${contact.id}?departement=${dept}${suite}`;
}

/**
 * La carte de relecture.
 *
 * **Le type de la valeur est dit.** Une chaine nue au-dessus de quatre boutons laissait
 * deviner s'il s'agissait d'une adresse, d'un numero, ou du nom de la commune juste
 * en dessous.
 *
 * **Valider, Rejeter et Corriger ont le meme poids.** Un bouton plein appelle le clic, or
 * l'ecran existe precisement pour que la decision soit prise contact par contact. Seul
 * « Oublier » se distingue, et vers le bas : replie sous la carte, il supprime
 * definitivement, et demande son motif.
 */
function carte(contact: ContactARevoir, donnees: DonneesRelire): string {
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

  const chemin = cheminAction(contact, donnees);
  // Une carte ouverte depuis la liste y renvoie : par une redirection ordinaire, puisque
  // c'est l'ecran entier qui change de mode, et non le seul atelier.
  const htmx = donnees.retourListe === undefined;
  // La saisie n'est rendue que sur la carte qu'elle visait.
  const saisie = donnees.refus === undefined ? undefined : donnees.saisie;
  const type = LIBELLE_KIND[contact.kind] ?? contact.kind;
  const provisoire = contact.score_version === null ? '<span class="provisoire">provisoire, domaine pas encore vérifié</span>' : "";

  return `<article class="contact carte-relecture" id="contact-${contact.id}">
  <div class="carte-corps">
  <div class="carte-lecture">
    <div class="chapeau"><span class="type">${echapperHtml(type)}</span>${
      donnees.retourListe === undefined
        ? ""
        : ` <a class="retour-liste" href="/relire?departement=${encodeURIComponent(donnees.departement)}&amp;mode=liste&amp;page=${donnees.retourListe}">← retour à la liste</a>`
    }</div>
    <div class="valeur" tabindex="-1">${echapperHtml(contact.valeur)}</div>
    <div class="cible">${cible}</div>
    ${regime === "" ? "" : `<div class="regime">${regime}</div>`}
    <div class="confiance">
      ${jauge(contact.score)}
      <span class="score">score ${contact.score === null ? "—" : decimal(contact.score)}
        <span class="discret">· lu ${decimal(contact.confiance)}</span></span>
      <span class="mot">confiance ${motConfiance(contact.score)}</span>
      ${provisoire}
    </div>
    ${motifsHtml(contact.score_motifs)}
  </div>
  <div class="carte-preuve">
    ${preuve(contact.extrait)}
    <div class="lien-source">Lue sur ${lien}
      <span class="discret">vue le ${dateHeure(contact.collected_at)} · méthode : ${echapperHtml(contact.methode_extraction)}</span></div>
  </div>
  </div>
  <!-- Trois formulaires et non un : Entree dans un champ envoie le formulaire par son
       *premier* bouton. D'un seul tenant, une correction ou un motif d'effacement valides
       d'une Entree partaient en « Valider » — la valeur lue validee, l'effacement jamais
       fait, et la carte suivante a l'ecran comme si tout s'etait bien passe. Chaque champ
       a donc son formulaire, dont le seul bouton est le sien ; l'attribut form garde
       les boutons a leur place. -->
  ${formulaire(`decision-${contact.id}`, chemin, htmx)}
  ${formulaire(`correction-${contact.id}`, chemin, htmx)}
  <div class="arbitrage">
    <div class="decisions">
      <button type="submit" form="decision-${contact.id}" name="action" value="valide" data-raccourci="v">Valider <kbd>V</kbd></button>
      <button type="submit" form="decision-${contact.id}" name="action" value="rejete" data-raccourci="r">Rejeter <kbd>R</kbd></button>
      <button type="submit" form="correction-${contact.id}" name="action" value="corrige" data-raccourci="c"
              data-champ="valeur-${contact.id}">Corriger <kbd>C</kbd></button>
    </div>
    <div class="correction">
      <label for="valeur-${contact.id}">Valeur corrigée, pour « Corriger »</label>
      <input type="text" id="valeur-${contact.id}" form="correction-${contact.id}" name="valeur" required
             autocomplete="off" placeholder="valeur corrigée" value="${echapperHtml(saisie?.valeur)}">
    </div>
    ${legende()}
    <!-- Oublier n'est pas rejeter. Rejeter ecrit un statut, que l'export sait remettre
         et que le run suivant recouvre ; oublier supprime la ligne, efface la copie en
         cache et inscrit l'exclusion. D'ou le motif obligatoire, et le repli. -->
    <details class="oubli"${saisie?.note ? " open" : ""}>
      <summary>Oublier ce contact — effacement définitif</summary>
      <p class="discret">Supprime le contact, efface la copie de la page gardée sur cette machine,
      et l'empêche de revenir à la collecte suivante. Sans retour.</p>
      <form class="groupe" method="post" action="${echapperHtml(chemin)}"${htmxCarte(chemin, htmx)}>
        <input type="text" name="note" required autocomplete="off" placeholder="motif, obligatoire pour oublier"
               aria-label="motif de l'effacement" value="${echapperHtml(saisie?.note)}">
        <button type="submit" name="action" value="oublie" class="danger"
                title="Supprime définitivement ce contact et l'empêche de revenir. Le motif, saisi à côté, est obligatoire.">
          Oublier
        </button>
      </form>
    </details>
  </div>
</article>`;
}

/**
 * `method`/`action` en plus de `hx-post` : sans JS le formulaire part quand meme, et le
 * serveur repond alors par une redirection plutot qu'un fragment. L'ecran reste utilisable
 * meme si htmx ne se charge pas.
 */
function htmxCarte(chemin: string, htmx: boolean): string {
  return htmx ? ` hx-post="${echapperHtml(chemin)}" hx-target="#atelier" hx-swap="innerHTML"` : "";
}

/** Un formulaire vide, auquel ses boutons et son champ se rattachent par `form="…"`. */
function formulaire(id: string, chemin: string, htmx: boolean): string {
  return `<form id="${id}" method="post" action="${echapperHtml(chemin)}"${htmxCarte(chemin, htmx)}></form>`;
}

/**
 * La preuve (ADR-040) : le texte de la page autour de la valeur, la cible surlignee. Les
 * trois morceaux viennent du crawl, donc d'un site que nous ne controlons pas : chacun est
 * echappe, et seul le `<mark>` est de nous.
 */
function preuve(brut: string | null): string {
  if (brut === null) return "";
  let extrait: { avant?: unknown; cible?: unknown; apres?: unknown };
  try {
    extrait = JSON.parse(brut) as typeof extrait;
  } catch {
    return "";
  }
  if (typeof extrait.cible !== "string" || extrait.cible === "") return "";
  return `<figure class="preuve">
  <figcaption>La preuve — extrait de la page</figcaption>
  <blockquote>${echapperHtml(extrait.avant)}<mark>${echapperHtml(extrait.cible)}</mark>${echapperHtml(extrait.apres)}</blockquote>
</figure>`;
}

/**
 * Le mode liste : pour parcourir. Valider et Rejeter s'y font en ligne ; Corriger et
 * Oublier ouvrent la carte, parce que la correction et l'effacement demandent la preuve
 * sous les yeux. Pas de decision groupee.
 */
function atelierListe(donnees: DonneesRelire): string {
  if (donnees.file.length === 0) return fileVide(donnees, 0);
  const dept = encodeURIComponent(donnees.departement);
  const lignes = donnees.file
    .map((contact) => {
      const chemin = cheminAction(contact, donnees);
      const cible = contact.association ?? `${contact.commune}, sans association rattachée`;
      return `<tr id="contact-${contact.id}">
  <td><span class="valeur-courte">${echapperHtml(contact.valeur)}</span><br><span class="type">${echapperHtml(LIBELLE_KIND[contact.kind] ?? contact.kind)}</span></td>
  <td>${echapperHtml(cible)}<br><span class="discret">${echapperHtml(contact.commune)}</span></td>
  <td>${jauge(contact.score)} <span class="discret">${contact.score === null ? "—" : decimal(contact.score)} · ${motConfiance(contact.score)}</span></td>
  <td class="source-courte">${echapperHtml(domaine(contact.source_url))}</td>
  <td><form class="arbitrage-ligne" method="post" action="${echapperHtml(chemin)}" hx-post="${echapperHtml(chemin)}" hx-target="#atelier" hx-swap="innerHTML">
    <button type="submit" name="action" value="valide">Valider</button>
    <button type="submit" name="action" value="rejete">Rejeter</button>
    <a href="/relire?departement=${dept}&amp;contact=${contact.id}&amp;retour=liste&amp;page=${donnees.page}">Corriger…</a>
  </form></td>
</tr>`;
    })
    .join("\n");

  return `${pagination(donnees)}
<table class="liste-relecture">
<thead><tr><th>Contact</th><th>Association · commune</th><th>Confiance</th><th>Lue sur</th><th>Décision</th></tr></thead>
<tbody>
${lignes}
</tbody>
</table>
<p class="discret">« Corriger » et « Oublier » ouvrent la carte du contact : la correction et
l'effacement demandent la preuve sous les yeux. Pas de décision groupée.</p>
${pagination(donnees)}`;
}

function domaine(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * Les liens de page du mode liste.
 *
 * Ils portent `page` **et** `departement` : sans le second, changer de page renverrait au
 * departement par defaut. Ce sont des liens ordinaires, pas des boutons htmx — une page
 * de relecture doit pouvoir se partager, se recharger et se rouvrir apres coup.
 */
function pagination(donnees: DonneesRelire): string {
  if (donnees.pages <= 1) return "";

  const lien = (page: number, libelle: string): string =>
    page === donnees.page
      ? `<span class="discret">${libelle}</span>`
      : `<a href="/relire?departement=${encodeURIComponent(donnees.departement)}&amp;mode=liste&amp;page=${page}">${libelle}</a>`;

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
 * Ce que chaque signal veut dire, en francais d'ecran. Les motifs sont ecrits par la
 * notation dans la langue des identifiants ; un detail inconnu — un bareme plus recent que
 * cette liste — s'affiche tel quel plutot que de disparaitre.
 */
const DETAIL_LISIBLE: Record<string, string> = {
  "MX non verifie": "domaine pas encore vérifié",
  "le domaine n'annonce aucun MX": "le domaine ne reçoit pas de courrier",
  "adresse nominative (§4.7)": "adresse nominative : elle désigne une personne",
  "regime indetermine": "régime indéterminé",
  "rattache a la commune seule": "rattaché à la commune seule, sans association",
  "page ecartee par le pre-filtre [4]": "la page parlait peu de vie associative",
  "page non jugee par le pre-filtre [4]": "la page n'a pas été jugée",
  "la valeur n'a pas la forme attendue": "la valeur n'a pas la forme d'une adresse ou d'un numéro",
  "valeur corrigee en revue humaine": "valeur corrigée en relecture",
};

/**
 * Les motifs sont du JSON ecrit par la notation. Un JSON illisible n'est pas une raison
 * de ne pas rendre la carte : la relecture doit rester possible meme sur une ligne dont
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
    return `<p class="discret">Lecture de base ${decimal(Number(motifs.base ?? 0))}, rien n'a fait baisser le score.</p>`;
  }
  const lignes = motifs.signaux
    .map((signal) => {
      const detail = Object.hasOwn(DETAIL_LISIBLE, signal.detail) ? DETAIL_LISIBLE[signal.detail] : signal.detail;
      return `<li><span class="facteur">× ${decimal(Number(signal.facteur))}</span> ${echapperHtml(detail)}</li>`;
    })
    .join("");
  return `<div class="motifs">
  <p class="discret">Lecture de base ${decimal(Number(motifs.base ?? 0))}, puis :</p>
  <ul>${lignes}</ul>
</div>`;
}
