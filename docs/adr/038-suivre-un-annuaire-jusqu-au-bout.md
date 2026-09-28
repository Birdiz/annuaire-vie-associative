# ADR-038 — Suivre un annuaire jusqu'au bout

Statut : acceptée — 2026-09-28

## Contexte

Rillieux-la-Pape (Rhône) publie un annuaire de 203 associations : 34 pages de liste de
six cartes, chacune liée à sa fiche. Le client le décrit comme « super bien renseigné ».
Le fichier livré en tirait quatre lignes.

L'exploration ne sait pas ce qu'est un annuaire (ADR-010, ADR-013) :

- elle garde huit liens par page ;
- elle s'arrête à deux sauts de l'accueil ;
- elle ne dépense que vingt pages par commune.

L'annuaire est atteint au premier saut. Ses liens de fiche, notés 7 (« associ » et
« annuaire » dans le chemin), prenaient les huit places, devant la pagination et devant
les autres rubriques. La page 2 de la liste n'était jamais demandée.

Deux défauts s'y ajoutaient :

- **Le courriel des fiches est chiffré** par le CMS (ADR-037).
- **Le nom des cartes était mal lu.** Le bloc d'une carte porte aussi sa catégorie
  (« Culture du monde ») et l'adresse du siège (« Chez M. … »). L'ancienne version en
  tirait des noms de personnes.

## Décision

**Reconnaître la liste d'un annuaire à sa forme, et la suivre avec un budget à part.**

### Reconnaître

`reconnaitreAnnuaire` (`src/decouverte/annuaire.ts`) juge le *chemin* de la page, jamais
sa query, puisqu'une page de pagination garde le chemin de la première. Trois conditions :

1. Le chemin annonce des associations (« associ ») et ne porte aucun terme de rubrique
   administrative ou hors sujet. Son dernier segment ne nomme pas non plus un autre
   annuaire : professionnels, santé, équipements, entreprises, services. Cela écarte les
   actualités de la vie associative, l'annuaire général de la mairie et ceux qui ne sont
   pas associatifs.
2. La page lie au moins cinq enfants directs de son chemin, sans query. Ce sont les
   fiches. En sont exclus les utilitaires du CMS (`pdf`, `feed`, `imprimer`…) et les liens
   que le site a mal écrits, qui se résolvent en relatif (`www.club.fr`, `nom@club.fr`). Une seule suffit sur une page déjà atteinte par la pagination, dont la dernière
   n'a souvent que quelques cartes.
3. La pagination est reconnue sous deux formes : le même chemin avec un paramètre de page
   entier (`page`, `p`, `paged`, `tx_paginate[currentPage]`, `start`…), ou `…/page/N`.

Une page atteinte comme fiche peut elle-même être une liste. Un annuaire rangé par
catégories se suit ainsi niveau par niveau, au lieu de s'arrêter aux catégories.

### Suivre

La colonne `page.role` (migration 14) vaut `exploration`, `pagination` ou `fiche`. Chaque
rôle a sa règle :

- **Pagination** : elle se suit, et chaque page de liste étend à son tour l'annuaire.
- **Fiche** : c'est une feuille.
- **Exploration** : elle garde ses règles. Les liens de l'annuaire en sont retirés, pour
  ne plus prendre la place des rubriques.

**Budget à part : 300 pages d'annuaire par commune**, en plus des 20 d'exploration. Ce
chiffre a été arbitré avec le client sur Rillieux (34 pages de liste et 203 fiches). Il se
règle par `--max-pages-annuaire`, et 0 revient au comportement d'avant. Comme
`--max-pages`, le réglage reste en ligne de commande et n'entre pas dans le fichier de
configuration. Ce n'est pas un invariant : les invariants 2, 3 et 8, eux, ne se règlent
nulle part.

**Les pages d'annuaire passent après toute l'exploration** (priorités 200 et 205, au-delà
de toutes les bandes de profondeur). Rillieux demande `Crawl-delay: 5` : ses 237 pages y
prennent une vingtaine de minutes. Servies plus tôt, elles occuperaient un worker pendant
que des accueils de mairie attendent, et un run interrompu laisserait un annuaire complet
et des communes jamais visitées. La liste passe avant ses fiches, puisque c'est elle qui
les fait connaître.

### Ce que la mesure a corrigé

La première version reconnaissait « annuaire » **ou** « associ ». Sur une collecte neuve du
Rhône, elle a suivi :

- l'annuaire général de trois mairies (`/annuaire` à Chaponnay, Saint-Martin-en-Haut et
  Dardilly, qui a consommé à elle seule ses 300 pages) ;
- des annuaires de professionnels, de santé et d'équipements rangés sous la vie
  associative.

Leurs fiches sortaient au profil simple, entreprises de transport et cardiologues compris,
avec l'indice associatif que le mot « annuaire » donne à leur URL (ADR-034). C'est le
reproche des « garages » du client de la Loire. Le chemin doit désormais porter
« associ ». Ce sont des lignes en moins sur ces communes, et c'est voulu : un annuaire
mélangé rapporte plus de rebut que d'associations.

La même mesure a fait apparaître d'autres défauts, corrigés dans la foulée :

- **Les utilitaires et les liens mal écrits**, décrits plus haut. `…/pdf` répondait 500 à
  Rillieux et se retentait cinq fois.
- **Le bouton en fin d'ancre** : « ASMC Yoga Fiche annuaire », quand toute la carte est un
  seul lien. Le même libellé se trouvait aussi, caché, dans le `<h1>` des fiches de
  Charbonnières. « Fiche annuaire », « En savoir plus », « Voir la fiche » sont retirés de
  l'ancre comme du titre, en fin de texte seulement.
- **Les services municipaux** : `…/thematique-annuaire/services-municipaux`, que
  l'exploration visitait davantage une fois libérée des liens d'annuaire, livrait le
  cabinet du maire. Ces rubriques rejoignent les termes administratifs du scoring. De même,
  « annuaire de la santé » et « annuaire des professionnels » rejoignent les termes hors
  sujet : ils livraient des orthoptistes.

### Nommer

Le nom est cherché selon le rôle de la page. Dans les deux cas suivants, il passe par le
même filtre que tout nom lu, et le bloc reste le recours si ce nom est refusé.

- **Sur la liste**, une carte nomme sa structure par l'ancre de son lien vers la fiche. On
  remonte du bloc le plus étroit autour du contact jusqu'au premier qui porte un tel lien :
  le paragraphe du téléphone n'en porte pas, l'`article` de la carte si. S'il en porte
  plusieurs, on s'abstient.
- **Sur la fiche**, le `<h1>` nomme tout contact hors gabarit (`footer`, `nav`, `aside`),
  pour que le standard de la mairie en pied de page ne prenne pas le nom de chaque
  association. Deux exceptions : une fiche qui porte plus de six contacts, et une fiche qui
  est elle-même une liste. Ce sont des rubriques, et leur titre (« Associations
  sportives ») ne nomme personne. Le chiffre de six est à mesurer, comme l'a été celui de
  l'ADR-035.

Le sous-titre de la fiche (« Association culturelle portugaise de … ») ne sert **qu'au
rattachement au RNA**, jamais de nom. S'en servir comme nom sortirait la même structure
sous deux lignes : « ACPR » pour le téléphone lu sur la liste, et la forme longue pour le
courriel lu sur la fiche.

La passe de nommage (`annuaire noms`, et la réparation au démarrage) suit le même chemin,
avec le rôle lu en base. `VERSION_NOM` passe à 5.

### Au passage : robots.txt juge l'URL qu'on demande

`selectionner` rendait la forme canonique d'une URL, query triée, et c'est elle qui partait
sur le réseau et que robots.txt jugeait. `/p?id=5&a=1` devenait `/p?a=1&id=5` et échappait
à `Disallow: /*?id=*` : une entorse latente à l'invariant 2. La query était en plus
réencodée (`%20` en `+`). Désormais, la forme canonique reste la clé de déduplication et de
hachage, et le payload du job porte `urlRequete`, l'URL telle que la page l'écrit. Un
payload antérieur n'a pas ce champ et se comporte comme avant.

## Conséquences

- **Une campagne reprise après la mise à jour se met à suivre les annuaires.** Un payload
  sans `role` se lit en `exploration`, avec le budget par défaut. C'est le comportement
  voulu.
- Les bases déjà collectées gagnent le nouveau nommage à l'ouverture, depuis le cache.
  Pour gagner les pages d'annuaire, il faut recollecter.
- Diagnostic : `annuaire pages --commune <insee>` montre toutes les pages d'une commune,
  bloquées comprises, avec leur rôle.
- Compteurs : `annuaires_reconnus`, `pages_pagination`, `pages_fiche`,
  `budget_annuaire_atteint`.
- Les numéros de Rillieux sont surtout des 06/07. Ils restent exclus par défaut
  (invariant 6) : c'est au client de cocher l'option s'il en a le droit.

## Alternatives écartées

**Relever les plafonds d'exploration** (profondeur, liens par page, budget). Cela aurait
coûté sur toutes les communes, surtout en rubriques administratives, pour ne couvrir un
annuaire qu'à moitié.

**Lire le sitemap.** Il énumère les fiches sans dire lesquelles sont des associations, et
la reconnaissance par la forme suffit sur le cas mesuré.

**Fiches adressées par `?id=`.** Cette forme sert aussi aux filtres, aux tris et aux
agendas : elle n'est pas reconnue. À rouvrir si la mesure en montre.
