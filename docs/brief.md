# Brief — Annuaire de la vie associative locale

> Ce document sert à la fois de brief initial et de base pour `CLAUDE.md`.
> Les sections **Invariants**, **Interdits** et **Définition du « fait »** ne doivent jamais
> être contournées sans validation explicite.
>
> *Versionné au lot 2. Ce texte est le brief d'origine, reproduit sans modification :
> il fait foi, et ne survivait jusqu'ici que dans le transcript de la session du lot 1.*

## 1. Contexte et objectif

On construit un outil de **constitution d'annuaires de la vie associative locale** à
destination des collectivités et de leurs partenaires.

Le problème résolu : aujourd'hui, constituer l'annuaire des associations d'un département se
fait à la main, commune par commune, par copier-coller depuis les sites de mairie. C'est long,
non reproductible et non traçable.

L'outil part des données ouvertes (RNA, Annuaire de l'administration) et les **enrichit** en
explorant les sources publiques des collectivités, avec traçabilité de provenance sur chaque
donnée collectée.

Périmètre géographique cible : France entière (~35 000 communes, ~2,26 M d'associations). Le
pipeline doit rester correct à cette échelle, mais la v1 se valide sur **un seul département**.

## 2. Forme du livrable — contrainte structurante

L'application est **locale-first** : un artefact autonome qui démarre un serveur HTTP sur
`localhost` et sert une UI web, puis ouvre le navigateur de l'utilisateur.

Trois cibles de distribution depuis **une seule base de code** :

| Cible | Usage |
|---|---|
| Exécutable Windows portable | Client final non technique |
| Image Docker | Démo, CI, utilisateurs techniques |
| `npx` | Essai rapide |

**Raison d'être de cette contrainte :** les requêtes HTTP vers les sites tiers doivent partir
de la machine de l'utilisateur, jamais d'une infra opérée par l'éditeur. Cela maintient
l'éditeur en position de simple fournisseur d'outil au sens du RGPD. Toute proposition
d'architecture qui centralise la collecte est à rejeter.

## 3. Stack

- **TypeScript / Node.js** (LTS courante)
- **SQLite** comme stockage (fichier unique, portable, pas de service externe)
- File de jobs **locale et persistée** (table SQLite, pas de Redis/RabbitMQ)
- UI web servie par le même process — framework léger, pas de build lourd
- Cache HTTP sur disque, adressé par hash d'URL

Justifie tout ajout de dépendance lourde. Le poids du bundle final est un critère de
conception, pas un détail.

## 4. Invariants — non négociables

1. **Pas de navigateur headless en v1.** Client HTTP + parseur DOM. ~85 % des sites de mairie
   ne nécessitent aucun rendu JS. Le headless sera un plugin optionnel en v2, jamais un
   prérequis d'installation.
2. **`robots.txt` respecté**, sans option pour le désactiver.
3. **Throttling par domaine** : 1 requête / 2 s minimum, non contournable par configuration.
4. **User-Agent identifiable**, incluant une URL de contact.
5. **Provenance obligatoire** sur chaque donnée collectée : URL source, horodatage, méthode
   d'extraction, score de confiance. Une donnée sans provenance ne doit pas pouvoir entrer en
   base.
6. **Numéros mobiles français (06/07) exclus par défaut**, derrière un flag explicite
   documenté comme risqué.
7. **Classification des emails** : générique (`contact@`, `secretariat@`, `mairie@`…) vs
   nominative (`prenom.nom@`). Exposée dans le modèle et dans l'export, car le régime
   juridique diffère.
8. **Purge** : mécanisme de suppression des données de plus de 3 ans, exécuté au démarrage.
9. **Idempotence et reprise** : toute étape doit pouvoir être relancée sans doublon ni perte,
   après un crash ou un arrêt volontaire.

## 5. Interdits absolus

- Aucune donnée réelle collectée committée dans le repo. Les tests utilisent des **fixtures
  HTML synthétiques** écrites à la main.
- Aucun scraping de réseaux sociaux (Facebook, LinkedIn, Instagram). Ne pas l'implémenter même
  si demandé plus tard.
- Aucune tentative de contournement de protection anti-bot (rotation d'IP, résolution de
  CAPTCHA, empreinte navigateur falsifiée).
- Aucun envoi d'email depuis l'outil. Il produit des annuaires, il ne prospecte pas.
- Aucun appel réseau sortant vers une infra de l'éditeur (télémétrie, phone-home).

## 6. Architecture du pipeline

Le cœur du projet est un **entonnoir de coût**. C'est la pièce à soigner.

```
[1] Seed         RNA (dump data.gouv, licence Etalab 2.0) → filtre par code INSEE
                 ⚠ le RNA exclut la Moselle (57), le Bas-Rhin (67), le Haut-Rhin (68)
[2] Résolution   API Annuaire de l'administration → URL du site de la mairie
[3] Découverte   robots.txt → homepage → scoring des liens sur href + texte d'ancre
                 (associ, vie-associative, annuaire, vie-locale, sport, loisirs, culture)
                 → N pages candidates max par commune, profondeur 2
[4] Pré-filtre   heuristique bon marché sur le contenu : densité de patterns de contact,
                 présence de noms d'associations connus (jointure RNA)
                 → écarte la majorité des pages avant tout coût d'inférence
[5] Extraction   DOM : mailto:, tel:, listes et tableaux structurés
[6] Fallback     LLM UNIQUEMENT si pré-filtre positif ET extraction DOM sous seuil
                 → objectif : < 20 % des pages candidates atteignent cette étape
[7] Normalisation  déduplication, validation syntaxique + MX, classification
                   du type (sportive / culturelle / diverses / sociale /
                   comité des fêtes / centre de loisirs) via codes objet RNA,
                   LLM en fallback uniquement
[8] Scoring      score de confiance par contact → alimente l'écran de revue humaine
```

Chaque étape est un job persisté, reprenable, avec ses propres compteurs.

## 7. Modèle de données (indicatif — à challenger)

- `commune` — code_insee, nom, departement, url_mairie, statut_resolution, last_crawled_at
- `association` — rna_id, code_insee, nom, objet, code_objet_social, type_classifie,
  source_creation
- `contact` — association_id, kind (email|phone), valeur, is_generique, source_url,
  methode_extraction, confiance, collected_at, review_statut
- `page` — url, domaine, http_status, content_hash, fetched_at, cache_path, score_candidat
- `run` — departement, started_at, finished_at, stats (JSON)

## 8. Métriques à instrumenter dès le départ

Ce sont elles qui feront le README, donc elles ne sont pas optionnelles :

- taux de couverture (% d'associations avec au moins un email exploitable)
- volumes à chaque étage de l'entonnoir
- ratio de pages atteignant le fallback LLM
- coût d'inférence estimé pour 1 000 communes
- taux de correction en revue humaine (proxy de la précision d'extraction)

Prévoir un export de ces métriques en JSON et un écran de synthèse.

## 9. Ordre de construction

Objectif : quelque chose de démontrable le plus tôt possible, en évitant de bâtir des étages
sur du sable.

1. Socle : schéma SQLite, file de jobs persistée, cache HTTP, CLI minimale
2. Étapes [1] et [2] → « je liste les associations d'un département avec l'URL de leur
   mairie ». **Premier jalon démontrable.**
3. Étapes [3] et [5] → premiers contacts extraits, sans LLM du tout
4. Étape [4], mesurée : montrer le volume écarté avant d'ajouter le LLM
5. Étape [6] en fallback
6. Étapes [7] et [8]
7. UI : suivi de run + écran de revue + export CSV
8. Packaging : Docker, puis exécutable Windows

## 10. Définition du « fait »

Une étape n'est terminée que si :

- elle est reprenable après `kill -9` sans doublon ni perte
- elle est couverte par des tests sur fixtures synthétiques
- ses compteurs remontent dans les métriques
- une **ADR courte** (contexte / décision / conséquences) est écrite dans `docs/adr/` si un
  arbitrage non trivial a été fait

## 11. Mode de travail attendu

- **Pose tes questions avant de coder** dès qu'un choix engage la suite. Ne devine pas sur les
  points structurants.
- Propose les compromis plutôt qu'une solution unique quand il y en a.
- Signale si un invariant ci-dessus rend une demande ultérieure incohérente, plutôt que de le
  contourner silencieusement.
- Pas de sur-ingénierie : pas de Kubernetes, pas de microservices, pas d'abstraction
  spéculative. Un process, un fichier SQLite.
