# Annuaire de la vie associative locale

Outil local-first de constitution d'annuaires d'associations pour les collectivites.
Il part des donnees ouvertes (RNA, Annuaire de l'administration) et les enrichit en
explorant les sources publiques des collectivites, avec provenance sur chaque donnee.

Le brief complet fait foi. Ce fichier ne retient que ce qui contraint le code.

## Contrainte structurante

L'application est **locale-first** : un process, un fichier SQLite, une UI servie sur
`localhost`. Les requetes HTTP vers les sites tiers partent de la machine de
l'utilisateur, **jamais** d'une infra operee par l'editeur. C'est ce qui maintient
l'editeur en position de simple fournisseur d'outil au sens du RGPD.

**Toute proposition d'architecture qui centralise la collecte est a rejeter.**

Trois cibles de distribution depuis une base unique : executable Windows portable,
image Docker, `npx`.

## Invariants — non negociables

1. **Pas de navigateur headless.** Client HTTP + parseur DOM.
2. **`robots.txt` respecte**, sans option pour le desactiver.
3. **Throttling : 1 requete / 2 s minimum par domaine**, non contournable par configuration.
4. **User-Agent identifiable**, incluant une URL de contact.
5. **Provenance obligatoire** sur chaque donnee collectee : URL source, horodatage,
   methode d'extraction, score de confiance.
6. **Numeros mobiles francais (06/07) exclus par defaut**, derriere un flag explicite.
7. **Classification des emails** : generique vs nominative — le regime juridique differe.
8. **Purge** des donnees de plus de 3 ans, executee au demarrage.
9. **Idempotence et reprise** : toute etape se relance sans doublon ni perte, apres crash.

Les invariants 2, 3 et 8 sont tenus **par construction** : ils ne sont pas exposes dans
la surface de configuration. C'est leur absence du fichier de config qui les rend
non contournables, pas un commentaire dans le code. Ne pas les y ajouter.

De meme, l'invariant 5 est une contrainte `NOT NULL` du schema et l'invariant 9 repose
sur des contraintes `UNIQUE` : une donnee sans provenance ou un doublon apres reprise
doit echouer au niveau de la base, pas etre evite par de la logique applicative.

## Interdits absolus

- Aucune donnee reelle collectee committee. Les tests utilisent des **fixtures HTML
  synthetiques** ecrites a la main.
- Aucun scraping de reseaux sociaux (Facebook, LinkedIn, Instagram).
- Aucun contournement de protection anti-bot (rotation d'IP, CAPTCHA, empreinte falsifiee).
- Aucun envoi d'email depuis l'outil.
- Aucun appel reseau sortant vers une infra de l'editeur (telemetrie, phone-home).
- **La suite de tests ne sort jamais sur Internet.** Tout ce qui touche au reseau se
  teste contre un serveur HTTP local jetable. Cet interdit est tenu **par construction**
  depuis le lot 2 : `npm test` precharge `test/helpers/pas-de-reseau.ts`, qui refuse
  tout hote hors boucle locale. Les tests qui lancent la CLI en sous-processus doivent
  le precharger aussi.

## Decisions techniques

| # | Decision | Consequence |
|---|---|---|
| D1 | `node:sqlite` + Node SEA | Node 24+. **Aucun module natif**, a aucun lot. |
| D2 | Departement de validation : 35 par defaut (parametre CLI) | Sous-ensemble fige de 20 communes pour l'iteration |
| D3 | Dump RNA telecharge au 1er run, `--rna-file` en override | Downloader resumable par `Range` |
| D4 | LLM : BYOK, provider pluggable, desactive par defaut | Le pipeline est complet et mesurable sans aucune cle |
| D5 | UI : `node:http` + htmx + CSS ecrit a la main | Applique au lot 6 : htmx vendorise, 50 Ko (ADR-020) |
| D6 | Parseur DOM : `node-html-parser` | Applique au lot 3 : 11 paquets, 3,0 Mo (ADR-011) |
| D7 | Tests : `node:test` + `node:assert` | Zero dependance de test |
| D8 | Build : aucun pour le dev, `esbuild` (devDep) pour le SEA | Node 24 execute le TS nativement |
| D9 | Config validee a la main | Pas de `zod` |
| D11 | Migrations SQL numerotees | Pas d'ORM |

Le poids du bundle final est un critere de conception. **Justifier tout ajout de
dependance**, et par defaut s'en passer. Le projet a **une seule** dependance runtime,
`node-html-parser`, entree au lot 3 apres mesure de son cout (ADR-011). C'est un seuil
qui ne se franchit qu'une fois : tout ajout ulterieur se justifie de la meme facon.

Un seul fichier tiers est embarque hors npm : `src/ui/assets/htmx.min.js`, vendorise au
lot 6 (ADR-020). Sa version et son SHA-256 sont des constantes de `src/ui/assets.ts`,
verifiees par un test — un fichier minifie ne se relit pas en revue de diff.

## Conventions

- Identifiants en anglais, sauf les termes metier non traduisibles : `commune`,
  `association`, `departement`, `code_insee`, `rna_id`.
- Messages CLI/UI et commentaires en francais, sans accents dans les identifiants.
- Imports relatifs avec l'extension `.ts` explicite (exige par Node en execution directe).
- Syntaxe effacable uniquement : pas d'`enum`, pas de parametres-proprietes, pas de
  `namespace`. Utiliser des unions de litteraux de chaine a la place des `enum`.

## Une seule porte d'entree DOM

`node-html-parser` n'est importe que par `src/parse/html.ts`. Meme logique que la porte
de sortie reseau : la dependance reste remplacable, et `css-select` — tire
transitivement — n'est jamais atteint. N'appelez pas ses accesseurs `.text` depuis
ailleurs : ils restituent le contenu des `<script>` et collent deux cellules voisines,
ce qui peut fabriquer un numero de telephone inexistant.

## Une seule porte de sortie reseau

Tout appel reseau passe par `src/http/`. Aucun autre module ne doit importer `fetch`,
`node:http`, `node:https`, `node:dns` ou `undici` — un test verifie cette regle et
echoue sinon. C'est ce qui rend les invariants 2, 3 et 4 vrais par construction plutot
que par discipline.

Deux portes y cohabitent depuis le lot 5 : le client HTTP, et le resolveur MX de
`src/http/dns.ts` (ADR-017). Ce dernier doit importer **l'objet** du module —
`import dns from "node:dns/promises"` — et non la fonction nue : `resolveMx` se sert de
cet objet par `this`, et un binding nomme echappe a `setServers`, donc au garde-fou
anti-reseau de la suite de tests. Un test d'architecture verifie cette ligne.

## Une seule porte d'ecoute

`src/ui/serveur.ts` est le seul module autorise a importer `node:http` pour **ecouter**
(ADR-020). Le test d'architecture verifie en meme temps qu'il n'appelle jamais
`request`, `http.get` ni `fetch` : il peut ecouter, il ne peut pas appeler.

L'UI n'ecoute que sur `127.0.0.1`, et cette adresse n'est pas configurable — seul le port
l'est. Les garde-fous (verification de `Host`, jeton echange contre un cookie
`SameSite=Strict`, refus des POST croises, CSP `default-src 'self'`) vivent dans
`src/ui/routes.ts`, ou ils se testent sans ouvrir de socket.

Toute valeur venue du crawl passe par `echapperHtml` de `src/ui/rendu.ts` avant d'entrer
dans une page — meme discipline que le desamorcage des formules a l'export. La CSP ferme
la meme porte une seconde fois ; aucune des deux ne dispense de l'autre.

## Definition du « fait »

Une etape n'est terminee que si :

- elle est reprenable apres `kill -9` sans doublon ni perte ;
- elle est couverte par des tests sur fixtures synthetiques ;
- ses compteurs remontent dans les metriques ;
- une **ADR courte** est ecrite dans `docs/adr/` si un arbitrage non trivial a ete fait.

## Commandes

```bash
npm run check      # typecheck strict + suite complete, sans reseau
npm test           # tests seuls
npm run annuaire -- <commande>
npm run annuaire -- ui        # interface locale : suivi, revue, export
```

## Mode de travail attendu

- Poser les questions avant de coder des qu'un choix engage la suite.
- Proposer les compromis plutot qu'une solution unique.
- Signaler si un invariant rend une demande ulterieure incoherente, plutot que de le
  contourner silencieusement.
- Pas de sur-ingenierie : un process, un fichier SQLite.
