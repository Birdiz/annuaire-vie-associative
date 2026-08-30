# ADR-029 — Une barre de portée, et le vocabulaire de l'utilisateur

Statut : acceptée — 2026-08-30

## Contexte

Quatre reproches faits à l'interface après usage réel, et ils se ramènent à deux.

**Le département était partout à l'écran et nulle part modifiable.** Il figurait dans le
badge d'en-tête, dans le libellé du bouton de lancement (« Lancer le run complet sur le
département 35 »), dans celui du téléchargement (« Télécharger l'annuaire du département
35 »), et dans l'URL. Pendant ce temps, le seul contrôle qui permettait d'en changer —
`choixDepartement` — ne s'affichait **qu'à partir de deux départements en base**
(`if (departements.length <= 1) return ""`) et ne proposait que ceux déjà amorcés.

D'où la situation constatée : sur une base amorcée sur le seul 35, l'outil répétait « 35 »
six fois par écran et **n'offrait aucun chemin vers le 88**. Le pipeline l'acceptait
pourtant — `?departement=88` tapé à la main dans la barre d'adresse fonctionnait — mais
rien à l'écran ne le laissait deviner. L'outil paraissait soudé à un département, alors
qu'il ne l'était que dans son interface.

**L'écran parlait la langue du dépôt.** Cinq mentions visibles renvoyaient à des documents
que l'utilisateur n'a pas : `ADR-025` deux fois, `§4.6`, `§4.7`, `§8`. Les étages de
l'entonnoir portaient la numérotation interne des étapes du brief — « [1] associations
actives », « [5] contacts extraits » — et trois messages renvoyaient à « l'étape [8] ».
Ajouter une documentation pour rendre ces renvois lisibles alourdirait l'outil ; les
retirer ne coûte rien, puisque ce qu'ils désignent se dit en français.

Deux constats mineurs se sont ajoutés en cours de route. L'écran de revue affichait une
valeur nue au-dessus de six contrôles, sans jamais dire de quoi il s'agissait ni ce qui
était attendu — devant `mairie@exemple.fr`, rien ne disait s'il fallait juger l'adresse,
la commune, ou l'absence d'association rattachée. Et la passe d'amorce déclarait
« cette passe n'a pas de décompte » pendant les vingt minutes que dure la lecture du
registre, alors que `dump.consumed_bytes` et `dump.total_bytes` en donnent un.

## Décision

**Une barre de portée, sous le bandeau, et le département ne se dit qu'à cet endroit.**
Elle est rendue sur les trois écrans, quel que soit le nombre de départements en base.
Les libellés d'action redeviennent neutres : « Lancer le run complet », « Télécharger le
fichier ».

**Le champ est une saisie libre, pas une liste.** C'est le point de la décision : un
département qui n'est pas encore en base est justement celui qu'on veut pouvoir demander.
Une liste des départements connus ne peut, par construction, jamais offrir le premier
département suivant. Les départements déjà amorcés restent proposés, en liens visibles
et en `datalist` — un `datalist` seul est une affordance invisible.

La barre dit ce que la base contient pour le département affiché : « 4 associations dans
1 commune », ou « Jamais amorcé. Le lancer le remplira depuis le registre national ». Un
écran de zéros ne distingue pas « rien trouvé » de « jamais collecté ».

**Le paramètre `?departement=` reste dans l'URL.** C'est lui qui rend une page de revue
rechargeable, partageable, et qui permet deux onglets sur deux départements. Ce qui
gênait n'était pas sa présence mais sa répétition à l'écran, et c'est elle qui disparaît.
La valeur est normalisée (`« 2a » → « 2A »`) et vérifiée par `departementBienForme` ; une
valeur malformée ne se promène pas d'écran en écran, on retombe sur le département courant
en disant pourquoi. Le `pattern` du formulaire fait le même contrôle côté navigateur et ne
dispense pas de celui-ci.

**Aucune référence interne à l'écran.** Les cinq renvois sont réécrits en clair, la
numérotation des étapes disparaît des étages de l'entonnoir et des messages. Les
références *légales* restent : « article 14 du RGPD » désigne un texte que l'utilisateur
peut aller lire, ce qui n'est pas le cas d'`ADR-025`. Un test parcourt les trois écrans et
échoue sur `ADR-\d+`, `§\s*\d` ou `\[\d+\]` dans le corps de la page.

**La passe d'amorce compte en octets.** `dump.consumed_bytes` est l'offset de reprise : il
est avancé dans la même transaction que les lignes produites, donc il ne ment pas. L'écran
en fait une barre et dit ce que cet octet signifie : « 512 Mo sur 1,25 Go lus », « le
fichier est lu au fil de l'eau, jamais écrit sur le disque ».

**L'écran de revue dit ce qu'il demande.** Un chapeau nomme le type de chaque valeur
(« Adresse email », « Numéro de téléphone »), une introduction dit ce qu'est une carte, et
une légende repliée explique les quatre actions. Celles-ci sont groupées par intention —
trancher, corriger, effacer — plutôt qu'alignées bout à bout, où un champ paraissait
appartenir au bouton qui le précède. **Aucune n'est mise en avant** : « Valider » en
bouton plein, répété sur dix cartes, fabrique un rang de boutons qui appelle le clic, or
l'écran existe pour que la décision soit prise contact par contact.

## Conséquences

- Le département reste l'unité de travail du pipeline, et rien ici ne le change. Ce qui
  change est qu'on peut en ouvrir un autre depuis l'écran.
- Un département jamais amorcé s'affiche vide et se remplit en lançant le run. C'est le
  comportement voulu, et la barre le dit avant qu'on clique.
- La liste des runs et la file de jobs restent globales : elles ne sont pas filtrées par
  la portée affichée. Un run ouvert sur le 35 reste visible depuis l'écran du 88, avec son
  département nommé dans la ligne et dans le tableau. C'est exact — il n'y a qu'une file —
  mais cela demande de lire la ligne, pas seulement de voir une barre bouger.
- Écrire « par construction » sur l'absence de jargon suppose un test qui rougit : c'est
  celui sur `ADR-\d+`, `§\s*\d` et `\[\d+\]`. Il exclut le `<head>`, où la configuration
  htmx porte des codes de statut `[23]..` et `[45]..` qui sont des expressions régulières.

## Alternative écartée

**Une portée « tous les départements ».** Elle a été demandée et n'est pas retenue ici.
Rien ne s'y oppose côté données — `commune.code_insee` est national, seul le prédicat
`WHERE departement = ?` d'une dizaine de requêtes est à rendre optionnel — et l'amorce y
gagnerait même : le registre est aujourd'hui relu en entier pour chaque département, soit
101 × 1,25 Go là où une passe nationale en lirait 1,25 une fois. Ce qui s'y oppose est
l'étape de découverte : environ 34 900 communes à 20 pages, soit jusqu'à 700 000 requêtes,
sous un plancher de 2 s par clé de throttling (ADR-004) et une concurrence plafonnée à 16.
Le meilleur cas arithmétique est de l'ordre de deux jours de collecte continue, et le cas
réel bien davantage puisque la clé `/24` regroupe délibérément les communes hébergées
ensemble. Ce n'est pas un bouton, c'est une campagne — elle mérite sa propre décision.
