# ADR-023 — L'interface et le conteneur

Statut : acceptée — 2026-08-23

## Contexte

L'ADR-020 a posé que l'interface n'écoute que sur `127.0.0.1`, et que **cette adresse
n'est pas un réglage** : une UI qui écouterait sur `0.0.0.0` exposerait au réseau local
une base de données personnelles et une commande d'écriture. C'est le corollaire direct du
local-first, au même titre que les invariants absents du fichier de configuration.

L'image Docker du §2 du brief rencontre cette règle de plein fouet. Dans un conteneur,
`127.0.0.1` est la boucle locale **du conteneur** : un `docker run -p 8787:8787` publie un
port que personne n'écoute côté hôte. L'invariant et la cible de distribution se
contredisent — exactement le cas que le §11 du brief demande de signaler plutôt que de
contourner en silence.

## Décision

**L'image sert le pipeline, pas l'interface.** `annuaire run`, `normaliser`, `exporter`,
`status`, `metrics` s'exécutent dans le conteneur avec `/data` en volume. L'interface
reste l'affaire des deux autres emballages, `npx` et l'exécutable Windows, où elle ouvre
une boucle locale qui est celle de l'utilisateur.

Trois choix concrets en découlent :

- **Aucun `EXPOSE` dans le `Dockerfile`.** Annoncer un port laisserait croire à une
  publication qui ne peut pas fonctionner. Mieux vaut ne rien promettre que promettre à
  faux ; un test d'architecture le vérifie.
- **`annuaire ui` n'est pas désactivé pour autant.** Sous Linux, `docker run --network
  host` place le conteneur dans l'espace réseau de l'hôte : `127.0.0.1` y désigne alors la
  vraie boucle locale, et l'interface est joignable sans qu'une ligne de code ait changé.
- **Aucune détection de conteneur.** Une heuristique sur `/.dockerenv` refuserait de
  démarrer précisément dans le cas où l'interface fonctionne, et deviendrait fausse au
  premier changement d'exécuteur de conteneurs.

## Conséquences

- **Vérifié sur ce poste** : sous Docker Desktop pour macOS, `--network host` ne relie pas
  la boucle locale du conteneur à celle du Mac — l'interface démarre et reste
  injoignable. Le README dit donc « sous Linux », et pas « sous Docker ».
- Sur Linux, l'accès repose sur le partage d'espace de noms réseau, comportement
  documenté de Docker. **Il n'a pas pu être vérifié depuis ce poste**, et le README ne le
  présente pas comme mesuré.
- Un utilisateur qui veut l'interface et le confort d'un conteneur n'a pas de solution
  parfaite : il lance le pipeline dans le conteneur et l'interface par `npx` sur le même
  répertoire de données. Les deux process partagent la base sans se connaître, comme un
  `run` et une `ui` lancés dans deux terminaux — c'est le mode WAL choisi au lot 1 qui le
  permet.
- Si un jour cette gêne devient inacceptable, la sortie ne sera pas une option d'adresse
  d'écoute : ce serait un tunnel explicite côté hôte, ou un mode d'interface qui n'ouvre
  aucune écriture. La règle de l'ADR-020 reste entière.

## Alternatives écartées

- **Écouter sur `0.0.0.0` quand un conteneur est détecté** — le jeton et la vérification
  de `Host` limitent le risque, mais la règle « l'adresse n'est pas configurable » perdrait
  son sens : elle deviendrait « sauf quand le programme en décide autrement ». Une règle
  non contournable qui admet une exception automatique n'est plus une règle.
- **Publier un port via un relais dans l'image** (`socat` de `0.0.0.0` vers `127.0.0.1`) —
  même exposition, avec en plus un binaire de plus dans l'image et la règle contournée
  d'un cran plus loin du code qui la porte.
- **Retirer `ui` de l'image** — coûterait une variante de build pour interdire ce qui
  fonctionne sous `--network host`.
