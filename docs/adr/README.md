# Décisions d'architecture

Une ADR est écrite dès qu'un arbitrage non trivial est fait (§10 du brief). Format :
contexte, décision, conséquences — y compris celles qu'on assume à contrecœur.

Une ADR acceptée ne se réécrit pas : on en ajoute une qui la remplace.

| # | Titre | Statut |
|---|---|---|
| [001](001-runtime-et-packaging.md) | Runtime et packaging : `node:sqlite` + SEA | Acceptée |
| [002](002-file-de-jobs-par-bail.md) | File de jobs par bail expirant | Acceptée |
| [003](003-cache-adresse-par-hash.md) | Cache adressé par hash, écriture atomique | Acceptée |
| [004](004-cle-de-throttling.md) | Clé de throttling : hôte + /24 | Acceptée |
| [005](005-acces-aux-dumps-data-gouv.md) | Accès aux dumps data.gouv sans enfreindre robots.txt | Acceptée |
| [006](006-sources-de-donnees-du-lot-2.md) | Sources du lot 2 sous contrainte de `robots.txt` | Acceptée |
| [007](007-telechargement-en-flux.md) | Télécharger en flux, à côté de `fetch` | Acceptée |
| [008](008-job-de-longue-haleine.md) | Jobs de longue haleine : commits par tranche | Acceptée |
| [009](009-peuplement-des-communes.md) | Peupler `commune` depuis l'Annuaire | Acceptée |
| [010](010-decoupage-du-crawl.md) | Un job par page, et un budget par campagne | Acceptée |
| [011](011-premiere-dependance-runtime.md) | Première dépendance runtime : `node-html-parser` | Acceptée |
| [012](012-rattachement-et-regime-des-contacts.md) | Rattachement déterministe, et régime des contacts | Acceptée |
| [013](013-ordre-de-parcours-et-budget.md) | Ordre de parcours du crawl, et budget a 20 pages | Acceptée |
| [014](014-prefiltre-consultatif.md) | Pré-filtre consultatif, et portillon à deux conditions | Acceptée |
| [015](015-temporalite-rna-et-dormance.md) | Champs temporels du RNA, et qualification de la dormance | Acceptée |
| [016](016-reenfilement-et-fraicheur-des-index.md) | Réenfiler un job, et ne pas mettre un index en cache | Acceptée |
| [017](017-validation-mx.md) | Validation MX : une porte DNS, et un fait de domaine | Acceptée |
| [018](018-classification-en-six-types.md) | Six types : ce que le code RNA porte, et ce qu'il ne porte pas | Acceptée |
| [019](019-deduplication-et-score-de-revue.md) | Déduplication, et un score distinct de la confiance de lecture | Acceptée |
| [020](020-porte-d-entree-locale.md) | Une porte d'entrée locale, et un fichier tiers embarqué | Acceptée |
| [021](021-correction-en-revue.md) | Ce qu'un humain corrige, et ce que la base en fait | Acceptée |
| [022](022-un-artefact-trois-emballages.md) | Un artefact, trois emballages | Acceptée |
| [023](023-l-interface-et-le-conteneur.md) | L'interface et le conteneur | Acceptée |
| [024](024-lancer-un-run-depuis-l-interface.md) | Lancer un run depuis l'interface | Acceptée |
| [025](025-regime-juridique-et-obligations.md) | Régime juridique et obligations de l'utilisateur | Acceptée |
| [026](026-droit-a-l-effacement.md) | Droit à l'effacement : une exclusion, pas une suppression | Acceptée |
| [027](027-drapeau-des-mobiles-et-avancement-du-run.md) | Le drapeau des mobiles à l'écran, et l'avancement du run | Acceptée |
| [028](028-publication-de-l-executable.md) | Publier l'exécutable, et le vérifier là où il tourne | Acceptée |
