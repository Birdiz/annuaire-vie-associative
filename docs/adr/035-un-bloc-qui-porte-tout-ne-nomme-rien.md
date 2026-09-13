# ADR-035 — Un bloc qui porte tous les contacts n'en nomme aucun

Statut : acceptée — 2026-09-13

## Contexte

Le filtrage du lot précédent (ADR-034) a retiré du fichier les garages et les libellés de
navigation. Il restait, dans le même fichier, un défaut plus grave et d'une autre nature :
des lignes **fausses**.

Sur les Vosges, une ligne nommée « BADMINTON CLUB SAINT-DIE-DES-VOSGES » livrait
**90 adresses**, dont celles de 89 autres associations. Une autre en portait 53 sous
« BIBLIOTHEQUE PATRIMONIALE DU DIOCESE », une troisième 21 sous « SOCIETE DE CHASSE
COMMUNALE ARCHETTES-VOSGES ». Le fichier de la Loire a la même maladie — c'est elle qui
produisait la ligne « France » et ses trente adresses.

La cause se lit en une page. `rattacher` parcourt les blocs DOM qui portent le contact, du
plus étroit au plus large, et retient le premier nom du RNA qu'il y reconnaît. Sur une
fiche dont la cellule ne porte que « Mr Frédéric SCHNEIDER », le bloc suivant est la
**section entière** : 4 582 caractères, vingt et un contacts, et le nom de la première
association venue. Les vingt et un l'ont reçu.

Ce n'est pas une erreur de rattachement parmi d'autres : c'est une erreur qui se propage à
tous les contacts d'une page d'un coup, et qui se présente dans le fichier livré avec
l'autorité d'un registre national.

## Décision

**Un bloc qui porte plus de trois contacts n'est plus un contexte.** `extraction.ts` compte,
une fois par page, les contacts distincts de chaque bloc, et retire des `contextes` ceux qui
dépassent `CONTACTS_MAX_PAR_BLOC`. Le rattachement et le nommage en héritent sans le savoir :
ils reçoivent les blocs qui parlent de *ce* contact, et plus les conteneurs qui les empilent.

### Trois, et le chiffre est mesuré

La fiche d'une structure porte souvent un fixe, un mobile et une adresse. Au-delà, on n'a
trouvé aucune fiche. Balayage des 1 184 pages visitées du département témoin :

| Plafond | Rattachements | Groupes de 4 contacts ou plus sur une même page | Plus gros groupe |
|---|---|---|---|
| aucun | 906 | 28 | **147** |
| 1 | 40 | 0 | 1 |
| 2 | 179 | 0 | 3 |
| **3** | **236** | **0** | **3** |
| 4 | 270 | 7 | 4 |

Le plafond retire 382 des 506 rattachements de la base. C'est énorme, et c'est le sujet :
vérifiés page par page, ils étaient faux. Ce que la colonne « rattachés au RNA » comptait
n'était pas ce qu'elle promettait.

### Ce qui se répare en SQL vit dans une migration ; ce qui demande la page vit ailleurs

La correction du code ne vaut que pour les collectes suivantes, or le client a une base et
un fichier à livrer. Deux mécanismes de réparation, et la frontière entre eux est ce dont
ils ont besoin :

**La migration 12** détache les rattachements dont le groupe (commune, association, page)
porte quatre contacts ou plus. Elle s'applique à l'ouverture, sans commande, **et sans le
cache** — lequel se purge. Elle n'a pas accès aux blocs, donc elle approxime ; confrontée
page par page à ce que le code corrigé décide, elle retire 364 des 382 rattachements
devenus faux et n'en emporte que **3** qui auraient été gardés. Un contact détaché ne perd
rien : il garde sa provenance, retombe sur le nom lu dans son bloc puis sur son domaine
(ADR-033), et le faisceau d'indices de l'ADR-034 décide s'il mérite une ligne.

**`src/reparation.ts`** rejoue le nommage, qui lui exige le corps de la page. Jusqu'ici
c'était une commande à taper (`annuaire noms`) : un client qui installait la nouvelle
version et exportait dans la foulée recevait un fichier portant encore les « Site
internet » et les « France Grand Est » de l'ancienne heuristique, sans savoir qu'une
commande les aurait effacés. La passe s'exécute désormais depuis la porte commune de la
CLI, comme la purge — « au démarrage » ne veut pas dire « par les commandes qui y pensent ».

**Un marqueur, et non un balayage.** `metric(reparation, nom_pressenti_version)` retient la
dernière version d'heuristique appliquée : la réparation s'exécute au plus une fois par
version. Sans lui, une base dont le cache a disparu repasserait sur tous ses contacts à
chaque commande — `remplirNoms` ne marque délibérément pas les lignes dont le corps manque,
pour qu'elles repassent quand il revient, et cette respiration-là n'a de sens que dans une
commande explicite.

**Et pour ce que le cache ne couvre plus, une revalidation de la chaîne.** Un nom écrit par
une version antérieure ne se recalcule qu'en relisant la page ; mais « ce nom passerait-il
aujourd'hui ? » ne demande que la chaîne. Les noms que le filtre courant refuse sont
**effacés** — on ne remet rien à la place. Garder un « Site internet » parce qu'on ne sait
plus le recalculer serait le pire des deux.

## Conséquences

Sur les Vosges, base ouverte par la nouvelle version, aucune commande tapée :

| | Avant | Après |
|---|---|---|
| Lignes du profil simple | 950 | 784 |
| Lignes réunissant 5 contacts ou plus | 24 | 5 |
| Plus grosse ligne | **68 contacts** | 5 contacts |
| Lignes portant un type RNA | 117 | 103 |

Les 14 lignes typées perdues sont des lignes dont le type venait d'un rattachement de
conteneur : elles nommaient une association qui n'était pas la leur.

Deux ajustements sont venus de la même mesure : les noms de région (« France Grand Est »
nommait 37 contacts d'un même annuaire) et les rubriques composées (« Associations
sportives ») rejoignent le mobilier de page ; les domaines d'institutions — `ac-*`,
`agglo-*`, `cc-*`, `*.gouv.fr` — cessent de nommer des structures, une école n'étant pas
une association.

**Ce qui reste, et qu'on assume.** Le nom d'une commune **voisine** lu sur une page
(« Fraize » sur le site de Plainfaing) passe encore : le filtre ne connaît que la commune
du contact, et lui passer la liste du département demanderait de la faire descendre
jusqu'à une fonction pure qui n'a pas de base. Les adresses d'une mairie dont le domaine
ne correspond pas à l'URL déclarée sortent sous le libellé du domaine (« Plombieres » pour
Plombières-les-Bains). Les noms de personnes sans civilité restent le résidu connu de
l'ADR-034.
