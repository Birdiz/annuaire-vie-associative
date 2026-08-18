# ADR-006 — Sources de données du lot 2, sous contrainte de `robots.txt`

Statut : acceptée — 2026-08-18

## Contexte

Le lot 2 doit amorcer les associations d'un département (étape [1]) et résoudre l'URL
du site de leur mairie (étape [2]). Trois portes semblaient évidentes ; l'invariant §4.2
— `robots.txt` respecté, sans option pour le désactiver — en ferme deux.

**Le dump RNA du ministère est interdit.** `https://media.interieur.gouv.fr/robots.txt`
contient `Disallow: /rna/`, exactement le répertoire des dumps. C'est d'autant plus
contrariant que ce ZIP est **découpé par département** : l'entrée du 35 pèse 6,5 Mo
compressés, et l'hôte accepte `Range`. Lire le catalogue en fin d'archive puis extraire
la seule entrée utile aurait coûté deux requêtes et 7,5 Mo. Cette voie est fermée.

**L'API OpenDataSoft de l'Annuaire est interdite.**
`https://api-lannuaire.service-public.gouv.fr/robots.txt` contient `Disallow: /api/`
pour `User-agent: *`. Elle aurait permis un export filtré par département en une requête.

**Le `tar.bz2` de l'Annuaire n'est pas la seule option.** L'ADR-005 avait relevé que
`all_latest.tar.bz2` pèse 365 Mo et que Node n'a pas de décompresseur bzip2, ce qui
imposait soit une dépendance en JavaScript pur — la première du projet — soit une autre
source. Le répertoire `donnees_locales_v4/all/` contient en réalité, régénéré chaque
jour, un `…-data.gouv_local.json` de 273 Mo servi **compressé en gzip** quand on
l'accepte, soit une trentaine de Mo sur le fil. `zlib` suffit : **la réserve de
l'ADR-005 est levée, et le projet garde zéro dépendance runtime.**

Le second fichier du même répertoire, `…-data.gouv_commune.zip`, ne contient que la
compétence géographique (`code_insee_commune`, `nom`, `type_service_local`) : aucune URL
de mairie. Il ne sert à rien ici malgré son nom engageant.

## Décision

| Étape | Source retenue | Pourquoi |
|---|---|---|
| [1] RNA | `data-pipeline-open.s3.sbg.io.cloud.ovh.net/rna/waldec.csv` | Miroir publié par data.gouv ; `robots.txt` en 404, donc aucune restriction (RFC 9309 §2.3.1.3) |
| [2] Annuaire | `lecomarquage.service-public.gouv.fr/donnees_locales_v4/all/<horodatage>-data.gouv_local.json` | `robots.txt` en 403, donc aucune restriction ; contient `site_internet` et le pivot `mairie` |

`waldec.csv` est retenu par défaut, `import.csv` derrière `--avec-import` : Waldec
couvre les associations créées ou modifiées depuis 2009, donc le vivier réellement
actif, tandis qu'Import rassemble surtout des structures dormantes.

`--rna-file <chemin>` accepte un ZIP officiel que l'utilisateur a téléchargé lui-même.
`robots.txt` s'adresse aux robots, pas aux personnes : rien n'interdit à quelqu'un
d'aller chercher le fichier avec son navigateur, et l'outil sait alors n'en lire que
l'entrée de son département.

## Conséquences

**Le prix du respect de `robots.txt` est un facteur 170.** Là où le dump officiel aurait
livré 7,5 Mo pour un département, le miroir autorisé impose de traverser 1,25 Go. Le
fichier est agrégé nationalement et trié par numéro RNA, donc aucun `Range` ciblé n'est
possible : il faut le lire en entier et filtrer à la volée. Le S3 **ne compresse pas**
(`Accept-Encoding: gzip` reste sans effet), ces 1,25 Go sont donc bien transférés.

C'est ce qui justifie `--rna-file` : pour un usage répété sur un seul département, la
voie manuelle est deux ordres de grandeur moins coûteuse. Elle est documentée dans
l'aide de la commande, pas cachée.

Le nom du dump de l'Annuaire portant un horodatage, il faut lire le listing du
répertoire à chaque run. Une expression régulière sur les `href` suffit — la page est un
index de serveur, pas du HTML de mairie. Introduire `node-html-parser` (D6) ici ferait
entrer la première dépendance du projet au mauvais endroit ; elle arrivera au lot 3,
face à de vraies pages.

Ces sources sont ajoutées à l'allowlist du test d'architecture qui traque les adresses
codées en dur : leur présence est donc un choix visible et vérifié, pas un oubli.

Si l'une de ces deux portes se ferme à son tour, il faudra soit une source tierce, soit
généraliser la voie manuelle. Rien dans le code ne permet de passer outre `robots.txt`,
et cela ne doit pas changer.
