# ADR-002 — File de jobs par bail expirant plutôt qu'état « running »

Statut : acceptée — 2026-08-17

## Contexte

L'invariant §4.9 exige que toute étape se relance après un arrêt brutal sans doublon ni
perte. Un run départemental dure des heures ; il sera interrompu.

La conception naïve marque un job `running` quand un worker le prend. Après un
`kill -9`, la base garde des jobs `running` qu'aucun process ne traite. Il faut alors
un nettoyage au démarrage — qui ne sait pas distinguer un job abandonné par un process
mort d'un job réellement en cours dans un autre process. Cette ambiguïté n'a pas de
solution correcte sans battement de cœur.

Second problème, plus subtil : même avec une reprise correcte, si l'effet d'un job et
sa complétion sont écrits séparément, un arrêt entre les deux fait rejouer l'effet.
L'idempotence ne peut donc pas être une discipline laissée à chaque handler.

## Décision

**Aucun état « running » persisté.** Un job pris passe `leased` avec une date
d'expiration. Après un arrêt brutal, le bail expire de lui-même et le job redevient
éligible — sans nettoyage au démarrage, sans intervention. Le bail *est* le battement
de cœur.

Trois choix l'accompagnent :

1. **Prise atomique** en une seule instruction `UPDATE … WHERE id = (SELECT … LIMIT 1)
   RETURNING …`. Deux workers ne peuvent pas obtenir le même job.
2. **`attempts` incrémenté à la prise, pas à l'échec.** Un job qui fait tomber le
   process consomme une tentative : sans cela, un job qui provoque un crash serait
   repris indéfiniment et bloquerait la file à chaque redémarrage.
3. **L'effet et la complétion sont commités ensemble.** Le handler fait son travail
   asynchrone puis rend une fonction `commit` synchrone ; le worker l'exécute dans la
   même transaction que la complétion du job. Le handler n'écrit jamais lui-même en
   base. L'exactement-une-fois devient une propriété du cadre, pas de chaque handler.

## Conséquences

- Reprise sans intervention après `kill -9`, vérifiée par un test qui tue réellement un
  process enfant en plein vol puis relance et vérifie qu'aucun effet n'est perdu ni
  rejoué.
- **Un job plus long que son bail doit le renouveler**, sans quoi il serait repris en
  parallèle. Le worker s'en charge par un timer à la moitié du bail.
- **Après un crash, les jobs en vol attendent l'expiration de leur bail** avant d'être
  repris — soit une minute par défaut. C'est le prix de l'absence de battement de cœur
  séparé. Sur un run de plusieurs heures, c'est négligeable ; sur les tests, on
  raccourcit le bail.
- Un arrêt demandé par l'utilisateur relâche le bail et **rend la tentative
  consommée** : une interruption volontaire n'est pas un échec du job.
- Un job dont les tentatives sont épuisées passe `dead` et **apparaît dans les
  métriques**. Un échec ne disparaît jamais en silence.
