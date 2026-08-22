# ADR-015 — Champs temporels du RNA, et qualification de la dormance

Statut : acceptée — 2026-08-21

Solde la dette ouverte par l'[ADR-013](013-ordre-de-parcours-et-budget.md), qui la posait
comme « un préalable au lot 4 : sans lui, la métrique du §8 reste ininterprétable ».

## Contexte

Le taux de couverture du §8 — la métrique qui fait le README — valait 1,5 % au lot 3 :
478 associations pourvues d'un email sur 31 273. Le dénominateur compte toutes les
associations non dissoutes du RNA, dont une part inconnue n'a plus donné signe de vie
depuis des années.

Une association dissoute se déclare ; une association dormante, non — elle cesse
simplement de déclarer. Le dump `waldec` retient déjà celles ayant déclaré un mouvement
depuis 2009, mais c'est un seuil bas et lointain. Aucun champ temporel n'était stocké :
`convertirLigne` ne retenait que `date_disso`, alors que le RNA expose `date_creat`,
`date_decla`, `position` et `maj_time`.

Sans dénominateur qualifié, on ne sait pas si 1,5 % est un échec de la collecte ou le
reflet d'un tissu associatif largement éteint. Les deux appellent des suites opposées.

## Décision

**Les quatre champs temporels du RNA sont stockés bruts**, sans interprétation à
l'écriture : `date_creation`, `date_declaration`, `position_rna`, `maj_rna`. Les quatre
d'un coup, alors que seul `date_decla` sert aujourd'hui : ils coûtent quatre `ALTER` et
évitent une seconde migration quand le seuil se raffinera.

**La sentinelle `0001-01-01` du RNA devient `NULL`.** Elle vaut « non dissoute » sur
`date_disso` mais « date inconnue » sur les autres champs : la laisser entrer ferait passer
une absence pour l'an 1, et rangerait ces lignes du mauvais côté de n'importe quel seuil.

**Les associations sans date ne sont comptées ni comme dormantes, ni comme vivantes.**
Elles forment une troisième population, rendue à part. Les verser d'un côté ou de l'autre
trancherait par défaut une question sur laquelle la source ne dit rien.

**Le seuil de dormance reste un paramètre affiché, provisoirement à cinq ans.** L'ADR-013
exige qu'il soit « choisi sur la distribution observée de `date_decla` plutôt que fixé a
priori ». Cette distribution demande un nouveau passage RNA, que ce lot livre les moyens
d'obtenir sans le remplacer :

```bash
npm run annuaire -- dormance --departement 35
```

rend l'histogramme des déclarations par année, les trois populations, et **le critère
appliqué à côté du chiffre qu'il produit**. Le seuil définitif sera fixé sur cet
histogramme, et cette ADR amendée en conséquence.

**Le taux de couverture est affiché sur les deux dénominateurs**, actives puis non
dormantes, dans cet ordre. Ne montrer que le second, plus favorable, améliorerait le
chiffre en changeant la question — et le lecteur ne verrait pas le changement.

## Conséquences

**Le chiffre bas reste visible.** C'est délibéré. Un taux de couverture qui monte parce
qu'on a rétréci son dénominateur n'est pas un progrès, et un README qui ne montrerait que
le second priverait le lecteur du moyen de s'en apercevoir.

**La base amorcée avant ce lot ne porte aucune date de déclaration.** Les colonnes ont été
ajoutées par migration ; leur contenu vient du dump. Sur l'installation de mesure de
l'Ille-et-Vilaine, les 31 273 associations sont donc toutes « sans date », et le
dénominateur qualifié restera vide tant que l'amorce n'aura pas été rejouée. C'est le
comportement attendu — la migration ne fabrique pas de données qu'elle n'a pas lues — et
`dormance` l'affiche comme tel plutôt que de rendre un pourcentage sur zéro.

**La dormance ne sera jamais qu'un proxy.** Une association peut vivre sans rien déclarer
en préfecture pendant dix ans. Le seuil ne mesure pas l'activité, il mesure la trace
administrative de l'activité ; c'est la seule que les données ouvertes portent, et le
chiffre doit être lu avec cette réserve. C'est aussi pourquoi le critère voyage avec lui.

**`position` et `maj_time` ne servent encore à rien.** Ils sont stockés parce qu'ils sont
gratuits une fois la ligne lue, et parce qu'un raffinement du seuil pourrait les vouloir.
Aucune lecture ne s'y appuie aujourd'hui, et aucune ne doit s'y appuyer sans mesure.
