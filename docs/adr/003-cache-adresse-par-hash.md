# ADR-003 — Cache adressé par hash d'URL, écriture atomique

Statut : acceptée — 2026-08-17

## Contexte

Le pipeline repasse plusieurs fois sur les mêmes pages : mise au point du scoring,
reprise après interruption, run de validation rejoué. Sans cache, chaque itération
recoûte des heures de crawl à 1 requête / 2 s et sollicite inutilement les sites des
mairies — ce qui, au-delà du temps perdu, est discourtois.

Les URL de sites de mairie sont longues, accentuées, parfois avec des paramètres : elles
ne peuvent pas servir de noms de fichiers directement.

## Décision

Clé = `sha256` de l'**URL canonicalisée** — schéma et hôte en minuscules, port par
défaut retiré, fragment retiré, paramètres triés, chemin laissé tel quel car sensible à
la casse sur la plupart des serveurs. Stockage sous `cache/<aa>/<bb>/<hash>.{body,meta.json}`,
l'arborescence à deux niveaux évitant un répertoire à cent mille entrées.

**Le corps est écrit avant les métadonnées**, chacun en fichier temporaire puis
`rename`. Les métadonnées font office de marqueur de validité.

Au-delà du TTL, revalidation conditionnelle par `If-None-Match` / `If-Modified-Since` ;
un `304` rafraîchit l'horodatage sans retélécharger.

## Conséquences

- Un `kill -9` en cours d'écriture laisse au pire un fichier temporaire orphelin, jamais
  une entrée tronquée que le run suivant relirait comme valide. À la lecture, une entrée
  dont le corps manque ou dont la taille ne correspond pas aux métadonnées est traitée
  comme absente et nettoyée.
- Un second run sur un département déjà parcouru est quasi gratuit : les `304` évitent
  le transfert, et le contenu vient du disque.
- **Pas d'invalidation par motif d'URL** : on ne peut pas « vider tout ce qui vient de
  tel domaine » sans parcourir l'arborescence. Le besoin ne s'est pas présenté ; s'il
  apparaît, la table `page` porte déjà le domaine et le chemin de cache.
- La purge du cache s'appuie sur la date de modification du fichier plutôt que sur les
  métadonnées : lire un JSON par entrée rendrait la purge impraticable à l'échelle
  visée. C'est une approximation assumée — les deux dates ne diffèrent que d'une
  écriture.
- Le cache contient le HTML brut, donc **les mêmes données personnelles que la base**.
  Il est purgé selon la même règle des trois ans, sans quoi la purge serait un
  trompe-l'œil.
