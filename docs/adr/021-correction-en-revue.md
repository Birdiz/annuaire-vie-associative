# ADR-021 — Ce qu'un humain corrige, et ce que la base en fait

Statut : acceptée — 2026-08-22

## Contexte

`contact.review_statut` porte quatre valeurs depuis le lot 1 : `a_revoir`, `valide`,
`rejete`, `corrige`. Trois d'entre elles n'avaient jamais été atteintes, faute d'écran. La
quatrième posait en plus une question que le schéma laissait ouverte : **où range-t-on la
valeur corrigée ?** Il n'y avait pas de colonne pour elle.

Le lot 5 a rendu la question concrète. La validation MX a trouvé 41 domaines en
`EBADNAME`, tous issus d'adresses de la forme `abcdanse[^@]gmail.example` : un CMS
répandu chez les petites communes remplace l'arobase de ses `mailto:` par ce littéral.
**138 contacts** sont concernés, notés zéro depuis, et l'ADR-017 a explicitement renvoyé
leur sort à une décision humaine plutôt qu'à une désobfuscation automatique — « une
décision d'extraction, à prendre en regardant le §5 du brief ».

## Décision

### `valeur` n'est jamais réécrite

C'est ce qui a été lu sur la page : de la provenance au sens de l'invariant 5. La saisie
humaine vit dans une colonne à part, `valeur_corrigee`, et l'export sort les deux plus une
troisième colonne, `valeur_publiable`, qui dit laquelle utiliser. Trois colonnes pour une
adresse est verbeux ; écraser la première aurait coûté la capacité de dire d'où venait la
ligne, ce qui est précisément ce que l'outil promet.

`valeur_normalisee`, en revanche, **suit** la correction : c'est elle, et elle seule, que
le MX et la notation lisent. Une correction qui la laisserait derrière serait décorative.
Le régime juridique (§4.7) est recalculé sur la valeur corrigée, pour la même raison.

### La contradiction échoue en base, pas dans le serveur

Un contact `corrige` sans `valeur_corrigee` est une contradiction. SQLite ne sait pas
ajouter un `CHECK` de table par `ALTER` ; deux triggers `BEFORE INSERT` / `BEFORE UPDATE`
avec `RAISE(ABORT)` tiennent la même promesse au même endroit. C'est la discipline des
`UNIQUE` du lot 1 : une incohérence doit échouer même quand l'écriture vient d'ailleurs —
d'un script, d'une session `sqlite3` ouverte à la main.

De même, une correction qui fabriquerait un doublon **est refusée par l'index unique**, et
le message le dit. L'écraser silencieusement ferait disparaître un contact.

### La correction rouvre la notation, elle ne note pas

L'écran de revue remet `score_version` à `NULL` — le mécanisme de péremption que le lot 5
utilise déjà. Le prochain `annuaire normaliser` revalide la syntaxe, résout le MX du
nouveau domaine et renote la ligne. **Aucune logique de score dans le serveur HTTP** : le
barème a un seul propriétaire.

Conséquence visible, et assumée : entre la correction et le rejeu, la ligne n'a plus de
score. L'écran de revue affiche le nombre de corrections en attente et la commande qui les
note.

### Une valeur corrigée à la main ne reste pas plafonnée par la lecture machine

Le barème gagne un signal `corrigeEnRevue` : la base du produit devient **0,95** au lieu
de `confiance`. Sans lui, une adresse désobfusquée à la main garderait la base de 0,45 de
l'ADR-012, tout `--score-min` continuerait à l'écarter, et la revue ne servirait à rien.

0,95 et non 1 : l'humain a lu la même page que nous, il a pu se tromper aussi. Les autres
facteurs — MX, régime, rattachement — s'appliquent normalement par-dessus, et c'est voulu :
corriger une adresse ne prouve pas que son domaine reçoit du courrier.

`confiance` reste intacte. C'est la distinction que défend l'en-tête de `score.ts` : elle
dit comment la machine a **lu**, le score dit si le contact vaut d'être **publié**.

### §4.6 tient aussi dans la revue

Un numéro mobile saisi en correction est refusé, avec le message qui renvoie à
l'invariant. L'UI n'a pas de flag `--avec-mobiles`, et laisser les 06/07 entrer par la
revue ouvrirait une porte que personne n'a ouverte.

### Un contact rejeté ne sort plus de l'export

Par défaut, et `--avec-rejetes` le rétablit. Un arbitrage humain qui ne changerait rien au
fichier livré ne servirait à rien.

## Conséquences

**`VERSION_SCORE` passe à 2**, ce qui périme tous les scores en base et provoque une
renotation complète au prochain rejeu. C'est le comportement voulu : un barème modifié ne
doit pas laisser en base un mélange indiscernable d'anciens et de nouveaux scores.

**Le §8 gagne sa dernière métrique.** Le « taux de correction en revue humaine », seul
proxy de précision d'extraction que le brief demande, devient mesurable. Il se lit sur
l'**état** des lignes et non sur un compteur d'événements : valider puis corriger un même
contact compte deux événements pour une seule ligne, et le rapport serait faux.

**Les 138 adresses cassées de l'ADR-017 ont maintenant un chemin.** Notées zéro, elles
arrivent en tête de la file de revue, qui est ordonnée par score croissant. Les réparer
reste une décision humaine, prise ligne par ligne — la désobfuscation automatique, elle,
n'est toujours pas tranchée.
