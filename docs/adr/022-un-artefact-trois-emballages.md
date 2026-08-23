# ADR-022 — Un artefact, trois emballages

Statut : acceptée — 2026-08-23

## Contexte

Le §2 du brief demande trois cibles de distribution depuis une base unique : exécutable
Windows portable, image Docker, `npx`. L'ADR-001 avait tranché le runtime (`node:sqlite`
+ outillage SEA officiel) et posé que le développement resterait sans build, Node 24
exécutant le TypeScript nativement. Restait à savoir ce qu'on emballe, et sous quelle
forme.

La reconnaissance du lot a rendu la question moins ouverte qu'elle n'en avait l'air :

**`bin: ./src/cli.ts` ne peut pas fonctionner.** Node refuse délibérément de retirer les
types d'un fichier TypeScript situé sous un chemin `node_modules` — « to discourage
package authors from publishing packages written in TypeScript ». Or c'est exactement là
qu'`npx` installe un paquet. La cible `npx` réclame donc un artefact JavaScript, au même
titre que le SEA. Deux des trois cibles convergent avant même qu'on ait choisi.

**Le SEA exécute son script principal en CommonJS.** Le champ `mainFormat` de la
documentation courante accepte `"module"`, mais il est absent des Node 24 les plus
anciennes et incompatible avec `useSnapshot`. Le format par défaut, lui, marche partout.

## Décision

**Un seul bundle `esbuild`, au format CommonJS, sert les trois emballages.**
`scripts/build.ts` produit `dist/annuaire.cjs` (262 Ko) et copie à côté les trois fichiers
statiques de l'UI. `npx` l'exécute directement, l'image Docker le copie dans une image
`node:24-alpine`, et `scripts/sea.ts` en fait le script principal de `annuaire.exe`.

Le développement, lui, ne change pas : `npm run annuaire`, `npm test` et `npm run check`
exécutent les sources. **Le build n'existe que pour emballer.**

Trois conséquences ont été portées dans le code plutôt que dans un commentaire :

- **Aucun `await` de premier niveau dans `src/`.** esbuild refuse de le convertir en
  CommonJS. Le point d'entrée quitte `src/cli.ts` pour `src/bin.ts`, qui appelle `main()`
  en `.then()`. Un test d'architecture interdit désormais la construction qui casserait le
  build — sans lui, la régression ne se verrait qu'au moment d'une release.
- **`src/ui/assets.ts` connaît trois provenances** : `import.meta.dirname` en source,
  `__dirname` dans le bundle, `sea.getAsset()` dans l'exécutable. C'est le point de
  lecture unique que l'ADR-020 avait réservé pour ce lot ; rien d'autre n'a bougé.
- **La sentinelle SEA est lue dans le binaire cible.** Elle vaut
  `NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2` sur Node 24.17, là où la documentation
  en montre une forme abrégée. Recopier la doc faisait échouer l'injection sur un message
  obscur ; la lire rend la construction robuste au changement de version.

**`esbuild` et `postject` entrent en dépendances de développement.** Aucune dépendance
runtime n'est ajoutée : le produit livré n'a toujours que `node-html-parser`. Le binaire
d'esbuild est un outil de construction, pas un module natif chargé à l'exécution —
l'interdiction de l'ADR-001 vise ce qui doit vivre dans l'artefact, et elle reste tenue.

**`scripts/sea.ts` est le seul fichier du dépôt qui sort sur le réseau hors `src/http/`.**
Il télécharge le `node.exe` officiel et vérifie son empreinte contre le `SHASUMS256.txt`
publié à côté. Cette sortie a lieu au moment d'emballer, jamais à l'exécution de l'outil
ni dans la suite de tests, qui n'importe pas ce module. Un test d'architecture vérifie
qu'aucun autre script ne prend cette liberté, et que celui-ci ne vise que `nodejs.org`.

## Conséquences

- **`package.json` déclare `bin: ./dist/annuaire.cjs` et `files: ["dist"]`.** Le paquet
  publié ne contient plus une ligne de TypeScript. `prepack` reconstruit le bundle, si
  bien qu'un `npm pack` ne peut pas emballer un artefact périmé. Le paquet fait 124 Ko.
- **Le `private: true` reste.** La cible `npx` se valide par `npm pack` puis installation
  du tarball ; le jour de la publication, il n'y aura que cette ligne à retirer.
- **La signature Authenticode du `node.exe` est retirée avant injection.** Un binaire qui
  se déclare signé *et* corrompu est pire pour Windows qu'un binaire non signé, et
  `signtool` n'existe que sous Windows. La table des certificats est en fin de fichier par
  spécification : `retirerSignature` la tronque, remet le répertoire à zéro, et refuse
  tout ce qui s'écarte de cette forme. La manipulation est couverte par un test sur un PE
  synthétique — le vrai `node.exe` fait 88 Mo et n'a rien à faire dans le dépôt.
- **L'exécutable produit n'est pas signé.** SmartScreen préviendra au premier lancement.
  Le signer suppose un certificat de signature de code, qui est une décision d'éditeur et
  non une décision technique.
- **Ni cache de code, ni instantané** dans la configuration SEA : les deux sont propres à
  la plateforme qui les produit, et les activer depuis un poste macOS pour une cible
  Windows fabriquerait un exécutable mort-né. On y gagnerait quelques dizaines de
  millisecondes au démarrage ; on y perdrait la construction croisée.
- **Ce poste ne peut pas exécuter `annuaire.exe`.** Il est produit, mesuré, son empreinte
  est publiée, et sa structure est vérifiée — blob présent, fusible basculé à `:1`. Son
  lancement reste à valider sur un poste Windows, et le README le dit ainsi.

## Alternatives écartées

- **Publier les sources TypeScript et laisser Node les exécuter** — impossible pour
  `npx`, cf. ci-dessus. C'est ce constat qui a rendu le bundle non négociable.
- **Deux artefacts, un ESM pour npm et un CJS pour le SEA** — deux fois la surface de
  build et de test pour un gain nul : le CommonJS convient aux trois emballages.
- **Inliner les fichiers statiques dans le bundle en base64** — supprimerait le répertoire
  `dist/assets/`, mais donnerait deux représentations du même fichier selon le mode
  d'exécution, et priverait `sea.getAsset()` de sa raison d'être. Le point de lecture
  unique de l'ADR-020 fait déjà ce travail.
