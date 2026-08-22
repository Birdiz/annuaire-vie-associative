# ADR-014 — Pré-filtre consultatif, et portillon à deux conditions

Statut : acceptée — 2026-08-21

Réalise l'étape [4] du §6 du brief, dans l'esprit du §9 : « **mesurée** : montrer le
volume écarté avant d'ajouter le LLM ».

## Contexte

L'étape [4] n'existe que parce que l'étape [6] coûte de l'argent. Sa question n'est pas
« cette page contient-elle des associations ? » mais « cette page vaut-elle le prix d'une
inférence ? ». Ce sont deux questions différentes, et les confondre conduit à un filtre
qui écarte des données déjà acquises pour rien.

Le corpus de mesure est celui du lot 3 : **2 477 pages de l'Ille-et-Vilaine**, relues
depuis le cache disque, **sans une seule requête réseau, en 8,9 secondes**. C'est ce
rejeu hors ligne qui a rendu le réglage possible — recrawler le département coûte treize
minutes plancher (ADR-013) et autant de requêtes vers de vraies mairies, pour un contenu
qu'on possède déjà.

## Décision

### Le verdict est consultatif

Le pré-filtre marque les pages. Il n'écarte rien de l'extraction [5], et ne change pas le
suivi des liens [3].

Deux raisons, dont la seconde est la plus contraignante.

*L'extraction DOM est déjà payée.* Quand le verdict est calculé, les contacts sont
extraits : les écarter ne ferait économiser rien du tout et perdrait des données. Sur le
corpus, **910 des 1 076 pages écartées portaient au moins un contact** — toutes l'ont
conservé.

*Un filtre qui modifie le corpus qu'il mesure n'est plus mesurable.* Le §9 demande une
étape [4] mesurée avant l'ajout du LLM. Si le verdict gouvernait aussi le budget de
crawl, le corpus observé au passage suivant serait déjà celui que le filtre a choisi, et
plus aucun chiffre ne dirait ce que le filtre écarte. La rétroaction sur le crawl est
donc écartée — pas par prudence, par impossibilité de conclure.

### Le portillon a deux conditions, et les deux vides ne se valent pas

Le §6 ouvre le fallback « UNIQUEMENT si pré-filtre positif **ET** extraction DOM sous
seuil ». La conjonction n'est pas une précaution redondante, c'est elle qui porte tout le
raisonnement :

- une page **riche en noms d'associations connus mais pauvre en contacts** est la cible
  exacte du LLM — un annuaire rendu d'une façon que le DOM ne sait pas lire ;
- une page **sans noms et sans contacts** est du bruit.

Les deux sont vides d'adresses. Une seule mérite qu'on paie pour la relire. Le compte de
contacts extraits est donc persisté sur la ligne `page` : sans lui, la seconde condition
ne serait pas évaluable après coup, et le ratio du §8 ne serait pas mesurable avant
d'avoir écrit la première ligne d'inférence.

### Signaux et seuil

Quatre signaux, tous calculés sur un DOM déjà analysé, à coût marginal nul : noms
d'associations connus (jointure RNA), contacts appariés à un nom dans leur bloc, densité
de contacts, et vocabulaire du §6 lu **sur le chemin de l'URL**. Ce dernier point est un
constat de mesure : le texte d'une page de mairie contient sa navigation, donc les
rubriques de toutes les autres pages — « sport » et « associations » y figurent partout,
ce qui en ferait un bruit constant. Le chemin ne parle que de la page.

**Le seuil est fixé à 8.** Il n'est pas choisi a priori, mais sur la courbe observée :

| Seuil | Écartées | Candidates [6] | Pages écartées portant un nom connu, sans contact |
|---:|---:|---:|---:|
| 6 | 26,0 % | 422 (17,0 %) | 20 |
| **8** | **43,4 %** | **160 (6,5 %)** | **86** |
| 10 | 56,1 % | 103 (4,2 %) | 129 |
| 12 | 68,3 % | 62 (2,5 %) | 170 |

La dernière colonne est le coût du filtre : des pages qui nommaient des associations et
n'avaient rien livré, donc des candidates légitimes, écartées. **8 est le dernier seuil
où le filtre retient plus de pages prometteuses qu'il n'en écarte** — 160 contre 86. Dès
10, le rapport s'inverse. Le critère est celui-là, pas un arrondi.

## Conséquences

**Le fallback LLM est borné à 6,5 % des pages, contre 40,3 % sans filtre.** L'objectif du
§6 est « < 20 % des pages candidates » : il est tenu avec une marge de trois. Sans le
pré-filtre, 997 pages appelleraient une inférence ; il en reste 160.

**Aucune page ayant produit un contact rattaché à une association n'est écartée** :
157 sur 157 retenues, et les 2 003 contacts rattachés du département sont tous sur des
pages retenues. Ce n'est pas un hasard de seuil mais une propriété de structure — un
contact rattaché implique un nom connu et un bloc apparié, donc au moins 9 points. La
propriété tient jusqu'au seuil 12 et cède à 14.

**43,4 % d'écartées ne sont pas « la majorité des pages » que le §6 annonçait.** C'est un
écart assumé avec le texte du brief, et non un manquement. La grandeur que l'étape [4]
protège est le coût d'inférence, pas le nombre de pages : c'est la conjonction avec la
seconde condition qui le borne, et elle le borne à 6,5 %. Monter le seuil pour atteindre
une majorité d'écartées coûterait plus en candidates perdues qu'il n'économiserait — la
table ci-dessus le chiffre.

**Le vrai taux de rappel reste inconnu, et le restera jusqu'au lot 5.** Savoir si les 86
pages écartées portant un nom contenaient réellement des contacts exploitables suppose de
les soumettre au LLM. Leur score bas signifie qu'un nom y apparaît sans structure
d'annuaire, sans densité de contacts et sans URL parlante — le profil d'une mention au fil
d'une actualité (« le Club de Bruz organise… ») plutôt que d'un annuaire. **Ces 86 pages
sont l'échantillon désigné pour mesurer le rappel du filtre dès que l'étape [6] existera.**

**Le verdict porte un numéro de version.** Un réglage de seuil ou de poids laisse sinon en
base un mélange indiscernable d'anciens et de nouveaux verdicts, et le rejeu ne saurait
pas quoi recalculer. La version est écrite sur chaque ligne, et le rejeu saute par défaut
ce qui est déjà à jour.

**Le rejeu depuis le cache devient l'outil de réglage standard.** Il est un recalcul pur,
sans état de reprise : tué en plein vol, il se relance et retombe sur l'état exact d'un
passage sans incident — un test le vérifie en abattant réellement un processus. Il
n'incrémente délibérément **aucun compteur cumulatif** : ceux du §8 disent ce qui s'est
passé pendant les runs, et rejouer dix réglages les gonflerait de dix fois le corpus. La
distribution se lit dans la table, après coup.
