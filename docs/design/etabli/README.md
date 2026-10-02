# L'Établi — maquette retenue (phase 1, direction 2)

Ces trois fichiers sont des maquettes. Ils ont été produits par Claude Design à partir de
[`../claude-design-prompt.md`](../claude-design-prompt.md), puis exportés en zip le 2026-10-02.
Thomas a retenu la direction 2, « L'Établi », dont la référence est Prodigy.

| Fichier | Contenu |
|---|---|
| `direction-2-etabli.dc.html` | Identité : concept, palette claire et sombre avec ses contrastes, typographie, logo, carte du parcours. Écran A (Collecter, en clair puis en sombre), écran B (Relire), écran C (Exporter, fichier simple), bande de composants |
| `etabli-etats.dc.html` | Les états complémentaires : Préparer (usage courant, premier lancement), Collecter (jamais amorcé, arrêtée, en erreur), Relire (mode liste, file vide), Exporter (fichier complet, suspendu), et l'aide en panneau latéral |
| `comparaison-phase-1.dc.html` | La comparaison des trois directions (La Fiche sourcée, L'Établi, Le Forum) |

## Comment lire ces fichiers

- **Ce ne sont pas du code à reprendre.** Les maquettes utilisent des styles en ligne, une
  police Google et le runtime de Claude Design (`support.js`, non versionné). Ouvertes
  depuis le dépôt, elles ne s'affichent donc pas correctement. Elles se lisent comme une
  source. Le portage sert une feuille de style unique et des woff2 locaux, conformément à
  la CSP `default-src 'self'`.
- **Les jetons font foi** : `--bg`, `--sf`, `--tx`, `--mu`, `--bd`, `--pr`, `--ac`, `--al`, et
  la rampe de confiance `--c1` à `--c4`, en clair et en sombre, tels que la palette 2b les
  affiche.
- **Les données sont fictives** : communes, associations, adresses et numéros RNA.
- **Écarts connus avec l'outil**, à ne pas porter tels quels :
  - l'aperçu des colonnes du fichier complet invente des noms (`base_legale`, `extrait`,
    `decide_le`…). Les vraies colonnes sont dans `src/export/csv.ts` ;
  - « environ 5 h 10 restantes » est une estimation que l'outil ne calcule pas ;
  - « Relancer reprend à la page 1 303 » est faux : la reprise suit une file de jobs, pas
    un ordre de pages.
