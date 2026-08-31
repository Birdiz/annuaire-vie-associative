# ADR-031 — Réinitialiser un département, sans lever les exclusions

Statut : acceptée — 2026-08-30, **révisée le même jour** (voir « Révision »)

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

Une commande `annuaire reinitialiser --departement <dd>`, et — après révision — un bloc
dédié sur l'écran de synthèse.

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
- La collecte suivante relit le registre national en entier pour ce département, puisque
  `ouvrirDump` ne reprend qu'une ligne `en_cours`. Réinitialiser ne change rien à ce coût,
  qui existait déjà pour tout nouveau département.

## Révision — le même geste à l'écran

Cette décision excluait d'abord toute exposition dans l'interface : « un bouton *tout
effacer* à côté du bouton de lancement, dans un outil dont les utilisateurs sont des agents
de collectivité, est un piège ». Le raisonnement portait sur **un bouton qui efface au
clic**. Il ne vaut plus dès lors que le geste se fait en deux temps.

Le bloc de l'écran de synthèse reprend donc exactement la mécanique de la ligne de commande,
et pour les mêmes raisons :

- **Le premier clic ne fait que compter.** Il affiche ce qui partirait — communes,
  associations, contacts, pages, collectes — et, à côté, **ce qui reste** : les effacements
  déjà demandés par des personnes, le registre national, les autres départements. Montrer
  ce qui part sans dire ce qui survit serait mentir par omission, en particulier sur le
  droit à l'effacement.
- **Le second clic seul supprime**, sous un libellé qui nomme le département.
- **Pas de `confirm()`.** La CSP est `default-src 'self'` : aucun script en ligne ne
  s'exécute. C'est une contrainte heureuse — une boîte de dialogue du navigateur est
  précisément ce qu'on renvoie sans lire, là où un aller-retour serveur impose un écran.

Deux points de mise en œuvre qui ne sont pas des détails :

- **Le bloc vit hors du suivi**, qui se remplace toutes les deux secondes (ADR-024). Un
  écran de confirmation qui disparaît pendant qu'on le lit serait la meilleure façon de
  faire cliquer sans comprendre.
- **L'état vit dans le fragment rendu, pas en mémoire.** htmx remplace le bloc par la
  réponse : la réponse *est* l'état. Un rechargement de page revient donc au repos, ce qui
  est le sens de lecture le plus sûr pour une opération irréversible. Rien ne lie les deux
  requêtes — l'onglet a pu rester ouvert une heure — donc **le décompte est refait à la
  confirmation**, et le garde-fou de la collecte ouverte est revu aux deux temps : une
  collecte a pu démarrer entre les deux écrans, et c'est l'état au moment d'effacer qui
  compte. Un test le vérifie en démarrant une collecte entre la simulation et la
  confirmation.

Le bloc est placé en bas de l'écran, loin du bouton de lancement, dans un encadré à part.
La couleur d'alerte est réservée au moment où l'on montre ce qui va partir, pas à
l'invitation à regarder.
