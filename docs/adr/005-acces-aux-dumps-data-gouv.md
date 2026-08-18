# ADR-005 — Accéder aux dumps data.gouv sans enfreindre `robots.txt`

Statut : acceptée — 2026-08-17

## Contexte

Deux décisions validées entraient en collision, ce qui ne s'est vu qu'en lisant le
`robots.txt` réel plutôt qu'en le supposant :

- **D3** — l'outil télécharge le dump RNA depuis data.gouv au premier run.
- **§4.2** — `robots.txt` est respecté, sans option pour le désactiver.

Or `https://www.data.gouv.fr/robots.txt` contient, pour `User-agent: *` :

```
Disallow: /api/1/datasets/r/
```

C'est exactement le motif des URL de téléchargement des ressources — celles du RNA
comme celles de l'Annuaire de l'administration. La lecture stricte de l'invariant
interdit donc l'amorce du pipeline.

On aurait pu arguer que le protocole d'exclusion vise la découverte automatisée et non
la récupération délibérée d'un fichier d'open data nommément désigné par l'utilisateur.
L'argument est défendable, mais il aurait fallu inscrire une exception dans le code —
et une exception à un invariant qui se veut absolu en est la première fissure.

## Décision

Ne jamais passer par le redirecteur `/api/1/datasets/r/…`.

Constaté sur le site réel (17/08/2026) :

1. L'**API de métadonnées**, `https://www.data.gouv.fr/api/1/datasets/<id>/`, n'est
   pas interdite par `robots.txt`. Elle renvoie, pour chaque ressource, son URL
   directe.
2. Ces URL directes pointent vers `echanges.dila.gouv.fr` et
   `lecomarquage.service-public.gouv.fr`, dont les `robots.txt` répondent **403** —
   soit « aucune restriction » au sens de la RFC 9309 §2.3.1.3.

Le chemin d'amorce est donc : métadonnées via l'API autorisée, puis téléchargement sur
l'hôte de fichiers. Aucune exception à l'invariant, aucun drapeau, aucune discussion sur
ce qu'est « vraiment » un crawler.

## Conséquences

- Une requête de plus par jeu de données, sur une ressource légère et mise en cache.
- On dépend de la stabilité de l'API de métadonnées, pas d'URL de ressources codées en
  dur — ce qui est de toute façon la bonne pratique : les identifiants de ressources
  changent à chaque publication mensuelle.
- Le test de `robots.txt` inclut ce cas réel : le redirecteur doit être refusé et l'API
  de métadonnées acceptée. Une régression sur l'analyseur se verrait immédiatement.
- **À traiter au lot 2** : le dump de l'Annuaire de l'administration est un
  `all_latest.tar.bz2` de 365 Mo, et non le JSON léger supposé. Node n'a pas de
  décompresseur bzip2 (`zlib` couvre gzip, deflate et brotli), et l'ADR-001 interdit
  les modules natifs. Il faudra donc soit une dépendance bzip2 en JavaScript pur — la
  première du projet, à justifier — soit une autre source pour la résolution des URL de
  mairie. L'hôte accepte `Range` et fournit `ETag` : la reprise de téléchargement et la
  revalidation conditionnelle fonctionneront.
