# ADR-020 — Une porte d'entrée locale, et un fichier tiers embarqué

Statut : acceptée — 2026-08-22

## Contexte

Le lot 6 ajoute l'interface : suivi de run, écran de revue, export. Elle heurte deux
règles que les lots précédents ont posées, et qui n'avaient jamais eu à traiter le cas
d'un serveur.

**La première est la porte de sortie.** `test/architecture.test.ts` interdit d'importer
`node:http` ailleurs que dans `src/http/`, et c'est ce test qui rend les invariants 2, 3
et 4 vrais par construction plutôt que par discipline. Un serveur HTTP a besoin de
`node:http`.

**La seconde est le poids.** La décision D5 du brief annonce « `node:http` + htmx + CSS
écrit à la main ». Mais le projet n'a qu'une dépendance runtime, entrée au lot 3 après
mesure (ADR-011), et embarquer htmx ajoute un second fichier tiers d'une cinquantaine de
kilo-octets dans les trois cibles de distribution.

S'y ajoute une question que ni l'un ni l'autre ne posait : un serveur local **n'est pas un
serveur inoffensif**. Il tourne avec les droits de l'utilisateur, tient des données
personnelles, et sait écrire en base. N'importe quelle page ouverte par ailleurs dans le
même navigateur peut adresser `127.0.0.1`.

## Décision

### La règle vise le trafic sortant, et le test le dit maintenant

`robots.txt`, le délai de deux secondes et le User-Agent identifiable n'ont de sens que
pour ce qui **part** de la machine. Un serveur qui écoute n'en relève pas.

Le test garde donc sa liste d'interdits et gagne une allowlist d'**un seul fichier**,
`src/ui/serveur.ts`, pour `node:http` seulement. Un second test vérifie que ce fichier
appelle bien `createServer` et **ne contient ni `request(`, ni `http.get(`, ni `fetch`** :
il peut écouter, il ne peut pas appeler. Sans cette seconde moitié, l'exception aurait
ouvert par la bande exactement ce que la règle ferme.

L'allowlist est nominative pour que son coût reste visible : y ajouter une seconde ligne
doit demander la même discussion que la première.

### L'adresse d'écoute n'est pas un réglage

`127.0.0.1`, sans option pour en changer — jamais `0.0.0.0`. C'est le corollaire direct du
local-first, au même titre que l'absence des invariants dans le fichier de configuration.
Le **port**, lui, est une option : il ne protège rien.

Quatre garde-fous s'y ajoutent, dans `routes.ts` pour être testables sans socket :

- **l'en-tête `Host` est vérifié.** Sans lui, un nom de domaine contrôlé par un tiers et
  qui résout vers `127.0.0.1` suffirait à faire porter les requêtes du navigateur sur
  cette base — c'est le rebinding DNS, et le local-first n'en protège pas ;
- **un jeton** tiré à chaque démarrage, imprimé par la CLI, échangé contre un cookie
  `SameSite=Strict; HttpOnly` dès la première page, puis retiré de l'URL ;
- **les POST dont `Sec-Fetch-Site` n'est pas `same-origin` sont refusés** ;
- **une CSP `default-src 'self'`**, avec `Referrer-Policy: no-referrer` — cliquer sur
  l'URL source d'un contact ne doit pas annoncer à la mairie visitée l'adresse de l'écran
  de revue.

L'échappement HTML n'est pas couvert par la CSP : il reste obligatoire sur toute valeur
venue du crawl, et c'est `rendu.ts` qui le porte. Les deux ferment la même porte, aucune
ne dispense de l'autre. Une URL collectée n'est en outre rendue en lien que si elle est
`http(s)` : `javascript:` est une URL syntaxiquement valide, qu'échapper ne désamorce pas.

### htmx est vendorisé, et son empreinte est vérifiée

Une copie exacte de la version 2.0.7 dans `src/ui/assets/`, servie depuis la machine.
Jamais un CDN : un `script` distant ferait sortir l'outil sur le réseau à l'ouverture d'un
écran, et laisserait chez un tiers la trace de chaque consultation. Un test vérifie
qu'aucun gabarit ne référence de ressource distante.

Le fichier est minifié, donc illisible en revue de diff. Sa version et son **SHA-256** sont
des constantes de `src/ui/assets.ts`, et un test recalcule l'empreinte : une modification
du fichier tiers fait échouer `npm run check` au lieu de passer inaperçue. Sa licence — 0BSD
— est embarquée à côté de lui.

La configuration de htmx passe par une balise `meta`, pas par du script : la CSP interdit
le JS en ligne. C'est ce qui permet d'afficher un arbitrage refusé, htmx n'échangeant par
défaut que les réponses 2xx. Pour la même raison, le sélecteur de département porte un
bouton plutôt qu'un `onchange`.

## Conséquences

**L'UI fonctionne sans JavaScript.** Chaque formulaire de revue porte `method`/`action` en
plus de `hx-post` ; le serveur répond alors par une redirection 303 plutôt qu'un fragment.
htmx supprime un rechargement de page, il ne conditionne pas l'usage.

**Deux processus peuvent ouvrir la base.** `annuaire ui` et `annuaire run` sont deux
commandes distinctes ; le WAL, choisi au lot 1 précisément pour cela, fait que le suivi
voit un run avancer sans que les deux se connaissent. `busy_timeout` à 5 s couvre les
contentions courtes.

**Le poids augmente de 50 Ko dans les trois cibles.** C'est la contrepartie assumée de D5.
L'alternative — zéro JavaScript, avec `meta refresh` pour le suivi — a été écartée : elle
aurait rechargé la page entière toutes les deux secondes pendant un arbitrage, ce qui
aurait vidé le champ de correction en cours de saisie.

**Le lot 7 devra rendre les assets lisibles depuis un exécutable unique.** L'artefact
Windows n'a pas de fichiers voisins à lire (ADR-001). `src/ui/assets.ts` est le seul point
de lecture disque, et le seul à basculer alors sur `sea.getAsset()`.
