# ADR-041 — L'Établi : quatre stations, une carte à la fois

Statut : acceptée — 2026-10-02

## Contexte

L'interface tenait en quatre onglets : Synthèse, Revue, Export, Aide. Synthèse portait à
la fois les réglages, la commande du run, le suivi, les métriques et la zone sensible. La
revue empilait dix cartes de quatre boutons chacune. L'identité visuelle était « papier
administratif » : fonctionnelle, mais sans logo ni parcours lisible.

Thomas a demandé une refonte conduite avec Claude Design. Le prompt
(`docs/design/claude-design-prompt.md`) a ouvert trois directions, une par référence :
Annuaire des Entreprises, Prodigy et HelloAsso. Il a retenu la direction 2,
« L'Établi » (référence Prodigy), archivée dans `docs/design/etabli/`.

## Décision

**Le parcours devient une barre de quatre stations : Préparer, Collecter, Relire,
Exporter.** Chaque station affiche son état dans la barre (« en cours · 2 h 41 »,
« 1 287 restants », « suspendu pendant la collecte »), et Relire porte un compteur.

### Routes

- `/preparer`, `/collecter`, `/relire` et `/exporter` sont les quatre stations.
- `/` reste la porte d'entrée du jeton, imprimée par la CLI. Après l'échange, elle renvoie
  en 303 vers Préparer tant que l'URL de contact manque, et vers Collecter ensuite.
- `GET /revue` et `GET /export` répondent en **308**, query conservée : ces adresses
  vivent dans des favoris. `POST /revue/:id` reste accepté, pour un formulaire de
  l'ancienne version encore ouvert au moment de la mise à jour.
- `/export.csv` ne change pas.
- `/aide` reste une page complète.

### La barre se coupe en deux

- **La plaque du département**, à gauche. Un `<details>` replié porte le formulaire de
  l'ancienne barre de portée, sans retouche : c'est le seul endroit où le département se
  lit et se change (ADR-029). Le libellé « 35 · Ille-et-Vilaine » vient de
  `src/departements.ts`, une liste du Code officiel géographique de l'INSEE (Licence
  Ouverte) recopiée et figée.
- **Les stations**, un fragment `GET /stations` rafraîchi toutes les dix secondes. Il ne
  porte **aucun champ**, pour la même raison que le bloc de suivi.

### Relire

- **Une carte au centre, la file à gauche.** La carte présente la valeur, l'association, le
  régime, la confiance, les motifs du score et la preuve (ADR-040).
- **La confiance tient en dix points d'une seule teinte**, avec le chiffre et un mot :
  faible sous 0,50, moyenne sous 0,80, élevée au-delà. Jamais de feu tricolore. Les points
  sont des classes, puisque la CSP refuse `style=`.
- **Valider, Rejeter et Corriger ont le même poids.** Oublier est replié sous la carte,
  avec son motif obligatoire.
- **Une décision renvoie l'atelier** (`#atelier`) avec la carte suivante. Sans JS, elle
  répond par un 303 qui garde le mode et la page.
- **Le mode liste** (`?mode=liste`) affiche 50 lignes par page. Valider et Rejeter s'y
  font en ligne ; Corriger et Oublier ouvrent la carte, parce qu'il faut la preuve sous
  les yeux. Pas de décision groupée.
- **Raccourcis V, R, C** dans `src/ui/assets/etabli.js`, un fichier externe d'un
  kilo-octet. Ils sont facultatifs : le script ne fait que cliquer les vrais boutons, et
  n'agit pas quand le focus est dans un champ. `hx-on` est exclu, car il exigerait
  d'évaluer du code, ce que la CSP refuse.

### Aide

Le bouton « ? » ouvre un **`popover` déclaratif** (`popovertarget`), sans une ligne de
script. Il contient trois parties :

- ce que fait l'écran courant ;
- les cinq étapes ;
- une FAQ courte.

Le mode d'emploi complet reste la page `/aide`, liée depuis le pied de chaque page.

### Exporter

- **L'aperçu des trois premières lignes passe par le même générateur que le fichier.**
  `cellulesCsv` rend les cellules : `lignesCsv` les met en forme CSV, l'écran en lit les
  premières. Un aperçu tiré d'une autre requête finirait par montrer des lignes que le
  fichier ne contient pas. C'est la même règle que `compterLignes`.
- **« N contacts restent sur l'établi »** ne recompte rien : il reprend les écartés et les
  rejetés que l'outil savait déjà dire.
- **L'avertissement RGPD est gardé intégralement**, sous « Avant de télécharger ».

### Identité

- **Jetons.** Ce sont ceux de la palette 2b, en clair et en sombre, exactement. Le
  thème suit `prefers-color-scheme`, avec `color-scheme`.
- **Police.** Atkinson Hyperlegible Next, sous licence OFL, conçue pour la basse vision.
  C'est une **police variable** : un seul woff2 de 33 Ko couvre le 400 et le 700, contre
  les deux fichiers et 56 Ko que la maquette prévoyait. Elle a été récupérée une fois
  depuis Google Fonts (v7, sous-ensemble latin), à l'adresse
  `https://fonts.gstatic.com/s/atkinsonhyperlegiblenext/v7/NaPNcYPdHfdVxJw0IfIP0lvYFqijb-UxCtm5_wdGseiJn3q0pkZ_.woff2`.
  Son empreinte est une constante de `src/ui/assets.ts`, vérifiée par test, et sa licence
  voyage avec elle. L'adresse n'est écrite qu'ici : aucune URL n'a sa place dans `src/`.
  La police mono reste celle du système.
- **Logo.** C'est une carte posée sur la pile. Dans l'en-tête, il est en SVG inline, coloré
  par la feuille de style pour suivre le thème. En favori, c'est `logo.svg`.
- **Couleur d'alerte.** Elle reste réservée à l'effacement et au RGPD. Une erreur de
  collecte s'affiche dans un cadre noir.

### Un défaut corrigé au passage

htmx 2 injecte sa propre feuille de style d'indicateurs, que la CSP refusait à chaque
page. La balise meta de configuration porte désormais `"includeIndicatorStyles":false`.

## Ce que la maquette montrait et qui n'est pas porté

- **L'estimation du temps restant.** L'outil ne la calcule pas, et un chiffre inventé
  serait pire qu'aucun.
- **« Relancer reprend à la page 1 303 ».** C'est faux : la reprise suit une file de jobs,
  pas un ordre de pages. L'écran dit « reprend où elle s'est arrêtée ».
- **Les colonnes inventées de l'aperçu** (`base_legale`, `extrait`…). L'aperçu affiche les
  colonnes réelles.
- **Hors périmètre, à chiffrer si besoin :**
  - les filtres type et commune de Relire ;
  - « Revoir les décisions » ;
  - « N nouveaux contacts sont arrivés » ;
  - le décompte pour un autre seuil.

## Conséquences

- **Poids.** Les assets passent de 68 à 117 Ko : la police (33 Ko), la feuille (27 Ko au
  lieu de 18), le logo et les raccourcis (1,4 Ko). Le bundle ne change pas.
- **Ce que les tests figent.** Les libellés qui comptaient restent : « Lancer la collecte
  complète », « Télécharger le fichier », « Jamais amorcé », `id="contact-N"`, la
  `<progress>` native. Des tests vérifient en plus quatre choses :
  - les redirections ;
  - la barre sans champ ;
  - le parcours carte par carte, et l'échappement de la preuve ;
  - l'absence de tout `style=` et de tout script en ligne sur les cinq écrans.

## Corrections après revue (2026-10-02)

Une revue de l'écran, faite après la fusion, a trouvé quatre défauts.

- **La carte est faite de trois formulaires.** D'un seul tenant, Entrée dans un champ
  envoyait le formulaire par son premier bouton, Valider :
  - une correction validait la valeur lue ;
  - un motif d'effacement validait le contact, sans rien effacer.

  Chaque champ a désormais son formulaire, dont le seul bouton est le sien. L'attribut `form`
  garde les boutons à leur place. `C` sans valeur saisie ouvre le champ au lieu d'envoyer.
- **Un refus garde la carte et la saisie.** L'action porte `contact=N`. Sans lui, le refus
  s'affichait au-dessus de la première carte de la file. Ce qui avait été tapé revient dans
  les champs, par le corps de la réponse et jamais par l'URL. « Corriger… », depuis la liste,
  y ramène à la même page.
- **Aucun `<details>` dans un bloc rafraîchi.** Remplacé toutes les deux ou dix secondes, il
  se refermait sous les yeux de qui le lisait. Seul le contenu du détail se rafraîchit
  désormais (`/chiffres/detail`), et un test l'interdit dans les fragments.
- **L'aperçu d'export suit les réglages.** Avant, il restait sur l'ancien profil, avec son
  avertissement, alors que « Télécharger » envoyait le nouveau.

Le panneau « ? » recouvre le bord droit de l'écran et se referme au premier clic en dehors.
C'est le comportement voulu ; ce qui en était dit plus haut ne l'est pas.
