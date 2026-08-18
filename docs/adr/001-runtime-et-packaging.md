# ADR-001 — Runtime et packaging : `node:sqlite` + Node SEA

Statut : acceptée — 2026-08-17

## Contexte

Trois cibles de distribution depuis une base unique : exécutable Windows portable pour
un client final non technique, image Docker, `npx`. La première commande le reste : un
client qui doit installer un runtime, compiler un module natif ou lancer un
`node-gyp` n'utilisera jamais l'outil.

Le driver SQLite décide de la faisabilité. `better-sqlite3` a l'API la plus riche mais
est un module natif : binaires précompilés par plateforme, et extraction du `.node` au
démarrage quand on l'empaquette en exécutable unique. Ce coût se repaie à chaque
version de Node et à chaque release.

## Décision

`node:sqlite`, intégré à Node 24, et l'outillage officiel **Single Executable
Application** pour produire l'exécutable Windows.

Vérifié avant de s'engager : `node:sqlite` fonctionne sans drapeau expérimental sur
Node 24.17 (SQLite 3.53.0). La configuration SEA n'a donc aucun drapeau à transporter.

Node 24 exécutant nativement le TypeScript par suppression des types, il n'y a **aucune
étape de build** pour le développement ni pour les tests. `esbuild` n'intervient qu'au
moment de produire le fichier unique attendu par le SEA, en dépendance de
développement.

## Conséquences

- Node 24+ requis. La contrainte est explicite dans `engines`.
- **Aucun module natif n'est admis dans le projet, à aucun lot.** Cette interdiction
  déborde largement SQLite : elle exclut d'avance des bibliothèques qu'on aurait
  volontiers prises. Toute proposition d'ajout doit être vérifiée à cette aune.
- Le SQL des migrations vit dans un module TypeScript et non dans des fichiers `.sql` :
  l'exécutable unique n'a pas de fichiers voisins à lire. On perd la coloration
  syntaxique, on gagne l'absence de lecture disque au démarrage.
- Même raison pour `src/version.ts` : `package.json` n'est pas lisible à l'exécution.
  Un test vérifie que les deux valeurs restent synchronisées.
- La syntaxe TypeScript est restreinte à ce qui est effaçable : pas d'`enum`, pas de
  paramètres-propriétés, pas de `namespace`. Un test le vérifie.
- API SQLite plus pauvre que `better-sqlite3` (pas d'extensions, moins de sucre). Rien
  de ce dont le pipeline a besoin n'en dépend.

## Alternatives écartées

- **`better-sqlite3` + prebuilds** — écartée pour le coût récurrent de packaging.
- **Bun + `bun:sqlite`** — `bun build --compile` produit directement l'exécutable, mais
  change de runtime et s'écarte de la contrainte « TypeScript / Node LTS » du brief.
