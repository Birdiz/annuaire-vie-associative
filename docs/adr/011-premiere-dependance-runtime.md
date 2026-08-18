# ADR-011 — Première dépendance runtime : `node-html-parser`

Statut : acceptée — 2026-08-18

## Contexte

La décision D6 prévoyait `node-html-parser` comme parseur DOM, avec repli sur `cheerio`
si les sélecteurs manquaient. L'ADR-006 avait explicitement refusé de la faire entrer au
lot 2, pour lire un index de serveur qu'une expression régulière suffisait à traiter :
« elle arrivera au lot 3, face à de vraies pages ».

Les lots 1 et 2 ont zéro dépendance runtime, et `CLAUDE.md` demande de justifier tout
ajout, le poids du bundle final étant un critère de conception.

Le coût réel a donc été mesuré avant de trancher : `node-html-parser@9.0.1` installe
**11 paquets et 3,0 Mo**, dont tout `css-select` — un moteur de sélecteurs CSS que le
lot 3 n'utilise pas. Ce n'est pas « une dépendance », et la fiche du paquet ne le dit pas.

L'alternative était un tokenizer maison d'environ 250 lignes. Elle n'était pas
fantaisiste : le projet a déjà écrit à la main un parseur CSV en flux, un découpeur de
tableaux JSON et un lecteur ZIP.

## Décision

**`node-html-parser` est acceptée**, appliquant D6 telle qu'écrite. L'arbitrage a été
soumis et tranché : face à du HTML de mairie réel — balises non fermées, tableaux
imbriqués, encodages hérités — un parseur éprouvé vaut mieux qu'un tokenizer qu'on
déboguerait sur des cas trouvés en production.

**Son usage est borné à un adaptateur unique**, `src/parse/html.ts`. Aucun autre module
du projet ne l'importe. C'est la même logique que la porte de sortie réseau unique : la
dépendance reste remplaçable, et `css-select` n'est jamais atteint.

**L'adaptateur ne se sert pas des accesseurs de texte de la bibliothèque.** Ils ne
conviennent pas, et c'est vérifié plutôt que supposé :

- `.text` restitue le contenu des `<script>`, donc les adresses des régies analytiques ;
- `.text` concatène sans séparateur : `<td>Club de foot</td><td>écrire</td>` donne
  `Club de footécrire`. Outre l'échec du rapprochement en bord de cellule, deux cellules
  numériques voisines peuvent **fabriquer un numéro de téléphone qui n'existe pas**.

La traversée est donc écrite ici, et ne coupe qu'aux frontières de bloc — un `<span>` au
milieu d'une adresse ne la coupe pas, deux `<td>` voisins sont séparés.

**Le décodage de caractères ne dépend de rien.** Node embarque ICU au complet :
`TextDecoder` couvre `windows-1252` et l'alias WHATWG `iso-8859-1`. L'ordre suit la
spécification HTML — BOM, puis en-tête HTTP, puis `<meta>`, puis UTF-8 — avec une règle
qui compte davantage : **une déclaration `utf-8` qui ne décode pas est ignorée** au profit
de `windows-1252`. Ces sites déclarent faux souvent, et faire confiance à l'en-tête
écrirait des « Ã© » en base, donc dans l'export remis au client.

## Conséquences

Le projet n'a plus zéro dépendance runtime. C'est le seuil qu'on ne franchit qu'une fois :
tout ajout ultérieur devra être mesuré et justifié de la même façon, et `cheerio` — le
repli prévu par D6 — pèserait davantage.

Aucun module natif n'entre : D1 et le packaging SEA restent tenables, et `esbuild` saura
n'embarquer que ce qui est atteint depuis l'adaptateur.

Le décodage repose sur un ICU complet. Un Node compilé en `small-icu` ferait échouer la
lecture d'une part notable des sites de mairie. Un repli sur `latin1` existe pour que
cela ne fasse pas échouer un job, mais il doit rester un repli : un test affirme que
`new TextDecoder("windows-1252").encoding` vaut bien `windows-1252`, de sorte qu'une
régression de l'image de distribution soit détectée par `npm test` et non en production.
