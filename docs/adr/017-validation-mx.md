# ADR-017 — Validation MX : une porte DNS, et un fait de domaine

Statut : acceptée — 2026-08-22

## Contexte

Le §6.7 du brief range dans l'étape [7] une « validation syntaxique + MX ». Jusqu'ici,
rien ne séparait une chaîne ayant la forme d'un email d'une adresse dont le domaine sait
recevoir du courrier. Le taux de couverture — la métrique qui fait le README (§8) —
comptait donc indifféremment les deux.

Le contrôle MX pose une question que les lots précédents n'avaient pas rencontrée : il
sort sur le réseau, mais **pas en HTTP**. Il ne passe donc ni par `robots.txt`, ni par le
throttle, ni par le User-Agent — les trois choses que `src/http/` existe pour garantir.

## Décision

**La résolution MX vit dans `src/http/dns.ts`.** C'est déjà le seul répertoire du projet
qui touche au DNS : `throttle.ts` y résout l'adresse de chaque hôte pour en tirer la clé
/24 (ADR-004). Le résolveur MX y entre en voisin, pas en exception. `node:dns` rejoint
`node:http` et consorts dans la liste des modules que le test d'architecture interdit
partout ailleurs.

**Elle est active par défaut, sans drapeau.** Un `--verifier-mx` optionnel ferait dépendre
le chiffre publié de la façon dont l'outil a été invoqué : deux runs, deux « taux de
couverture », tous deux appelés ainsi. C'est exactement ce que la discipline du projet
refuse — les garanties se tiennent par construction, pas par option.

**Le délai de 2 s ne s'applique pas, et ce n'est pas un oubli.** L'invariant §4.3 protège
les serveurs web des mairies d'un débit qu'elles n'ont pas demandé. Une requête MX ne
s'adresse pas à elles : elle part vers le résolveur du système, qui répond depuis son
cache dans l'immense majorité des cas. Lui appliquer 2 s par domaine ferait durer une
heure ce qui prend quatre secondes, sans épargner un octet à quiconque. Ce qui protège
réellement est en place : un plafond de concurrence, un domaine interrogé une seule fois,
et un cache persistant de trente jours.

**Le MX est un fait de domaine, jamais d'adresse.** `contact@mairie-x.fr` et
`nimportequoi@mairie-x.fr` ont le même verdict. La table s'appelle donc `domaine_mail` et
porte le domaine en clé ; une adresse n'en hérite que par jointure. L'appeler
`email_valide` aurait laissé croire à une garantie que le DNS ne donne pas : il dit que le
domaine sait recevoir du courrier, pas que la boîte existe.

**Trois états, pas deux.** `mx = 1` présent, `mx = 0` absent, `mx IS NULL` la résolution a
échoué. Confondre les deux derniers condamnerait un domaine valide sur un incident réseau
passager. Un verdict en échec est en outre toujours traité comme périmé : il se rejoue au
passage suivant.

**Le garde-fou de test passe par le résolveur, pas par un espion.**
`test/helpers/pas-de-reseau.ts` pointe le résolveur DNS par défaut vers `127.0.0.1:9`, un
port mort. `resolveMx` y échoue en `ECONNREFUSED` ; `lookup()`, dont `throttle.ts` a
besoin, passe par le résolveur du système et n'est pas affecté. L'interdit reste vrai par
construction.

Ce mécanisme a une condition non évidente, découverte en le mettant en place :
`node:dns/promises` porte ses méthodes sur un objet, et `resolveMx` s'en sert par `this`.
Importée en binding nommé — `import { resolveMx }` — elle perd cet objet et retombe sur
les serveurs du système, **hors de portée de `setServers`**. La suite de tests sortirait
alors réellement sur Internet en se croyant confinée. Aucun test de comportement ne
rattrape cela : un test d'architecture vérifie donc la forme de cet import.

## Ce que la mesure a montré

Sur l'Ille-et-Vilaine, 748 domaines distincts pour 4 273 emails collectés, résolus en
**quatre secondes**. 681 annoncent un MX, 65 n'en annoncent pas, 2 n'ont pas pu être
résolus.

Effet sur la couverture : des 478 associations créditées d'au moins un email, **455**
en ont un dont le domaine reçoit du courrier. Le taux passe de 1,53 % à 1,45 %. L'écart
est faible, et c'est en soi le résultat : la couverture basse n'est pas un artefact
d'adresses mortes.

**Le contrôle a surtout révélé un défaut d'extraction.** 41 domaines sont revenus en
`EBADNAME` — un code qui signifie « ce n'est pas un nom de domaine ». Ils venaient tous
d'adresses de la forme `abcdanse[^@]gmail.com` : un CMS répandu chez les petites communes
remplace l'arobase de ses `mailto:` par ce littéral, qu'un script répare côté client. Le
motif permissif de l'étape [5] les acceptait, et **138 contacts** comptaient dans la
couverture. D'où la validation syntaxique de `src/normalisation/validation.ts`, qui les
note à zéro et dit pourquoi.

**Ce que ce lot ne fait pas** : reconstruire ces adresses. Ce serait une désobfuscation,
donc une décision d'extraction [5], à prendre en regardant le §5 du brief — le projet
désobfusque déjà les formes `[at]` avec une confiance minorée, mais l'étendre à une
obfuscation manifestement destinée aux moissonneurs mérite d'être décidé, pas glissé.

## Conséquences

- Une requête DNS par domaine collecté part de la machine de l'utilisateur. Elle ne
  révèle rien qu'un crawl n'ait déjà révélé — la plupart de ces domaines sont ceux des
  mairies, résolus à chaque page visitée — mais elle sort, et c'est écrit ici.
- Un verdict MX vieillit. Trente jours de fraîcheur : assez court pour que l'annuaire ne
  mente pas, assez long pour qu'une seconde campagne ne repaie pas tout. Les verdicts
  sont purgés à trois ans comme le reste des données collectées.
- Le taux de couverture a désormais deux lectures, et les deux sont affichées. Ne montrer
  que la plus favorable reviendrait à améliorer le chiffre en changeant la question.
