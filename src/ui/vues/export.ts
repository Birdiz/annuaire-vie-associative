/**
 * Ecran d'export — la sortie de l'annuaire, en CSV.
 *
 * Le fichier est produit par `lignesCsv` (lot 5), sans variante propre a l'UI : deux
 * chemins d'export produiraient tot ou tard deux fichiers differents, et la provenance
 * qui voyage avec chaque ligne n'aurait plus de garantie unique.
 */

import { echapperHtml, nombre, choixDepartement } from "../rendu.ts";

export type DonneesExport = {
  departement: string;
  departements: readonly string[];
  scoreMin: string;
  avecRejetes: boolean;
  lignes: number;
  rejetes: number;
};

export function ecranExport(donnees: DonneesExport): string {
  const dept = encodeURIComponent(donnees.departement);
  return `${choixDepartement("/export", donnees.departements, donnees.departement)}
<h2>Export CSV</h2>
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
  <p><button type="submit">Telecharger l'annuaire du departement ${echapperHtml(donnees.departement)}</button></p>
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
`;
}
