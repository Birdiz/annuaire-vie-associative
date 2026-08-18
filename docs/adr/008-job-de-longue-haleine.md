# ADR-008 — Jobs de longue haleine : commits par tranche

Statut : acceptée — 2026-08-18

## Contexte

L'ADR-002 a posé un contrat net pour les handlers de jobs : le handler fait l'asynchrone
— HTTP, fichiers — **sans jamais écrire en base**, et rend un `commit(db)` synchrone que
le worker exécute dans la même transaction que la complétion du job. L'exactement-une-fois
devient ainsi une propriété du cadre, pas une discipline du handler.

Ce contrat suppose qu'un job tienne dans une transaction. L'amorce RNA traverse 1,25 Go
et produit des dizaines de milliers de lignes. Un unique `commit` final poserait trois
problèmes : une transaction de plusieurs dizaines de milliers d'insertions, la totalité
des lignes retenue en mémoire jusqu'à la fin, et surtout **aucune reprise possible** —
un arrêt à 90 % du fichier perdrait 90 % du travail, indéfiniment.

Le bail, lui, ne pose pas de problème : le worker le renouvelle déjà tout seul à
intervalle régulier, un job de vingt minutes le tient sans rien faire de particulier.

## Décision

Les deux étapes de collecte du lot 2 écrivent en base **pendant** leur exécution, par
tranches d'environ 2 000 lignes. Chaque tranche est une transaction qui contient à la
fois les lignes produites et l'avancement de `dump.consumed_bytes`. Le `commit(db)`
final ne fait plus que marquer le dump terminé et enchaîner sur l'étape suivante.

C'est une entorse explicite au contrat de l'ADR-002, limitée aux jobs qui consomment un
flux. Elle est compensée, non pas ignorée :

- **L'idempotence est portée par le schéma**, pas par le handler : `association.rna_id`
  est `UNIQUE` et les écritures sont des `INSERT … ON CONFLICT DO UPDATE`, `commune` a
  `code_insee` pour clé primaire. Rejouer une tranche déjà écrite est sans effet.
- **L'offset et les données sont commités ensemble.** Après un `kill -9`, ils ne peuvent
  pas diverger : la reprise repart exactement là où la dernière transaction s'est
  arrêtée. Un test le vérifie en coupant le flux en cours de route, puis en contrôlant
  que l'offset tombe sur une frontière de ligne et que le nombre d'associations écrites
  correspond très précisément aux octets consommés.
- **Le parseur ne compte que les lignes complètes.** `CsvStreamParser.consumedBytes`
  n'avance qu'après une ligne entièrement rendue, donc l'offset ne peut pas désigner le
  milieu d'un enregistrement.

## Conséquences

Un job interrompu laisse des données partielles visibles en base. C'est voulu : elles
sont exactes, simplement incomplètes, et `annuaire dumps` montre où en est la lecture.
L'alternative — tout ou rien — coûterait une reprise à chaque incident sur un transfert
de plus d'un gigaoctet.

Le contrat de l'ADR-002 reste la règle pour tout le reste. Un handler qui écrit en base
doit désormais le justifier ; les deux seuls du projet sont ceux-ci, et ils le
justifient par la taille de ce qu'ils lisent. Si un troisième apparaît sans consommer de
flux, c'est le signe qu'il fait fausse route.

Comme les compteurs s'incrémentent par `UPSERT` immédiat, ils sont accumulés en mémoire
et appliqués dans la transaction de tranche : trente-sept mille écritures autonomes
auraient coûté plus cher que le travail utile.
