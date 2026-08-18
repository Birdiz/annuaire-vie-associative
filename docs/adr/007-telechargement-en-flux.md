# ADR-007 — Télécharger en flux, à côté de `fetch`

Statut : acceptée — 2026-08-18

## Contexte

Le client HTTP du lot 1 est taillé pour des pages : il plafonne les réponses à
`MAX_RESPONSE_BYTES` (5 Mo), lit le corps entier en mémoire, puis l'écrit dans un cache
adressé par hash d'URL. Les dumps du lot 2 pèsent de 273 Mo à 1,25 Go. Aucune de ces
trois propriétés ne tient à cette échelle.

Il fallait donc une seconde voie — sans pour autant créer une seconde porte de sortie
réseau, ce que l'invariant « une seule porte » interdit.

## Décision

`HttpClient.openStream()`, méthode du client existant et non module séparé : elle
emprunte les mêmes chemins internes que `fetch` pour `robots.txt`, le throttle et le
User-Agent, qui sont privés. Les garanties du lot 1 valent donc pour les flux sans
qu'on ait eu à les réécrire — un test le vérifie explicitement pour chacune.

Elle rend un `AsyncIterable<Uint8Array>` plutôt qu'un `Buffer`, n'écrit rien dans le
cache par hash, et accepte un `fromByte` qui déclenche une requête `Range`.

**Le timeout ne couvre que l'obtention des en-têtes.** `REQUEST_TIMEOUT_MS` vaut 20 s ;
appliqué au corps entier comme le fait `fetch`, il tuerait tout transfert de plus de
20 secondes. Un `AbortController` local est armé avant la requête et désarmé dès que la
réponse arrive ; ensuite, seul le signal de l'appelant peut interrompre le flux.

**gzip et `Range` s'excluent, et le choix se fait par source.** Un offset d'octets
décompressés ne veut rien dire pour un serveur qui compte en octets transmis. D'où
`identityEncoding`, qui refuse la compression :

- **Annuaire** : compression acceptée, pas de reprise. 273 Mo deviennent une trentaine
  sur le fil ; en cas de coupure, recommencer coûte moins cher que de renoncer au gain.
- **RNA** : `identityEncoding`, pour que la reprise ait un sens. Le S3 ne compresse de
  toute façon pas, mais l'en-tête rend l'intention explicite.

**`If-Range` n'est pas fiable, la validation de reprise est faite côté client.** Le
miroir RNA répond `206 Partial Content` même avec un `If-Range` portant un ETag périmé,
au lieu du `200` complet qu'exige la RFC 7233 §3.2. S'y fier reviendrait à recoller la
première moitié d'un fichier avec la seconde moitié d'un autre — une corruption
silencieuse, invisible jusqu'à ce que quelqu'un s'étonne d'une association fantôme.
Avant toute reprise, l'appelant compare donc lui-même `ETag`, `Last-Modified` et la
taille totale à ceux mémorisés ; au moindre écart, il repart de zéro.

Le champ `resumed` du résultat distingue un `206` d'un `200` : un serveur qui ignore
purement et simplement le `Range` est ainsi détecté plutôt que subi.

**L'état de reprise vit en base, pas sur disque.** La table `dump` porte `consumed_bytes`,
`etag`, `last_modified`, `total_bytes` et l'en-tête du CSV. L'offset est avancé dans la
même transaction que les lignes qu'il représente : après un arrêt brutal, l'offset et
les données ne peuvent pas être en désaccord. Un index unique partiel
(`WHERE statut = 'en_cours'`) garantit qu'il n'existe jamais qu'un dump ouvert par
source, donc que la reprise n'a jamais à choisir entre plusieurs candidats.

L'en-tête est mémorisé parce qu'une reprise redémarre au milieu du fichier, là où
l'ordre des colonnes n'est plus lisible ; sans cela il faudrait une requête
supplémentaire à chaque reprise pour relire les premiers octets.

## Conséquences

`MAX_RESPONSE_BYTES` ne s'applique pas aux flux. C'est délibéré et c'est le prix de la
manœuvre : le garde-fou de taille disparaît, l'appelant décide quand s'arrêter.

Le compteur `http.bytes` ne mesure que les corps bufferisés ; les flux sont comptés par
`dump.octets_lus`. Deux compteurs pour deux régimes, plutôt qu'un total qui mélangerait
une page de mairie et un dump national.

Les dumps ne passant pas par le cache par hash, aucune revalidation `If-None-Match`
automatique ne s'applique : c'est la table `dump` qui tient ce rôle, avec une
granularité de reprise que le cache ne saurait pas offrir.
