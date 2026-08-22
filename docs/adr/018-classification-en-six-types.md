# ADR-018 — Six types : ce que le code RNA porte, et ce qu'il ne porte pas

Statut : acceptée — 2026-08-22

## Contexte

Le §6.7 demande de classifier chaque association en « sportive / culturelle / diverses /
sociale / comité des fêtes / centre de loisirs », « via codes objet RNA, LLM en fallback
uniquement ». La colonne `type_classifie` et sa contrainte `CHECK` existent depuis le lot
1 et n'ont jamais été renseignées.

Le fallback LLM est écarté (ADR-015). La question devient donc : le code objet RNA
suffit-il, et sinon, que fait-on du reste ?

## Ce que la mesure a montré

`objet_social1` est un code hiérarchique à six chiffres dont les trois premiers désignent
la famille. Sur l'Ille-et-Vilaine il est renseigné à **100 %** des 36 170 associations,
réparties sur **31 familles**.

Aucun référentiel embarquable n'accompagne ces codes. La sémantique de chaque famille a
donc été lue sur le vocabulaire distinctif des noms qu'elle porte, mesuré par fréquence
relative :

| Famille | Effectif | Vocabulaire distinctif |
|---|---:|---|
| 006 | 8 270 | théâtre, compagnie, musique, productions |
| 011 | 6 501 | sportive, tennis, football, gymnastique |
| 015 | 3 152 | d'élèves, parents, l'école, APEL, étudiants |
| 007 | 2 772 | canin, tarot, poker, bridge, échecs, philatélique |
| 014 | 2 634 | amicale, personnel communal, employeurs |
| 009 | 1 606 | fêtes, jumelage, amitié, aînés ruraux |
| 017 | 1 459 | santé, sang, donneurs, soins |
| 020 | 1 419 | humanitaire, solidarité, Afrique |
| 024 | 1 223 | environnement, nuisibles, nature, sauvegarde |
| 013 | 568 | chasse, chasseurs, pêche, cynégétique |

C'est une inférence, et elle est faillible : une famille peu peuplée n'a pas de
vocabulaire lisible, et le rabattement de `014` ou `050` reste discutable. Ce qui suit en
tient compte — le fourre-tout absorbe ce qui n'est pas clair, plutôt que d'inventer une
certitude.

**Le résultat décisif est ailleurs.** Les 252 associations dont le nom contient « comité
des fêtes » se répartissent sur **six familles différentes** : 172 en `009`, 58 en `007`,
7 en `006`, 6 en `014`, 2 en `050`, 1 en `034`. Aucun rabattement de famille ne les
trouverait. Il en va de même des accueils et centres de loisirs, dispersés sur cinq
familles — et à peine une dizaine au total.

## Décision

**Les six types du brief sont conservés.** Élargir la liste — santé, environnement,
agriculture, culte, anciens combattants, éducation, que le RNA distingue nettement —
aurait été plus fidèle aux données, et c'est un arbitrage qui a été posé. Il a été
tranché en faveur du brief.

**Quatre types viennent de la famille RNA**, par une table de correspondance explicite :
`sportive` (011), `culturelle` (005, 006, 010), `sociale` (003, 009, 017, 018, 019, 020,
021, 030, 036, 038). Toute famille absente de la table tombe dans `diverses`.

**Deux types viennent du nom, et le nom l'emporte sur le code.** `comite_des_fetes` et
`centre_de_loisirs` sont reconnus par motif, sur limites de mots dans le nom normalisé.
La préséance n'est pas un choix de style : le code ne les porte pas, mesures ci-dessus à
l'appui, et le motif est plus spécifique que la famille.

**La règle appliquée est écrite en base.** `source_classification` reçoit `rna:011` ou
`nom:comite_des_fetes`, et `classification_version` la version de la table. Un type sans
règle traçable n'est pas auditable, et sans version on ne saurait pas quels verdicts sont
périmés après un ajustement — même discipline que `prefiltre_version` au lot 4.

## Conséquences

Sur l'Ille-et-Vilaine, 31 273 associations actives classées :

| Type | Effectif | Part |
|---|---:|---:|
| diverses | 11 506 | 36,8 % |
| culturelle | 8 049 | 25,7 % |
| sportive | 5 766 | 18,4 % |
| sociale | 5 706 | 18,2 % |
| comité des fêtes | 244 | 0,8 % |
| centre de loisirs | 2 | 0,0 % |

**Plus d'un tiers en « diverses », et c'est assumé.** Le brief ne prévoit aucun type pour
l'éducation (3 152 associations), les loisirs et jeux (2 772), l'environnement (1 223),
l'agriculture, le commerce ou le culte. Les ranger de force dans « culturelle » ou
« sociale » aurait produit un chiffre plus flatteur et moins vrai. Le fourre-tout est
lisible pour ce qu'il est, et le code d'origine reste dans `source_classification` : le
jour où la liste des types s'élargit, la reclassification est un simple rejeu.

**« Centre de loisirs » est vide, et c'est un fait sur le RNA, pas un défaut de règle.**
Deux associations sur 31 273. Ces structures sont le plus souvent portées par la commune
elle-même ou par une association dont le nom ne les mentionne pas. La catégorie reste,
puisque le brief la demande ; elle ne se remplira pas.
