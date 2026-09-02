# ADR-033 — Nommer une structure quand le RNA ne la connaît pas

Statut : acceptée — 2026-09-01

## Contexte

Troisième reproche du premier utilisateur, et le plus lourd : **beaucoup de lignes sans
nom d'association**. « Sans ça, la ligne ne me sert à rien. » Il a raison : une adresse
qu'on ne peut rattacher à personne ne se travaille pas.

Ces lignes sont les contacts non rattachés (`contact.association_id IS NULL`), et leur
nombre n'est pas un défaut de collecte mais une conséquence directe du rattachement. Il ne
trouve un nom que s'il reconnaît, dans le bloc DOM, un `nom_normalise` **déjà connu du
RNA** (`rattachement.ts`), avec un plancher de huit caractères. Ressortent donc anonymes :
toute structure absente du registre, toute association dissoute, tout nom trop court, et
tout cas d'homonymie — que l'[ADR-012](012-rattachement-et-regime-des-contacts.md) refuse
délibérément de trancher.

## Décision

Une **cascade à quatre temps**, appliquée par groupe dans le profil simple
([ADR-032](032-deux-profils-d-export.md)) :

| Ordre | Source | Nature | Signalée par |
|---|---|---|---|
| 1 | `association.nom` (RNA) | lecture | `nom_source = rna` |
| 2 | `contact.nom_pressenti` (bloc DOM) | lecture | `nom_source = bloc` |
| 3 | domaine e-mail spécifique | **inférence** | `nom_source = domaine` |
| 4 | domaine de la mairie | **inférence** | `nom_source = mairie` |
| — | rien | — | ligne écartée du profil simple |

La distinction lecture / inférence est le cœur de cette ADR. Un nom déduit d'un domaine
n'a **aucune source** : il n'a été lu nulle part. Le fichier complet le signale par une
colonne ; le fichier simple, qui ne la porte pas, le dit sur l'écran d'export. Sans cette
distinction, une déduction se présenterait comme un fait — et la personne qui répondra à
une demande d'accès n'a que le fichier sous les yeux.

### `contact.nom_pressenti` — une dérivée, pas une donnée collectée

Le texte du bloc DOM qui porte le contact (`ContactExtrait.contextes`) est calculé à chaque
crawl, sert déjà au rattachement… puis jeté. Rien ne l'écrit en base. C'est pourtant la
seule source qui porte vraiment le nom d'une association que le RNA ignore.

La migration 11 ajoute cinq colonnes, sur le modèle explicite de `prefiltre_*`
(migration 4) et de `score_*` (migration 5) :

- `nom_pressenti`, `nom_pressenti_normalise` — la paire `nom` / `nom_normalise`, parce que
  la clé de regroupement se calcule en SQL, où `normaliserNom` (NFD) n'est pas exprimable.
  Sans elle, un nom accentué et le même nom sans accents feraient deux structures.
- `nom_pressenti_source` — la méthode.
- `nom_pressenti_at` — quand.
- `nom_pressenti_version` — la règle appliquée, et **la distinction entre « jamais
  cherché » et « cherché, rien trouvé »**. Sans elle, la passe de rattrapage rebalaierait
  éternellement les mêmes pages sans converger.

**Aucune contrainte de provenance, et pas de colonne de confiance.** C'est une dérivée : sa
provenance est celle du contact, sur la même ligne — `source_url`, `collected_at`,
`methode_extraction`, `confiance` y sont déjà, et déjà `NOT NULL`. L'invariant 5 n'est pas
contourné, il ne s'applique pas. Une confiance affirmerait une mesure là où il n'y a qu'une
heuristique binaire : trouvé, ou pas trouvé.

### Le nom déduit d'un domaine

`contact@tennis-club-bruzou.fr` désigne presque sûrement le Tennis Club de Bruzou ;
`lespetitesmains@orange.fr` ne désigne rien. Un domaine est **spécifique** quand il n'est
ni une messagerie grand public (liste en dur d'une trentaine d'entrées), ni celui de la
mairie ou l'un de ses sous-domaines, ni dégénéré (une seule étiquette, punycode).

Le domaine de la **page** où le contact a été lu n'entre pas dans ce jugement, et c'est
voulu : `contact@tennisbruzou.fr` trouvé *sur* `tennisbruzou.fr` est le meilleur cas de
tous, pas un cas à écarter.

Deux détails qui comptent :

- **Les plateformes d'hébergement** — `clubeo`, `sportsregions`, `footeo`, `e-monsite`… —
  sont très répandues chez les petits clubs français. Sans une liste, `tennisbruzou.clubeo.com`
  et trente de ses voisins sortiraient tous nommés « Clubeo » : c'est le sous-domaine qui
  porte le nom.
- **Le libellé est sans accents, et il l'est par nature.** Un nom de domaine n'en porte
  pas, et on ne restaure pas « Théâtre » depuis `theatre-des-landes.fr` sans inventer.
  Exception assumée à la règle « le texte affiché s'accentue » du CLAUDE.md, qui vise le
  texte de l'interface et non une donnée dérivée d'une chaîne ASCII.

L'inférence **renonce plutôt que de tronquer** : un libellé trop court, trop long ou
illisible ne produit rien. Couper fabriquerait un nom qui n'a jamais existé nulle part.

### Le mobilier de page ne masque jamais un nom de structure

L'heuristique du bloc rejette le mobilier de page — « Contact : », « Nous écrire »,
« Secrétariat » — testé en **préfixe**, parce que « Amicale des secrétaires » est un nom
quand « Secrétariat : » n'en est pas un.

Cette règle s'est retournée contre elle-même : `accueil` y figurait, et rejetait donc
« **Accueil de loisirs** Les Petites Mains ». C'est-à-dire exactement la structure qu'une
collectivité cherche en premier, et celle que le RNA ne connaît jamais — un accueil de
loisirs communal n'est pas une association déclarée.

Deux corrections, et la seconde est la vraie :

1. `accueil` est désormais rejeté **seulement s'il est tout le segment** : « Accueil » est
   un lien de navigation, « Accueil périscolaire de Bruz » est un nom.
2. Les motifs de nom de `classification.ts` servent de **laissez-passer**, avant tout
   filtre. Ils ne disent pas seulement quel type attribuer : ils affirment que le texte
   *nomme une structure*. Un test vérifie qu'aucun d'eux n'est masqué par le mobilier —
   c'est ce qui empêche un mot ajouté demain d'en éteindre un autre en silence.

### Le nom déduit du domaine de la mairie

Un contact sur le domaine de la commune est nommé « Mairie de *commune* », et **chaque
adresse garde sa ligne**. Le fichier de référence de l'utilisateur contient précisément ces
lignes-là — `periscolaire@`, `aej@`, `secretariat-socio@` — et une commune a souvent six
services : les réunir dans une cellule unique rendrait la ligne inutilisable.

Conséquence à assumer : un numéro de téléphone n'a pas de domaine, donc une ligne
« Mairie de … » sort sans téléphone. Seul le nom lu dans le bloc réunit les deux.

## Ce qui a été écarté

**Le nom déduit du slug d'URL**, première idée et la plus séduisante. Inexploitable sur ce
corpus, et la raison est structurelle : le scoring dirige le crawl vers les pages-**listes**
(`associ`, `annuaire`, `club`, `sport` — `scoring.ts`). Les contacts non rattachés portent
donc des URL de rubrique — `/associations`, `/vie-associative`, `/contact` — partagées par
N structures. Le slug donnerait le même nom à tous les contacts d'une page. Ce n'est pas un
nom manquant : c'est un nom faux, et un nom faux a l'air vrai.

**Le titre de page ou le `<h1>`.** Indisponibles, et pas par oubli : `<head>` est dans
`IGNORES` (`parse/html.ts`), donc `<title>` n'atteint jamais `doc.texte` ; et `h1`…`h6` ne
sont pas dans `BLOCS`, donc leur texte finit noyé sans qu'on puisse le réidentifier.

**Le plancher de huit caractères du rattachement.** Il existe pour éviter les *faux
rattachements* — « ACCA » se trouve partout. Le nom pressenti ne rattache rien : lui
imposer le même plancher jetterait des noms courts parfaitement légitimes.

## Conséquences

- Un domaine portant le nom de la commune sans être celui de la mairie — office de
  tourisme, ancien site — produira le nom de la commune comme nom de structure. Limite
  connue, non traitée : il faudrait comparer au nom de la commune normalisé, que la table
  `commune` ne stocke pas.
- Un téléphone orphelin sans nom pressenti n'a **aucune** source de nom : il sort du profil
  simple. Le rattrapage par le bloc est ce qui le récupère.
- Le nom affiché dans le fichier simple peut être une inférence sans que le fichier le
  dise. C'est l'écran d'export qui porte cet avertissement, et la colonne `nom_source` du
  fichier complet qui le rend vérifiable ligne à ligne.

## Mise en œuvre

Trois temps, livrés dans cet ordre :

1. **L'export** — les branches 1, 3 et 4 de la cascade, les cinq colonnes de la
   migration 11, et l'exclusion en dernier recours. Ne demande aucune recollecte.
2. **L'écriture au crawl** — `nom-pressenti.ts`, le champ `empreinte` sur
   `ContactExtrait`, et la règle **un nom connu ne s'efface jamais, un nom absent se
   comble**. Elle demande deux gestes dans `crawl.ts`, parce que l'`ON CONFLICT` du
   contact est gardé par la confiance : une vue moins sûre n'écrit rien, donc n'apporterait
   jamais un nom manquant, et une vue plus sûre mais muette effacerait un nom déjà trouvé.
   Ne profite qu'aux collectes à venir.
3. **`annuaire noms`** — la passe de rattrapage, qui relit les corps depuis le cache
   disque et nomme une base **déjà collectée**, sans une seule requête réseau. C'est elle
   qui fait remonter le taux de lignes nommées chez un utilisateur existant, et elle qui
   réunit le téléphone et l'e-mail d'une même structure sur une seule ligne du fichier
   simple.

Deux points de la passe méritent d'être écrits plutôt que subis :

- elle lit les pages avec `avecMobiles: true`, **délibérément**. Elle n'écrit aucun
  contact — elle apparie ceux qui sont déjà en base — et à `false`, un mobile légitimement
  collecté sous `--avec-mobiles` ne retrouverait jamais son contexte. Un test verrouille
  qu'elle n'insère rien : sans lui, ce serait une porte dérobée à l'invariant 6 ;
- un contact que la page ne nomme pas reçoit quand même sa **version**, avec un nom nul.
  C'est ce qui la fait converger : sans cette marque, les mêmes pages seraient rescannées
  à chaque passage, éternellement. Un cache froid, lui, ne marque rien — « on n'a pas pu
  regarder » n'est pas « on a regardé et il n'y a rien ».
