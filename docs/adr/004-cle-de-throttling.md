# ADR-004 — Clé de throttling : nom d'hôte et /24 de l'adresse résolue

Statut : acceptée — 2026-08-17

## Contexte

L'invariant §4.3 impose « 1 requête / 2 s minimum par domaine ». Reste à décider ce
qu'est un domaine.

Pris au pied de la lettre par nom d'hôte, l'invariant se contourne sans le vouloir. Les
petites communes sont massivement hébergées chez une poignée de prestataires
spécialisés. Un département de trois cents communes peut donc représenter trois cents
hôtes distincts pour une seule infrastructure, qui encaisserait alors trois cents fois
le débit autorisé. La règle serait respectée à la lettre et violée en pratique — et
c'est la pratique qui compte pour un hébergeur qui voit sa charge monter.

## Décision

Deux clés par requête, la plus contraignante l'emportant :

1. **Nom d'hôte** — la lecture littérale de l'invariant.
2. **/24 de l'adresse IPv4 résolue** (/48 en IPv6), résolution mise en cache par hôte.

Une résolution DNS en échec n'empêche pas la requête : la clé par hôte continue de
s'appliquer et l'erreur remontera de la requête elle-même.

Deux détails de mise en œuvre se sont révélés nécessaires pour que la garantie tienne
réellement, plutôt qu'en apparence :

- **Horloge monotone** (`performance.now()`) et non horloge murale. `Date.now()` a une
  granularité d'une milliseconde et peut reculer lors d'une synchronisation NTP : deux
  départs réservés à 2000 ms d'écart peuvent alors se produire à 1999,1 ms
  d'intervalle. La mesure d'un intervalle et l'horodatage d'une donnée collectée sont
  deux besoins distincts, servis par deux horloges distinctes.
- **Réservation depuis le départ réel** et non depuis le créneau prévu. Un réveil
  dépasse toujours son échéance, d'un délai variable : si le premier dépasse de 0,9 ms
  et le second de 0,1 ms, des créneaux espacés d'exactement 2 s produisent des départs
  à 1999,2 ms. Le créneau suivant est donc recalculé depuis l'instant constaté.

Le plancher de 2 s est appliqué **à un seul endroit**, le throttle, et vient de
`invariants.ts`. Le client HTTP ne fait remonter que le `Crawl-delay` demandé par le
site, et le throttle retient le maximum des deux.

## Conséquences

- Une résolution DNS supplémentaire par hôte, mise en cache pour la durée du run.
- Deux hôtes du même /24 sont espacés même s'ils appartiennent à des communes sans
  rapport. On ralentit donc parfois sans nécessité. C'est le sens de l'erreur qu'on
  choisit : trop lent est poli, trop rapide ne l'est pas.
- Le sous-réseau est une approximation de « même infrastructure » : un grand hébergeur
  s'étale sur plusieurs /24, et le regroupement sera alors partiel. Mieux vaut cette
  approximation que le nom d'hôte seul.
- Le débit total ne dépend que du nombre de clés traitées en parallèle
  (`concurrency`, 8 par défaut), seul levier laissé à la configuration.
- Un test mesure l'espacement réel de 2 s de bout en bout, **au départ des requêtes** —
  mesuré à l'arrivée serveur, l'écart est faussé par l'ouverture de la connexion TCP de
  la première requête quand la seconde réutilise le keep-alive.

## Alternative écartée

**eTLD+1 via la Public Suffix List** — plus classique, mais aveugle à l'hébergement
mutualisé, qui est précisément le cas problématique ici. Elle imposerait en outre soit
une dépendance, soit l'embarquement d'une liste à tenir à jour.
