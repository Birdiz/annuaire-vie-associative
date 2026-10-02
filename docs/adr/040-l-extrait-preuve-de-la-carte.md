# ADR-040 — L'extrait, preuve de la carte de relecture

Statut : acceptée — 2026-10-02

## Contexte

La carte de relecture de « L'Établi » (ADR-041) montre, à côté de la décision, un extrait
de la page source où la valeur est surlignée. C'est l'emprunt central à Prodigy : on juge
sur la preuve, sans rouvrir la page.

Aucune colonne ne portait cette preuve. La relire depuis le cache à chaque affichage
l'aurait fait disparaître dès que le cache est purgé (trois ans) ou réinitialisé, et
aurait coûté une analyse DOM par carte.

## Décision

**L'extrait est calculé à l'extraction et stocké sur le contact** (`contact.extrait`,
migration 15).

- **Une fonction pure, `extraitAutour`** (`src/decouverte/extraction.ts`), appelée par le
  crawl et par la réparation, sur la même page analysée par la même porte DOM. Une base
  collectée et une base réparée montrent la même preuve.
- **Ce qui est surligné, c'est ce que la page montrait.** La recherche se fait dans cet
  ordre : la valeur telle que lue, puis le texte qui l'a fait repérer, puis l'ancre du
  lien. Un `mailto:` dont le lien dit « Écrire au club » surligne cette ancre. Un `tel:`
  en forme internationale retrouve les chiffres affichés, séparateurs quelconques.
- **Le texte vient de `doc.texte`.** Il ne contient ni `<script>` ni `<style>` : un extrait
  ne peut pas citer ce que la page n'affichait pas.
- **La forme stockée est un JSON `{avant, cible, apres}`**, environ 100 caractères de part
  et d'autre, coupés aux mots, avec une ellipse. L'écran échappe les trois morceaux et
  entoure la cible d'un `<mark>`. Il ne recherche rien lui-même.
- **La colonne accepte `NULL`.** Ce n'est pas de la provenance au sens de l'invariant 5 :
  l'URL, la date, la méthode et le score restent obligatoires. Une valeur introuvable dans
  le texte reste sans preuve, plutôt qu'avec une preuve inventée.
- **Les bases antérieures** sont réparées une fois, depuis le cache, par `src/reparation.ts`
  avec le marqueur `metric(reparation, extraits_version)`. Une page absente du cache laisse
  la carte sans preuve, et le marqueur est posé quand même, pour que la base ne soit pas
  relue à chaque commande.
- **Compteur.** `extraction/contacts_avec_extrait`. Un taux qui chute dirait qu'un gabarit
  de site cache ses valeurs au texte.

## Conséquences

- **L'extrait peut citer une personne** (« écrire au trésorier : … »). Il reste local, ne
  sort dans **aucun** export (les colonnes du CSV ne changent pas), et disparaît avec la
  ligne quand on l'oublie (invariant 10) ou qu'on la purge (invariant 8).
- **Une vue plus sûre du même contact remplace l'extrait** : la preuve doit citer la page
  que la provenance nomme. Sans extrait, l'ancien est gardé.
