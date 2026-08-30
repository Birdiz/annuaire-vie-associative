# ADR-027 — Publier l'exécutable, et le vérifier là où il tourne

Statut : acceptée — 2026-08-30

## Contexte

L'ADR-022 a produit l'exécutable Windows, et le README explique comment le construire :
`npm run build:sea`. Pour l'utilisateur que cette cible vise — le « client final non
technique » — cette phrase est un mur. Cloner un dépôt, installer Node 24, lancer un script
npm : c'est exactement la chaîne d'outils que l'exécutable existe pour lui épargner.

Le constat est venu d'un utilisateur Windows : *« je ne vois pas d'exécutable sur le
dépôt »*. Il n'y en avait effectivement aucun — ni fichier commité, ni release.

Deux réserves de l'ADR-022 restaient par ailleurs ouvertes : le binaire était produit
depuis macOS, et **son lancement n'avait jamais été vérifié sur Windows**. Sa structure
l'était (empreinte du `node.exe` officiel, signature Authenticode retirée, blob injecté),
mais rien n'attestait qu'un double-clic ouvre quoi que ce soit.

## Décision

**L'exécutable n'entre pas dans le dépôt ; il est construit par la CI sur un poste Windows
et attaché à une release.**

- **Pas de binaire commité.** 88,5 Mo par version, dans un dépôt qui en fait quelques
  centaines de Ko, et une histoire git qui grossirait à chaque publication sans jamais
  pouvoir maigrir. Un binaire versionné est aussi un binaire non relisible en revue — le
  projet a déjà cette gêne pour un seul fichier de 50 Ko, htmx, et l'a payée d'un test
  d'empreinte (ADR-020).
- **Construction sur `windows-latest`.** `scripts/sea.ts` cible `win-x64` depuis n'importe
  quel système : un runner Linux suffirait à *fabriquer* le fichier. Le poste Windows sert
  à autre chose — **lancer** ce qui vient d'être fabriqué. Deux étapes de fumée le font :
  `annuaire status`, qui ouvre la base et joue les migrations sous `node:sqlite`, puis
  `annuaire ui`, dont la sortie est lue pour en extraire l'adresse à jeton, suivie d'une
  requête sur `/assets/htmx.min.js` — la seule façon de vérifier que les ressources ont
  bien été injectées et que `sea.getAsset` les rend.
- **Publication sur tag `v*` seulement.** Les autres branches s'arrêtent à l'artefact du
  run, téléchargeable trente jours. Une release est un geste délibéré, pas une
  conséquence d'un commit.
- **La suite complète tourne dans des jobs distincts** de la construction. Séparée à
  dessein : un test rouge n'empêche pas d'obtenir un binaire à inspecter, mais il bloque la
  release, qui dépend de tous les jobs.
- **`gh release create`, pas d'action tierce.** Le `gh` des runners GitHub suffit ; la
  règle de parcimonie qui vaut pour les dépendances runtime vaut aussi pour les
  dépendances de chaîne de construction, où une action tierce est du code exécuté avec un
  jeton d'écriture sur le dépôt.

## Où tourne la suite de tests — mesure, puis correction

Le premier jet faisait tourner la suite complète sur Windows à chaque push, au motif que
c'est le seul système où le produit est distribué sans Node. La mesure a tranché autrement :

| | Durée |
|---|---|
| Construction + fumée, Windows | **55 s** |
| Suite complète, Linux | **19 s** |
| Suite complète, Windows | **> 11 min, sans avoir fini** |

Le coût n'est pas dans les assertions, il est dans les process. 58 fichiers de test, donc 58
démarrages de Node avec retrait des types ; `test/cli.test.ts` y ajoute à lui seul **60
lancements de la CLI en sous-processus**, et cinq autres fichiers en lancent d'autres pour
vérifier la reprise après `kill -9`. Sous Linux, ces 118 démarrages coûtent 19 s ; Windows
les multiplie par cinq environ. Deux pistes ont été essayées et écartées, chiffres à
l'appui : `--experimental-test-isolation=none` **ralentit** (39 s contre 19, la parallélisation
entre fichiers étant perdue), et `NODE_COMPILE_CACHE` ne gagne rien de mesurable (18,1 s
contre 17,9 s).

D'où la répartition retenue :

- **La suite tourne sur `ubuntu-latest` à chaque push.** C'est le retour qu'attend un
  développeur, il tourne là où il est rapide.
- **Elle tourne aussi sous Windows, sur `main` et sur les tags**, découpée en trois tranches
  par `--test-shard`. Elle garde la porte de la release, sans être payée à chaque commit
  d'une branche de travail.

Ce qui reste vérifié sous Windows **à chaque push**, c'est le binaire lui-même : construction,
lancement, ouverture de la base et de l'interface. C'était le but du poste Windows ; la suite
complète en était un ajout, pas la raison.

## Conséquences

- L'utilisateur Windows télécharge un fichier depuis la page Releases. Rien d'autre.
- La CI sort sur le réseau — vers `nodejs.org` et le registre npm. C'est la construction,
  jamais l'exécution du produit ni sa suite de tests : l'interdit du §5 du brief porte sur
  les appels sortants de l'outil, et `scripts/sea.ts` était déjà la seule exception
  assumée (ADR-022).
- Le `GITHUB_TOKEN` n'obtient `contents: write` que dans le job de publication. Les jobs
  qui exécutent du code npm (`npm ci` lance les scripts d'installation des dépendances)
  restent en lecture seule.
- **L'exécutable n'est toujours pas signé, et Windows le fait sentir deux fois.** Vérifié
  sur un poste réel : SmartScreen affiche son avertissement de réputation, et Defender peut
  aller jusqu'à mettre le fichier en quarantaine. Le second est un faux positif de forme —
  un `node.exe` officiel dont la table des certificats a été retirée et le contenu étendu
  ressemble, pour une heuristique, à un binaire légitime modifié ; c'est exactement ce que
  la recette SEA produit, et il n'y a rien à corriger dans le code. Trois réponses, dans
  cet ordre : l'empreinte SHA-256 publiée dans la release, qui permet à l'utilisateur de
  vérifier lui-même que le fichier est bien celui qu'a construit la CI ; le signalement du
  faux positif à Microsoft, seule correction durable et gratuite ; et `npx` comme
  contournement propre — même bundle, sans binaire à débloquer. **Pas d'exclusion Defender
  recommandée** : demander à un utilisateur de désarmer son antivirus pour installer un
  outil est précisément le réflexe qu'on ne veut pas lui apprendre. Les notes de release
  portent ces trois réponses, le README aussi.
- Signer relèverait d'une décision d'éditeur — un certificat OV ou EV, nominatif et payant,
  que ce dépôt n'a pas à porter à la place de la collectivité qui distribue l'outil. Il
  réglerait les deux blocages d'un coup, et c'est la sortie si la gêne devient inacceptable.
- La version de Node du runner devient celle du binaire : `scripts/sea.ts` télécharge le
  `node.exe` de la version qui l'exécute. `node-version: "24"` suit donc la dernière 24.x
  publiée — voulu, tant que la ligne 24 est maintenue.

## Alternatives écartées

- **Commiter `dist/annuaire.exe`** — le dépôt deviendrait plus lourd que le produit, à
  chaque version, définitivement.
- **Construire sur Ubuntu** (moins cher, plus rapide) — on retomberait sur la réserve de
  l'ADR-022 : un fichier dont la structure est vérifiée mais dont personne ne sait s'il
  démarre. C'est précisément la question que cet ADR referme.
- **Publier sur npm et renvoyer vers `npx`** — utile, mais pour un autre public : `npx`
  demande Node, et l'exécutable existe pour les postes qui n'en ont pas.
- **Un installateur (MSI, winget)** — plus de surface (droits d'administrateur, entrées de
  registre, désinstallation) pour un outil qui tient dans un fichier et n'écrit que dans
  son répertoire de données.
