# ADR-010 — Un job par page, et un budget par campagne

Statut : acceptée — 2026-08-18

## Contexte

L'étape [3] du §6 doit explorer, pour chaque commune, le site de sa mairie jusqu'à
profondeur 2, sous un budget de pages. Deux découpages étaient possibles : un job par
commune, qui mène son parcours en largeur en mémoire, ou un job par page.

Le job par commune a un attrait immédiat : le budget se tient dans une variable locale,
sans aucune lecture en base. Mais il rejoue exactement la situation que l'ADR-008 a dû
concéder au lot 2 — un handler qui écrit pendant son exécution, donc hors de la
transaction qui le marque terminé. L'ADR-008 disait déjà qu'un troisième handler de
cette forme, sans flux de plusieurs centaines de mégaoctets à justifier, « serait le
signe qu'il fait fausse route ».

Restait à décider où vit l'état du parcours. La table `page`, créée au lot 1, n'avait
jamais servi.

## Décision

**Un job par page.** `decouverte_planifiee` ouvre la campagne d'un département,
`page_crawl` traite une page. Ni l'un ni l'autre n'écrit hors de son `commit(db)` :
l'exactement-une-fois redevient une propriété du cadre, et non de chaque handler. Aucun
des deux ne réserve de mémoire proportionnelle à la taille du travail, et la reprise
après un arrêt brutal est granulaire à la page.

**`skipped` est réservé au payload inexploitable.** Le cadre n'exécute le `commit` que
sur la branche `done` (`src/jobs/worker.ts`). Or une page interdite par `robots.txt`,
absente, ou qui n'est pas du HTML n'est pas un job raté : c'est un job réussi dont le
résultat est négatif, et ce résultat doit être écrit. Rendre `skipped` perdrait
l'information, ou obligerait à écrire hors transaction. À l'inverse, un échec
transitoire — 429, 5xx, temporisation — est relancé par une exception, ce qui rend la
main au backoff et aux `max_attempts` de la file plutôt que de les réimplémenter.

**Le budget se lit par comptage, dans la transaction qui l'autorise.** Une ligne `page`
est écrite à l'*enfilement*, pas à la visite ; le budget est alors
`count(*) FROM page WHERE campagne = ? AND code_insee = ?`, lu dans le même
`BEGIN IMMEDIATE` que les insertions qu'il autorise. SQLite ne laissant progresser
qu'une écriture à la fois, deux workers ne peuvent pas compter simultanément le même
budget. **Ne pas remplacer `transaction()` par un `BEGIN` nu : c'est ce détail qui rend
le budget correct.**

**La clé de `page` porte la campagne et la commune.** L'unicité globale de `page.url`,
héritée du lot 1, était fausse sur deux plans :

- Le lot 2 attribue la même `url_mairie` à tous les codes INSEE d'une fiche, une commune
  nouvelle conservant les codes de ses communes déléguées. La seconde commune n'aurait
  eu aucune ligne, donc aucune page et aucun contact — silencieusement. Le coût réseau
  du doublon est nul : le cache HTTP est adressé par URL (ADR-003), la seconde commune
  est servie par le cache.
- Rien ne distinguait deux passages. La seconde campagne aurait trouvé le budget déjà
  consommé par la première et n'aurait plus rien exploré, définitivement.

La migration 3 recrée donc `page` avec `url_hash = sha256(campagne \n code_insee \n url)`
et `UNIQUE (campagne, code_insee, url)`. La recréation est sans risque ici — aucune table
ne référence `page`, et seule la purge la lit — ce qui la distingue du cas de la
migration 2, où recréer `commune` aurait exigé de désactiver les clés étrangères.

**`planifiee_at` rend une page purgeable.** La purge du lot 1 ne supprimait que ce qui
portait `fetched_at`. Une page planifiée puis jamais visitée — ce que laisse un arrêt
brutal — aurait été immortelle et aurait consommé le budget de sa commune pour toujours.
`src/purge.ts` s'appuie désormais sur `coalesce(fetched_at, planifiee_at)`.

**Le résultat du crawl ne touche pas `statut_resolution`.** L'ADR-009 confiait au lot 3
la vérification que l'URL répond, mais rétrograder `resolue` en `echec` aurait oscillé :
le seed du run suivant l'aurait remontée. Deux faits distincts, deux colonnes :
`statut_resolution` dit ce que déclare l'Annuaire, `crawl_statut` ce qu'on a constaté.

## Conséquences

Le nombre de jobs est de l'ordre du nombre de pages, soit quelques milliers par
département — sans commune mesure avec les deux jobs du lot 2, mais la table `job` est
indexée pour l'éligibilité et chaque job reste court.

Le budget est consommé dans l'ordre d'achèvement, pas dans l'ordre du mérite : les liens
de la page d'accueil sont enfilés avant que les meilleures pages de profondeur 2 ne
soient connues. La priorité de la file est dérivée du score pour corriger l'ordre de
*prise*, mais pas celui de la *réservation* : une page moyenne découverte tôt peut encore
prendre la place d'une meilleure découverte tard. C'est acceptable tant que le budget
n'est pas serré ; c'est la mesure du lot 4 qui dira s'il faut une passe de tri.

Deux communes partageant un site produisent deux jeux de contacts, un par commune. C'est
voulu — chacune doit apparaître dans son annuaire — mais cela signifie qu'un même contact
peut exister en plusieurs exemplaires en base. La déduplication est l'étape [7].
