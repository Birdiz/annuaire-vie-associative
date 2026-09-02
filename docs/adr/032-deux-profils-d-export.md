# ADR-032 — Deux profils d'export, et ce que le profil simple abandonne

Statut : acceptée — 2026-09-01

## Contexte

Le premier utilisateur de l'outil s'en sert et en est satisfait, sauf du fichier. Trois
reproches, tous sur le CSV, et ils disent la même chose sous trois angles : **le fichier
est écrit pour l'outil, pas pour la personne qui doit s'en servir.**

1. **Seize colonnes**, dont il n'en lit que cinq.
2. **Des lignes en double.** Ce n'en sont pas : l'export produisait une ligne par *valeur
   de contact*. Une association avec un e-mail et un téléphone sortait deux fois, sous le
   même nom. Le fichier qu'il tient à la main, lui, est une ligne par *structure*,
   téléphone et e-mail côte à côte.
3. **Beaucoup de lignes sans nom d'association** — « sans ça, la ligne ne me sert à rien ».

Le point 3 relève de l'[ADR-033](033-nommer-une-structure-sans-le-rna.md). Les deux
premiers sont l'objet de celle-ci.

La difficulté n'est pas technique. `src/export/csv.ts` s'ouvrait sur une affirmation :
« la provenance voyage avec la donnée », et un export qui la laisserait derrière
« reproduirait exactement le problème que l'outil prétend résoudre ». L'écran d'export
répétait la promesse. Livrer cinq colonnes, c'est aller contre une doctrine écrite du
projet — pas contre l'invariant 5, qui est une contrainte `NOT NULL` du schéma et reste
entier, mais contre une règle que le code s'était donnée à lui-même.

## Décision

**Deux profils de la même fonction, pas deux fonctions.**

| | `complet` | `simple` |
|---|---|---|
| Colonnes | 16 historiques + `nom_pressenti` + `nom_source` | 6 |
| Granularité | une ligne par contact | une ligne par structure |
| Défaut | ligne de commande | interface |

Le profil `complet` est **l'artefact auditable** : c'est lui qui porte la provenance, le
régime juridique et le score. Il ne change pas — ses seize colonnes gardent leur ordre,
un test l'écrit en dur, et les deux nouvelles sont **ajoutées en queue** pour ne décaler
aucun fichier déjà livré.

Le profil `simple` est un **extrait explicitement dérivé**, pour la personne qui doit
passer des appels et non auditer une collecte.

### La colonne `type`

Six colonnes et non cinq : `departement`, `commune`, `nom`, **`type`**, `telephone`, `email`.
Une adresse d'association ne se travaille pas de la même façon selon qu'elle désigne un club
sportif ou un accueil de loisirs, et le type existait déjà en base sans jamais atteindre le
fichier livré.

Les valeurs sont les six du §6.7, sans accents comme toute valeur de colonne
([ADR-018](018-classification-en-six-types.md)). Deux chemins la renseignent, et l'écart entre
eux est délibéré :

- **une association du RNA** porte le type que l'étape [7] lui a calculé, code objet à l'appui.
  `diverses` y est un fourre-tout **assumé** : le code a été lu, il ne rentrait dans aucun des
  cinq autres types ;
- **tout le reste** — nom lu dans un bloc, déduit d'un domaine, ou mairie — n'a aucun code objet.
  `classer(null, nom)` y retomberait sur `diverses` par défaut, et ce `diverses`-là ne dirait pas
  la même chose : non pas « le code a été lu et ne dit rien de plus », mais « on n'a rien lu du
  tout ». Les confondre ferait passer une ignorance pour un classement. Seuls les verdicts venus
  d'un **motif de nom** sont retenus, et la cellule reste vide sinon.

Ce second chemin n'est pas un raffinement : ce sont précisément les structures qui intéressent
une collectivité — périscolaire, accueil de loisirs — qui ne sont jamais au RNA, donc jamais
rattachées. Sans lui, leur colonne serait vide par construction.

Même discipline que `regime`, en somme : refuser de trancher est une réponse, deviner n'en est
pas une.

### Ce que le profil simple abandonne, et qui doit être dit

- **La provenance.** Impossible de remonter à la page d'origine d'une adresse depuis ce
  fichier. L'écran d'export le dit à l'endroit exact où le fichier quitte l'outil.
- **Le régime juridique.** Pas de colonne `regime`, et la concaténation peut réunir
  `contact@club.fr / marie.dupont@club.fr` dans une seule cellule — une adresse de
  fonction et une adresse qui désigne une personne. L'invariant 7 reste tenu par le modèle
  et par le profil complet, mais **pas par ce fichier-là**. C'est la conséquence la plus
  lourde de la décision, elle est de nature RGPD et non cosmétique, et l'avertissement de
  l'écran est réécrit pour le profil simple.
- **La distinction personne / structure, jusque dans le nom.** Sur le département 88,
  218 des 950 lignes (23 %) portaient en colonne `nom` une personne physique — « Michel
  BERTRAND », « FRITZ Claudine » — parce que c'est ce que la page nommait à côté du
  contact, et 107 d'entre elles une adresse personnelle. **Décision prise de les
  conserver** : le président d'une association est souvent le bon interlocuteur, et un
  fichier qui les écarte perd près d'un quart de sa matière. La contrepartie est que
  l'avertissement de l'écran doit le dire en toutes lettres, ce qu'il fait.
- **La certitude sur le nom.** Un nom peut avoir été déduit d'un domaine
  ([ADR-033](033-nommer-une-structure-sans-le-rna.md)). Le profil complet le signale par
  `nom_source` ; le profil simple ne le peut pas, l'écran le dit donc en toutes lettres.

Le commentaire d'en-tête de `csv.ts` est réécrit en conséquence : la provenance est
**obligatoire en base et disponible à l'export**, le profil complet en est le porteur. Ce
qui serait fautif, ce n'est pas d'offrir un extrait — c'est de le présenter comme l'export
de référence, ou de laisser un commentaire promettre ce que le code ne tient plus.

### Regroupement : la clé porte toujours la commune

Quatre branches, dans l'ordre — voir l'ADR-033 pour la cascade des noms :
`A:<insee>:<association_id>`, `P:<insee>:<nom_pressenti_normalise>`,
`D:<insee>:<domaine>`, `M:<insee>:<valeur_normalisee>`.

Le `code_insee` figure dans **toutes**, y compris pour une association rattachée. L'index
unique des contacts est `(association_id, kind, valeur_normalisee)`, sans la commune :
rien n'empêche donc un groupe de chevaucher deux communes, et la colonne `commune` du
fichier n'aurait alors plus de valeur cohérente.

**La branche `M:` est clée par adresse**, et non par commune. Une mairie a souvent six
adresses de service — périscolaire, CCAS, sports — et les réunir dans une cellule unique
rendrait la ligne inutilisable. Conséquence assumée : un numéro de téléphone n'a pas de
domaine, donc une ligne « Mairie de … » sort sans téléphone. C'est le nom lu dans le bloc
qui les réunira, quand il sera là.

**Aucune fusion entre branches.** Un `nom_pressenti` « Tennis Club de Bruzou » et
l'association RNA homonyme font deux lignes. Les fusionner supposerait de faire confiance
à un nom deviné pour identifier une association — c'est-à-dire refaire un rattachement
approximatif, que l'[ADR-012](012-rattachement-et-regime-des-contacts.md) refuse. Le
doublon apparent est le prix de ne pas inventer un lien.

### La déduplication commune/association, appliquée à la lecture

Les deux index uniques partiels ne se voient pas l'un l'autre : une même adresse lue dans
un bloc nommant une association et dans un bloc anonyme fait deux lignes, toutes deux
légitimes. L'étape [7] supprime la seconde
([ADR-019](019-deduplication-et-score-de-revue.md)) — pour qui a pensé à lancer la
normalisation.

Rien ne l'y oblige, et l'oubli passait presque inaperçu : la ligne en trop sortait sans
nom, donc dans le bruit. **Depuis que la cascade la nomme, elle prend l'apparence d'une
seconde structure**, et un doublon nommé se lit comme un fait. Le profil simple applique
donc la règle de `dedup.ts` en lecture, base normalisée ou non.

### Agrégation en JavaScript, malgré `group_concat`

SQLite 3.53 est embarqué dans Node 24 et `group_concat(… ORDER BY …)` fonctionne —
vérifié, ce n'est pas un problème de version. Trois raisons de ne pas s'en servir :

1. le libellé de la branche `D:` n'est pas calculable en SQL ;
2. il faudrait deux concaténations conditionnelles par groupe, **plus** une déduplication
   sur la valeur publiable, et `group_concat(DISTINCT …)` n'accepte ni séparateur ni
   `ORDER BY` ;
3. ni `GROUP BY` ni `ORDER BY` sur expression ne permettent à SQLite de streamer sans
   trieur : la mémoire est la même des deux côtés.

Le générateur garde donc son curseur `.iterate()` et **rompt sur le changement de clé**.
La mémoire retenue est celle d'un seul groupe — pas d'une commune, pas d'un département.
La rétro-pression du §1 du brief est intacte.

### Le comptage et le rendu partagent leur requête

`compterLignes` et `lignesCsv` dérivent de la même CTE. Un écran qui annonce un nombre que
le fichier ne tient pas est pire qu'un écran muet, et un test vérifie l'égalité sur un
corpus qui couvre les quatre branches.

S'y ajoute `compterSansNom`. Ce n'est pas un ornement : sans ce chiffre, l'exclusion des
contacts anonymes est silencieuse, et qui compare les deux fichiers conclut à une perte de
données — à raison de s'en inquiéter. La CLI et l'écran le disent tous les deux.

### La table `{ nom, cellule }`

La liste des noms de colonnes et le tableau des valeurs vivaient côte à côte, couplés
**par position**, sans aucune garde : insérer une colonne au milieu de l'un décalait
silencieusement toutes les cellules de l'autre. Les tenir ensemble rend le décalage
impossible par construction. C'était à refermer *avant* d'ajouter un second profil, sous
peine de doubler le problème.

## Conséquences

- Le fichier livré au client tient en cinq colonnes et une ligne par structure.
- Le fichier auditable existe toujours, et reste le défaut de la ligne de commande.
- Une valeur inconnue de `--profil` est une erreur d'usage (code 2). À l'écran, elle
  retombe sur `complet`, jamais sur `simple` : `complet` contient `simple`, l'inverse est
  faux, et une URL gardée en favori avec un paramètre mal recopié ne doit pas livrer un
  fichier amputé sans le dire.
- Les deux fichiers portent des noms différents — `annuaire-35-simple.csv` et
  `annuaire-35.csv` — parce qu'ils atterrissent dans le même dossier de téléchargements.
- Les numéros sortent **tels qu'ils ont été lus**, apostrophe de désamorçage comprise
  devant un `+33`. Reformater serait modifier la donnée livrée ; la graphie de la page est
  ce que l'utilisateur reconnaît.

## Ce qui n'a pas été retenu

**Un seul format à cinq colonnes.** Aurait supprimé l'artefact auditable, donc la capacité
de répondre « d'où sort cette adresse ? » — la question même que l'outil existe pour
rendre répondable.

**Un fichier de provenance annexe, livré à côté.** Deux fichiers à garder ensemble, dont
le second ne serait jamais ouvert. La séparation par profil dit la même chose sans exiger
de discipline.

**Un plafond de longueur par cellule.** Une troncature silencieuse est une perte de donnée
invisible dans un fichier livré. Le profil complet reste exhaustif à côté.
