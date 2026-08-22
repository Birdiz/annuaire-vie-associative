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

Le pipeline est un entonnoir de coût en huit étages (§6 du [brief](docs/brief.md)). Six lots ont
été livrés :

| Étape | | Statut |
|---|---|---|
| [1] Amorce RNA | associations du département | ✅ lot 2 |
| [2] Résolution | URL du site de la mairie | ✅ lot 2 |
| [3] Découverte | scoring des liens, crawl à profondeur 2 | ✅ lot 3 |
| [4] Pré-filtre | écarter les pages avant tout coût d'inférence | ✅ lot 4 |
| [5] Extraction | `mailto:`, `tel:`, listes et tableaux | ✅ lot 3 |
| [6] Fallback LLM | uniquement si le DOM n'a pas suffi | ⬜ écarté |
| [7] Normalisation | déduplication, validation syntaxique + MX, classification | ✅ lot 5 |
| [8] Scoring | score de publiabilité par contact | ✅ lot 5 |
| — Interface | suivi de run, revue humaine, export | ✅ lot 6 |

L'étage [6] est écarté : la mesure du lot 4 lui a retiré sa justification
([ADR-015](docs/adr/015-temporalite-rna-et-dormance.md)). Le pipeline est complet et mesurable sans
aucune clé d'API, ce que le brief posait comme objectif (D4).

Mesure de bout en bout sur l'Ille-et-Vilaine. Lot 2 : **353 communes, dont 332 avec l'URL de leur
mairie (94 %), et 31 273 associations actives, en 40 s.** Lot 3 : **2 591 pages explorées et 7 424
contacts collectés** en une quarantaine de minutes, dont 1 674 rattachés à une association — soit
**1,5 % de couverture**. Lot 4 : la dormance des associations est
désormais qualifiée, et **elle n'explique pas ce 1,5 %** — voir plus bas.

Lot 4 : sur ces mêmes pages, **le pré-filtre ramène le volume qui appellerait une inférence de
40,3 % à 6,5 %** — 160 pages au lieu de 997 — sans écarter une seule des 157 pages ayant produit
un contact rattaché à une association. L'objectif du brief pour cet étage est « < 20 % » ; il est
tenu avec une marge de trois, et **avant qu'une seule ligne d'inférence n'ait été écrite**.

Lot 5 : l'annuaire sort enfin de l'outil. **36 170 associations classées en six types**, 111
doublons résorbés, **748 domaines de messagerie vérifiés en quatre secondes**, 7 313 contacts notés,
et un export CSV où chaque ligne porte son URL source et sa date de collecte. Le contrôle MX a
révélé au passage un défaut d'extraction que rien n'avait vu — voir plus bas.

Lot 6 : le score du lot 5 trouve enfin son destinataire. Une **interface locale** — un serveur sur
`127.0.0.1`, rien qui sorte de la machine — sert le suivi d'un run en cours, un écran de revue qui
présente les contacts **les moins sûrs d'abord** avec le détail de ce qui a fait baisser leur note,
et l'export. Un humain peut valider, rejeter, ou **corriger** une valeur : la valeur lue reste en
base à côté de la correction, et c'est l'étape [8] qui renote, pas l'écran. Les 138 adresses cassées
par un CMS trouvées au lot 5 arrivent ainsi en tête de file. Il ne reste que le packaging.

## Prérequis

**Node 24 ou plus**, et rien d'autre. Node exécute le TypeScript nativement : il n'y a aucune étape
de build, ni pour le développement ni pour les tests.

```bash
node --version
```

Le projet a **une seule dépendance runtime**, `node-html-parser`, entrée au lot 3 après mesure de
son coût ([ADR-011](docs/adr/011-premiere-dependance-runtime.md)). L'interface du lot 6 embarque un
second fichier tiers, hors npm : une copie de **htmx 2.0.7** (50 Ko, licence 0BSD) servie depuis la
machine, dont l'empreinte SHA-256 est vérifiée par un test
([ADR-020](docs/adr/020-porte-d-entree-locale.md)).

```bash
npm install
```

## Tester

### 1. La suite complète, sans réseau

```bash
npm run check
```

Typecheck strict, puis 405 tests. **La suite ne sort jamais sur Internet** : `npm test` précharge
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
contact@sainte-colombe.example         score   —   lu 0.90 dom:mailto         [generique]
    Sainte-Colombe (commune)
    source : http://127.0.0.1:53905/
club@asso.example                      score   —   lu 0.81 dom:mailto+nom     [generique]
    Club de Sainte-Colombe
    source : http://127.0.0.1:53905/vie-associative
marie.dupont@tennis.example            score   —   lu 0.54 texte:motif+nom    [nominatif]
    Tennis club colombin
    source : http://127.0.0.1:53905/vie-associative
amicale@asso.example                   score   —   lu 0.41 texte:obfusque+nom [indetermine]
    Amicale laique de Sainte-Colombe
    source : http://127.0.0.1:53905/vie-associative
```

Ce qu'il faut y lire :

- **la provenance est sur chaque ligne** — URL source, méthode d'extraction, confiance ;
- **le score est vide à ce stade** : il est calculé par l'étape [8], quelques lignes plus bas. Les
  deux chiffres sont montrés ensemble et jamais l'un à la place de l'autre — la confiance dit
  comment le contact a été *lu*, le score s'il vaut d'être *publié*
  ([ADR-019](docs/adr/019-deduplication-et-score-de-revue.md)) ;
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
qu'un seuil se règle sur un vrai corpus sans le recrawler.

La démonstration finit par les **étapes [7] et [8]**, et sort le fichier que l'outil existe pour
produire :

```
code_insee;commune;rna_id;association;type;kind;valeur;regime;score;confiance;methode_extraction;source_url;collected_at;review_statut
35999;Sainte-Colombe;;;;email;contact@sainte-colombe.example;generique;0.62;0.90;dom:mailto;http://127.0.0.1:53905/;…
35999;Sainte-Colombe;W35999000;Club de Sainte-Colombe;sportive;email;club@asso.example;generique;0.73;0.81;dom:mailto+nom;…
35999;Sainte-Colombe;W35999003;Comite des fetes…;comite_des_fetes;email;fetes@asso.example;indetermine;0.69;0.81;dom:mailto+nom;…
35999;Sainte-Colombe;W35999002;Tennis club colombin;sportive;email;marie.dupont@tennis.example;nominatif;0.39;0.54;texte:motif+nom;…
```

Ce qu'il faut y lire :

- **la provenance voyage avec la donnée.** URL source, date de collecte, méthode et confiance sont
  des colonnes du fichier livré. Un export qui les laisserait derrière reproduirait exactement le
  problème que l'outil prétend résoudre ;
- **le type vient du code objet RNA**, sauf pour le comité des fêtes : son code dit « loisirs », et
  c'est son nom qui tranche. Le code ne porte pas cette catégorie, mesures à l'appui
  ([ADR-018](docs/adr/018-classification-en-six-types.md)) ;
- **`marie.dupont@` tombe à 0,39** alors qu'elle a été lue à 0,54 : adresse nominative, lue dans du
  texte, sur un domaine dont le MX n'a pas pu être vérifié. Trois signaux, tous trois inscrits dans
  `score_motifs` — un score qu'on ne peut pas expliquer n'est pas révisable ;
- **aucun verdict MX n'aboutit ici**, et c'est voulu : la démonstration pointe elle-même le
  résolveur DNS vers un port mort, pour que « aucune requête ne sort de la machine » reste vrai au
  pied de la lettre. On y voit au passage que le code distingue « pas de MX » de « je n'ai pas pu
  savoir ».

Les métriques affichées ensuite donnent les volumes par étage de l'entonnoir. La base de
démonstration est créée dans `data/demo`, ignorée par git, et recréée à chaque exécution.

### 3. Pour de vrai, sur un département

C'est le seul mode qui émet des requêtes vers des sites tiers, depuis votre machine. Deux portes
de sortie s'y ouvrent : les requêtes HTTP vers les sites de mairie, et une résolution DNS par
domaine de messagerie collecté, pour le contrôle MX de l'étape [7]
([ADR-017](docs/adr/017-validation-mx.md)).

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

La normalisation se rejoue elle aussi seule. Elle ne sort du réseau que pour les domaines dont le
verdict MX n'est pas encore connu — le reste est un recalcul local :

```bash
npm run annuaire -- normaliser --departement 35
```

Puis l'annuaire lui-même :

```bash
npm run annuaire -- exporter --departement 35 --score-min 0.6 --fichier annuaire-35.csv
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
| `run --departement <dd>` | Run complet : amorce, résolution, découverte, puis normalisation |
| `decouvrir --departement <dd>` | Rejoue la seule découverte sur une base déjà amorcée |
| `communes --departement <dd>` | Communes et URL de leur mairie |
| `associations --departement <dd>` | Associations amorcées, avec leur commune |
| `contacts --departement <dd>` | Contacts collectés, avec leur provenance |
| `pages --departement <dd>` | Pages explorées et verdict du pré-filtre |
| `prefiltrer --departement <dd>` | Rejoue le pré-filtre depuis le cache, sans réseau |
| `normaliser --departement <dd>` | Rejoue la normalisation [7] et le scoring [8] |
| `exporter --departement <dd>` | Exporte l'annuaire en CSV, provenance comprise |
| `ui [--port <n>]` | Interface locale : suivi de run, revue humaine, export |
| `dormance --departement <dd>` | Ancienneté de déclaration des associations |
| `metrics [--json]` | Compteurs de l'entonnoir |
| `status`, `jobs`, `dumps` | État de l'installation, de la file, des téléchargements |
| `requeue <id\|cle>` | Remet en attente un job terminé, écarté ou mort |
| `purge` | Force la purge des données de plus de trois ans |
| `fetch <url>` | Récupère une URL via le client conforme (diagnostic) |

Un run interrompu — `Ctrl-C`, coupure, `kill -9` — se reprend en relançant la même commande. Rien
n'est perdu ni rejoué : c'est une propriété de la file de jobs, vérifiée par un test qui tue
réellement un process en plein vol.

## L'interface

```bash
npm run annuaire -- ui
```

La commande imprime une adresse et rend la main quand on l'interrompt :

```
Interface locale disponible :

  http://127.0.0.1:8787/?jeton=xi9dz8uqA-OdyO6KhoZ0_6Sn1GOO_TEu
```

Trois écrans, servis par un `node:http` de quelques centaines de lignes, avec htmx et du CSS écrit
à la main — pas de bundler, pas de React (D5).

**Synthèse** — le §8 du brief à l'écran : taux de couverture selon trois définitions dont l'écart
*est* le résultat, volumes par étage de l'entonnoir, verdicts MX, classification, taux de
correction. Le bloc de suivi se rafraîchit tout seul : un `annuaire run` lancé dans un autre
terminal est vu avancer d'ici, sans que les deux processus se connaissent — c'est ce pour quoi le
mode WAL avait été choisi au lot 1.

**Revue** — les contacts à arbitrer, **les moins sûrs d'abord**, chacun avec le détail des signaux
qui ont fait baisser sa note, son régime juridique et son URL source. Valider, rejeter, ou corriger
la valeur. Une correction ne réécrit jamais ce qui a été lu : elle s'écrit à côté, remet la ligne
dans le flux de notation, et c'est `annuaire normaliser` qui la renote
([ADR-021](docs/adr/021-correction-en-revue.md)). Un numéro mobile saisi en correction est refusé,
comme partout ailleurs (§4.6).

**Export** — le même CSV que `annuaire exporter`, sans variante propre à l'interface. Les contacts
rejetés en revue en sortent par défaut : un arbitrage humain qui ne changerait rien au fichier livré
ne servirait à rien.

Le serveur **n'écoute que sur `127.0.0.1`**, et cette adresse n'est pas configurable — seul le port
l'est. Un serveur local n'est pas un serveur inoffensif : il tourne avec vos droits et tient des
données personnelles. L'en-tête `Host` est donc vérifié (rebinding DNS), un jeton tiré à chaque
démarrage est échangé contre un cookie `SameSite=Strict`, les requêtes d'écriture croisées sont
refusées, et une CSP `default-src 'self'` interdit toute ressource distante — htmx est servi depuis
votre machine ([ADR-020](docs/adr/020-porte-d-entree-locale.md)).

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

**Le taux de couverture de 1,5 % appelait une réserve. Le lot 4 l'a levée, et le résultat
n'est pas celui qu'on espérait.** L'hypothèse était que le dénominateur — les 31 273
associations non dissoutes — était gonflé par des structures dormantes. Les dates de
déclaration du RNA sont maintenant stockées, et le champ est renseigné à 100 % :

| Population retenue | Effectif | Couvertes | Taux |
|---|---:|---:|---:|
| Toutes actives | 31 273 | 478 | 1,53 % |
| Déclaré depuis 5 ans | 16 094 | 325 | 2,02 % |
| Déclaré depuis 1 an | 5 417 | 118 | 2,18 % |

Se restreindre aux 17 % d'associations les plus récemment déclarantes ne gagne que 0,65 point.
**La dormance n'explique pas la couverture basse** : celles qui déclarent encore sont presque
aussi absentes des sites de mairie que celles qui ont cessé. Le plafond n'est pas un artefact
de comptage, c'est un fait sur ce que les communes publient. Signal connexe qui va dans le même
sens : **170 associations sur 36 170 déclarent un site web**, soit 0,5 %.

La distribution ne désigne d'ailleurs aucun seuil : les déclarations croissent de façon lisse
de 2006 à 2025, sans creux. Les cinq ans affichés sont une convention assumée, pas une
frontière découverte ([ADR-015](docs/adr/015-temporalite-rna-et-dormance.md)).

**Le pré-filtre borne le coût d'inférence à 6,5 % des pages**, contre 40,3 % sans lui, et le fait
sans rien perdre de mesurable : les 157 pages ayant produit un contact rattaché à une association
sont toutes retenues, et les 2 003 contacts rattachés du département avec elles
([ADR-014](docs/adr/014-prefiltre-consultatif.md)). Le seuil n'a pas été choisi puis justifié : il
est le dernier point de la courbe où le filtre retient plus de pages prometteuses qu'il n'en écarte.

Ce que ce chiffre ne dit pas encore : le vrai taux de rappel. Savoir si les 86 pages écartées qui
nommaient pourtant une association contenaient des contacts exploitables suppose de les soumettre
au LLM. Elles sont l'échantillon désigné pour le mesurer dès que l'étape [6] existera.

**Le lot 5 a levé la limite que cette section annonçait** — un même email présent à la fois
rattaché à une association et au niveau de la commune. 111 doublons ont été résorbés, et zéro au
passage suivant : la règle est une requête SQL rejouable, donc idempotente
([ADR-019](docs/adr/019-deduplication-et-score-de-revue.md)).

**La validation MX coûte quatre secondes et rapporte plus qu'elle ne retire.** 748 domaines
distincts pour 4 273 emails : 681 annoncent un MX, 65 n'en annoncent pas, 2 n'ont pas pu être
résolus. Des 478 associations créditées d'au moins un email, **455 en ont un dont le domaine reçoit
du courrier** — le taux passe de 1,53 % à 1,45 %. L'écart est faible, et c'est en soi le résultat :
la couverture basse n'est pas un artefact d'adresses mortes.

**Le contrôle MX a surtout trouvé un défaut que rien n'avait vu.** 41 domaines sont revenus en
`EBADNAME`. Ils venaient tous d'adresses de la forme `abcdanse[^@]gmail.com` : un CMS répandu chez
les petites communes remplace l'arobase de ses `mailto:` par ce littéral, qu'un script répare côté
client. Le motif permissif de l'étape [5] les acceptait, et **138 contacts comptaient dans la
couverture**. Ils sont désormais notés à zéro, avec leur motif, et tout seuil d'export les écarte.
Les reconstruire serait une désobfuscation — donc une décision d'extraction, à prendre en regardant
le §5 du brief, pas à glisser dans un lot de normalisation
([ADR-017](docs/adr/017-validation-mx.md)). **Le lot 6 leur donne un chemin sans trancher cette
question** : notées zéro, elles arrivent en tête de la file de revue, où chacune peut être réparée
à la main. La désobfuscation automatique, elle, reste ouverte.

**La classification tient à 100 %, et son fourre-tout est assumé.** Le code objet du RNA est
renseigné sur les 36 170 associations, réparties sur 31 familles :

| Type | Effectif | Part |
|---|---:|---:|
| diverses | 11 506 | 36,8 % |
| culturelle | 8 049 | 25,7 % |
| sportive | 5 766 | 18,4 % |
| sociale | 5 706 | 18,2 % |
| comité des fêtes | 244 | 0,8 % |
| centre de loisirs | 2 | 0,0 % |

Plus d'un tiers en « diverses » parce que le brief ne prévoit aucun type pour l'éducation
(3 152 associations), les loisirs et jeux (2 772) ou l'environnement (1 223). Les y ranger de force
aurait produit un chiffre plus flatteur et moins vrai ; le code d'origine reste en base, et
élargir la liste des types un jour ne coûtera qu'un rejeu. À l'inverse, « comité des fêtes » ne
peut **pas** venir du code : les 252 associations qui en portent le nom se répartissent sur six
familles différentes ([ADR-018](docs/adr/018-classification-en-six-types.md)).

## Documentation

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
