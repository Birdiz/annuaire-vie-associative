# Prompt Claude Design — refonte de l'interface, phase 1 (diverger)

Statut : prêt à envoyer (2026-10-02). La phase 1 ouvre trois directions. La phase 2
(converger) aura son propre prompt, une fois que Thomas aura choisi une direction et dit ce
qu'il garde des deux autres. Le portage dans `src/ui/` viendra ensuite. Il est contraint par
la CSP, par htmx et par les tests qui figent le balisage, et il fera l'objet d'un plan à part.

Portée : la refonte porte sur les **parcours**, pas seulement sur la peau. Direction visuelle :
laissée ouverte.

Références choisies par Thomas après une analyse web d'outils comparables. Il y en a une par
axe, pour que les directions divergent vraiment :

| Axe | Référence | Pourquoi |
|---|---|---|
| Service public sobre | Annuaire des Entreprises (data.gouv.fr) | Chaque champ porte sa source et sa date : la provenance mise en scène, c'est notre invariant 5 |
| Atelier de revue | Prodigy (Explosion) | Une carte à la fois, des décisions au clavier, la preuve à côté de la décision |
| Chaleur associative | HelloAsso | Le ton « nous », des couleurs franches, la vie associative comme bien commun |

Références secondaires, communes aux trois directions, pour l'écran de collecte : Apify
Console (vue d'exécution, compteurs en direct) et OpenRefine (candidats, confiance, choix
humain).

Écartés comme axe à part entière : le suivi de pipeline (Dagster, Datasette), relégué au
rang de référence secondaire. Également écartés : Démarches simplifiées, trop lourd, et
La Suite numérique, trop proche de l'identité de l'État.

Contrainte légale vérifiée. Le DSFR, la police Marianne et le bloc-marque sont réservés aux
sites de l'État, et les collectivités en sont exclues : voir le dépôt GouvernementFR/dsfr et
la circulaire 6411-SG du 7 juillet 2023. L'outil ne doit en emprunter ni le code ni
l'apparence.

---

## Prompt (à coller tel quel)

```text
I need a redesign — visual identity AND user journeys — for "Annuaire de la vie associative
locale", a French desktop tool that local authorities use to build the directory of the
associations (non-profits, sports clubs, festival committees…) in their territory.

This is phase 1: DIVERGE. Give me THREE clearly distinct directions, one per reference
below. Do not converge, do not pick a winner, do not blend the three into one. I will
choose afterwards.

## The product in brief
- Local-first. The user runs a portable Windows executable; it starts a small web server on
  their own PC and opens the UI in their browser at localhost. Nothing leaves the machine:
  the crawling happens from the user's PC, never from a cloud. The footer says so today:
  "Serveur local : rien de ce qui est affiché ici ne sort de cette machine." That promise
  is part of the product, not a legal footnote.
- What it does, in order:
  1. reads the French national register of associations (RNA) for one département;
  2. politely explores the public websites of every town hall (mairie) of that département
     — robots.txt respected, one request every 2 seconds per site, so a full run takes
     several hours;
  3. extracts contacts (emails, landline phones) and attaches each one to an association;
  4. records provenance on EVERY contact: source URL, date read, extraction method, and a
     confidence score with its reasons;
  5. a human reviews the uncertain contacts;
  6. exports a CSV file.
- Order of magnitude for one département: ~350 communes, ~36,000 active associations,
  a few thousand pages explored, a few thousand contacts. Use invented association and
  town names in mockups (e.g. "Comité des fêtes de Saint-Aubin-des-Landes", "Judo club du
  Val de Seiche") — never real ones.
- Audience: staff of town halls, inter-municipal bodies and départements ("agents de
  collectivité"). Not technical. Office Windows PCs, Edge or Chrome, screens from 1366 to
  1920 px wide. They are personally accountable under the GDPR for what they export.
- Tone: trustworthy, traceable, human, calm. It shows its sources and admits what it does
  not know. Never "growth", never a lead-generation tool, never gamified (no badges,
  streaks, confetti, mascots).

## The three references (one direction each)
Borrow the SPIRIT of each reference, never its look. None of the directions may be
mistaken for the product it comes from.

1. Annuaire des Entreprises (annuaire-entreprises.data.gouv.fr, French public service).
   Take: every piece of data shows where it comes from and when it was last updated;
   public-service plainness that earns trust; dense information made calm. Direction theme:
   "provenance, made visible". WARNING: it is a French State website. The State design
   system (DSFR), the Marianne typeface, the "bloc-marque" and the "bleu France / rouge"
   pairing are legally reserved for State websites; local authorities are excluded. This
   direction must NOT look like a government site.
2. Prodigy (the annotation tool by Explosion). Take: one decision at a time, keyboard-first,
   the evidence sitting right next to the decision, a queue that visibly shrinks.
   Direction theme: "the review workshop". Our users are not power users, so keyboard
   shortcuts are a bonus, never a requirement.
3. HelloAsso (French platform for associations). Take: the warmth of local associative
   life, frank colours, a "we" voice, associations shown as a common good. Direction theme:
   "local associative life". Do not borrow its fundraising register: this tool never asks
   anyone for money.

Secondary references, for the collection screen in all three directions: Apify Console
(run view with status, duration, live counters) and OpenRefine (candidates, confidence, a
human choice per value).

Anti-references, for all three: commercial scraping and lead-gen tools (Phantombuster,
Lusha, Hunter.io — "leads", credits, aggressive enrichment); SEO directory aggregators full
of ads and unsourced data; generic admin templates (AdminLTE, Bootstrap dashboards with
colourful KPI tiles); dark Grafana-style monitoring walls; any imitation of the French
State's visual identity.

## The journeys to redesign
You may reorganise the navigation. Today there are four tabs (Synthèse, Revue, Export,
Aide) and the Synthèse tab carries setup, run control, metrics and a danger zone all at
once. The help page already describes the natural journey in five steps:
"Renseigner l'URL de contact — une fois pour toutes", "Choisir le département",
"Lancer la collecte, et la laisser travailler", "Relire ce dont l'outil n'est pas sûr",
"Exporter le fichier". Propose your own journey and show it as a map.

Screens and states to cover:
1. First launch / setup.
   - A contact URL is mandatory before any collection: it is announced to every website
     visited so a webmaster can reach the user. Field label "URL de contact", button
     "Enregistrer".
   - Choosing the département. It is shown, and changed, in exactly ONE place in the whole
     UI (today a scope bar under the header). A département never collected shows "Jamais
     amorcé. Le lancer le remplira depuis le registre national."; others already in the
     database are listed as "Déjà en base : 35, 56".
   - Mobile numbers (06/07) are EXCLUDED by default. Keeping them is a checkbox
     ("Conserver aussi les numéros mobiles 06/07 pendant cette session") plus a separate
     "Appliquer" button — two gestures on purpose — and switching it on shows a GDPR
     warning that stays visible.
2. Collection running (a run lasts hours).
   - Main button "Lancer la collecte complète"; while running, "Arrêter la collecte" with
     the reassurance that stopping loses nothing and relaunching resumes.
   - Three phases: Amorce → Découverte → Normalisation, each done / current / to come.
   - A progress bar with a sentence ("1 240 pages visitées sur 4 980"), job counters, the
     list of recent runs ("Dernières collectes": n°, département, statut, début, durée).
   - Some phases have no count yet: the UI must say so rather than invent a percentage.
3. Coverage — what the collection produced.
   - Three rates read together: "au moins un email", "… exploitable", "… dont le domaine
     reçoit du courrier", plus the number of active associations.
   - A funnel: associations actives → pages explorées → pages retenues → contacts extraits
     → contacts notés.
   - Mail-domain check, classification of associations into types, and review counters
     ("à arbitrer", "validés", "rejetés", "corrigés", "taux de correction").
4. Review queue ("Revue"). The least certain contacts first. Each contact card shows:
   - the value type ("Adresse email", "Numéro de téléphone") and the value itself;
   - the association it is attached to and its commune — or "commune, sans association
     rattachée";
   - the legal regime of an email: "adresse de fonction", "adresse nominative — elle
     désigne une personne", or "régime indéterminé";
   - the score ("score 0,62 · lu 0,75") with the list of reasons that raised or lowered it;
   - the extraction method, the date read ("vue le 14/09/2026 10:32"), and the source page
     ("Lue sur https://…");
   - four actions. "Valider", "Rejeter" and "Corriger" (with a field "valeur corrigée")
     carry EQUAL visual weight: the tool must not nudge the reviewer. "Oublier" is a
     permanent GDPR erasure (deletes the line, its cached copy, and blocks it from coming
     back); it requires a written reason ("motif, obligatoire pour oublier") and stands
     apart — downward, never as a primary action.
   - There is a short legend: "Que font les quatre boutons ?"
5. Export ("Export CSV").
   - Two profiles: "Fichier simple — 6 colonnes, une ligne par structure" (default in the
     UI, no provenance, never names a person) and "Fichier complet — toutes les colonnes,
     une ligne par contact" (the auditable file, with provenance and legal regime).
   - A minimum score field, an "include rejected contacts" checkbox, the announced line
     count, and how many contacts were left out and why.
   - Button "Télécharger le fichier". During a run, the export is suspended and a banner
     says why.
   - The GDPR warning sits exactly where the file leaves the tool: "Ce fichier contient
     des données personnelles, et vous en êtes responsable de traitement." … duty to
     inform people (art. 14 GDPR) … "Cet outil ne prospecte pas, et ce fichier n'est pas un
     fichier de prospection."
6. Help ("Aide"): the five steps, the obligations, an FAQ ("Rien ne bouge depuis vingt
   minutes. C'est bloqué ?", "Est-ce que quelque chose sort de mon poste ?"…).
7. Danger zone "Repartir de zéro". A first button "Voir ce qui serait effacé" shows what
   would be deleted and what stays (erasure requests, other départements). Then "Oui,
   effacer le département 35" or "Annuler". It must sit at the bottom, away from daily use.

## Hard constraints (apply to all three directions)
Technical — this is server-rendered HTML, not a SPA:
- HTML rendered by the server + htmx. No JavaScript framework. Every form must also work
  without JavaScript.
- Content-Security-Policy is "default-src 'self'". Therefore: no inline style attributes,
  no inline scripts, no remote fonts, images or stylesheets, no data: URIs. Icons are SVG
  (inline markup or served locally). One hand-written stylesheet.
- Fonts: open licence (OFL or similar), self-hosted woff2, at most 2 families, and say the
  weight budget. The system font stack is acceptable if the direction does not need more.
  Every kilobyte ships inside the executable, so state the total asset weight.
- The run-monitoring block refreshes every 2 seconds, the metrics every 10 seconds: those
  blocks can NEVER contain an input field (it would be wiped while typing). Inputs live in
  separate, non-refreshing blocks. Design with that split in mind.
- Progress uses the native <progress> element (no width-in-a-div trick: the CSP forbids
  inline styles).

Themes and accessibility:
- Light AND dark themes, following the OS preference.
- Deliver design tokens that map 1:1 to CSS custom properties.
- French public bodies are bound by RGAA (accessibility): WCAG AA contrast at minimum,
  visible focus, nothing conveyed by colour alone.
- Desktop first, designed at 1280 px; must remain usable at 375 px.

Semantics, non-negotiable:
- The alert colour is reserved for erasure and legal warnings (GDPR, personal data). Never
  decorative, never for "error 404"-style trivia.
- The score reads as CONFIDENCE in a reading, not as a verdict. It must not look like a
  green / orange / red traffic light.
- The excluded-mobiles default must be visible, and so must the moment it is switched on.
- Provenance (source page, date, method, score) is always one step away from any contact.
- No internal references on screen: no "ADR-…", no "§ 4.6", no bracketed step numbers.
- Nothing that looks like a French State website (see reference 1).

Language: every UI string is in FRENCH with proper accents (é, è, à, ç, «  »). Use real
French copy, including the strings quoted above — not lorem ipsum. Only technical values
stay unaccented: CSV column names (code_insee, methode_extraction) and values (generique,
nominatif, indetermine), CLI options.

## Deliverables — for EACH of the three directions
1. Name and one-sentence concept, plus what it borrows from its reference and what it
   deliberately does not.
2. Mood: 5–8 keywords, and how it uses (or refuses) illustration and imagery.
3. Palette with hex values and roles: background, surface, text, muted text, border,
   primary, accent, alert (erasure/legal), and the confidence scale. Light AND dark values,
   with the contrast ratio of each text-on-background pair.
4. Type pairing (open licence, or system stack) with a desktop type scale, and the font
   weight budget in KB.
5. Logo: a wordmark and a square icon, in colour and in monochrome, shown large and as a
   16 px favicon.
6. Journey map: the screens, their order, and where setup, collection, review and export
   live in the navigation.
7. Three key screens at 1280 px, light theme:
   A. Collection running — phase "Découverte" in progress, live counters, the stop button,
      recent runs, the coverage rates. Also show screen A in the dark theme.
   B. Review — a page of the queue with at least three contact cards: one generic email
      with a high score, one nominative email ("adresse nominative — elle désigne une
      personne") with a low score and its reasons, one landline phone attached to a commune
      only.
   C. Export — "Fichier simple" selected, the announced line count, the left-out contacts
      explained, the GDPR warning, and "Télécharger le fichier".
8. One component strip: the "Repartir de zéro" confirmation (what would be deleted, what
   stays, "Oui, effacer le département 35" / "Annuler"), and the empty state of a
   département "Jamais amorcé".

## Finish with
A comparison table of the three directions:
- legibility for a non-technical municipal agent;
- trust and traceability (does provenance read at a glance?);
- fit with the constraints (server-rendered, htmx, strict CSP, no input in refreshed blocks);
- distinctiveness (and distance from a State website);
- font and asset weight;
- main risk.
Then stop. I will pick a direction and tell you what to keep from the others for a
convergence round.
```
