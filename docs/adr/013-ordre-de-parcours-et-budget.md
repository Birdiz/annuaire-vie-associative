# ADR-013 — Ordre de parcours du crawl, et budget porté à 20 pages

Statut : acceptée — 2026-08-20

Complète l'[ADR-010](010-decoupage-du-crawl.md), dont elle corrige le schéma de priorité.

## Contexte

Premier passage du lot 3 sur des sites réels : l'Ille-et-Vilaine, 332 communes ayant une
URL de mairie. Le run a été interrompu à 2 578 jobs traités, 2 591 pages et 7 424
contacts, après environ quarante minutes de découverte. Trois faits mesurés, qu'aucune
fixture synthétique ne pouvait produire — la fixture du lot 3 n'a **qu'une seule
commune**, donc ni concurrence entre communes, ni hébergement mutualisé, ni saturation
de budget.

**Le parcours était déséquilibré.** 972 pages visitées en profondeur 1 pour seulement
149 racines visitées sur 332. Les racines étaient enfilées sans priorité, donc à la
valeur par défaut de 100, tandis que tout lien découvert recevait
`prioriteDeScore(score) = 100 − 4 × score`, soit une priorité **meilleure** dès que le
score était positif. La file triant par priorité croissante, chaque lien découvert
doublait toutes les mairies pas encore visitées.

**Le débit était bas.** Environ 1 requête par seconde, contre un plafond théorique de 4
avec huit workers et le délai de 2 s. Mesure de la cause : les 333 domaines de mairie du
département se résolvent sur **93 sous-réseaux /24 seulement**, les deux plus chargés en
hébergeant 42 et 41. **85 % des domaines partagent leur /24 avec un autre.** Le throttle
retenant la clé la plus contraignante (ADR-004), concentrer les workers sur un même
sous-arbre — donc un même hôte — sérialisait ce que la concurrence devait étaler.

**Le budget mordait.** 115 communes sur 332 avaient saturé le plafond de 10 pages.

## Décision

**La profondeur domine le score dans la priorité.** Trois bandes disjointes — 10, 80,
150 — une par niveau de profondeur, le score ne départageant qu'à l'intérieur d'une
bande, avec une amplitude bornée à 39 pour qu'aucun score, même aberrant, ne fasse
changer de bande. Une page d'accueil passe donc toujours avant n'importe quel lien
découvert.

Ce choix a deux justifications distinctes, et c'est leur convergence qui le rend net.

*Sur la valeur produite* : un run interrompu doit laisser une couverture large et
superficielle plutôt que profonde et partielle. Pour un annuaire, connaître une page de
chaque commune vaut mieux que tout savoir d'une commune sur deux. L'interruption n'est
pas un cas exceptionnel — un département demande des dizaines de minutes.

*Sur le débit* : traiter les racines d'abord répartit mécaniquement les requêtes sur des
sous-réseaux distincts. C'est le **seul levier de débit disponible** une fois le délai de
2 s posé comme invariant non négociable. Augmenter `concurrency` n'y change rien : le
goulot n'est pas le nombre de workers mais la file par /24.

**Le budget passe de 10 à 20 pages par commune.** Un tiers des communes saturant le
plafond, celui-ci bornait la récolte autant que la richesse réelle des sites. Le
doublement est un pas mesurable, pas un réglage définitif.

**Les communes sans collecte sont détaillées par cause.** L'agrégat « sans collecte
possible » confondait trois situations de natures différentes : un site injoignable est
un incident, un site interdit par `robots.txt` est une limite assumée du produit, une
commune non tentée est un run inachevé. Les confondre empêche de savoir s'il faut
relancer, corriger, ou ne rien faire.

## Conséquences

**Le plancher de durée est structurel et ne descendra plus.** Il vaut, pour le /24 le
plus chargé, le nombre de requêtes qu'il porte multiplié par 2 s — soit environ treize
minutes pour l'Ille-et-Vilaine. Le correctif de priorité vise l'écart entre ce plancher
et les quarante minutes observées, pas le plancher lui-même. Descendre en dessous
exigerait d'enfreindre l'invariant 3, ce qui est exclu.

**42 communes du département, soit 13 %, sont interdites par `robots.txt`.** On n'y
collectera jamais rien. C'est assumé et désormais affiché comme tel, pas contourné.

Le doublement du budget ne double pas la durée : le coût dépend de la répartition des
pages supplémentaires sur les sous-réseaux saturants, pas de leur nombre total.

**Le taux de couverture mesuré est de 1,5 %** — 478 associations sur 31 273. Ce chiffre
appelle une réserve avant d'être lu comme un échec : le dénominateur compte toutes les
associations non dissoutes du RNA, dont une part inconnue de structures dormantes. Le
dump `waldec` retient déjà celles ayant déclaré un mouvement depuis 2009, mais c'est un
seuil bas. **Aucun champ temporel n'est aujourd'hui stocké** — `convertirLigne` ne retient
que `date_disso` — alors que le RNA expose `date_creat`, `date_decla`, `position` et
`maj_time`. Qualifier la dormance suppose donc une migration, puis un seuil choisi sur la
distribution observée de `date_decla` plutôt que fixé a priori. C'est un préalable au
lot 4 : sans lui, la métrique du §8 reste ininterprétable.

Signal connexe utile à ce même arbitrage : **170 associations sur 36 170 déclarent un
site web**, soit 0,5 %. Le gisement de contacts n'est pas du côté des sites
d'associations.
