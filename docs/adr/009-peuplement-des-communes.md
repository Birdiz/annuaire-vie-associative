# ADR-009 — Peupler `commune` depuis l'Annuaire, et rattacher les associations

Statut : acceptée — 2026-08-18

## Contexte

Le plan du lot 1 avait laissé une question ouverte, à trancher **après mesure** plutôt
qu'avant : le RNA rattache-t-il ses associations à une commune de façon exploitable ? Si
le code INSEE y était peu renseigné, il aurait fallu résoudre `code postal + libellé`
vers un code INSEE, donc introduire une troisième source de données (le COG de l'INSEE),
avec les rapprochements approximatifs que cela suppose — un code postal couvre souvent
plusieurs communes.

Il fallait aussi décider d'où viennent les communes elles-mêmes.

## Décision

**Aucune source COG n'est nécessaire.** La colonne `adrs_codeinsee` du RNA est renseignée
sur **100 %** des lignes échantillonnées — 2 209 lignes lues à trois endroits distincts
du fichier. Le rattachement association → commune est donc une jointure directe, pas un
problème de résolution. La question ouverte est close.

**Les communes viennent de l'Annuaire**, pas d'un référentiel dédié. Le dump du
co-marquage porte à la fois le code INSEE, le nom de la commune et l'URL du site : la
même lecture peuple `commune` et résout `url_mairie`. Ajouter un référentiel séparé
pour les seuls noms de communes aurait été une source de plus à télécharger, à tenir à
jour et à faire diverger.

Le département est dérivé du code INSEE plutôt que lu quelque part : deux caractères en
métropole, trois outre-mer (971 à 978), et `2A`/`2B` en Corse. Un code malformé ne
rattache à aucun département plutôt que d'en inventer un.

**Un code INSEE inconnu de l'Annuaire crée une commune minimale.** Une association peut
déclarer une commune que l'Annuaire ne couvre pas — commune disparue, fusionnée, ou
simplement absente du dump. La clé étrangère refuserait la ligne. Plutôt que de perdre
l'association, on insère une commune portant le libellé du RNA et
`statut_resolution = 'inconnu'`, et on compte le cas dans `rna.communes_creees`. Une
commune ainsi créée n'a pas d'URL de mairie : elle est visible comme un trou à combler,
pas comme un succès.

**L'ordre de lecture du dump est sans conséquence.** Une commune est décrite par
plusieurs fiches — mairie principale, mairie déléguée, mairie annexe — dont certaines
sans site. L'`UPSERT` ne remplace jamais une URL trouvée par une absence d'URL, et ne
rétrograde jamais un statut `resolue`. Le résultat ne dépend donc pas de l'ordre dans
lequel le dump présente ses fiches.

**Les associations dissoutes sont conservées, avec leur date.** Les ignorer aurait laissé
en base, marquées comme vivantes, les associations dissoutes depuis le passage
précédent : le seed n'aurait eu aucun moyen de les corriger. Elles sont donc écrites
avec `date_dissolution`, et ce sont les lectures — la commande `associations`, et les
étapes suivantes — qui les excluent.

## Conséquences

La couverture de `commune` est celle de l'Annuaire : une commune sans aucune fiche
n'existe pas tant qu'une association ne l'y fait pas entrer. Pour l'Ille-et-Vilaine, la
mesure de bout en bout donne 353 communes et 332 URL de mairie, soit 94 %. La moyenne
nationale des fiches `mairie` portant un site est plus basse, autour de 62 % : le taux
attendu dépend donc franchement du département, et un écart n'est pas en soi le signe
d'une régression.

`statut_resolution = 'resolue'` signifie « une URL est déclarée par l'Annuaire », et non
« elle répond ». Vérifier qu'elle répond relève de la découverte, donc du lot 3. La
confiance enregistrée vaut 0,9 : source officielle et déclarative, mais non vérifiée.
