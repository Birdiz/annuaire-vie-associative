/**
 * Ecran d'export — la sortie de l'annuaire, en CSV.
 *
 * Le fichier est produit par `lignesCsv` (lot 5), sans variante propre a l'UI : deux
 * chemins d'export produiraient tot ou tard deux fichiers differents, et la provenance
 * qui voyage avec chaque ligne n'aurait plus de garantie unique. Le choix du profil
 * (ADR-032) est un parametre de cette meme fonction, pas un second chemin.
 *
 * Cet ecran est le seul endroit ou quelqu'un lira ce que le profil simple abandonne. Le
 * README ne sera pas ouvert au moment ou le fichier part ; cette page, si.
 */

import { echapperHtml, nombre, pluriel, banniereRun, barre } from "../rendu.ts";
import type { Progression } from "./collecter.ts";
import type { ProfilExport } from "../../export/csv.ts";
import type { EtatCollecte } from "../rendu.ts";

export type DonneesExport = {
  departement: string;
  scoreMin: string;
  avecRejetes: boolean;
  profil: ProfilExport;
  lignes: number;
  /** Contacts que le profil simple ecarte faute de nom de structure. */
  sansNom: number;
  horsSujet: number;
  rejetes: number;
  /** Un export pris au milieu d'un run livre un annuaire a moitie note. */
  collecte: EtatCollecte;
  /**
   * Les premieres lignes du fichier, tirees du **meme** generateur que lui (`cellulesCsv`) :
   * l'en-tete, puis au plus trois lignes. Un apercu tire d'une autre requete montrerait un
   * jour des lignes que le fichier ne contient pas.
   */
  apercu: { colonnes: readonly string[]; lignes: readonly (readonly string[])[] };
  /** Ou en est la collecte qui suspend l'export, pour le dire au lieu de faire attendre a l'aveugle. */
  progression: Progression | undefined;
};

export function ecranExporter(donnees: DonneesExport): string {
  const dept = encodeURIComponent(donnees.departement);
  const simple = donnees.profil === "simple";

  // Exporter pendant un run livre un fichier que la fin du run rendrait faux : les
  // contacts arrives apres manquent, ceux qui ne sont pas encore notes sortent sans
  // score, et le seuil ne veut plus rien dire. Le bouton est donc retire — pas
  // seulement grise : un bouton desactive invite a chercher comment l'activer.
  const bloque = donnees.collecte.kind === "pilote";
  if (bloque) return suspendu(donnees);

  const banniere = banniereRun(
    donnees.collecte,
    "Les chiffres ci-dessous bougent encore, et un fichier pris maintenant serait incomplet.",
  );

  return `<h1>Export CSV</h1>
${banniere}
<!-- L'aperçu suit les réglages sans attendre de bouton : le volume, l'aperçu, ce qui reste
     sur l'établi et l'avertissement dépendent du profil, et « Télécharger » envoie le profil
     coché, lui. Un écran resté sur l'ancien profil annonçait un fichier et en livrait un
     autre. Seule la colonne de sortie est échangée, pour ne pas voler le focus du réglage.
     autocomplete="off" : un navigateur qui restaure les cases au rechargement les
     désaccorderait de nouveau de ce que le serveur a rendu. -->
<form method="get" action="/export.csv" class="grille-export" autocomplete="off"
      hx-get="/exporter" hx-trigger="change, input changed delay:500ms from:#export-score-min"
      hx-target="#export-sortie" hx-select="#export-sortie" hx-swap="outerHTML" hx-replace-url="true">
  <input type="hidden" name="departement" value="${echapperHtml(donnees.departement)}">
  <div class="export-reglages">
    <fieldset class="profils">
      <legend>Contenu du fichier</legend>
      <label class="profil">
        <input type="radio" name="profil" value="simple"${simple ? " checked" : ""}>
        <span><strong>Fichier simple</strong> — 6 colonnes, une ligne par structure.
        <span class="discret">Sans provenance, ne nomme jamais une personne. Département, commune,
        nom, type, téléphone, e-mail ; plusieurs numéros ou adresses d'une même structure sont
        réunis dans la cellule, séparés par « / ». Le type est <code>sportive</code>,
        <code>culturelle</code>, <code>sociale</code>, <code>comite_des_fetes</code>,
        <code>centre_de_loisirs</code> ou <code>diverses</code> ; il reste vide quand rien ne
        l'établit, plutôt que de deviner.</span></span>
      </label>
      <label class="profil">
        <input type="radio" name="profil" value="complet"${simple ? "" : " checked"}>
        <span><strong>Fichier complet</strong> — toutes les colonnes, une ligne par contact.
        <span class="discret">Avec l'adresse de la page source, la date de lecture, la méthode
        d'extraction et le score. C'est le fichier auditable : lui seul permet de remonter à
        l'origine d'une donnée, et de distinguer une adresse de service d'une adresse
        nominative.</span></span>
      </label>
    </fieldset>
    <p>
      <label>Score minimum
        <input type="text" id="export-score-min" name="score-min" value="${echapperHtml(donnees.scoreMin)}"
               placeholder="0.6" size="6">
      </label>
      <span class="discret">vide = tous les contacts, notés ou non</span>
    </p>
    <p>
      <label class="bascule">
        <input type="checkbox" name="avec-rejetes" value="1"${donnees.avecRejetes ? " checked" : ""}>
        Inclure les ${nombre(donnees.rejetes)} contacts rejetés en relecture
      </label>
    </p>
    <!-- formaction : sans JavaScript, ce bouton recharge l'ecran avec les reglages choisis,
         et l'apercu suit. Le bouton de telechargement, lui, part vers le fichier. -->
    <p><button type="submit" formaction="/exporter">Mettre à jour l'aperçu</button></p>
  </div>

  <div class="export-sortie" id="export-sortie">
    ${volumetrie(donnees, simple)}
    ${restes(donnees, simple)}
    ${apercu(donnees, simple)}
    <!-- L'avertissement est ici, et pas seulement dans le README : c'est le moment ou le
         fichier quitte l'outil, donc le seul ou il sera lu par quelqu'un qui est sur le point
         d'en avoir besoin. -->
    <section class="avant-telecharger">
      <h2>Avant de télécharger</h2>
      ${avertissement(simple)}
      <p><button type="submit" class="primaire">Télécharger le fichier</button></p>
    </section>
    <p class="discret">
    Équivalent en ligne de commande :
    <code>annuaire exporter --departement ${echapperHtml(donnees.departement)}${
        simple ? " --profil simple" : ""
      }${donnees.scoreMin === "" ? "" : ` --score-min ${echapperHtml(donnees.scoreMin)}`}${
        donnees.avecRejetes ? " --avec-rejetes" : ""
      } --fichier annuaire-${echapperHtml(donnees.departement)}.csv</code>
    <br>Sans <code>--profil</code>, la ligne de commande produit le fichier complet.
    </p>
  </div>
</form>



<p class="discret">Les contacts rejetés en relecture sont exclus par défaut : un arbitrage humain
qui ne changerait rien au fichier livré ne servirait à rien. <a href="/relire?departement=${dept}">Aller à la relecture</a>.</p>

<p class="discret">Le fichier contient <strong>tous les numéros fixes</strong>. Seuls les
mobiles 06/07 dépendent du réglage de la collecte, et l'export, lui, ne filtre aucun numéro :
ce qui a été collecté sort.</p>
`;
}

/** L'export attend la fin de la collecte, et dit ou elle en est. */
function suspendu(donnees: DonneesExport): string {
  const dept = encodeURIComponent(donnees.departement);
  const avancement = donnees.progression?.avancement;
  return `<h1>Export CSV</h1>
${banniereRun(
  donnees.collecte,
  "L'export est suspendu jusqu'à la fin : un fichier pris maintenant sortirait sans les contacts à venir, et sans le score de ceux qui ne sont pas encore notés.",
)}
<section class="carte export-suspendu">
  <h2>L'export attend la fin de la collecte</h2>
  <p>La collecte écrit encore dans la base. Exporter maintenant donnerait un fichier pris à
  mi-chemin. Il se débloque dès qu'elle se termine, ou si vous l'arrêtez.</p>
  ${avancement === undefined ? "" : barre(avancement.faits, avancement.total, avancement.unite, avancement.phrase)}
  <p class="discret">Le bouton revient dès que la collecte est finie ou arrêtée. Rien n'est perdu
  entre-temps : l'export lit la base, il ne la consomme pas.</p>
  <p><a class="bouton" href="/relire?departement=${dept}">Relire en attendant</a>
  <a href="/collecter?departement=${dept}">Voir la collecte</a></p>
</section>`;
}

/**
 * Ce qui reste sur l'etabli : les contacts que le fichier ne portera pas, par motif. Les
 * chiffres sont ceux que l'outil sait deja produire — aucun n'est recompte ici.
 */
function restes(donnees: DonneesExport, simple: boolean): string {
  const motifs: [number, string][] = [];
  if (simple) {
    motifs.push([donnees.sansNom, "sans nom de structure"]);
    motifs.push([donnees.horsSujet, "nommés, mais rien n'indique une structure de la vie associative"]);
  }
  if (!donnees.avecRejetes) motifs.push([donnees.rejetes, "rejetés à la relecture"]);
  const retenus = motifs.filter(([n]) => n > 0);
  if (retenus.length === 0) return "";
  const total = retenus.reduce((somme, [n]) => somme + n, 0);
  return `<div class="restes">
  <h3>${nombre(total)} contact${pluriel(total)} reste${total >= 2 ? "nt" : ""} sur l'établi</h3>
  <dl>${retenus.map(([n, motif]) => `<div><dt>${echapperHtml(motif)}</dt><dd>${nombre(n)}</dd></div>`).join("")}</dl>
  <p class="discret">Ils restent en base${simple ? ", et le fichier complet les contient" : ""}.</p>
</div>`;
}

/**
 * L'apercu : les premieres lignes du fichier, telles qu'il les portera. Chaque cellule vient
 * du crawl et passe par `echapperHtml`.
 */
function apercu(donnees: DonneesExport, simple: boolean): string {
  const { colonnes, lignes } = donnees.apercu;
  if (lignes.length === 0) return '<p class="discret">Aucune ligne ne sortirait avec ces réglages.</p>';
  return `<div class="apercu">
  <p class="discret">Aperçu des ${nombre(lignes.length)} première${pluriel(lignes.length)} ligne${pluriel(lignes.length)}${
    simple ? "" : `, ${nombre(colonnes.length)} colonnes`
  }</p>
  <div class="defilement">
  <table>
  <thead><tr>${colonnes.map((nom) => `<th><code>${echapperHtml(nom)}</code></th>`).join("")}</tr></thead>
  <tbody>
${lignes.map((cellules) => `<tr>${cellules.map((cellule) => `<td>${echapperHtml(cellule)}</td>`).join("")}</tr>`).join("\n")}
  </tbody>
  </table>
  </div>
</div>`;
}

/**
 * Ce que le fichier contiendra. Ce qu'il laisse derriere est dit a cote, par `restes` : le
 * nombre d'ecartes n'est pas un detail d'affichage — sans lui, la personne qui compare les
 * deux fichiers voit des lignes disparaitre sans explication et conclut a une perte de
 * donnees. C'est a l'outil de dire ce qu'il n'a pas mis.
 */
function volumetrie(donnees: DonneesExport, simple: boolean): string {
  const unite = simple ? "une par structure" : "une par contact";
  const entete = `<p class="volume"><strong>${nombre(donnees.lignes)}</strong> ligne${pluriel(donnees.lignes)}
vont sortir <span class="discret">— ${unite}</span></p>`;

  if (!simple) {
    return `${entete}
<p class="discret">Chaque ligne porte son URL source, sa date de collecte, sa méthode
d'extraction et son score : un export qui les laisserait derrière reproduirait le problème que
l'outil résout. La valeur corrigée en relecture, quand il y en a une, sort à côté de la valeur
lue.</p>`;
  }

  return `${entete}
<p class="discret">Ce fichier <strong>ne porte pas la provenance</strong> : pour remonter à la
page d'origine d'une adresse, à sa date de lecture ou à son score, choisissez le fichier
complet.</p>
<p class="discret">La colonne <code>type</code> est renseignée par la normalisation : si elle
est vide partout, c'est qu'elle n'a pas encore tourné —
<code>annuaire normaliser --departement ${echapperHtml(donnees.departement)}</code>.</p>`;
}

function avertissement(simple: boolean): string {
  const regime = simple
    ? `Ce fichier <strong>ne distingue pas</strong> les adresses de fonction de celles qui
désignent une personne, et peut réunir les deux dans une même cellule. Le fichier complet
porte cette distinction en colonne <code>regime</code>. <strong>La colonne « nom » nomme
une structure, jamais une personne</strong> : quand la page ne citait que le président à
côté d'une adresse, l'outil cherche le nom de la structure dans sa fiche, et s'il ne le
trouve pas, le contact est écarté — compté ci-dessus — et reste dans le fichier complet. Le
repérage s'appuie sur une liste de prénoms : un prénom rare peut encore passer.`
    : `La colonne <code>regime</code> distingue les adresses de fonction
(<code>generique</code>) de celles qui désignent une personne (<code>nominatif</code>) ;
<code>indetermine</code> signale un cas que l'outil refuse de trancher.`;

  // Le nom deduit d'un domaine est une inference. Elle est signalee dans le fichier
  // complet, par la colonne « nom_source » ; ici, elle doit l'etre en toutes lettres,
  // parce que le profil simple, lui, ne la porte pas.
  const noms = simple
    ? ` Le nom affiché peut avoir été <strong>déduit du domaine de l'adresse</strong> quand
ni le RNA ni la page ne l'ont donné : c'est une inférence, pas une lecture. La colonne
<code>nom_source</code> du fichier complet dit, pour chaque contact, d'où le nom provient.`
    : "";

  return `<p class="avertissement">
<strong>Ce fichier contient des données personnelles, et vous en êtes responsable de
traitement.</strong> ${regime}${noms} Avant tout usage,
vous devez informer les personnes concernées au titre de l'article 14 du RGPD — collecte
indirecte, dans un délai d'un mois ou dès la première communication. Cet outil ne prospecte
pas, et ce fichier n'est pas un fichier de prospection.
</p>`;
}
