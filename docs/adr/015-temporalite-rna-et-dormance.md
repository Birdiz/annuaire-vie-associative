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

**Le seuil de dormance est fixé à cinq ans, et assumé comme une convention.** L'ADR-013
exigeait qu'il soit « choisi sur la distribution observée de `date_decla` plutôt que fixé a
priori ». La distribution a été mesurée, et elle ne désigne aucun seuil : voir les
conséquences ci-dessous. Cinq ans est donc retenu faute de frontière naturelle, pas parce
que les données l'indiquent — et il est affiché à côté de chaque pourcentage qu'il produit.

**Le taux de couverture est affiché sur les deux dénominateurs**, actives puis non
dormantes, dans cet ordre. Ne montrer que le second, plus favorable, améliorerait le
chiffre en changeant la question — et le lecteur ne verrait pas le changement.

## Conséquences

**Le chiffre bas reste visible.** C'est délibéré. Un taux de couverture qui monte parce
qu'on a rétréci son dénominateur n'est pas un progrès, et un README qui ne montrerait que
le second priverait le lecteur du moyen de s'en apercevoir.

**Le champ est intégralement peuplé : 0 % des 31 273 associations actives d'Ille-et-Vilaine
sont sans date de déclaration.** La troisième population prévue existe dans le modèle mais
se révèle vide sur ce département. Le seuil peut donc parler de toute la population, ce qui
n'allait pas de soi.

**La distribution ne désigne aucun seuil.** Les déclarations croissent de façon lisse et
monotone de 2006 (754) à 2025 (4 730), sans creux ni palier. La seule discontinuité est en
amont — 151 déclarations en 2005 contre 754 en 2006 — et c'est un artefact de couverture du
dump Waldec, pas un fait sur les associations. **Il n'existe pas de frontière naturelle entre
vivant et dormant** : c'est un résultat de la mesure, et il valait d'être établi plutôt que
supposé. Cinq ans coupe la population à 51,5 % / 48,5 %, ce qui est une coïncidence et non
un signal.

**L'hypothèse que cette ADR devait tester est infirmée.** L'ADR-013 supposait que le taux de
couverture de 1,5 % était difficile à lire parce que son dénominateur comptait « une part
inconnue de structures dormantes ». Mesuré, l'effet est marginal :

| Population | Effectif | Couvertes | Taux |
|---|---:|---:|---:|
| Toutes actives | 31 273 | 478 | 1,53 % |
| Déclaré depuis 10 ans | 22 159 | 414 | 1,87 % |
| Déclaré depuis 5 ans | 16 094 | 325 | 2,02 % |
| Déclaré depuis 1 an | 5 417 | 118 | 2,18 % |

Se restreindre aux 17 % d'associations les plus récemment déclarantes ne fait gagner que
0,65 point. **La dormance n'explique pas la couverture basse** : les associations qui
déclarent encore sont presque aussi absentes des sites de mairie que celles qui ont cessé.
Le plafond n'est pas un artefact de dénominateur, c'est un fait sur ce que les communes
publient.

**Conséquence pour le lot 5.** L'espérance du fallback LLM doit être réévaluée à cette
lumière. On ne peut pas extraire des contacts d'associations dont les mairies ne parlent
pas : le gisement n'est pas dans une meilleure lecture des pages déjà visitées, il est
ailleurs — ou il n'est pas. Le signal connexe relevé par l'ADR-013 pointe dans le même sens
(170 associations sur 36 170 déclarent un site web, soit 0,5 %). C'est un arbitrage de
produit, pas une question technique, et il se pose maintenant plutôt qu'après avoir payé
l'inférence.

**La dormance ne sera jamais qu'un proxy.** Une association peut vivre sans rien déclarer
en préfecture pendant dix ans. Le seuil ne mesure pas l'activité, il mesure la trace
administrative de l'activité ; c'est la seule que les données ouvertes portent, et le
chiffre doit être lu avec cette réserve. C'est aussi pourquoi le critère voyage avec lui.

**`position` et `maj_time` ne servent encore à rien.** Ils sont stockés parce qu'ils sont
gratuits une fois la ligne lue, et parce qu'un raffinement du seuil pourrait les vouloir.
Aucune lecture ne s'y appuie aujourd'hui, et aucune ne doit s'y appuyer sans mesure.
