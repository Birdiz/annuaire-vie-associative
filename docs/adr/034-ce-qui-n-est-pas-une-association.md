# ADR-034 — Ce qui n'est pas une association

Statut : acceptée — 2026-09-10

## Contexte

Premier essai du client sur la Loire, et deux reproches :

> « Je comprends pas pourquoi il me sort des trucs qui n'ont rien à voir avec des assoc ?
> (genre les garages etc..) Et de plus sur certaines communes même s'il y a un annuaire
> dispo, il extrait rien. »

Le fichier livré donne raison au premier sans discussion. Sur 1 590 lignes, **1 380 (87 %)
n'ont aucune correspondance RNA** : leur nom vient du bloc DOM (ADR-033, étape 2) ou du
domaine de l'adresse (étape 3). On y lit « Garage Pupier », « Boulangerie Vericel-Guyot »,
« CIC Lyonnaise de banque », « GAEC Jacquet Elevage » — et aussi « Dans tous les cas »,
« Site internet », « Facebook », « Retrouvez toutes les informations ICI », « GAGNAIRE
Maxence », plus une ligne « France » réunissant trente adresses sans rapport.

Trois mécanismes indépendants, mesurés sur le run complet des Vosges (88, 511 communes) :

1. **Le crawl visite des annuaires d'entreprises.** `annuaire` valait +3 dans `scorerLien`,
   et aucun terme ne parlait des commerces : `/commerces/annuaire-des-entreprises/`
   marquait +6, soit mieux que la moitié des vraies rubriques associatives. 333 des
   3 183 contacts du 88 viennent de pages explicitement commerçantes.
2. **Rien ne filtre à l'extraction.** Le pré-filtre est consultatif (ADR-014) : il note la
   page, l'extraction prend tout. Les pages notées de 10 à 20 ont livré 1 169 contacts
   pour **7** rattachements au RNA.
3. **`acceptable()` acceptait presque tout.** Le filtre de `nom-pressenti.ts` connaissait
   la prose, le mobilier en préfixe, les civilités et les adresses — mais ni le
   vocabulaire commercial, ni les libellés de champ testés autrement qu'en préfixe, ni les
   fils d'Ariane, ni les noms de commune, ni « France ».

## Décision

Un filtre en **trois couches**, et non une.

| Couche | Ce qu'elle empêche | Où |
|---|---|---|
| Ne pas visiter | Le crawl ne dépense plus son budget sur les annuaires d'entreprises | `TERMES_HORS_SUJET`, `decouverte/scoring.ts` |
| Ne pas nommer | Un libellé de menu, une phrase, un horaire, un commerce ne deviennent pas des noms de structure | `acceptable()`, `decouverte/nom-pressenti.ts` |
| Ne pas livrer | Une structure sans indice de vie associative ne prend pas de ligne dans le profil simple | `estStructurePlausible`, `normalisation/plausibilite.ts` |

**Trois couches parce qu'elles ne protègent pas les mêmes bases.** La première ne vaut que
pour les collectes à venir. La deuxième répare une base déjà collectée — `VERSION_NOM`
passe à 3, et `annuaire noms` réévalue tout ce qui ne porte pas la version courante, en
relisant le cache disque, sans réseau. La troisième ne lit que la base : elle rattrape même
un poste dont le cache a été purgé, et c'est la seule qui protège le fichier livré demain
à partir d'une collecte d'hier.

### Une seule liste de vocabulaire, deux usages

`scorerLien` décide des liens à suivre **et** sert d'indice à l'export. Conséquence
recherchée : les termes hors sujet ajoutés à la première couche retirent les garages d'une
base **déjà collectée**, au moment de l'export, sans recollecte. C'est la discipline que le
pré-filtre applique déjà en réemployant cette même fonction — deux listes qui doivent
s'accorder finissent toujours par diverger.

Le poids des termes hors sujet est **-6**, distinct du -4 des rubriques administratives. À
-4 ils n'auraient qu'annulé « annuaire » ; à -6 ils l'emportent, sans emporter « vie
associative » (+6 sur le chemin, +6 sur l'ancre) : une rubrique qui annonce les
associations *et* les commerces reste visitée.

### Le faisceau d'indices

Une ligne du profil simple **affirme** une structure de la vie associative : le profil ne
porte ni provenance ni régime juridique (ADR-032), donc rien dans le fichier ne vient
nuancer ce que la ligne dit. Elle doit reposer sur au moins un indice :

- le RNA la connaît — c'est un registre, il passe avant toute heuristique ;
- son nom porte du vocabulaire de structure (`MOTS_DE_STRUCTURE`, plus les motifs de
  `classification.ts`, déjà chargés d'affirmer « ce texte nomme une structure ») ;
- la page qui la porte a un vocabulaire associatif (`scorerLien` > 0).

Et un contre-indice qui l'emporte sur les deux derniers : le **vocabulaire commercial**.
Une liste de commerçants publiée sous `/vie-locale/` reste une liste de commerçants.

**Un nom déduit d'un domaine exige en plus un indice de page.** C'est la réponse à
« garder mais restreindre » : une inférence n'a été lue nulle part (ADR-033), et sans
corroboration elle se présenterait comme un fait.

**La branche « mairie » n'est pas concernée.** « Mairie de Dogneville » ne se fait passer
pour rien d'autre que ce qu'elle est, et c'est souvent le seul contact d'une commune dont
le site ne publie pas d'annuaire. Ce que le faisceau protège, c'est la ligne qui affirme
une association sans en être une.

L'indice se cumule sur **toutes** les lignes du groupe, jamais sur la première seule : le
fichier ne doit pas dépendre de celle des deux pages que le tri place en tête.

### Le verdict du pré-filtre, essayé puis retiré

Un quatrième indice avait sa place évidente : le pré-filtre note déjà chaque page, et son
score se corrèle franchement au rattachement RNA — les pages notées de 10 à 20 ont livré
1 169 contacts pour 7 rattachements, celles notées 35 et plus, 528 pour 372. Le seuil de
rétention du pré-filtre (8) ne prouvant rien, il fallait le relever ; 25 semblait le bon
endroit.

**Mesuré, il ne sauvait aucun contact.** Sur les 881 contacts nommés du 88, le nombre de
lignes que ce signal rescapait, et que ni le vocabulaire du nom ni celui de l'URL ne
rescapaient déjà, est **zéro**. Rien d'étonnant après coup : une page que le pré-filtre note
haut est une page où des noms du RNA apparaissent, donc une page d'annuaire, donc une page
dont l'URL le dit. Il coûtait deux sous-requêtes corrélées par ligne, et il a été retiré.
Un signal qui n'ajoute rien n'est pas un signal.

### Ce qui est écarté se compte, et se dit

`compterEcartes` rend désormais **deux** nombres au lieu d'un : les contacts qu'on ne sait
pas nommer, et ceux qu'on a nommés sans pouvoir les rattacher à la vie associative. Les
deux appellent des gestes différents — le premier se rattrape (`annuaire noms`, une
correction en revue), le second est une décision de l'outil. L'écran d'export et la CLI
disent les deux : sans cela, l'exclusion se lit comme une perte de données.

## Conséquences

Sur les Vosges, base inchangée, sans recollecte : **950 lignes → 780**. Les 117 lignes
rattachées au RNA sont **toutes** conservées — le filtre ne touche qu'aux structures que le
registre ignore. Parmi les 268 lignes disparues : les garages, carrosseries, pharmacies,
notaires et exploitations agricoles ; les fils d'Ariane (« Associations / Sports ») ; les
libellés de champ (« Site internet », « Télécopie ») ; les fonctions (« Directrice ») ; les
phrases (« Cette rubrique est au service des associations ») ; les adresses postales
(« CS 10 032 - 42160 Andrézieux-Bouthéon ») ; les noms de commune.

**Ce qui reste, et qu'on assume.** Les noms de personnes sans civilité — « Sylvie
Couvreur », « GAGNAIRE Maxence » — passent encore quand ils figurent sur une page
d'annuaire : ce sont souvent les présidents que la commune publie elle-même, et aucun
signal fiable ne les sépare d'un nom de structure sans dictionnaire de prénoms. Le profil
complet porte la colonne `regime`, qui les signale ; l'écran d'export l'avertit déjà.

**Ce qu'on n'a pas fait.** Suivre la pagination d'un annuaire a été écrit puis retiré : la
mesure sur les 1 184 pages du 88 montre que les suites dont l'URL garde le vocabulaire sont
**déjà** visitées, et que les liens restants qui ressemblent à une pagination sont, à seize
pages près, des articles d'actualité portant une ancre numérique. Une heuristique de plus
pour un gain nul et un risque réel : le §9 demande de mesurer avant d'ajouter.
