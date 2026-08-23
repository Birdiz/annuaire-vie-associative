# ADR-025 — Régime juridique et obligations de l'utilisateur

Statut : acceptée — 2026-08-23

## Contexte

Toute l'architecture du projet repose sur une position juridique : parce que les requêtes
partent de la machine de l'utilisateur et jamais d'une infrastructure de l'éditeur,
celui-ci est **fournisseur d'outil** et non responsable de traitement. Le §2 du brief en
fait la contrainte structurante, le CLAUDE.md interdit toute architecture qui la
romprait, et le test d'architecture refuse toute URL d'infrastructure codée en dur.

La revue du lot 9 a constaté que cette position n'était **écrite nulle part**. Le README
faisait 28 Ko sans une occurrence de « RGPD », « CNIL », « base légale », « responsable de
traitement », « article 14 » ou « opposition ». L'écart est frappant avec le soin apporté
au reste : l'ADR-017 documente honnêtement qu'une requête DNS part de la machine, et rien
ne disait à l'utilisateur qu'il assume les obligations d'un responsable de traitement.

Or la conséquence de la position de l'éditeur est exactement là : si l'éditeur n'est pas
responsable de traitement, **quelqu'un d'autre l'est**, et c'est l'utilisateur. Ne pas le
lui dire revient à lui faire assumer sans le savoir des obligations qu'il ne remplira pas.

## Décision

Le régime juridique est documenté à trois endroits, chacun pour un moment différent :

1. **Le README**, section « Ce que vous devez faire » — lue avant l'installation.
2. **Cette ADR** — le raisonnement, pour qui reprend le code.
3. **L'écran d'export** — l'avertissement au moment où le fichier quitte l'outil.

Ce que ces trois endroits énoncent :

- **L'utilisateur est responsable de traitement.** Il décide des finalités et des moyens ;
  l'éditeur fournit un outil qui s'exécute sur la machine de l'utilisateur, ne reçoit
  aucune donnée et n'émet aucun appel vers son infrastructure.
- **La base légale est à établir par l'utilisateur**, et la mise en balance à mener. Pour
  une collectivité, la mission d'intérêt public (art. 6.1.e) est généralement le fondement
  pertinent ; pour un autre acteur, l'intérêt légitime (art. 6.1.f) demande une mise en
  balance documentée. L'outil ne choisit pas à sa place.
- **L'information des personnes est obligatoire** (art. 14, collecte indirecte) : au plus
  tard un mois après la collecte, ou dès la première communication si elle intervient
  avant. C'est l'obligation la plus souvent oubliée sur ce type de traitement.
- **La conservation est de trois ans**, purgée automatiquement au démarrage (§4.8), et
  cette durée doit figurer au registre des traitements.
- **Le régime diffère selon le type d'adresse.** La colonne `regime` de l'export distingue
  `generique` (adresse de fonction) de `nominatif` (adresse désignant une personne
  physique). La seconde relève pleinement du RGPD ; la première mérite la même prudence,
  une adresse de fonction pouvant être relevée par une personne identifiable.
- **L'outil ne prospecte pas.** Il n'envoie aucun courriel, et c'est un interdit du §5 du
  brief. Cela n'empêche pas techniquement d'importer le CSV dans un routeur : la doctrine
  de la CNIL sur le moissonnage à fin de prospection est frontale, et l'avertissement doit
  être explicite.
- **Les droits des personnes doivent pouvoir être honorés.** C'est l'objet de l'ADR-026.

## Conséquences

- Le README gagne une section normative, et non un paragraphe de politesse : elle énumère
  ce que l'utilisateur doit faire, pas ce qu'il pourrait envisager.
- L'écran d'export porte l'avertissement au moment utile. Il parlait déjà de provenance ;
  il parle désormais aussi de régime.
- Cette ADR ne fait pas de l'éditeur un conseil juridique. Elle énonce les obligations
  usuelles d'un responsable de traitement sur un traitement de ce type ; l'utilisateur
  reste seul juge de sa situation, et de la nécessité de consulter son DPO.
- **Ce document n'est pas un avis juridique et n'engage pas l'éditeur.**
