# ADR-031 — Réinitialiser un département, sans lever les exclusions

Statut : acceptée — 2026-08-30

## Contexte

Mettre l'outil au point demande de relancer une collecte sur des données fraîches, sans
traîner ce qu'une version antérieure de l'extraction avait écrit. Le correctif de
l'[ADR-030](030-reparer-une-arobase-masquee.md) l'illustre : il ne répare que les
extractions à venir, et une base déjà collectée garde ses valeurs cassées.

Deux façons de s'en sortir. Réparer rétroactivement — écarté : deux index `UNIQUE` portent
sur `valeur_normalisee`, une adresse réparée peut entrer en collision avec la version
propre déjà présente, et il faut alors une politique de fusion. Ou **repartir de zéro sur
ce département**, ce qui ne demande aucun arbitrage sur les données et donne exactement ce
qu'on cherche : une collecte neuve.

## Décision

Une commande `annuaire reinitialiser --departement <dd>`, et **rien dans l'interface**.

**Ce à quoi elle ne touche pas** est le cœur de la décision, et se lit dans l'ordre
d'importance :

- **La table `exclusion`.** Une personne qui a demandé à être effacée l'a été pour de bon :
  l'exclusion est l'objet durable, la suppression n'en est que la conséquence immédiate
  ([ADR-026](026-droit-a-l-effacement.md), invariant 10). Si réinitialiser levait
  l'exclusion, la collecte suivante remettrait la donnée en base sans que personne ne s'en
  aperçoive — et l'outil aurait promis un droit qu'il ne tient que jusqu'au prochain run.
  C'est le seul endroit du projet où « tout effacer » doit s'arrêter net, y compris pour
  une exclusion dont la portée est justement la commune effacée. Un test le garde.
- **Le `dump`.** Le registre est national et partagé par tous les départements ; le
  reprendre coûterait 1,25 Go pour rien.
- **`domaine_mail`.** Les verdicts MX sont indexés par domaine, pas par département :
  `orange.fr` sert des associations partout. C'est un cache, il se revalide seul.
- **Les compteurs globaux** (`metric` sans `run_id`), qui comptent la purge et la
  maintenance et n'appartiennent à aucun département.

**La suppression est explicite et ne s'en remet pas aux cascades.** `contact` et `page`
cascadent bien depuis `commune`, mais `association.code_insee` est en
`ON DELETE SET NULL` : effacer les communes y laisserait des associations rattachées à
rien, invisibles de toutes les requêtes par département et impossibles à retrouver
ensuite. L'ordre les prend avant, et un test compte les orphelines sur la table entière —
c'est justement la différence qu'un oubli produirait.

**Le cache disque part avant la base**, et l'ordre n'est pas indifférent : les chemins ne
sont connus que par `page.cache_path`. Les lignes supprimées d'abord, les fichiers
deviendraient introuvables et survivraient sans que rien ne puisse les désigner. Dans
l'autre sens, une interruption laisse au pire des lignes dont le cache manque — ce qu'un
crawl traite comme un cache froid, c'est-à-dire comme la normale.

**Deux garde-fous, et aucune question au clavier.** `--simulation` compte sans rien
écrire ; `--confirmer` est exigée pour effacer réellement. L'outil tourne dans un
conteneur, dans un exécutable lancé par double-clic et dans un script : une confirmation
interactive y serait tantôt impossible, tantôt silencieusement acceptée. La commande
refuse aussi tant qu'une collecte est ouverte sur le département — le worker écrit des
communes et des pages en continu, et effacer sous lui laisserait des lignes recréées juste
après la transaction, c'est-à-dire un département « effacé » qui ne l'est pas.

**Trois verbes, trois raisons d'effacer**, et ils ne doivent pas se confondre : `purge`
efface ce qui a plus de trois ans quel que soit le département (invariant 8) ; `oublier`
honore un droit et son effet doit survivre à toutes les collectes suivantes
(invariant 10) ; `reinitialiser` refait une collecte. Le nom est distinct pour cette
raison.

## Conséquences

- L'opération est idempotente : un second passage ne trouve plus rien et ne se plaint pas.
  C'est ce qu'attend l'invariant 9 d'une commande relancée après interruption.
- Les suppressions en base tiennent dans une transaction. Un département à moitié effacé
  ferait repartir une collecte sur une base incohérente.
- **Rien dans l'interface, et c'est délibéré.** Un bouton « tout effacer » à côté du bouton
  de lancement, dans un outil dont les utilisateurs sont des agents de collectivité, est un
  piège. L'opération relève de la mise au point, pas de l'usage courant ; elle reste donc
  là où l'on sait ce qu'on fait. Si le besoin apparaît côté écran, il devra passer par
  autre chose qu'un bouton — et par sa propre décision.
- La collecte suivante relit le registre national en entier pour ce département, puisque
  `ouvrirDump` ne reprend qu'une ligne `en_cours`. Réinitialiser ne change rien à ce coût,
  qui existait déjà pour tout nouveau département.
