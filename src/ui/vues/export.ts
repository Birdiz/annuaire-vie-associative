/**
 * Ecran d'export — la sortie de l'annuaire, en CSV.
 *
 * Le fichier est produit par `lignesCsv` (lot 5), sans variante propre a l'UI : deux
 * chemins d'export produiraient tot ou tard deux fichiers differents, et la provenance
 * qui voyage avec chaque ligne n'aurait plus de garantie unique.
 */

import { echapperHtml, nombre, banniereRun } from "../rendu.ts";
import type { EtatCollecte } from "../rendu.ts";

export type DonneesExport = {
  departement: string;
  scoreMin: string;
  avecRejetes: boolean;
  lignes: number;
  rejetes: number;
  /** Un export pris au milieu d'un run livre un annuaire a moitie note. */
  collecte: EtatCollecte;
};

export function ecranExport(donnees: DonneesExport): string {
  const dept = encodeURIComponent(donnees.departement);

  // Exporter pendant un run livre un fichier que la fin du run rendrait faux : les
  // contacts arrives apres manquent, ceux qui ne sont pas encore notes sortent sans
  // score, et le seuil ne veut plus rien dire. Le bouton est donc retire — pas
  // seulement grise : un bouton desactive invite a chercher comment l'activer.
  const bloque = donnees.collecte.kind === "pilote";
  const banniere = banniereRun(
    donnees.collecte,
    bloque
      ? "L'export est suspendu jusqu'a la fin : un fichier pris maintenant sortirait sans les contacts a venir, et sans le score de ceux qui ne sont pas encore notes."
      : "Les chiffres ci-dessous bougent encore, et un fichier pris maintenant serait incomplet.",
  );

  const commande = bloque
    ? `<p class="discret">Le bouton revient des que le run est fini ou arrete. Rien n'est perdu entre-temps :
       l'export lit la base, il ne la consomme pas.</p>`
    : `<p><button type="submit" class="primaire">Telecharger le fichier</button></p>`;

  return `<h2>Export CSV</h2>
${banniere}
<form method="get" action="/export.csv">
  <input type="hidden" name="departement" value="${echapperHtml(donnees.departement)}">
  <p>
    <label>Score minimum
      <input type="text" name="score-min" value="${echapperHtml(donnees.scoreMin)}"
             placeholder="0.6" size="6">
    </label>
    <span class="discret">vide = tous les contacts notes ou non</span>
  </p>
  <p>
    <label>
      <input type="checkbox" name="avec-rejetes" value="1"${donnees.avecRejetes ? " checked" : ""}>
      Inclure les ${nombre(donnees.rejetes)} contacts rejetes en revue
    </label>
  </p>
  ${commande}
</form>

<p class="discret">
Le seuil courant sortirait <strong>${nombre(donnees.lignes)}</strong> lignes.
Chaque ligne porte son URL source, sa date de collecte, sa methode d'extraction et son
score : un export qui les laisserait derriere reproduirait le probleme que l'outil
resout. La valeur corrigee en revue, quand il y en a une, sort a cote de la valeur lue.
</p>

<p class="discret">
Equivalent en ligne de commande :
<code>annuaire exporter --departement ${echapperHtml(donnees.departement)}${
    donnees.scoreMin === "" ? "" : ` --score-min ${echapperHtml(donnees.scoreMin)}`
  }${donnees.avecRejetes ? " --avec-rejetes" : ""} --fichier annuaire-${echapperHtml(donnees.departement)}.csv</code>
</p>

<p class="discret">Les contacts rejetes en revue sont exclus par defaut : un arbitrage humain
qui ne changerait rien au fichier livre ne servirait a rien. <a href="/revue?departement=${dept}">Aller a la revue</a>.</p>

<!-- L'avertissement est ici, et pas seulement dans le README : c'est le moment ou le
     fichier quitte l'outil, donc le seul ou il sera lu par quelqu'un qui est sur le point
     d'en avoir besoin. -->
<p class="avertissement">
<strong>Ce fichier contient des donnees personnelles, et vous en etes responsable de
traitement.</strong> La colonne <code>regime</code> distingue les adresses de fonction
(<code>generique</code>) de celles qui designent une personne (<code>nominatif</code>) ;
<code>indetermine</code> signale un cas que l'outil refuse de trancher. Avant tout usage,
vous devez informer les personnes concernees au titre de l'article 14 du RGPD — collecte
indirecte, dans un delai d'un mois ou des la premiere communication. Cet outil ne prospecte
pas, et ce fichier n'est pas un fichier de prospection.
</p>
`;
}
