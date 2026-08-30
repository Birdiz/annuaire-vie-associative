# Annuaire de la vie associative locale

Outil **local-first** de constitution d'annuaires d'associations, à destination des collectivités
et de leurs partenaires.

Constituer l'annuaire des associations d'un département se fait aujourd'hui à la main, commune par
commune, par copier-coller depuis les sites de mairie. Cet outil part des données ouvertes — le RNA
et l'Annuaire de l'administration — puis les enrichit en explorant les sources publiques des
collectivités, **avec la provenance de chaque donnée collectée** : URL source, horodatage, méthode
d'extraction, score de confiance.

Un process, un fichier SQLite, une interface servie sur `localhost`. Les requêtes vers les sites
tiers partent de la machine de l'utilisateur, jamais d'une infrastructure opérée par l'éditeur —
c'est ce qui fait de vous, et non de l'éditeur, le responsable de traitement
([obligations](docs/obligations.md)).

Le pipeline est complet et mesurable **sans aucune clé d'API**. Les résultats de mesure sur
l'Ille-et-Vilaine — couverture, coût, limites — sont dans [`docs/mesures.md`](docs/mesures.md).

## Prérequis

**Node 24 ou plus**, et rien d'autre. Node exécute le TypeScript nativement : aucune étape de build
pour le développement ni pour les tests. Seul l'emballage en a une, et elle n'entre pas dans
l'artefact livré (`esbuild` et `postject`, en dépendances de développement).

```bash
node --version
npm install
```

Une seule dépendance runtime, `node-html-parser`
([ADR-011](docs/adr/011-premiere-dependance-runtime.md)). Un seul fichier tiers hors npm : une copie
de htmx 2.0.7 (50 Ko, 0BSD), servie depuis la machine, dont l'empreinte SHA-256 est vérifiée par un
test ([ADR-020](docs/adr/020-porte-d-entree-locale.md)).

## Installer

Trois emballages, **un seul artefact** : le même bundle est exécuté par `npx`, copié dans l'image
Docker et injecté dans l'exécutable Windows
([ADR-022](docs/adr/022-un-artefact-trois-emballages.md)).

| Cible | Poids | Ce qu'elle demande |
|---|---|---|
| [Exécutable Windows](../../releases) | 88,5 Mo | rien |
| Paquet npm (`npx`) | 132 Ko | Node 24+ |
| Image Docker | 163 Mo | Docker |

**Exécutable Windows.** `annuaire.exe` se télécharge depuis la page
[Releases](../../releases) : double-clic, l'interface s'ouvre dans le navigateur. Le binaire n'est
pas dans le dépôt — il est construit par la CI sur un poste Windows, qui lance ensuite ce qu'elle
vient de produire ([ADR-027](docs/adr/027-publication-de-l-executable.md)). Il **n'est pas signé** :
Windows le bloque au premier lancement, et chaque release publie l'empreinte SHA-256 du fichier pour
que vous puissiez vérifier que c'est bien celui-là que vous avez.

**Si Windows bloque le fichier**, deux cas à ne pas confondre :

- **SmartScreen** — fenêtre bleue « Windows a protégé votre ordinateur ». C'est un avertissement de
  réputation, pas une détection : « Informations complémentaires », puis « Exécuter quand même ».
  Un fichier téléchargé porte aussi une marque qui déclenche l'avertissement à chaque lancement ;
  `Unblock-File .\annuaire.exe` en PowerShell la retire une fois pour toutes.
- **Defender qui supprime ou met en quarantaine** — bandeau « Menace trouvée », le fichier
  disparaît. C'est un **faux positif** : les exécutables autonomes construits ainsi — un `node.exe`
  officiel dans lequel un script est injecté — ressemblent, pour une heuristique, à un binaire
  légitime modifié. Comparez d'abord l'empreinte publiée dans la release :

  ```powershell
  Get-FileHash .\annuaire.exe -Algorithm SHA256
  ```

  Si elle correspond, le fichier est bien celui que la CI a construit, à l'octet près, et le
  signalement est infondé — il se signale à Microsoft sur
  [leur formulaire](https://www.microsoft.com/en-us/wdsi/filesubmission), ce qui est la seule
  correction durable tant que le binaire n'est pas signé. En attendant, le contournement propre
  n'est pas d'ajouter une exclusion Defender, c'est **`npx`** ci-dessous : même bundle, même
  comportement, sans binaire à débloquer.

Signer l'exécutable réglerait les deux d'un coup. C'est une décision d'éditeur — certificat
nominatif et payant — que ce dépôt ne prend pas à la place de la collectivité qui le distribue.

**npx.** Le paquet n'est pas publié à ce jour : il s'installe depuis un tarball construit sur place.

```bash
npm pack && npm install ./annuaire-vie-associative-0.1.0.tgz && npx annuaire ui
```

**Docker.** L'image sert le pipeline, avec `/data` en volume : la base, le cache HTTP et les dumps
survivent au conteneur.

```bash
docker build -t annuaire:0.1.0 . && docker run --rm -v annuaire:/data annuaire:0.1.0 run --departement 35
```

L'interface, elle, ne se publie pas par `-p` : elle n'écoute que sur `127.0.0.1`, qui dans un
conteneur désigne la boucle locale **du conteneur**
([ADR-023](docs/adr/023-l-interface-et-le-conteneur.md)).

Pour construire soi-même :

```bash
npm run build       # bundle unique : dist/annuaire.cjs + dist/assets/
npm run build:sea   # exécutable Windows (télécharge node.exe, empreinte vérifiée)
```

## Utiliser

```bash
npm run annuaire -- init
export ANNUAIRE_CONTACT_URL="https://votre-collectivite.fr/contact"
npm run annuaire -- run --departement 35
```

L'URL de contact est **obligatoire et sans valeur par défaut** : elle est annoncée dans le
`User-Agent` de chaque requête, et rien n'est collecté sans elle. L'interface la demande à l'écran
si elle manque.

Le run complet — amorce RNA, résolution des sites de mairie, découverte, normalisation — est le
seul mode qui émette des requêtes vers des sites tiers. Prévoyez du temps : le délai de 2 s par
domaine borne la durée, et l'amorce traverse un dump national de 1,25 Go. Le dump officiel est
découpé par département mais son `robots.txt` l'interdit ; le miroir autorisé est agrégé
nationalement, d'où l'échappatoire `--rna-file ~/Téléchargements/rna-35.zip` si vous téléchargez le
ZIP officiel à la main.

Un run interrompu — `Ctrl-C`, coupure, `kill -9` — **se reprend en relançant la même commande**.
Rien n'est perdu ni rejoué : c'est une propriété de la file de jobs, vérifiée par un test qui tue
réellement un process en plein vol.

Chaque étape se rejoue ensuite seule, sans relire le dump — c'est le mode d'itération :

```bash
npm run annuaire -- decouvrir --departement 35 --max-pages 20
npm run annuaire -- prefiltrer --departement 35     # depuis le cache, sans réseau
npm run annuaire -- normaliser --departement 35
npm run annuaire -- exporter --departement 35 --score-min 0.6 --fichier annuaire-35.csv
```

### L'interface

```bash
npm run annuaire -- ui
```

Trois écrans servis sur `127.0.0.1` — `node:http`, htmx, CSS écrit à la main, pas de bundler. La
commande imprime une adresse portant un jeton, et ouvre le navigateur (`--sans-navigateur` s'en
abstient) :

- **Synthèse** — couverture, volumes par étage de l'entonnoir, verdicts MX, classification. **Le
  run se lance et s'arrête d'ici** depuis le lot 8, sa phase s'écrivant dans le suivi
  ([ADR-024](docs/adr/024-lancer-un-run-depuis-l-interface.md)).
- **Revue** — les contacts à arbitrer, les moins sûrs d'abord, avec le détail des signaux qui ont
  fait baisser leur note. Valider, rejeter, corriger. Une correction ne réécrit jamais ce qui a été
  lu ([ADR-021](docs/adr/021-correction-en-revue.md)).
- **Export** — le même CSV que `annuaire exporter`, sans variante propre à l'interface.

L'adresse d'écoute n'est pas configurable, seul le port l'est. `Host` vérifié, jeton échangé contre
un cookie `SameSite=Strict`, POST croisés refusés, CSP `default-src 'self'`
([ADR-020](docs/adr/020-porte-d-entree-locale.md)).

### Commandes

```bash
npm run annuaire -- --help
```

| Commande | |
|---|---|
| `init` | Prépare le répertoire de données et la base |
| `run --departement <dd>` | Run complet : amorce, résolution, découverte, puis normalisation |
| `decouvrir --departement <dd>` | Rejoue la seule découverte sur une base déjà amorcée |
| `prefiltrer --departement <dd>` | Rejoue le pré-filtre depuis le cache, sans réseau |
| `normaliser --departement <dd>` | Rejoue la normalisation [7] et le scoring [8] |
| `exporter --departement <dd>` | Exporte l'annuaire en CSV, provenance comprise |
| `ui [--port <n>]` | Interface locale : lancement et suivi d'un run, revue, export |
| `communes`, `associations`, `contacts`, `pages` | Lectures de la base, `--departement <dd>` |
| `dormance --departement <dd>` | Ancienneté de déclaration des associations |
| `metrics [--json]` | Compteurs de l'entonnoir |
| `status`, `jobs`, `dumps` | État de l'installation, de la file, des téléchargements |
| `requeue <id\|cle>` | Remet en attente un job terminé, écarté ou mort |
| `purge` | Force la purge des données de plus de trois ans |
| `fetch <url>` | Récupère une URL via le client conforme (diagnostic) |
| `oublier --contact\|--domaine\|--commune <v> --motif <texte>` | Efface une donnée et l'empêche de revenir (art. 17 et 21) |

Lancé **sans aucune commande**, l'exécutable Windows sert l'interface — c'est ce qu'attend un
double-clic. `npx` et l'image Docker impriment l'aide.

## Développer

```bash
npm run check   # typecheck strict + 524 tests
npm test        # tests seuls
npm run demo    # le pipeline complet sur un faux site de mairie, hors ligne
```

**La suite ne sort jamais sur Internet** : `npm test` précharge un garde-fou qui refuse tout hôte
hors de la boucle locale, sous-processus compris. Tout ce qui touche au réseau se teste contre un
serveur HTTP local jetable, sur des fixtures HTML synthétiques écrites à la main.

`npm run demo` sert un faux site de mairie sur la boucle locale et fait tourner les commandes
réelles dessus — découverte, extraction, pré-filtre, normalisation, export. Aucune requête ne sort
de la machine. Ce que sa sortie donne à lire est commenté dans
[`docs/mesures.md`](docs/mesures.md).

Le code tient sur quelques règles de structure, chacune vérifiée par un test d'architecture : une
seule porte de sortie réseau (`src/http/`), une seule porte d'entrée DOM (`src/parse/html.ts`), une
seule porte d'écoute (`src/ui/serveur.ts`), une seule porte de lancement de processus
(`src/ui/navigateur.ts`). [`CLAUDE.md`](CLAUDE.md) les détaille.

## Ce que l'outil ne fait pas

Ces règles ne sont pas des réglages : elles n'ont **aucune surface de configuration**, et plusieurs
sont tenues par le schéma de la base ou par un test qui échoue si on s'en écarte.

- **`robots.txt` respecté**, sans option pour le désactiver.
- **1 requête / 2 s minimum par domaine**, non contournable — la clé combine le nom d'hôte et le
  /24 de l'adresse résolue, pour que l'hébergement mutualisé ne serve pas d'échappatoire.
- **Pas de navigateur headless**, pas de contournement de protection anti-bot.
- **Aucun scraping de réseaux sociaux**, même déclarés comme site officiel d'une mairie.
- **Aucun envoi d'email** : l'outil produit des annuaires, il ne prospecte pas.
- **Aucun appel vers une infrastructure de l'éditeur** : pas de télémétrie, pas de phone-home.
- **Numéros mobiles (06/07) exclus par défaut**, derrière un flag explicite.
- **Purge automatique** des données de plus de trois ans, exécutée au démarrage.
- **Aucune donnée réelle collectée n'entre dans le dépôt** : fixtures HTML synthétiques.

## Documentation

- [`docs/obligations.md`](docs/obligations.md) — **ce que vous devez faire** : base légale,
  information des personnes, droit d'opposition. Vous êtes responsable de traitement.
- [`docs/mesures.md`](docs/mesures.md) — les résultats sur l'Ille-et-Vilaine, et ce qu'ils disent
- [`docs/brief.md`](docs/brief.md) — le brief d'origine, qui fait foi
- [`docs/adr/`](docs/adr/) — les décisions d'architecture, avec leurs conséquences assumées
- [`CLAUDE.md`](CLAUDE.md) — ce qui contraint le code au quotidien
- [`src/ui/assets/htmx.LICENSE.txt`](src/ui/assets/htmx.LICENSE.txt) — licence du seul fichier
  tiers embarqué hors npm

## Licence et données

Les données du RNA et de l'Annuaire de l'administration sont publiées sous **Licence Ouverte
Etalab 2.0**. Le RNA **ne couvre ni la Moselle (57), ni le Bas-Rhin (67), ni le Haut-Rhin (68)**,
qui relèvent du droit local des associations : `run` les refuse explicitement plutôt que de rendre
un annuaire silencieusement vide.
