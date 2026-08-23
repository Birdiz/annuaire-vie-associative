# ADR-024 — Lancer un run depuis l'interface

Statut : acceptée — 2026-08-23

## Contexte

Les huit étages du §9 du brief sont livrés. Ce qui restait ouvert n'est pas un étage du
pipeline : c'est la **forme du livrable** décrite au §2, « un artefact autonome qui démarre
un serveur HTTP sur `localhost` et sert une UI web, puis ouvre le navigateur de
l'utilisateur ».

Trois écarts, tous sur le chemin du client final non technique — la cible de l'exécutable
Windows du lot 7 :

1. `annuaire` sans argument imprimait l'aide et rendait `2`. Un double-clic sur
   l'exécutable ouvrait donc une console d'aide.
2. Rien dans l'interface ne **lançait** un run. Elle regardait une file alimentée depuis
   un autre terminal — ce que le lot 6 assumait, mais qui suppose un terminal.
3. Sur une installation neuve, `contactUrl` manque, donc aucun client HTTP n'est construit
   (§4.4) et tout run échoue à l'assemblage. Un bouton sans réglage possible serait
   mort-né pour exactement cette persona.

## Décision

**L'interface pilote le run, et le worker tourne dans son process.**

`src/pipeline.ts` reçoit l'orchestration des trois passes, extraite de `cli.ts` sans
changement de comportement. `src/ui/pilote.ts` en tient une instance : le routeur lui
demande de démarrer ou d'arrêter, et ne l'attend jamais — un run dure des minutes, le
routeur répond en microsecondes.

Cinq arbitrages en découlent.

**Le worker est dans le process de l'UI, pas dans un sous-processus.** Un sous-processus
demanderait trois façons de se relancer — sources en développement, bundle CJS, exécutable
unique — la capture de sa sortie, la gestion des orphelins, et surtout il **perdrait
l'arrêt propre sous Windows**, où il n'y a pas de `SIGTERM` : « on cesse de prendre des
jobs, on laisse finir ceux en cours » y redeviendrait une terminaison brutale. En
in-process, l'`AbortController` du worker suffit, et `node:sqlite` étant synchrone, un seul
process ne peut pas se donner de `SQLITE_BUSY` à lui-même.

**Aucun verrou applicatif sur « un run est déjà en cours ».** Le bouton n'est bloqué que
tant que *cette* interface pilote un run. Une ligne `run` restée `en_cours` après un
`kill -9` ne doit pas condamner l'écran : elle est signalée, et relancer reste offert.
C'est vrai par l'invariant 9 — clés `UNIQUE` de déduplication, baux qui expirent — pas par
optimisme.

**La phase du run est persistée** (migration 7), et non gardée en mémoire par l'interface.
Un run lancé dans un terminal s'affiche alors pareil, et l'information survit au
redémarrage de l'interface. La file de jobs dit combien il reste à faire ; elle ne dit pas
dans laquelle des trois passes on se trouve.

**Ouvrir le navigateur n'est pas une sortie réseau** : rien ne part de la machine, on
demande au système d'ouvrir une URL locale. `src/ui/navigateur.ts` est le seul module
autorisé à lancer un processus, et un test d'architecture le vérifie — comme pour les
portes d'entrée et de sortie. Deux exigences : **jamais de shell** (`cmd /c start "" <url>`
est la recette répandue sous Windows, et un `&` dans l'URL y devient un séparateur de
commandes ; `rundll32 url.dll,FileProtocolHandler` prend l'URL comme un argument), et
**l'échec est ignoré** — ne pas trouver de navigateur n'est pas une raison de refuser de
servir, l'adresse vient d'être imprimée.

**Le défaut sans argument dépend de l'emballage**, décidé par `sea.isSea()`. C'est un fait
de construction, pas une heuristique d'environnement : la distinction avec ce que
l'ADR-023 a écarté pour le conteneur tient à ce qu'un exécutable unique *sait* qu'il en est
un, alors qu'un `/.dockerenv` ne fait que suggérer. `npx` et l'image Docker, dont les
utilisateurs ont un terminal sous les yeux, gardent l'aide et son code de sortie.

**L'URL de contact se règle depuis l'écran.** `app.configurerContactUrl` écrit dans
`config.json` en préservant le reste du fichier, puis reconstruit le client HTTP **en
conservant le cache et le throttle** : un throttle neuf remettrait à zéro l'espacement de
deux secondes par domaine, que l'invariant 3 interdit de contourner, fût-ce par
inadvertance. La validation est celle du chargement, exportée plutôt que dupliquée.

## Conséquences

- **Une page web déclenche désormais du trafic sortant.** Les garde-fous de l'ADR-020 —
  jeton échangé contre un cookie `SameSite=Strict`, vérification de `Host`, refus des POST
  croisés — couvraient l'écriture en base ; ils couvrent maintenant aussi le déclenchement
  d'un crawl. Aucun n'a eu besoin d'être élargi, ce qui est le signe qu'ils étaient au bon
  endroit.
- **L'arrêt de l'interface attend le run.** `Ctrl+C` abandonne le worker, laisse finir les
  jobs déjà pris, puis ferme la base. Fermer la base sous un worker vivant est la seule
  façon de perdre du travail dans ce lot, et c'est ce que cet ordre empêche.
- **Le bloc de suivi se rafraîchit toutes les deux secondes, donc il ne peut pas porter de
  champ de saisie.** Le réglage de l'URL de contact vit hors de lui, dans un bloc qui n'est
  échangé que par sa propre soumission. Pour la même raison, le pilote **mémorise son
  dernier refus** : un message rendu une seule fois dans la réponse au POST disparaîtrait
  avant d'être lu.
- **Le run lancé d'ici prend les options par défaut** : département courant de l'écran,
  budget de pages par défaut, pas d'`--avec-import`, pas de `--rna-file`. Les réglages fins
  restent à la CLI, dont c'est le public.
- Le bundle passe de 262 à 271 Ko. Aucune dépendance n'entre.
- Le comportement de l'exécutable sans argument **n'a pas pu être essayé** depuis ce poste,
  qui ne construit qu'une cible Windows : il se vérifie par le test de `sea.isSea()`, pas
  par exécution. Même réserve qu'au lot 7.

## Alternatives écartées

- **Un sous-processus par run** — l'isolation serait réelle : un plantage du worker ne
  fermerait pas l'interface. Mais le prix est trois chemins de relance à maintenir et un
  arrêt brutal sous Windows, qui est précisément la cible principale. On préfère une
  interface qui s'arrête avec son run à un run qu'on ne sait pas arrêter proprement.
- **Un verrou en base sur le run en cours** — bloquerait honnêtement le double lancement,
  et bloquerait tout aussi honnêtement après un `kill -9`, jusqu'à ce qu'un humain aille
  éditer une table. Un verrou qui exige un dépannage manuel est pire que pas de verrou
  quand la reprise est déjà garantie ailleurs.
- **Ouvrir le navigateur dans les trois emballages** — dans un conteneur, il n'y a pas de
  navigateur à ouvrir, et l'échec silencieux ne coûterait rien. Mais faire dépendre le
  comportement d'un échec attendu est un mauvais contrat ; `--sans-navigateur` le rend
  explicite, et l'image ne lance pas `ui` par défaut de toute façon.
- **Un écran de réglages complet** (`concurrency`, `cacheTtlHours`) — les seuls réglages
  légitimes, mais dont la persona visée n'a pas l'usage. Les invariants, eux, restent hors
  de toute surface de configuration : ce lot n'ouvre pas cette porte.
