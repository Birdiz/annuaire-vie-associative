# ADR-026 — Droit à l'effacement : une exclusion, pas une suppression

Statut : acceptée — 2026-08-23

## Contexte

L'outil produit un fichier de données personnelles collectées **indirectement**. Son
utilisateur, responsable de traitement (ADR-025), devra répondre à des personnes qui
demandent à en sortir : opposition (art. 21) et effacement (art. 17).

Avant le lot 9, il ne le pouvait pas. `grep "DELETE FROM" src/` ne rendait que la purge
par ancienneté et le dédoublonnage. L'action « rejeter » de l'écran de revue n'écrivait
qu'un `review_statut = 'rejete'` :

- l'option `--avec-rejetes` et la case de l'écran d'export **remettent** ces lignes dans
  le CSV ;
- et surtout, la campagne suivante **recollecte** l'adresse, puisque rien en base ne dit
  qu'elle ne doit plus entrer.

Une suppression sans mémoire n'est donc pas un effacement : elle dure jusqu'au prochain
run, et personne ne s'en aperçoit.

## Décision

**L'objet durable est l'exclusion ; la suppression n'en est que la conséquence
immédiate.** Une table `exclusion` (migration 10) retient ce que l'outil n'a plus le droit
de conserver, avec trois portées :

| Portée | Ce qu'elle vise |
|---|---|
| `contact` | une valeur normalisée précise |
| `domaine` | toutes les adresses d'un domaine de messagerie |
| `commune` | tout ce qui est rattaché à un code INSEE |

Oublier fait trois choses, et les trois comptent :

1. inscrire l'exclusion — consultée à chaque écriture de contact par le crawl, ce qui fait
   qu'une opposition survit à la campagne suivante ;
2. supprimer les lignes déjà en base ;
3. supprimer les copies en cache des pages qui portaient la donnée — le cache HTTP
   contient le HTML brut, donc l'adresse elle-même. L'y laisser reviendrait à effacer
   d'une main ce que l'on conserve de l'autre.

Le tout dans une seule transaction : une opposition à moitié honorée — la ligne supprimée,
l'exclusion absente — serait pire que rien.

Le **motif est obligatoire**, en ligne de commande comme dans l'interface. Un responsable
de traitement doit pouvoir dire au nom de quoi il a effacé, et le prouver.

## Ce que ce n'est pas

**Ce n'est pas une liste noire de collecte.** L'exclusion ne dit pas où l'outil a le droit
d'aller — `robots.txt` seul en décide, et cet invariant n'a pas d'option (§4.2). Elle dit
ce que l'outil n'a pas le droit de **retenir**. La distinction n'est pas rhétorique : une
liste d'URL à ne pas visiter serait un contournement de la logique de robots.txt, alors
qu'une liste de valeurs à ne pas conserver est une mesure de minimisation.

## Limite assumée

Le site tiers, lui, publie toujours l'adresse. Un nouveau crawl la remettra dans le cache
HTTP, où la purge à trois ans finira par l'emporter. Ce qui est garanti est qu'elle ne
rentrera plus dans l'annuaire — c'est-à-dire dans ce qui est exporté et transmis.

Cette limite est dite à l'utilisateur au moment où il efface, plutôt que d'être tue : elle
lui appartient, puisque c'est à lui de savoir ce qu'il peut répondre à la personne.

## Conséquences

- Une commande `annuaire oublier --contact | --domaine | --commune --motif <texte>`.
- Un bouton « Oublier » dans l'écran de revue, distinct de « Rejeter », avec sa mise en
  garde et son motif obligatoire.
- Un compteur `contacts_exclus` à l'extraction : ce que l'outil refuse de retenir se
  compte aussi (§8). Sans lui, une exclusion trop large passerait inaperçue.
- La consultation coûte une lecture indexée par contact écrit. C'est le prix pour que
  l'opposition survive au run suivant, et il est payé au bon endroit.
