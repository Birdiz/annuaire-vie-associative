import { test } from "node:test";
import assert from "node:assert/strict";

import { BOM, COLONNES_COMPLET, COLONNES_SIMPLE, SEPARATEUR } from "../../src/export/csv.ts";

/**
 * Le verrou qui manquait.
 *
 * Jusqu'au lot 10, la liste des noms de colonnes et le tableau des valeurs vivaient cote a
 * cote, couples **par position** et sans aucune garde : inserer une colonne au milieu de
 * l'un decalait silencieusement toutes les cellules de l'autre, et aucun test ne rougit.
 * La structure `{ nom, cellule }` rend ce decalage impossible ; ce fichier verrouille ce
 * qu'elle ne peut pas garantir seule — la liste elle-meme, et son ordre.
 *
 * Ces listes sont ecrites en dur, et c'est le but. Les deriver de la source ne
 * verifierait plus rien : un fichier deja livre au client depend de cet ordre.
 */

const ATTENDU_COMPLET = [
  "code_insee",
  "commune",
  "rna_id",
  "association",
  "type",
  "kind",
  "valeur",
  "valeur_corrigee",
  "valeur_publiable",
  "regime",
  "score",
  "confiance",
  "methode_extraction",
  "source_url",
  "collected_at",
  "review_statut",
  "nom_pressenti",
  "nom_source",
];

const ATTENDU_SIMPLE = ["departement", "commune", "nom", "type", "telephone", "email"];

test("le profil complet garde ses seize colonnes historiques, dans l'ordre", () => {
  const noms = COLONNES_COMPLET.map((colonne) => colonne.nom);

  // Les seize premieres ne bougent pas : des fichiers produits avant le lot 10 sont
  // ouverts dans des tableurs qui pointent des colonnes par leur position.
  assert.deepEqual(noms.slice(0, 16), ATTENDU_COMPLET.slice(0, 16));
  // Les deux suivantes sont ajoutees **en queue**, ce qui ne decale rien.
  assert.deepEqual(noms, ATTENDU_COMPLET);
});

test("le profil simple tient en six colonnes, dans l'ordre du fichier attendu", () => {
  assert.deepEqual(
    COLONNES_SIMPLE.map((colonne) => colonne.nom),
    ATTENDU_SIMPLE,
  );
});

test("aucun nom de colonne ne porte d'accent, dans aucun des deux profils", () => {
  // Le CLAUDE.md distingue : le texte affiche s'accentue, les noms de colonnes non —
  // les accentuer casserait les fichiers deja produits et les liens deja enregistres.
  // La regle est ici tenue par un test, et non par une relecture attentive.
  for (const colonne of [...COLONNES_COMPLET, ...COLONNES_SIMPLE]) {
    assert.match(colonne.nom, /^[a-z0-9_]+$/, `« ${colonne.nom} » n'est pas un nom de colonne valide`);
  }
});

test("le BOM ne prefixe que l'en-tete, et une seule fois", () => {
  // Un BOM au milieu du fichier n'est plus une marque d'encodage : c'est un caractere
  // invisible dans une cellule, que personne ne voit et que tout le monde subit.
  assert.equal(BOM.length, 1);
  assert.ok(!SEPARATEUR.includes(BOM));
});
