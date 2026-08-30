# ADR-027 — Le drapeau des mobiles à l'écran, et l'avancement du run

Statut : acceptée — 2026-08-30

## Contexte

Deux manques constatés à l'usage de l'interface du lot 8.

**Le drapeau des mobiles n'existait que dans la CLI.** `annuaire run --avec-mobiles` le
porte depuis le lot 3 ; l'écran, lui, appelait `optionsDecouvertePardefaut()` sans
argument, et rien ne permettait de conserver les 06/07 depuis l'interface. Le commentaire
de `src/ui/revue.ts` en tirait même une conséquence : « les mobiles sont exclus par
défaut, derrière un flag explicite **que l'UI n'a pas** ». Quelqu'un qui a besoin de ces
numéros — et le §4.6 admet le cas, sinon il n'y aurait pas de drapeau — devait
abandonner l'interface et revenir au terminal.

**On ne savait pas où en était un run.** Le bloc de suivi affichait la phase et le nombre
de jobs actifs. Or ce nombre **monte autant qu'il descend** : chaque page visitée en
enfile de nouvelles tant que le budget de la commune n'est pas épuisé. « Phase découverte,
4 218 jobs à traiter » dit qu'il se passe quelque chose, pas s'il reste dix minutes ou une
heure. Sur un run de quarante minutes, c'est la seule question qu'on se pose.

Un troisième manque, mineur mais du même ordre : les horodatages étaient rendus bruts,
`2026-08-30T11:05:29.852Z`. La base garde de l'ISO 8601 UTC — c'est ce qui rend les
comparaisons justes et l'ordre lexical fiable — mais l'écran demandait à celui qui le lit
de convertir un fuseau de tête.

## Décision

### 1. Le drapeau vit en mémoire dans le pilote, pas dans `config.json`

`PiloteRun` porte un `#avecMobiles`, faux à la construction, et l'interface le remet donc
à « exclus » à chaque `annuaire ui`. Ce n'est pas un oubli de persistance : le §4.6 dit
« exclus **par défaut** », et un opt-in qui survivrait au redémarrage serait un défaut
qu'on peut cocher une fois puis oublier six mois. Ce qu'il ouvre — un traitement de
données identifiant directement des personnes physiques, dont l'utilisateur répond
(ADR-025) — ne se re-consent pas sans y penser.

Le drapeau est **figé au démarrage du run** et voyage dans `EtatPilote`. Le basculer en
cours de route est refusé, et le refus est explicite : chaque job de page porte le drapeau
dans son payload depuis la planification, et rien ne relit le réglage ensuite. L'accepter
afficherait un état que la collecte n'applique pas.

### 2. L'avertissement est rendu à deux endroits, pour deux moments

Le réglage vit dans une section `#mobiles`, **hors du bloc rafraîchi** : ce fragment porte
une case à cocher, et le suivi est rééchangé toutes les deux secondes — la case serait
décochée pendant la lecture de l'avertissement, ce qui est la meilleure façon de faire
cliquer sans lire. Même raison que le champ d'URL de contact du lot 8.

Cocher puis valider fait deux gestes, et c'est voulu. Un interrupteur qui bascule au
survol ne conviendrait pas à ce qu'il déclenche.

L'avertissement est **redit à côté du bouton de lancement**, dans le bloc rafraîchi, quand
et seulement quand le drapeau est armé. Un opt-in visible seulement à l'instant où on le
coche est un opt-in qu'on oublie avoir donné ; une ligne « les mobiles sont exclus » à
chaque rafraîchissement, à l'inverse, finirait par ne plus être lue — et c'est justement
la ligne qu'il faut voir quand elle dit le contraire.

### 3. La barre compte des communes, jamais des pages

C'est l'arbitrage central. Le lot de communes est **figé** : la planification de l'étape
[3] insère toutes les pages racines dans une seule transaction, et rien n'en ajoute
ensuite. Le dénominateur ne bouge plus de tout le run, donc la barre ne recule jamais.

Les pages, elles, apparaissent au fil du crawl — jusqu'à `maxPages` par commune — et une
barre assise sur elles reculerait à chaque lien retenu. Une barre qui recule est pire que
pas de barre : elle fait perdre confiance à ce qu'affiche le reste de l'écran. Le compte
de pages est donc rendu à côté, **en chiffre et sans dénominateur** : il dit le travail
fourni sans prétendre dire le travail restant.

Chaque passe a sa mesure, ou n'en a pas :

| passe | mesure | pourquoi |
|---|---|---|
| amorce | aucune | le nombre de communes du département n'est connu qu'une fois le dump de l'Annuaire lu. Une barre inventée serait pire qu'aucune barre. |
| découverte | communes explorées / communes planifiées | dénominateur figé, cf. ci-dessus |
| normalisation | contacts à `score_version` courante / contacts | c'est le critère du travail lui-même. « Un score existe » figerait la barre à 100 % pendant toute la passe, un contact noté par une version antérieure du barème étant renoté. |

L'indicateur d'étape se lit même sans barre, et c'est déjà plus que ce que disait le
compteur de jobs.

**La progression se lit sur la base, pas sur le pilote.** Un run lancé dans un terminal
doit s'afficher comme un run lancé d'ici : c'est déjà le contrat du bloc de suivi depuis
le lot 6, et le WAL le permet sans que rien ne coordonne les deux process. La campagne
prise est la dernière du département plutôt que `campagneDuJour` — la planification vient
d'en ouvrir une, il n'en existe pas de plus récente, et c'est la seule lecture juste pour
un run démarré avant minuit et poursuivi après.

### 4. La barre est un `<progress>` natif

Pas un `<div>` dont on réglerait la largeur. La CSP du serveur est `default-src 'self'`,
donc `style-src 'self'` : un attribut `style` en ligne est **refusé par le navigateur**, et
la barre resterait vide sans que rien ne le signale — un échec silencieux, le pire genre.
Ajouter `'unsafe-inline'` à `style-src` reviendrait à payer un rectangle du garde-fou qui
protège l'écran de revue, où l'on regarde de près des chaînes lues sur des sites tiers.

L'élément natif porte sa valeur dans un attribut, se met en forme en CSS, et annonce tout
seul sa progression aux lecteurs d'écran.

### 5. Les dates sont formatées à la main, dans le fuseau de la machine

`dateHeure`, `jour` et `duree` vivent dans `rendu.ts`. Rien ne change en base.

Formatage manuel plutôt que `Intl.DateTimeFormat` : les accesseurs `getDate`/`getHours`
lisent le fuseau **à chaque appel**, là où un formateur `Intl` garde en cache celui qu'il
avait à sa construction — le bloc de suivi se rend toutes les deux secondes, et un
formateur construit à chaque rendu pour contourner ce cache serait du gâchis. Le rendu ne
dépend alors d'aucune donnée de locale, ce qui est cohérent avec un projet qui pèse ses
dépendances.

`jour` relit la chaîne caractère par caractère, sans passer par `Date` : `new
Date("2023-08-30")` vaut minuit UTC, et à l'ouest de Greenwich l'affichage local
retomberait sur la veille. Une borne de dormance décalée d'un jour se lirait comme une
erreur de calcul.

Un run resté ouvert sans date de fin — ce qu'un `kill -9` laisse — n'est pas chronométré
jusqu'à aujourd'hui : le compteur dirait l'âge de la panne, pas la durée d'un travail.

## Conséquences

- `SurfacePilote` gagne `avecMobiles()` et `reglerMobiles()`. Le routeur reste ignorant du
  worker, et les tests de routage continuent de se passer de file de jobs.
- `PhaseRun` gagne `PHASES_RUN` et `estPhaseRun` : la colonne `run.phase` est un TEXT
  nullable, elle se relit plutôt qu'elle ne se suppose.
- Le pilote garde **deux mémoires de refus** : celle des commandes de run, rendue dans le
  suivi, et celle du drapeau, rendue dans son propre réglage. Une seule faisait apparaître
  le même message aux deux endroits, et un refus rendu deux fois se lit comme deux refus.
- `POST /mobiles` vise `#mobiles` et non `#suivi`. C'est un réglage, pas une commande de
  run, et son avertissement doit rester sous les yeux.
- Une case non cochée n'est pas envoyée par le navigateur : l'absence du champ vaut
  « exclus ». C'est le sens de lecture sûr — le lire comme « inchangé » laisserait le
  drapeau armé pour toujours.
- L'invariant 6 reste tenu par construction là où il compte : la revue refuse toujours
  qu'un mobile entre par une correction manuelle, et le drapeau n'a aucune représentation
  persistée.
