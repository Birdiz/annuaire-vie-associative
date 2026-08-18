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
