# ADR-030 — Réparer une arobase masquée, et rien d'autre

Statut : acceptée — 2026-08-30

## Contexte

L'[ADR-017](017-validation-mx.md) avait mesuré, sur l'Ille-et-Vilaine, **138 adresses de la
forme `abcdanse[^@]gmail.com`** : un CMS répandu chez les petites communes écrit ses
`mailto:` avec l'arobase remplacée par ce littéral, et laisse un script de la page la
reposer côté client. L'invariant 1 nous interdit d'exécuter ce script.

Le trajet de ces adresses était le suivant. `nettoyerEmail` les accepte — son motif est
volontairement large, « du texte, une arobase, du texte, un point, deux lettres », et
`alp.basket35[^@]orange.fr` y répond. Elles entraient donc en base telles quelles. Trois
étapes plus loin, `validerEmail` les refusait — ni `[` ni `]` n'ont droit de cité dans une
partie locale non guillemetée — le score tombait à zéro, et elles arrivaient en tête de
la file de revue, où il fallait les corriger **une par une**.

`src/normalisation/validation.ts` disait explicitement pourquoi il ne les réparait pas :
« reconstruire ces adresses serait une désobfuscation, donc une décision d'extraction [5]
et non de normalisation ». La décision était donc renvoyée, pas tranchée.

Un second défaut, de même nature, est apparu en cherchant le premier : un
`href="mailto:mailto:club@asso.fr"` — le préfixe posé deux fois par un CMS — laissait le
second `mailto:` collé à la valeur, l'extraction n'en retirant que le premier. Même
trajet, même symptôme, puisque `:` n'a pas davantage droit de cité dans une partie locale.
Et `nettoyerEmail` étant partagé avec la case de correction de la revue, un lien collé tel
quel y était accepté avec son préfixe.

## Décision

**On répare le littéral `[^@]`, à l'extraction, et uniquement lui.**

Ce qui rend cette substitution différente d'une désobfuscation générale : **aucune adresse
valide ne contient de crochets**. La substitution ne peut donc pas abîmer une adresse
correcte — elle ne s'applique qu'à des chaînes qu'aucune adresse ne peut prendre. Déduire
une arobase du mot « at » dans de la prose reste, à l'inverse, une inférence sur du texte
libre : ce cas-là garde sa confiance basse et son traitement séparé.

La réparation est refusée si elle ne laisse pas **exactement une arobase** : au-delà, on a
affaire à autre chose et on ne touche à rien.

**La provenance dit qu'il y a eu réparation.** La méthode d'extraction devient
`dom:mailto+repare`, distincte de `dom:mailto`. L'export et la carte de revue la portent :
le fichier ne doit pas laisser croire que la page contenait littéralement cette chaîne.

**La confiance vaut 0,75**, entre les deux valeurs voisines et pas par goût du milieu. La
page **déclare** un lien de courriel : c'est le signal le plus fort dont on dispose, celui
de `CONFIANCE_DOM` (0,9). Mais l'adresse rendue n'est pas celle qui est écrite, et une
provenance honnête ne peut pas donner à une reconstruction la note d'une lecture. Elle
reste nettement au-dessus de `CONFIANCE_OBFUSQUE` (0,45), qui paie une inférence autrement
plus hardie.

Ce chiffre a une conséquence directe, et c'est pourquoi il est arbitré ici plutôt que
choisi au hasard : `base` du score vaut `confiance`, et le score ne fait ensuite que
descendre. À 0,45, ces adresses resteraient sous le seuil d'export courant de 0,6 —
réparées, mais toujours absentes du fichier livré. Réparer sans franchir le seuil ne
servirait à rien.

**Le schéma `mailto:` est retiré dans `nettoyerEmail`**, et non dans la seule branche
d'extraction. C'est le contrat de cette fonction depuis le lot 6 : une adresse saisie à la
main en revue doit être nettoyée exactement comme une adresse lue, sans quoi deux
populations que rien ne distingue cohabiteraient en base. Un lien collé dans la case de
correction est le cas courant.

## Conséquences

- Ces adresses cessent de traverser la revue humaine pour un défaut mécanique. La file
  garde ce qui mérite un jugement.
- La colonne `methode_extraction` gagne une valeur. Rien ne la parse — c'est de la
  provenance opaque, lue par un humain — donc aucun consommateur n'est cassé.
- **Les lignes déjà en base ne sont pas réparées.** Le correctif porte sur l'extraction,
  et il n'existe aujourd'hui aucun rejeu hors-ligne qui réécrive les contacts :
  `rejouerPrefiltre` relit bien les corps depuis le cache, mais ne met à jour que le
  verdict des pages. Une base déjà collectée garde donc ses valeurs cassées jusqu'à la
  collecte suivante, qui ajoutera l'adresse réparée à côté sans retirer l'ancienne.
- Une réparation rétroactive n'est pas un simple `UPDATE` : deux index `UNIQUE` portent
  sur `valeur_normalisee`, et réparer une adresse peut la faire entrer en collision avec
  la version propre de la même adresse, déjà présente. Elle demande donc une politique de
  fusion explicite — sujet distinct, à trancher ailleurs.

## Alternative écartée

**Réparer à la normalisation plutôt qu'à l'extraction.** C'est là que le défaut est
constaté, et la tentation est grande. Mais la normalisation lit `contact.valeur` sans
savoir d'où elle vient : elle ne peut pas distinguer une adresse cassée par un CMS d'une
adresse saisie de travers, ni ajuster la provenance en conséquence. L'extraction, elle,
sait qu'elle lit un `href` de `mailto:` — c'est cette connaissance qui autorise la
substitution et qui justifie la confiance retenue.

**Reconnaître toute paire de crochets** plutôt que ce seul littéral. L'ADR-017 avait
laissé la désobfuscation ouverte ; l'ouvrir en grand n'est pas la refermer. On ferme le
cas mesuré, dont on sait qu'il ne peut pas se tromper.
