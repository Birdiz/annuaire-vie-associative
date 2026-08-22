# Annuaire de la vie associative locale

Outil **local-first** de constitution d'annuaires d'associations, à destination des collectivités
et de leurs partenaires.

Constituer l'annuaire des associations d'un département se fait aujourd'hui à la main, commune par
commune, par copier-coller depuis les sites de mairie : c'est long, non reproductible et non
traçable. Cet outil part des données ouvertes — le RNA et l'Annuaire de l'administration — puis les
enrichit en explorant les sources publiques des collectivités, **avec la provenance de chaque
donnée collectée**.

Un process, un fichier SQLite, une interface servie sur `localhost`. Les requêtes vers les sites
tiers partent de la machine de l'utilisateur, jamais d'une infrastructure opérée par l'éditeur.

## État d'avancement

Le pipeline est un entonnoir de coût en huit étages (§6 du [brief](docs/brief.md)). Quatre lots ont
été livrés :

| Étape | | Statut |
|---|---|---|
| [1] Amorce RNA | associations du département | ✅ lot 2 |
| [2] Résolution | URL du site de la mairie | ✅ lot 2 |
| [3] Découverte | scoring des liens, crawl à profondeur 2 | ✅ lot 3 |
| [4] Pré-filtre | écarter les pages avant tout coût d'inférence | ✅ lot 4 |
| [5] Extraction | `mailto:`, `tel:`, listes et tableaux | ✅ lot 3 |
| [6] Fallback LLM | uniquement si le DOM n'a pas suffi | ⬜ |
| [7] Normalisation | déduplication, validation, classification | ⬜ |
| [8] Scoring | confiance par contact, écran de revue | ⬜ |

Mesure de bout en bout sur l'Ille-et-Vilaine. Lot 2 : **353 communes, dont 332 avec l'URL de leur
mairie (94 %), et 31 273 associations actives, en 40 s.** Lot 3 : **2 591 pages explorées et 7 424
contacts collectés** en une quarantaine de minutes, dont 1 674 rattachés à une association — soit
**1,5 % de couverture**. Ce que ce chiffre veut dire, et ce qu'il ne veut pas dire, est détaillé
plus bas.

Lot 4 : sur ces mêmes pages, **le pré-filtre ramène le volume qui appellerait une inférence de
40,3 % à 6,5 %** — 160 pages au lieu de 997 — sans écarter une seule des 157 pages ayant produit
un contact rattaché à une association. L'objectif du brief pour cet étage est « < 20 % » ; il est
tenu avec une marge de trois, et **avant qu'une seule ligne d'inférence n'ait été écrite**.

## Prérequis

**Node 24 ou plus**, et rien d'autre. Node exécute le TypeScript nativement : il n'y a aucune étape
de build, ni pour le développement ni pour les tests.

```bash
node --version
```

Le projet a **une seule dépendance runtime**, `node-html-parser`, entrée au lot 3 après mesure de
son coût ([ADR-011](docs/adr/011-premiere-dependance-runtime.md)).

```bash
npm install
```

## Tester

### 1. La suite complète, sans réseau

```bash
npm run check
```

Typecheck strict, puis 299 tests. **La suite ne sort jamais sur Internet** : `npm test` précharge
un garde-fou qui refuse tout hôte hors de la boucle locale, sous-processus compris. Tout ce qui
touche au réseau se teste contre un serveur HTTP local jetable, sur des fixtures HTML synthétiques
écrites à la main.

### 2. Voir le pipeline fonctionner, hors ligne

```bash
npm run demo
```

Un faux site de mairie est servi sur la boucle locale, une commune et ses associations sont
déposées comme le lot 2 les aurait écrites, puis les commandes réelles de la CLI tournent dessus.
**Aucune requête ne sort de la machine.**

Le site de démonstration concentre les cas que la découverte doit savoir traiter : une rubrique
associative à suivre, des actualités et des marchés publics à ignorer, un PDF, un tableau qui
associe un nom à ses coordonnées, une adresse obfusquée, un mobile, et un chemin interdit par
`robots.txt`. Sortie attendue :

```
contact@sainte-colombe.example         0.90 dom:mailto         [generique]
    Sainte-Colombe (commune)
    source : http://127.0.0.1:53905/
club@asso.example                      0.81 dom:mailto+nom     [generique]
    Club de Sainte-Colombe
    source : http://127.0.0.1:53905/vie-associative
marie.dupont@tennis.example            0.54 texte:motif+nom    [nominatif]
    Tennis club colombin
    source : http://127.0.0.1:53905/vie-associative
amicale@asso.example                   0.41 texte:obfusque+nom [indetermine]
    Amicale laique de Sainte-Colombe
    source : http://127.0.0.1:53905/vie-associative
```

Ce qu'il faut y lire :

- **la provenance est sur chaque ligne** — URL source, méthode d'extraction, confiance ;
- **la confiance décroît avec la méthode** : un `mailto:` vaut plus qu'un motif lu dans du texte,
  qui vaut plus qu'une adresse obfusquée reconstruite ;
- le suffixe **`+nom`** signale un contact rattaché à une association par rapprochement de son nom
  dans le bloc HTML qui le porte. C'est une inférence, la confiance en tient compte ;
- **`[generique]` / `[nominatif]`** est la classification du §4.7 du brief : le régime juridique
  n'est pas le même pour `contact@` et pour `prenom.nom@` ;
- le mobile `06 12 34 56 78` **n'apparaît pas**. Les numéros en 06/07 sont exclus par défaut : un
  mobile associatif est presque toujours la ligne personnelle d'un bénévole.

La démonstration enchaîne ensuite sur le **pré-filtre de l'étape [4]**, qui décide quelles pages
vaudraient le coût d'une inférence :

```
 35.0 retenue   liste          5 contacts
    http://127.0.0.1:53905/vie-associative
 15.0 retenue   liste          1 contacts
    http://127.0.0.1:53905/annuaire-des-associations
  4.0 ecartee   insuffisant    1 contacts
    http://127.0.0.1:53905/
```

Ce qu'il faut y lire :

- **la page d'accueil est écartée alors qu'elle a livré un contact.** Le verdict est consultatif :
  il ne gouverne que le coût de l'étape [6], jamais ce que l'extraction a déjà obtenu ;
- **`/annuaire-des-associations` est la seule candidate au fallback LLM** : elle nomme une
  association et n'a livré qu'un contact. C'est l'asymétrie qui donne son sens à l'étape [4] — une
  page pleine de noms sans adresses est une cible, une page vide de tout est du bruit ;
- **le motif dit pourquoi**, dans un sens comme dans l'autre. Un « écartée » sans raison ne serait
  ni discutable en revue, ni réglable.

Le rejeu qui suit relit ces mêmes pages **depuis le cache disque**, sans une requête : c'est ainsi
qu'un seuil se règle sur un vrai corpus sans le recrawler. Les métriques affichées ensuite donnent
les volumes par étage de l'entonnoir. La base de démonstration est créée dans `data/demo`, ignorée
par git, et recréée à chaque exécution.

### 3. Pour de vrai, sur un département

C'est le seul mode qui émet des requêtes vers des sites tiers, depuis votre machine.

```bash
npm run annuaire -- init
```

Renseignez l'URL de contact annoncée dans le `User-Agent` — elle est obligatoire, et sans valeur
par défaut : un `User-Agent` qui ne mène nulle part vaut un `User-Agent` anonyme.

```bash
export ANNUAIRE_CONTACT_URL="https://votre-collectivite.fr/contact"
```

Puis le run complet. Prévoyez du temps : le respect du délai de 2 s par domaine est ce qui borne
la durée, et l'amorce traverse un dump national de 1,25 Go.

```bash
npm run annuaire -- run --departement 35
```

Le dump RNA officiel est découpé par département mais son `robots.txt` l'interdit ; le miroir
autorisé, lui, est agrégé nationalement. D'où un facteur 170 en volume, et l'échappatoire
documentée : télécharger le ZIP officiel à la main, puis

```bash
npm run annuaire -- run --departement 35 --rna-file ~/Téléchargements/rna-35.zip
```

Une fois la base amorcée, la découverte se rejoue seule, sans relire le dump. C'est le mode
d'itération quand on règle le scoring :

```bash
npm run annuaire -- decouvrir --departement 35 --max-pages 20
```

```bash
npm run annuaire -- contacts --departement 35
```

```bash
npm run annuaire -- metrics --json
```

## Commandes

```bash
npm run annuaire -- --help
```

| Commande | |
|---|---|
| `init` | Prépare le répertoire de données et la base |
| `run --departement <dd>` | Run complet : amorce, résolution, puis découverte |
| `decouvrir --departement <dd>` | Rejoue la seule découverte sur une base déjà amorcée |
| `communes --departement <dd>` | Communes et URL de leur mairie |
| `associations --departement <dd>` | Associations amorcées, avec leur commune |
| `contacts --departement <dd>` | Contacts collectés, avec leur provenance |
| `pages --departement <dd>` | Pages explorées et verdict du pré-filtre |
| `prefiltrer --departement <dd>` | Rejoue le pré-filtre depuis le cache, sans réseau |
| `dormance --departement <dd>` | Ancienneté de déclaration des associations |
| `metrics [--json]` | Compteurs de l'entonnoir |
| `status`, `jobs`, `dumps` | État de l'installation, de la file, des téléchargements |
| `purge` | Force la purge des données de plus de trois ans |
| `fetch <url>` | Récupère une URL via le client conforme (diagnostic) |

Un run interrompu — `Ctrl-C`, coupure, `kill -9` — se reprend en relançant la même commande. Rien
n'est perdu ni rejoué : c'est une propriété de la file de jobs, vérifiée par un test qui tue
réellement un process en plein vol.

## Ce que l'outil ne fait pas

Ces règles ne sont pas des réglages. Elles n'ont volontairement **aucune surface de configuration**,
et plusieurs sont tenues par le schéma de la base ou par un test qui échoue si on s'en écarte.

- **`robots.txt` est respecté**, sans option pour le désactiver.
- **1 requête / 2 s minimum par domaine**, non contournable. La clé de throttling combine le nom
  d'hôte et le /24 de l'adresse résolue, pour que l'hébergement mutualisé de petites communes ne
  contourne pas la règle.
- **Pas de navigateur headless.** Client HTTP et parseur DOM.
- **Aucun scraping de réseaux sociaux.** Un lien vers Facebook, LinkedIn ou Instagram n'est ni
  suivi ni mémorisé, même déclaré comme site officiel d'une mairie.
- **Aucun contournement de protection anti-bot** — pas de rotation d'IP, pas de CAPTCHA, pas
  d'empreinte falsifiée.
- **Aucun envoi d'email.** L'outil produit des annuaires, il ne prospecte pas.
- **Aucun appel vers une infrastructure de l'éditeur** : pas de télémétrie, pas de phone-home.
- **Purge automatique** des données de plus de trois ans, exécutée au démarrage.
- **Aucune donnée réelle collectée n'entre dans le dépôt.** Les tests utilisent des fixtures HTML
  synthétiques écrites à la main.

## Ce que coûte un département, et ce qu'il rapporte

Le premier passage réel sur l'Ille-et-Vilaine a livré trois enseignements, consignés dans
l'[ADR-013](docs/adr/013-ordre-de-parcours-et-budget.md).

**La durée a un plancher structurel.** Les 333 domaines de mairie du département se résolvent sur
**93 sous-réseaux /24 seulement** — 85 % des domaines partagent le leur avec un autre, et les deux
plus chargés hébergent 42 et 41 communes. Le throttling retenant la clé la plus contraignante,
c'est le /24 le plus chargé qui fixe la durée minimale : environ **treize minutes**, quoi qu'on
fasse. Augmenter la concurrence n'y change rien, le goulot n'étant pas le nombre de workers.

**13 % des communes sont interdites par `robots.txt`** — 42 sur 332. On n'y collectera jamais rien.
C'est une limite assumée du produit, affichée comme telle en fin de run.

**Le taux de couverture de 1,5 % demande une réserve avant d'être lu comme un échec.** Le
dénominateur compte les 31 273 associations non dissoutes du RNA, dont une part inconnue de
structures dormantes. Aucun champ temporel n'est stocké aujourd'hui, alors que le RNA expose
`date_decla`, la date de dernière déclaration en préfecture. Tant que la dormance n'est pas
qualifiée, la métrique reste difficile à interpréter. Signal connexe : **170 associations sur
36 170 déclarent un site web**, soit 0,5 % — le gisement n'est pas de ce côté-là.

**Le pré-filtre borne le coût d'inférence à 6,5 % des pages**, contre 40,3 % sans lui, et le fait
sans rien perdre de mesurable : les 157 pages ayant produit un contact rattaché à une association
sont toutes retenues, et les 2 003 contacts rattachés du département avec elles
([ADR-014](docs/adr/014-prefiltre-consultatif.md)). Le seuil n'a pas été choisi puis justifié : il
est le dernier point de la courbe où le filtre retient plus de pages prometteuses qu'il n'en écarte.

Ce que ce chiffre ne dit pas encore : le vrai taux de rappel. Savoir si les 86 pages écartées qui
nommaient pourtant une association contenaient des contacts exploitables suppose de les soumettre
au LLM. Elles sont l'échantillon désigné pour le mesurer dès que l'étape [6] existera.

Une limite connue subsiste, documentée plutôt que contournée : un même email peut exister à la fois
rattaché à une association et au niveau de la commune — la déduplication est l'étape [7].

## Documentation

- [`docs/brief.md`](docs/brief.md) — le brief d'origine, qui fait foi
- [`docs/adr/`](docs/adr/) — les décisions d'architecture, avec leurs conséquences assumées
- [`CLAUDE.md`](CLAUDE.md) — ce qui contraint le code au quotidien

## Licence et données

Les données du RNA et de l'Annuaire de l'administration sont publiées sous **Licence Ouverte
Etalab 2.0**. Le RNA **ne couvre ni la Moselle (57), ni le Bas-Rhin (67), ni le Haut-Rhin (68)**,
qui relèvent du droit local des associations : `run` les refuse explicitement plutôt que de rendre
un annuaire silencieusement vide.
