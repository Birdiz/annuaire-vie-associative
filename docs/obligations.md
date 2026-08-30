# Obligations de l'utilisateur

Cette section n'est pas une formalité, et ce n'est pas une politesse : **c'est vous qui êtes
responsable de traitement**, pas l'éditeur de cet outil.

La raison est mécanique. Les requêtes partent de votre machine, la base est un fichier sur votre
disque, et l'outil n'émet aucun appel vers une infrastructure de l'éditeur — un test échoue si
une telle adresse apparaît dans le code. L'éditeur est donc simple fournisseur d'outil. Il n'y a
personne d'autre que vous derrière les obligations qui suivent. Le raisonnement complet est dans
l'[ADR-025](adr/025-regime-juridique-et-obligations.md).

**Avant de lancer une collecte :**

- **Établissez votre base légale.** Pour une collectivité, la mission d'intérêt public
  (art. 6.1.e) est généralement le fondement pertinent. Pour un autre acteur, l'intérêt légitime
  (art. 6.1.f) exige une mise en balance, et elle se documente. L'outil ne choisit pas pour vous.
- **Inscrivez le traitement à votre registre**, avec sa durée de conservation : trois ans, purgés
  automatiquement au démarrage.
- **Renseignez une URL de contact joignable depuis Internet.** Elle est annoncée dans le
  User-Agent de chaque requête, et l'outil refuse de collecter sans elle. Une adresse locale ou
  privée est refusée : un User-Agent qui ne mène nulle part vaut un User-Agent anonyme.

**Après la collecte, et c'est l'obligation la plus souvent oubliée :**

- **Informez les personnes concernées** (art. 14 — collecte indirecte). Au plus tard un mois
  après la collecte, ou dès la première communication des données si elle intervient avant.
- **Sachez lire la colonne `regime` de l'export.** `nominatif` désigne une adresse qui identifie
  une personne physique (`prenom.nom@`) ; `generique` une adresse de fonction (`contact@`) ;
  `indetermine` un cas que l'outil refuse de trancher plutôt que de deviner. Le régime le plus
  strict s'applique au premier, et la prudence reste de mise pour les autres — une adresse de
  fonction peut être relevée par une personne identifiable.
- **N'utilisez pas ce fichier pour prospecter.** L'outil n'envoie aucun courriel, et c'est un
  interdit de conception ; rien ne vous empêche techniquement d'importer le CSV ailleurs. La
  doctrine de la CNIL sur le moissonnage à fin de prospection est frontale sur ce point.

**Quand une personne s'y oppose :**

```bash
npm run annuaire -- oublier --contact prenom.nom@mairie.example --motif "opposition du 12/03"
```

La commande supprime la ligne, efface la copie de la page en cache, et **inscrit une exclusion**
pour que la campagne suivante ne la recollecte pas. Le bouton « Oublier » de l'écran de revue fait
la même chose. Le motif est obligatoire : il fait la preuve de la demande honorée.

Ce que cela ne fait pas : le site tiers publie toujours l'adresse. Un nouveau crawl la remettra
dans le cache HTTP, où la purge à trois ans l'emportera. Ce qui est garanti, c'est qu'elle ne
rentrera plus dans l'annuaire exporté. Voir
l'[ADR-026](adr/026-droit-a-l-effacement.md).

> Ces indications décrivent les obligations usuelles d'un responsable de traitement sur un
> traitement de ce type. Elles ne constituent pas un avis juridique et n'engagent pas l'éditeur :
> votre DPO reste seul juge de votre situation.

