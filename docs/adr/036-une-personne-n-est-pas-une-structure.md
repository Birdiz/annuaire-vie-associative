# ADR-036 — Une personne n'est pas une structure

Statut : acceptée — 2026-09-21

## Contexte

Troisième retour du client, sur l'Ain (01) et la Haute-Loire (43), et un seul mot : « il y a
**toujours** des noms ». Mesuré sur ses deux fichiers simples (2 111 et 1 009 lignes, produits
par la 1.2.0) :

| Défaut | 01 | 43 |
|---|---|---|
| Une personne en colonne `nom` — « Prénom NOM », « NOM Prénom », « X préside cette association » | ~520 (25 %) | ~260 (26 %) |
| Faux noms : jours, libellés, lieux-dits, messageries (« Gmail ») | ~65 | ~90 |
| Lignes identiques en trop, toutes dans des communes nouvelles | 26 | 0 |
| Adresses soudées au mot suivant — « …@cidff43.frhttps » | 22 | 69 |
| Un numéro 06 dans la colonne `nom` | 0 | 1 |
| Commune « Brioude Cedex » | 0 | 82 |

L'[ADR-032](032-deux-profils-d-export.md) avait **décidé de garder** les personnes — « le
président est souvent le bon interlocuteur » —, et les ADR-034 et 035 les rangeaient dans le
« résidu connu ». Le client refuse ce choix, et il a raison deux fois : la ligne présente une
donnée personnelle comme une structure, dans un fichier qui ne porte pas le régime juridique ; et
elle ne dit pas à quelle association s'adresser.

## Décision

**Une personne n'est jamais un nom de structure.** On cherche le nom de la structure dans la
fiche ; à défaut, le contact sort du profil simple, compté, et reste dans le complet.

### Reconnaître une personne

`normalisation/personne.ts`, fonction pure appelée par le nommage **et** par l'export (couche 3,
`estStructurePlausible`, qui voit aussi les libellés de domaine : `jean-dupont.fr`). Deux
étages, parce que leur ordre face au laissez-passer des motifs de structure n'est pas le même :

- **ce qui contamine n'importe quel nom**, jugé avant le laissez-passer : « préside »,
  « présidé par », une civilité suivie d'un nom — en tête, ou au milieu suivie d'un prénom —,
  un titre religieux, une fonction entre parenthèses. « Mme DUPONT Accueil de loisirs » passait ;
- **la forme d'un nom de personne**, jugée sur le cœur du segment — sans la fonction, le mot-outil
  ou le fragment de numéro qui le termine —, sur 1 à 4 jetons sans mot de structure, d'institution
  ou d'activité.

La forme exige un **prénom connu**. La casse seule condamnerait « SPA Haute-Loire » ou « APEL
Saint-Joseph », et ne séparerait jamais « Christophe Durand » de « Trail Urbain ». Trois niveaux de
preuve :

- **forte** — la casse confirme, en texte mixte : un nom de famille en capitales à côté d'un
  prénom, « Annie DURANDEL », « DURANDEL Gérard » ;
- **faible** — un prénom seul écrit comme un prénom, ou « Prénom Nom » sans capitales ;
- **aucune** — en particulier en capitales partout : « RESEAU LILAS », « PIERRE ANGULAIRE » sont
  des noms du RNA, et sans la casse « NOM Prénom » ne se sépare pas de « MOT Prénom ».

Une preuve forte suffit dans une énumération (« Tennis Club - Jean DUPONT ») ; les faibles doivent
l'être toutes (« Denise et Michelle »).

### La liste de prénoms — deuxième fichier tiers embarqué

Générée par `scripts/prenoms.ts` depuis le fichier national des prénoms de l'INSEE (édition 2025,
naissances 1900-2025, Licence Ouverte 2.0) — des effectifs statistiques, pas des données
collectées sur des personnes. Le script ne télécharge rien : le fichier se range à la main sous
`data/prenoms/`, et son SHA-256 est une constante du script. Prénoms d'**au moins 2 000
naissances** cumulées, normalisés, composés exclus (leurs parties y sont), et sans ceux qui sont
aussi des mots de structure ou de calendrier (« Harmonie », « Espérance », « Avril ») : **2 159
prénoms, 15 Ko**. Même discipline que htmx : un test recalcule son empreinte.

Le seuil est un compromis mesuré. À 1 000 naissances, la liste pèse 25 Ko et n'attrape que quatre
personnes de plus sur les deux fichiers du client ; les prénoms qui restent dehors ont été
donnés à moins de cent enfants en un siècle, et aucun seuil raisonnable ne les couvre.

### Chercher la structure

- **Dans le bloc** : la personne refusée, la boucle passe au segment suivant. La valeur d'un
  champ de catégorie — « Domaine de l'association : Aînés » — est neutralisée avant : c'est elle
  que la boucle prenait sinon.
- **Les libellés de champ séparent** comme un deux-points : « Président », « Trésorière »,
  « Secrétaire », « Téléphone », « Tél. », « Courriel », « E-mail », « Coordonnées », au
  singulier — aucun nom du RNA ne les porte. « SOCIÉTÉ de CHASSE Président » donne « SOCIÉTÉ de
  CHASSE ». Couper là où la page change de champ n'est pas tronquer : aucun texte n'est fabriqué.
  Un tiret espacé ne coupe que s'il sépare une personne d'autre chose : le RNA porte 2 150 noms
  avec un tiret.
- **Dans le titre de la fiche** : `analyser` relève le titre (`h1`–`h6`, `dt`, ou un élément dont
  une classe dit « titre », « title », « heading », « nom ») de chaque élément de moins de 2 000
  caractères qui en contient un. Un contact en hérite si sa fiche porte au plus trois contacts et
  si la branche du titre n'en porte aucun — un en-tête, et non la carte voisine.

Le titre n'est lu **que si le bloc nommait une personne**, et il l'est **dès la personne
rencontrée**. Lu partout, il nommait surtout des rubriques : sur le 43, 551 contacts sans nom en
recevaient un, « Nature », « Musique », « Sports divers » en tête — des lignes fausses là où il n'y
avait qu'une ligne en moins. Lu après les segments suivants du bloc, il perdait contre eux : sur
deux échantillons de trente fiches, les erreurs venaient toutes de ce qui suivait la personne —
l'activité (« Jeu de boules »), le hameau de l'école, un second membre du bureau.

### Faux noms

Chaque règle est vérifiée contre les 49 118 noms du RNA de la base de développement :

- un segment fait **uniquement** de jours et de mois — « Mardi matin », « Vendredi 13 » restent ;
- des débuts de phrase testés **en tête** — « Pour plus », « Nombre d' », « Par mail » ; « Sport
  pour tous » en compte des dizaines au RNA ;
- des libellés en segment entier, « Le Bourg », et « Hameau », « Esplanade », « ZA » en tête ;
- **le nom des autres communes du département**, forme longue comprise (« Vorey sur Arzon ») :
  referme le résidu de l'[ADR-035](035-un-bloc-qui-porte-tout-ne-nomme-rien.md) ;
- le texte mal décodé (« TÃ©l. »), l'encodage d'URL, la parenthèse fermante orpheline, et les
  entités HTML non décodées, dont le point-virgule coupait « Parents d&rsquo;Élèves » en
  « Élèves ».

### Adresses soudées, messageries

- **À la source** : `analyser` sépare les bornes de `<a>`, `<button>`, `<label>` (jamais celles de
  `<span>`, qui garde `contact<span>@</span>mairie.fr`) ; le suffixe d'une adresse ne change pas de
  casse (« laposte.netJudo ») ; `decollerEmail` coupe une messagerie suivie d'autre chose que son
  suffixe, et un suffixe courant suivi de `http` ou `www` — trois règles, et jamais « suffixe +
  minuscules », qui couperait `.coop` ou `.info`.
- **Les messageries** se reconnaissent par étiquette, quel que soit le suffixe (`gmail.fr`,
  `hotmail.be`), en TypeScript et dans le miroir SQL de l'export, qu'un test compare.
- **Les bases existantes** se réparent au démarrage, avec **la même fonction** et sous leur propre
  marqueur (`adresses_version`), avant le rejeu des noms — qui retrouve chaque contact dans sa page
  par sa valeur. La copie soudée se fond avec sa jumelle, s'efface si l'adresse est exclue
  (invariant 10), reste intacte si un humain l'a corrigée ; une exclusion inscrite sous la forme
  soudée vaut pour la forme décollée.

La frontière de l'ADR-035 gagne un troisième cas : **ce qui se répare sans la page, mais par une
règle que le code porte déjà, vit dans `reparation.ts` et appelle cette règle.** En SQL, ce
serait une seconde implémentation — la casse d'origine qui trahit « netJudo » ne s'y écrit qu'au
prix de centaines de motifs — et une valeur réparée autrement que l'extraction ne la produit ne
serait jamais retrouvée dans sa page.

### Communes nouvelles, « Cedex »

La clé de groupe du profil simple porte désormais le **code de la commune canonique** : le plus
petit des codes qui partagent le nom et l'**hôte** du site de mairie — l'hôte, parce que deux codes
frères diffèrent parfois d'un `/` final. Deux homonymes sans site commun restent deux communes. La
jumelle rattachée d'un code frère écarte la copie orpheline, et le décompte des écartés compte
les lignes consommées, sans quoi chaque fusion gonflait « sans nom ». Le profil complet ne change
pas.

Le seed retire « Cedex » du nom de la commune, et **la migration 13** le retire des bases déjà
amorcées. On ne retire que cela : préférer l'adresse physique aurait renommé des communes
nouvelles d'après la commune déléguée qui abrite la mairie.

### Invariant 6, tenu par l'export

Un seul motif téléphone, partagé par l'extraction et le nommage, **borné par des chiffres** : `\b`
échouait dans « …31Albert », et le mobile n'était ni extrait, ni exclu, ni effacé du nom. Le
filtre de nommage refuse tout numéro, fragment compris (« au 06 98 ») ; et l'export refuse un nom
qui en porte un, dans les deux profils, indépendamment de la réparation — un test le vérifie seul,
et rougit si l'on retire la garde.

### Réparation automatique

`VERSION_NOM` passe à 4. À la première ouverture, sans commande : migration 13, décollage des
adresses, rejeu du nommage depuis le cache (personnes, titres, communes voisines), puis effacement
des noms que le cache ne couvre plus et que le filtre courant refuse.

## Mesure

La règle du projet : mesurer sur un département jamais collecté, en comptant des catégories.
Le 43 a été collecté à neuf avec la 1.2.0 (955 lignes, le même profil de défauts que le fichier du
client : 82 « Cedex », 69 adresses soudées, un 06 dans un nom), puis une copie de la base a été
ouverte par la nouvelle version, sans aucune commande. Les personnes et faux noms restants sont
comptés par un classement **indépendant** du détecteur livré. Le 35 et le 88 viennent de la base
de développement, sur des copies.

| | 43 | 88 | 35 |
|---|---|---|---|
| Lignes du profil simple | 955 → 850 | 785 → 720 | 3 204 → 3 051 |
| Personnes en colonne `nom` | 145 → 1 | 126 → 3 | 115 → 6 |
| Lignes identiques | 0 → 0 | 20 → 0 | 61 → 0 |
| Adresses soudées | 69 → 0 | 19 → 0 | 0 → 0 |
| « Cedex » | 82 → 0 | 35 → 0 | 0 → 0 |
| Numéro dans une colonne hors contacts | 1 → 0 | 0 → 0 | 1 → 0 |
| Messageries prises pour des noms | 17 → 0 | 5 → 0 | 5 → 0 |

Sur le 43, des 341 contacts qu'une personne nommait, **257 retrouvent leur structure** — 144 dans
le bloc, 112 dans le titre de la fiche — et 84 sortent du profil simple. Quatre échantillons de
trente, tirés au hasard et relus page par page au fil des corrections : 27, 27, 28 et 28 noms
justes ; chaque erreur des trois premiers a donné une règle (titre lu dès la personne, entités
HTML, communes voisines).

Faux positifs, sur les 48 182 noms distincts du RNA passés par le filtre de nommage : **3** en
capitales, et tous contiennent un nom de personne (« … DE MONSIEUR CHARLES X ») ; 142 (0,3 %)
réécrits en casse de titre, surtout des prénoms seuls et des « Prénom Nom » — un test de charge,
les pages écrivant plus volontiers les capitales. Sur les 4 822 noms lus dans les blocs de la base
de développement, les 911 nouveaux rejets relus sont des personnes et des libellés.

Poids du bundle : 351,6 Ko → 383,6 Ko, dont 15 Ko de prénoms.

## Conséquences

- Le fichier simple perd des lignes — 11 % sur le 43 — et chacune est comptée : « sans nom de
  structure » ou « sans indice de vie associative ». Une ligne fausse est pire qu'une ligne en moins.
- La première commande après la mise à jour relit toutes les pages en cache : 1,5 s sur le 43,
  6 s sur la base de développement.

**Ce qui reste, et qu'on assume** : les prénoms sous le seuil ; les personnes écrites en
capitales partout ; « Nom Prénom » sans capitales (« Durandel Céline ») ; les lieux-dits sans
marqueur (« La Côte ») ; le nom d'une commune déléguée (« Belmont » pour Valromey-sur-Séran), que la
table des communes ne connaît pas ; une section prise pour sa structure (« Danse de salon » pour
l'association qui la porte).

## Ce qui a été écarté

- **Garder les personnes avec un avertissement** — la décision de l'ADR-032, que le client refuse.
- **Un dictionnaire de noms de famille** : aucun ne se justifie au poids, la casse fait ce travail.
- **Le titre de fiche lu partout** : il nommait des rubriques.
- **Une migration SQL pour les adresses soudées** : voir ci-dessus.
- **Dédupliquer les communes nouvelles à la collecte** : sans effet sur les bases existantes, et le
  cache HTTP absorbe déjà les requêtes répétées ([ADR-010](010-decoupage-du-crawl.md)).
- **Le tiret espacé comme séparateur général**, et « se termine par un mot-outil » comme rejet :
  2 150 et 249 noms du RNA.
