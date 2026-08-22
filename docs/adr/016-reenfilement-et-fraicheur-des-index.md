# ADR-016 — Réenfiler un job, et ne pas mettre un index en cache

Statut : acceptée — 2026-08-22

Corrige deux défauts découverts en exploitation pendant la mesure du lot 4. Ils sont
traités ensemble parce qu'ils sont la même erreur.

## Contexte

Deux mécanismes du projet économisent du travail en se calant sur le rythme de la source.

**Les clés de déduplication portent une période.** `annuaire_local:35:2026-08-22` pour
l'Annuaire, régénéré chaque jour ; `rna_waldec:35:2026-08` pour le RNA, publié chaque
mois. `enqueue` étant un `INSERT OR IGNORE`, relancer un run dans la même période ne
retélécharge rien. C'est délibéré, et c'est ce qui évite de traverser 1,16 Go pour des
données identiques.

**Le cache HTTP retient les réponses sept jours.** Il s'applique uniformément, y compris
au listing du co-marquage.

Les deux raisonnent sur la **source**. Aucun des deux ne prévoit que l'**intention** ou le
**lecteur** puisse changer sans elle. Le lot 4 a rencontré les deux cas le même jour.

*Le listing.* La migration 4 ajoutait quatre colonnes lues dans le dump de l'Annuaire.
Trois runs consécutifs ont échoué sur un `404` opaque : le listing servi depuis le cache
datait de deux jours et nommait un dump que le serveur avait fait tourner depuis. Un index
n'est pas une ressource — sa seule raison d'être est de nommer le fichier du jour. Le
mettre en cache une semaine garantit l'échec.

*La déduplication.* Une fois le listing rafraîchi, l'amorce RNA refusait de repartir : sa
clé mensuelle était consommée depuis le 20 août. La source n'avait pas bougé, mais le
lecteur si — c'était tout l'objet de la migration. Il a fallu ouvrir la base au SQL, à
quatre reprises dans la même session, pour débloquer des réessais parfaitement légitimes.

## Décision

**Le listing de l'Annuaire est toujours revalidé.** `forceRevalidate` existait déjà dans
`FetchOptions` ; il suffisait de s'en servir au bon endroit. Le coût est une requête
conditionnelle sur 600 octets, et le corps ne repart que si le listing a réellement changé.
Le cache reste inchangé partout ailleurs : c'est le rôle de cette URL précise qui justifie
l'exception, pas une défiance envers le cache.

**`annuaire requeue <id|cle>` remet un job terminé, écarté ou mort en attente**, tentatives
remises à zéro, payload d'origine conservé. `--state <etat>` traite tous ceux d'un état.

Les clés de déduplication ne sont **pas** modifiées. Elles ont raison sur les données : une
source inchangée ne mérite pas d'être relue, et raccourcir les périodes ferait payer à tous
les runs le prix d'un cas rare. Ce qui manquait n'était pas une règle plus fine, c'était le
moyen de **dire l'intention** quand la règle et elle divergent.

Un job `pending` ou `leased` n'est jamais réenfilé : le premier y est déjà, doubler le
second l'exécuterait deux fois.

## Conséquences

**L'exception au cache est ponctuelle et argumentée dans le code**, au point d'appel. Le
risque est qu'elle se propage par imitation à des URL qui n'en relèvent pas ; le
commentaire dit donc le critère, et non le geste : un index qui nomme une ressource
datée, pas une ressource.

**`requeue` est une commande d'exploitation, pas une échappatoire aux invariants.** Elle
ne touche ni à `robots.txt`, ni au délai de 2 s, ni à la purge — elle ne fait que rendre à
un job l'éligibilité que la file lui accorderait de toute façon la période suivante. Elle
avance dans le temps, elle ne contourne rien.

**Elle ne dispense pas de comprendre pourquoi un job a échoué.** Réenfiler un job mort
d'un `500` répété le fera mourir à nouveau. Le message d'échec renvoie donc vers
`annuaire jobs --state <etat>` plutôt que de laisser croire qu'un réessai suffit toujours.

**Reste une asymétrie assumée** : `--rna-file` ne rejoint pas un job déjà enfilé. Le
payload est figé à l'enfilement — c'est ce qui rend la reprise fidèle, les réglages
voyageant avec le travail et non avec la commande. Réenfiler un job RNA le fait donc
repartir sur le miroir, même si la relance passe `--rna-file`. Pour changer de source, il
faut laisser la période s'écouler ou supprimer le job. Ce n'est pas satisfaisant, et c'est
préférable à un payload que la ligne de commande pourrait réécrire après coup.
