# ADR-037 — Déchiffrer le `mailto:` de TYPO3, et rien d'autre

Statut : acceptée — 2026-09-28

## Contexte

Sur le Rhône, le client signale que Rillieux-la-Pape ne sort presque rien, alors que
l'annuaire du site est très complet. Les fiches de cet annuaire, servies par TYPO3,
écrivent le courriel ainsi :

```html
<a href="#" data-mailto-token="nbjmup+…" data-mailto-vector="1">Courriel</a>
```

C'est l'anti-spam du CMS (`spamProtectEmailAddresses`). Le jeton est l'adresse
`mailto:…` décalée d'un cran, lettre par lettre, sur trois plages de caractères. Au clic,
un script de la page la déchiffre. Les versions anciennes du CMS écrivent la même chose
en `href="javascript:linkTo_UnCryptMailto('nbjmup+…')"`.

Nous n'exécutons aucun script (invariant 1). La porte DOM jetait en plus tout `href="#"`,
comme une ancre interne. L'adresse que la page déclarait n'atteignait donc jamais
l'extraction.

## Décision

**On déchiffre ce jeton, à l'extraction, et uniquement lui.**

Le raisonnement est celui de l'ADR-030 :

- **La page déclare un lien de courriel.** C'est le signal le plus fort dont on dispose.
- **Le déchiffrement ne devine rien.** Un chiffrement de César n'a pas de clé à trouver,
  et le préfixe `mailto:` désigne le décalage : sur les 26 lettres, un seul décalage
  entre -10 et 10 (la plage que TYPO3 accepte) peut produire `mailto:`. Le résultat ne
  dépend donc ni de l'attribut `data-mailto-vector`, dont la convention de signe a changé
  entre versions du CMS, ni d'un choix de notre part.
- **Garde-fou** : le résultat n'est retenu que s'il commence par `mailto:` et porte
  exactement une arobase. Au-delà, on a affaire à autre chose et on ne touche à rien.

Ce n'est pas un contournement de protection anti-bot au sens des interdits du projet :
pas de rotation d'IP, pas de CAPTCHA, pas d'empreinte falsifiée. Le jeton ne distingue
pas un robot d'un humain ; il empêche seulement un moissonneur de lire l'adresse dans le
code source. Robots.txt, throttle et User-Agent restent appliqués sans changement.

**La porte DOM rend le jeton, pas l'adresse.** Un lien `<a data-mailto-token>` sort de
`analyser` sous la forme `x-typo3-mailto:<jeton>`, comme les `mailto:` et `tel:` sortent
tels quels. Déchiffrer est une décision d'extraction : c'est elle qui sait qu'elle lit un
lien de courriel, et qui en tire la provenance. Cette forme a une conséquence utile : les
contextes et le titre de fiche, qui comparent `lien.href` à l'empreinte du contact, en
héritent sans une ligne de plus.

**La provenance le dit.**

- Méthode `dom:mailto+typo3`, distincte de `dom:mailto`.
- Confiance 0,75, comme l'arobase réparée de l'ADR-030 et pour la même raison. La page
  déclare le lien, mais l'adresse rendue n'est pas celle qu'elle écrit. Et à moins de
  0,6, l'adresse resterait sous le seuil d'export courant : déchiffrée, mais absente du
  fichier.

**Les jetons comptent dans le plafond des blocs** (ADR-035). Sans cela, une liste de
vingt fiches aux adresses chiffrées passerait pour un bloc sans contact, et son titre
nommerait les vingt.

## Conséquences

- Nouveau compteur `extraction/emails_typo3`. Il dit ce que la règle rapporte, et
  signalera un changement de chiffrement du CMS.
- Les bases déjà collectées ne gagnent ces adresses qu'à la collecte suivante. La passe
  de nommage relit le cache, mais n'insère aucun contact (voir `noms.ts`).
- Les deux formes sont couvertes par des fixtures synthétiques. Les jetons des tests sont
  calculés à la main, sur des adresses inventées.

## Alternatives écartées

**Exécuter le script de la page.** C'est l'invariant 1, et ce serait ouvrir la porte à
tout le reste du JavaScript des sites.

**Désobfusquer plus largement** (entités HTML, inversion de chaîne, `[at]` dans les
`href`…). Chaque forme se décide sur mesure, comme l'ADR-030 l'a fait pour `[^@]`. Celle-ci
est retenue parce qu'elle est répandue chez les communes et qu'elle ne peut pas se tromper.
