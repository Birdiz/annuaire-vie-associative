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

import { echapperHtml, nombre, banniereRun } from "../rendu.ts";
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
  rejetes: number;
  /** Un export pris au milieu d'un run livre un annuaire a moitie note. */
  collecte: EtatCollecte;
};

export function ecranExport(donnees: DonneesExport): string {
  const dept = encodeURIComponent(donnees.departement);
  const simple = donnees.profil === "simple";

  // Exporter pendant un run livre un fichier que la fin du run rendrait faux : les
  // contacts arrives apres manquent, ceux qui ne sont pas encore notes sortent sans
  // score, et le seuil ne veut plus rien dire. Le bouton est donc retire — pas
  // seulement grise : un bouton desactive invite a chercher comment l'activer.
  const bloque = donnees.collecte.kind === "pilote";
  const banniere = banniereRun(
    donnees.collecte,
    bloque
      ? "L'export est suspendu jusqu'à la fin : un fichier pris maintenant sortirait sans les contacts à venir, et sans le score de ceux qui ne sont pas encore notés."
      : "Les chiffres ci-dessous bougent encore, et un fichier pris maintenant serait incomplet.",
  );

  const commande = bloque
    ? `<p class="discret">Le bouton revient dès que la collecte est finie ou arrêtée. Rien n'est perdu
       entre-temps : l'export lit la base, il ne la consomme pas.</p>`
    : `<p><button type="submit" class="primaire">Télécharger le fichier</button></p>`;

  return `<h2>Export CSV</h2>
${banniere}
<form method="get" action="/export.csv">
  <input type="hidden" name="departement" value="${echapperHtml(donnees.departement)}">
  <fieldset class="profils">
    <legend>Contenu du fichier</legend>
    <p>
      <label>
        <input type="radio" name="profil" value="simple"${simple ? " checked" : ""}>
        <strong>Fichier simple</strong> — 6 colonnes, une ligne par structure
      </label>
      <span class="discret">Département, commune, nom, type, téléphone, e-mail. Plusieurs
      numéros ou adresses pour une même structure sont réunis dans la cellule, séparés par
      « / ». Le type est <code>sportive</code>, <code>culturelle</code>, <code>sociale</code>,
      <code>comite_des_fetes</code>, <code>centre_de_loisirs</code> ou <code>diverses</code> ;
      il reste vide quand rien ne l'établit, plutôt que de deviner.</span>
    </p>
    <p>
      <label>
        <input type="radio" name="profil" value="complet"${simple ? "" : " checked"}>
        <strong>Fichier complet</strong> — toutes les colonnes, une ligne par contact
      </label>
      <span class="discret">Avec l'adresse de la page source, la date de lecture, la méthode
      d'extraction et le score. C'est le fichier auditable : lui seul permet de remonter à
      l'origine d'une donnée, et de distinguer une adresse de service d'une adresse
      nominative.</span>
    </p>
  </fieldset>
  <p>
    <label>Score minimum
      <input type="text" name="score-min" value="${echapperHtml(donnees.scoreMin)}"
             placeholder="0.6" size="6">
    </label>
    <span class="discret">vide = tous les contacts, notés ou non</span>
  </p>
  <p>
    <label>
      <input type="checkbox" name="avec-rejetes" value="1"${donnees.avecRejetes ? " checked" : ""}>
      Inclure les ${nombre(donnees.rejetes)} contacts rejetés en revue
    </label>
  </p>
  ${commande}
</form>

${volumetrie(donnees, simple)}

<p class="discret">
Équivalent en ligne de commande :
<code>annuaire exporter --departement ${echapperHtml(donnees.departement)}${
    simple ? " --profil simple" : ""
  }${donnees.scoreMin === "" ? "" : ` --score-min ${echapperHtml(donnees.scoreMin)}`}${
    donnees.avecRejetes ? " --avec-rejetes" : ""
  } --fichier annuaire-${echapperHtml(donnees.departement)}.csv</code>
<br>Sans <code>--profil</code>, la ligne de commande produit le fichier complet.
</p>

<p class="discret">Les contacts rejetés en revue sont exclus par défaut : un arbitrage humain
qui ne changerait rien au fichier livré ne servirait à rien. <a href="/revue?departement=${dept}">Aller à la revue</a>.</p>

<p class="discret">Le fichier contient <strong>tous les numéros fixes</strong>. Seuls les
mobiles 06/07 dépendent du réglage de la collecte, et l'export, lui, ne filtre aucun numéro :
ce qui a été collecté sort.</p>

<!-- L'avertissement est ici, et pas seulement dans le README : c'est le moment ou le
     fichier quitte l'outil, donc le seul ou il sera lu par quelqu'un qui est sur le point
     d'en avoir besoin. -->
${avertissement(simple)}
`;
}

/**
 * Ce que le fichier contiendra, et ce qu'il laissera derriere.
 *
 * Le nombre d'ecartes n'est pas un detail d'affichage : sans lui, la personne qui compare
 * les deux fichiers voit des lignes disparaitre sans explication et conclut a une perte
 * de donnees. C'est a l'outil de dire ce qu'il n'a pas mis.
 */
function volumetrie(donnees: DonneesExport, simple: boolean): string {
  if (!simple) {
    return `<p class="discret">
Le seuil courant sortirait <strong>${nombre(donnees.lignes)}</strong> lignes.
Chaque ligne porte son URL source, sa date de collecte, sa méthode d'extraction et son
score : un export qui les laisserait derrière reproduirait le problème que l'outil
résout. La valeur corrigée en revue, quand il y en a une, sort à côté de la valeur lue.
</p>`;
  }

  const ecartes =
    donnees.sansNom === 0
      ? ""
      : ` <strong>${nombre(donnees.sansNom)}</strong> contacts sans nom de structure en sont
      écartés — ni le RNA, ni la page, ni le domaine de leur adresse n'ont permis de les
      nommer, et une ligne sans nom ne se travaille pas. Ils restent dans le fichier complet.`;

  return `<p class="discret">
Le seuil courant sortirait <strong>${nombre(donnees.lignes)}</strong> lignes.${ecartes}
Ce fichier <strong>ne porte pas la provenance</strong> : pour remonter à la page d'origine
d'une adresse, à sa date de lecture ou à son score, choisissez le fichier complet.
</p>
<p class="discret">La colonne <code>type</code> est renseignée par la normalisation : si elle
est vide partout, c'est qu'elle n'a pas encore tourné —
<code>annuaire normaliser --departement ${echapperHtml(donnees.departement)}</code>.</p>`;
}

function avertissement(simple: boolean): string {
  const regime = simple
    ? `Ce fichier <strong>ne distingue pas</strong> les adresses de fonction de celles qui
désignent une personne, et peut réunir les deux dans une même cellule. Le fichier complet
porte cette distinction en colonne <code>regime</code>. <strong>La colonne « nom » peut
elle aussi désigner une personne physique</strong> — président, gérant, correspondant —
quand c'est ce que la page nommait à côté du contact.`
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
