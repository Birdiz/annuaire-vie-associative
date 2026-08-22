# ADR-019 — Déduplication, et un score distinct de la confiance de lecture

Statut : acceptée — 2026-08-22

## Contexte

Deux dettes du lot 3 arrivaient à échéance ensemble.

**La première est écrite dans le README** : « un même email peut exister à la fois
rattaché à une association et au niveau de la commune — la déduplication est l'étape [7] ».
Elle vient de l'ADR-012, qui impose que `code_insee` soit toujours renseigné, même quand
l'association l'est. Le schéma porte donc deux index uniques partiels — un par
association, un par commune pour les contacts orphelins — et ils ne se voient pas l'un
l'autre. La même adresse lue une fois dans un bloc qui nommait une association et une fois
dans un bloc qui n'en nommait aucune produit deux lignes, toutes deux légitimes au regard
des contraintes.

**La seconde est le §6.8** : « score de confiance par contact → alimente l'écran de revue
humaine ». La colonne `confiance` existe déjà, et la tentation était de s'en servir.

## Décision

### La ligne rattachée l'emporte, la ligne commune disparaît

Elle ne porte strictement rien de plus : même valeur, même commune, et une provenance qui
est celle d'une lecture moins précise du même fait.

L'alternative examinée — tout conserver, en marquant la ligne commune `rejete` — a été
écartée. Elle laissait une table qui ne se lit plus sans filtre, et un export qui doit se
souvenir de la règle : deux endroits où l'oublier, pour une trace dont personne n'a
l'usage.

**La règle est une requête SQL, pas une boucle applicative.** C'est ce qui la rend
rejouable à l'identique, donc idempotente au sens du §4.9 — et le test le vérifie en la
rejouant trois fois.

Elle raisonne par commune : la même adresse vue dans une commune voisine où aucune
association ne la porte survit, parce qu'elle y est le seul témoignage.

### Le score de revue est une colonne distincte de `confiance`

`confiance` dit comment le contact a été **lu** : 0,9 pour un `mailto:` que l'auteur de la
page a écrit lui-même, 0,45 pour une forme désobfusquée que nous avons reconstruite, moins
10 % quand le rattachement est une inférence sur le nom (ADR-012). C'est une provenance :
elle ne bouge plus une fois écrite.

Le score dit si le contact vaut d'être **publié**, ce qui dépend aussi du MX de son
domaine, du régime juridique de l'adresse (§4.7) et de la page d'où elle vient. Écraser
l'une par l'autre perdrait la provenance au premier réglage du barème — et il y en aura.

**Le barème est multiplicatif.** Chaque signal répond à « qu'est-ce que ceci retire à une
lecture parfaite ». Un produit se lit facteur par facteur — « le domaine n'a pas de MX »
retire toujours la même proportion, quelle que soit la qualité de lecture — là où une
somme de poids demanderait de connaître le total pour interpréter un terme.

**La syntaxe court-circuite tout, avec un facteur nul.** Une valeur qui n'a pas la forme
d'une adresse n'est pas un contact : il n'y a rien à arbitrer en revue, et un score
résiduel la ferait remonter au-dessus de contacts parfaitement lisibles. Elle reste en
base pour la trace, et tout seuil d'export l'écarte.

**Les motifs sont persistés avec le score.** Un score qu'on ne peut pas expliquer n'est
pas révisable : la personne qui arbitre doit voir *ce qui* a fait descendre le chiffre.
Même argument que `prefiltre_motif` au lot 4. Le test vérifie que le score est exactement
le produit annoncé par les motifs — ils ne sont pas un commentaire à côté du calcul, ils
sont le calcul.

## Conséquences

Sur l'Ille-et-Vilaine : **111 doublons supprimés**, et zéro au passage suivant.

Distribution des scores sur 7 313 contacts :

| Tranche | Contacts |
|---|---:|
| 0,0 | 141 |
| 0,1 – 0,3 | 138 |
| 0,4 – 0,5 | 2 822 |
| 0,6 – 0,7 | 3 968 |
| 0,8 – 0,9 | 244 |

**Aucun contact n'atteint 0,9.** Le plafond réel est 0,81 : un contact rattaché a
forcément payé les 10 % que l'ADR-012 impose à l'inférence de nom. C'est cohérent, et
c'est le genre de chose qu'un barème additif aurait masqué.

Le seuil d'export n'est pas fixé ici. `--score-min` existe, la distribution est affichée
par `annuaire normaliser`, et c'est elle — pas une opinion — qui doit dire où le placer.
Même discipline que l'ADR-014 pour le seuil du pré-filtre.
