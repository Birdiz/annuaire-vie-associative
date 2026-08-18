# ADR-012 — Rattachement déterministe, et régime des contacts

Statut : acceptée — 2026-08-18

## Contexte

L'étape [5] extrait des contacts d'une page de mairie. Le brief n'assigne explicitement
le rattachement d'un contact à une association à aucune étape : le pré-filtre [4] fait une
jointure RNA, la normalisation [7] déduplique et classifie. Le livrable du lot 3 selon le
§9.3 est « premiers contacts extraits, sans LLM du tout ».

Sans rattachement, ce livrable est « N emails trouvés sur des sites de mairie » — vrai,
mais loin de l'annuaire que l'outil promet. Avec rattachement, c'est « N associations avec
au moins un email », qui est la métrique de couverture du §8.

L'arbitrage a été soumis : le rattachement entre dans le lot 3.

## Décision

**Le rapprochement est une occurrence exacte, sur limites de mots, du nom normalisé.**
Pas de distance d'édition, pas de score. Le texte de la page et le nom venu du RNA passent
tous deux par `normaliserNom`, sorti de `src/seed/rna.ts` vers `src/texte.ts` pour que la
découverte ne dépende pas du module d'amorce — et surtout pour que les deux côtés de la
comparaison ne puissent jamais diverger.

Un rapprochement approximatif produirait des rattachements faux que personne ne saurait
défaire en revue, alors qu'un contact non rattaché reste parfaitement exploitable au
niveau de la commune. Trois garde-fous :

- **nom d'au moins 8 caractères normalisés** : « ACCA », « AS », « FCPE » apparaissent
  dans n'importe quel texte ;
- **le nom le plus long l'emporte** à texte égal, car il désigne plus précisément ;
- **un homonyme annule le rattachement**. Si deux associations vivantes de la commune
  portent le même nom normalisé, le choix serait arbitraire, et un contact attribué au
  mauvais destinataire est pire qu'un contact attribué à la commune.

**Le contexte est une chaîne de blocs, pas un bloc.** Dans un tableau, la cellule ne
contient que l'adresse ; c'est la ligne qui porte aussi le nom. L'extraction rend donc
tous les blocs englobants, du plus étroit au plus large, et le rattachement les parcourt
dans cet ordre : le plus étroit qui contient un nom gagne.

**L'identifiant de l'association est résolu dans le `commit`, pas dans la phase
asynchrone.** Une association disparue entre la lecture et l'écriture ferait échouer la
clé étrangère, et le job repartirait en boucle sans jamais pouvoir aboutir.

**Le rattachement se voit dans la provenance.** La méthode reçoit le suffixe `+nom`
(`dom:mailto+nom`) et la confiance est minorée de 10 % : c'est une inférence, elle doit
être distinguable d'une lecture directe par qui révisera.

**Barème de confiance.** Un lien `mailto:`/`tel:` est une déclaration de l'auteur de la
page (0,9) ; un motif trouvé dans du texte libre est une lecture de notre part (0,6) ;
une forme désobfusquée est une reconstruction (0,45). Les trois ne se valent pas, et c'est
cette valeur qui alimentera l'écran de revue de l'étape [8].

**`code_insee` est toujours renseigné, même quand l'association l'est.** Le `CHECK` du
schéma n'exige qu'un des deux, mais sans commune on ne saurait plus grouper, et l'étape
[7] ne pourrait pas rapprocher une ligne rattachée de son équivalent au niveau commune.

**Une réécriture ne dégrade jamais.** L'`ON CONFLICT DO UPDATE` est gardé par
`excluded.confiance > contact.confiance`, et ne touche pas `review_statut`. Sans cela, une
désobfuscation trouvée au passage suivant remplacerait un `mailto:`, et un contact déjà
validé en revue repasserait à « à revoir ».

**§4.7 — classification.** Une partie locale portant une racine de fonction (`contact`,
`secretariat`, `president`, `associ`…) est générique ; une forme `prenom.nom` ou
`j.nom` est nominative ; le reste est `NULL`. On ne devine pas ce que la forme ne dit pas,
mais quand elle désigne une personne, c'est le régime le plus strict qui s'applique.

**§4.6 — mobiles.** Les préfixes viennent de `invariants.ts`, qui n'avait jusqu'ici aucun
consommateur. Ils sont appliqués à la forme normalisée : un mobile écrit `+33 6 …` reste
un mobile, sans qu'il faille étendre la constante. Le drapeau `--avec-mobiles` voyage dans
le payload du job, pas dans la configuration : il s'applique à un travail précis, et une
reprise doit retrouver les réglages sous lesquels le crawl avait commencé.

## Conséquences

Un même email peut exister deux fois : rattaché à une association, et au niveau de la
commune. Les deux index uniques partiels sont disjoints par construction, et c'est
**assumé** — les deux lignes portent une provenance différente, et écraser ici perdrait
l'information que la page « contact mairie » porte aussi cette adresse. La déduplication
est l'étape [7], pas celle-ci.

Le taux de rattachement est la mesure de qualité de cette décision : deux compteurs
(`rattaches_association`, `rattaches_commune`) l'exposent. S'il s'avère bas sur mesure
réelle, c'est la forme du contexte qu'il faudra revoir, pas le seuil de similarité — la
décision de rester déterministe ne se rediscute qu'avec des chiffres.

L'exigence stricte de correspondance laisse passer les pages qui écrivent le nom
autrement que le RNA — sigle seul, article ajouté, orthographe divergente. Ces contacts ne
sont pas perdus : ils restent au niveau de la commune, visibles comme un gisement que
l'étape [7] ou un opérateur pourra reprendre.
