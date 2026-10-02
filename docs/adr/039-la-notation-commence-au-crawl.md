# ADR-039 — La notation commence au crawl

Statut : acceptée — 2026-10-02

## Contexte

La refonte de l'interface (ADR-041, maquette « L'Établi ») repose sur une promesse : on
relit pendant que la collecte tourne. Les heures de Découverte deviennent du temps de
relecture.

Jusqu'ici, c'était faux. Le score n'était calculé qu'à la Normalisation, qui vient après
la Découverte, et la file de revue exclut les contacts sans score. La raison est inscrite
dans `fileRevue` : arbitrer avant la notation « reviendrait à juger sans le seul élément
que l'outil apporte ». Pendant toute la Découverte d'un département neuf, la file restait
donc vide.

## Décision

**Le crawl note chaque contact qu'il écrit, dans la transaction de son commit. Ce score
est provisoire.**

- **Un seul barème.** Le crawl et la Normalisation passent tous deux par `noterLigne`
  (`src/normalisation/rejeu.ts`), seul chemin vers `noter()`. Le barème garde un
  propriétaire unique (ADR-021).
- **Les entrées sont connues au commit, sauf une : le MX.** La syntaxe, la confiance
  (après le ×0,9 du rattachement), le régime de l'adresse et le rattachement sont connus,
  et le verdict de préfiltre de la page est en mémoire. Le crawl ne fait aucun DNS : son
  commit est synchrone, et la porte DNS est `src/http/dns.ts` (ADR-017). Il lit le verdict
  déjà connu dans `domaine_mail`. Un domaine jamais vérifié se note « MX non vérifié »,
  facteur 0,9, et la carte le dit.
- **`score_version` reste `NULL`.** C'est la marque du provisoire, la même que pose la
  revue quand une correction rouvre la notation. `noterContacts` renote déjà toute ligne
  dont la version diffère : la Normalisation rend donc chaque score définitif, avec ses MX
  vérifiés, sans autre changement. `progressionNotation` compte toujours les versions
  courantes, et la barre de notation ne ment pas.

### Un défaut corrigé au passage

L'`ON CONFLICT` du contact relevait la confiance et la méthode d'une vue plus sûre, mais
gardait l'ancien score avec sa version courante. La Normalisation sautait la ligne, et le
score décrivait une lecture qui n'était plus la sienne. Désormais, l'upsert rend la ligne
(`RETURNING`) et le crawl la renote, à titre provisoire. Une vue moins sûre n'écrit
toujours rien, et n'a donc rien à renoter.

## Conséquences

- **La relecture s'ouvre dès les premiers contacts.** L'interface le dit : « les scores
  restent provisoires jusqu'à la normalisation ».
- **Le facteur MX inconnu ne change pas l'ordre de façon trompeuse.** Il retire 10 % à
  chaque adresse dont le domaine est inconnu, et rien aux téléphones. Les moins sûrs
  passent toujours en premier. Une adresse dont le domaine se révélera sans MX descendra à
  la Normalisation : c'est un domaine qui ne reçoit pas de courrier, et sa relecture ne
  sera pas perdue.
- **Arbitrer un contact au score provisoire est définitif.** La décision humaine ne dépend
  pas du MX. Une ligne validée reste validée quand son score change.
- **Coût.** Une requête `domaine_mail` par adresse écrite, indexée sur la clé. C'est
  négligeable devant l'analyse DOM de la page.
