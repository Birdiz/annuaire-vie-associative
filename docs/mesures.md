# Mesures

Ce que le pipeline a produit sur des données réelles, et ce que les chiffres autorisent à
conclure. Le README ne garde que le mode d'emploi ; les résultats vivent ici.

Département de mesure : l'Ille-et-Vilaine (35).

## Avancement, lot par lot

Le pipeline est un entonnoir de coût en huit étages (§6 du [brief](brief.md)). Huit lots ont
été livrés, et le brief est couvert de bout en bout :

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
| — Emballage | `npx`, image Docker, exécutable Windows | ✅ lot 7 |
| — Pilotage | lancer et arrêter un run depuis l'interface | ✅ lot 8 |

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
par un CMS trouvées au lot 5 arrivent ainsi en tête de file.

Lot 7 : l'outil s'emballe. **Un seul bundle** sert les trois cibles du brief — 262 Ko à sa
construction, 271 Ko depuis le lot 8 — soit un paquet npm de 132 Ko, une image Docker de 163 Mo,
et un exécutable Windows autonome de 88,5 Mo qui
n'attend ni Node, ni installateur, ni droits d'administrateur. Le développement, lui, n'a toujours
aucune étape de build : c'est l'emballage qui en a une
([ADR-022](docs/adr/022-un-artefact-trois-emballages.md)).

Lot 8 : l'outil se pilote enfin sans terminal. Un double-clic sur l'exécutable **démarre
l'interface et ouvre le navigateur** — le §2 du brief, pris au mot. L'écran demande l'URL de
contact si elle manque, puis offre un bouton : **le run part de la page, sa phase avance à
l'écran, et un second bouton l'arrête** sans rien perdre. Le worker tourne dans le process de
l'interface, ce qui est le seul moyen d'obtenir un arrêt propre sous Windows, où il n'existe pas
de `SIGTERM` ([ADR-024](docs/adr/024-lancer-un-run-depuis-l-interface.md)).


## Ce que coûte un département, et ce qu'il rapporte

Le premier passage réel sur l'Ille-et-Vilaine a livré trois enseignements, consignés dans
l'[ADR-013](adr/013-ordre-de-parcours-et-budget.md).

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
frontière découverte ([ADR-015](adr/015-temporalite-rna-et-dormance.md)).

**Le pré-filtre borne le coût d'inférence à 6,5 % des pages**, contre 40,3 % sans lui, et le fait
sans rien perdre de mesurable : les 157 pages ayant produit un contact rattaché à une association
sont toutes retenues, et les 2 003 contacts rattachés du département avec elles
([ADR-014](adr/014-prefiltre-consultatif.md)). Le seuil n'a pas été choisi puis justifié : il
est le dernier point de la courbe où le filtre retient plus de pages prometteuses qu'il n'en écarte.

Ce que ce chiffre ne dit pas encore : le vrai taux de rappel. Savoir si les 86 pages écartées qui
nommaient pourtant une association contenaient des contacts exploitables suppose de les soumettre
au LLM. Elles sont l'échantillon désigné pour le mesurer dès que l'étape [6] existera.

**Le lot 5 a levé la limite que cette section annonçait** — un même email présent à la fois
rattaché à une association et au niveau de la commune. 111 doublons ont été résorbés, et zéro au
passage suivant : la règle est une requête SQL rejouable, donc idempotente
([ADR-019](adr/019-deduplication-et-score-de-revue.md)).

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
([ADR-017](adr/017-validation-mx.md)). **Le lot 6 leur donne un chemin sans trancher cette
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
familles différentes ([ADR-018](adr/018-classification-en-six-types.md)).


## Ce que la démonstration hors ligne donne à lire

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
  ([ADR-019](adr/019-deduplication-et-score-de-revue.md)) ;
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
  ([ADR-018](adr/018-classification-en-six-types.md)) ;
- **`marie.dupont@` tombe à 0,39** alors qu'elle a été lue à 0,54 : adresse nominative, lue dans du
  texte, sur un domaine dont le MX n'a pas pu être vérifié. Trois signaux, tous trois inscrits dans
  `score_motifs` — un score qu'on ne peut pas expliquer n'est pas révisable ;
- **aucun verdict MX n'aboutit ici**, et c'est voulu : la démonstration pointe elle-même le
  résolveur DNS vers un port mort, pour que « aucune requête ne sort de la machine » reste vrai au
  pied de la lettre. On y voit au passage que le code distingue « pas de MX » de « je n'ai pas pu
  savoir ».

Les métriques affichées ensuite donnent les volumes par étage de l'entonnoir. La base de
démonstration est créée dans `data/demo`, ignorée par git, et recréée à chaque exécution.

