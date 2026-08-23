/**
 * Migrations du schema.
 *
 * Le SQL vit dans ce fichier plutot que dans des `.sql` separes : l'artefact Windows
 * est un executable unique (SEA, cf. ADR-001) qui n'a pas de fichiers voisins a lire.
 * Embarquer le SQL dans le module supprime toute lecture disque au demarrage et rend
 * le calcul de checksum trivial. Contrepartie assumee : pas de coloration syntaxique.
 *
 * Regle : une migration appliquee ne se modifie jamais. On en ajoute une nouvelle.
 */

export type Migration = {
  version: number;
  name: string;
  sql: string;
};

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "init",
    sql: `
--------------------------------------------------------------------------------
-- Domaine
--------------------------------------------------------------------------------

CREATE TABLE commune (
  code_insee        TEXT PRIMARY KEY,
  nom               TEXT NOT NULL,
  departement       TEXT NOT NULL,
  url_mairie        TEXT,
  statut_resolution TEXT NOT NULL DEFAULT 'inconnu'
                    CHECK (statut_resolution IN ('inconnu','resolue','sans_site','echec')),
  source_resolution TEXT,
  last_crawled_at   TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
) STRICT;

CREATE INDEX idx_commune_departement ON commune (departement);

-- Cle de substitution plutot que rna_id en cle primaire : une association peut etre
-- decouverte sur un site de mairie sans correspondance RNA (cf. Q-C du plan). rna_id
-- reste unique, mais nullable, pour ne pas fermer cette porte.
CREATE TABLE association (
  id                    INTEGER PRIMARY KEY,
  rna_id                TEXT UNIQUE,
  code_insee            TEXT REFERENCES commune (code_insee) ON DELETE SET NULL,
  nom                   TEXT NOT NULL,
  nom_normalise         TEXT NOT NULL,
  sigle                 TEXT,
  objet                 TEXT,
  code_objet_social     TEXT,
  type_classifie        TEXT CHECK (type_classifie IN (
                          'sportive','culturelle','diverses','sociale',
                          'comite_des_fetes','centre_de_loisirs')),
  source_classification TEXT,
  site_web              TEXT,
  source_creation       TEXT NOT NULL CHECK (source_creation IN ('rna','decouverte')),
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
) STRICT;

CREATE INDEX idx_association_code_insee ON association (code_insee);
CREATE INDEX idx_association_nom_normalise ON association (nom_normalise);

-- Les colonnes de provenance sont NOT NULL : l'invariant §4.5 est une contrainte de
-- schema, pas une convention. Une donnee sans provenance ne peut pas entrer en base.
CREATE TABLE contact (
  id                 INTEGER PRIMARY KEY,
  association_id     INTEGER REFERENCES association (id) ON DELETE CASCADE,
  code_insee         TEXT REFERENCES commune (code_insee) ON DELETE CASCADE,
  kind               TEXT NOT NULL CHECK (kind IN ('email','phone')),
  valeur             TEXT NOT NULL,
  valeur_normalisee  TEXT NOT NULL,
  is_generique       INTEGER CHECK (is_generique IN (0, 1)),
  source_url         TEXT NOT NULL,
  methode_extraction TEXT NOT NULL,
  confiance          REAL NOT NULL CHECK (confiance >= 0.0 AND confiance <= 1.0),
  collected_at       TEXT NOT NULL,
  review_statut      TEXT NOT NULL DEFAULT 'a_revoir'
                     CHECK (review_statut IN ('a_revoir','valide','rejete','corrige')),
  review_note        TEXT,
  CHECK (association_id IS NOT NULL OR code_insee IS NOT NULL)
) STRICT;

-- C'est cette contrainte qui rend une reprise apres crash inoffensive : rejouer une
-- extraction ne peut pas creer de doublon.
CREATE UNIQUE INDEX idx_contact_unicite
  ON contact (association_id, kind, valeur_normalisee)
  WHERE association_id IS NOT NULL;

-- SQLite considere deux NULL comme distincts : sans cet index partiel, les contacts
-- rattaches a une commune seule echapperaient a la deduplication ci-dessus.
CREATE UNIQUE INDEX idx_contact_unicite_orphelin
  ON contact (code_insee, kind, valeur_normalisee)
  WHERE association_id IS NULL;

CREATE INDEX idx_contact_collected_at ON contact (collected_at);
CREATE INDEX idx_contact_review ON contact (review_statut);

CREATE TABLE page (
  url_hash       TEXT PRIMARY KEY,
  url            TEXT NOT NULL UNIQUE,
  domaine        TEXT NOT NULL,
  code_insee     TEXT REFERENCES commune (code_insee) ON DELETE CASCADE,
  http_status    INTEGER,
  content_hash   TEXT,
  fetched_at     TEXT,
  cache_path     TEXT,
  score_candidat REAL,
  profondeur     INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE INDEX idx_page_domaine ON page (domaine);
CREATE INDEX idx_page_fetched_at ON page (fetched_at);
CREATE INDEX idx_page_code_insee ON page (code_insee);

--------------------------------------------------------------------------------
-- Execution
--------------------------------------------------------------------------------

CREATE TABLE run (
  id          INTEGER PRIMARY KEY,
  departement TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  statut      TEXT NOT NULL DEFAULT 'en_cours'
              CHECK (statut IN ('en_cours','termine','interrompu','echec')),
  stats       TEXT
) STRICT;

CREATE INDEX idx_run_started_at ON run (started_at);

-- Pas d'etat "running" persiste : un job pris est 'leased' avec une expiration. Apres
-- un kill -9 le bail expire et le job redevient eligible sans intervention ni
-- nettoyage au demarrage. Voir ADR-002.
CREATE TABLE job (
  id                INTEGER PRIMARY KEY,
  run_id            INTEGER REFERENCES run (id) ON DELETE CASCADE,
  type              TEXT NOT NULL,
  dedup_key         TEXT NOT NULL UNIQUE,
  payload           TEXT NOT NULL,
  state             TEXT NOT NULL DEFAULT 'pending'
                    CHECK (state IN ('pending','leased','done','failed','dead','skipped')),
  priority          INTEGER NOT NULL DEFAULT 100,
  attempts          INTEGER NOT NULL DEFAULT 0,
  max_attempts      INTEGER NOT NULL DEFAULT 5,
  available_at      TEXT NOT NULL,
  lease_expires_at  TEXT,
  last_error        TEXT,
  reason            TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
) STRICT;

-- Sert la selection du prochain job eligible, y compris la reprise des baux expires.
CREATE INDEX idx_job_eligible ON job (state, available_at, priority, id);
CREATE INDEX idx_job_lease ON job (state, lease_expires_at);
CREATE INDEX idx_job_run ON job (run_id, state);

-- Incremente dans la meme transaction que l'effet mesure. Un compteur tenu a cote de
-- la transaction ment des le premier crash, et ces compteurs font le README (§8).
--
-- run_id est nullable : la purge au demarrage et les operations de maintenance
-- produisent des compteurs qui n'appartiennent a aucun run. Comme pour contact, deux
-- index partiels sont necessaires — SQLite considere deux NULL comme distincts, donc
-- un index unique ordinaire laisserait les compteurs globaux se dupliquer.
CREATE TABLE metric (
  id     INTEGER PRIMARY KEY,
  run_id INTEGER REFERENCES run (id) ON DELETE CASCADE,
  etape  TEXT NOT NULL,
  nom    TEXT NOT NULL,
  valeur INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE UNIQUE INDEX idx_metric_cle
  ON metric (run_id, etape, nom)
  WHERE run_id IS NOT NULL;

CREATE UNIQUE INDEX idx_metric_cle_globale
  ON metric (etape, nom)
  WHERE run_id IS NULL;
`,
  },
  {
    version: 2,
    name: "seed-rna-et-resolution-mairie",
    sql: `
--------------------------------------------------------------------------------
-- Provenance de la resolution d'URL de mairie (invariant 5)
--------------------------------------------------------------------------------

ALTER TABLE commune ADD COLUMN resolution_source_url TEXT;
ALTER TABLE commune ADD COLUMN resolution_collected_at TEXT;
ALTER TABLE commune ADD COLUMN resolution_confiance REAL;

-- L'invariant 5 veut qu'une donnee sans provenance ne puisse pas entrer en base. Sur
-- une table neuve il s'ecrirait en CHECK ; ici la table existe deja, et un CHECK
-- portant sur plusieurs colonnes ne s'ajoute pas apres coup. La recreation de table
-- n'est pas une option : elle exigerait de desactiver les cles etrangeres, or
-- PRAGMA foreign_keys est sans effet a l'interieur d'une transaction et chaque
-- migration s'execute dans la sienne. Deux triggers donnent la meme garantie, au
-- meme endroit : la base refuse l'ecriture, l'applicatif n'a rien a verifier.

CREATE TRIGGER commune_resolution_provenance_insert
BEFORE INSERT ON commune
WHEN NEW.statut_resolution = 'resolue'
 AND (NEW.url_mairie IS NULL
   OR NEW.resolution_source_url IS NULL
   OR NEW.resolution_collected_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'commune resolue sans provenance complete');
END;

CREATE TRIGGER commune_resolution_provenance_update
BEFORE UPDATE ON commune
WHEN NEW.statut_resolution = 'resolue'
 AND (NEW.url_mairie IS NULL
   OR NEW.resolution_source_url IS NULL
   OR NEW.resolution_collected_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'commune resolue sans provenance complete');
END;

--------------------------------------------------------------------------------
-- Associations : dissolution
--------------------------------------------------------------------------------

-- Le RNA porte une date de dissolution. La retenir permet d'ecarter les structures
-- eteintes d'un annuaire de la vie associative sans perdre la ligne d'origine.
ALTER TABLE association ADD COLUMN date_dissolution TEXT;

CREATE INDEX idx_association_dissolution
  ON association (date_dissolution)
  WHERE date_dissolution IS NOT NULL;

--------------------------------------------------------------------------------
-- Dumps ouverts : etat de reprise
--------------------------------------------------------------------------------

-- Un dump pese de 273 Mo a 1,25 Go et n'est jamais stocke en entier. Sa reprise
-- repose donc sur un offset d'octets, avance dans la meme transaction que les lignes
-- qu'il a produites : apres un arret brutal, l'offset et les donnees sont d'accord.
-- etag et total_bytes servent a verifier que la ressource n'a pas change avant de
-- reprendre — le serveur du miroir RNA ignore If-Range, on ne peut pas lui deleguer
-- ce controle.
CREATE TABLE dump (
  id              INTEGER PRIMARY KEY,
  source          TEXT NOT NULL
                  CHECK (source IN ('rna_waldec','rna_import','annuaire_local')),
  url             TEXT NOT NULL,
  etag            TEXT,
  last_modified   TEXT,
  total_bytes     INTEGER,
  consumed_bytes  INTEGER NOT NULL DEFAULT 0 CHECK (consumed_bytes >= 0),
  statut          TEXT NOT NULL DEFAULT 'en_cours'
                  CHECK (statut IN ('en_cours','termine','echec')),
  fichier_local   TEXT,
  -- En-tete du CSV, memorise des la premiere tranche. Une reprise redemarre au milieu
  -- du fichier, la ou l'ordre des colonnes n'est plus lisible : sans cela il faudrait
  -- une requete supplementaire pour relire les premiers octets a chaque reprise.
  entete          TEXT,
  derniere_erreur TEXT,
  started_at      TEXT NOT NULL,
  finished_at     TEXT
) STRICT;

-- Un seul dump en cours par source : la reprise n'a ainsi jamais a choisir entre
-- plusieurs candidats.
CREATE UNIQUE INDEX idx_dump_en_cours ON dump (source) WHERE statut = 'en_cours';

CREATE INDEX idx_dump_source ON dump (source, started_at);
`,
  },
  {
    version: 3,
    name: "decouverte-et-extraction",
    sql: `
--------------------------------------------------------------------------------
-- Communes : ce que la decouverte a constate
--------------------------------------------------------------------------------

-- L'ADR-009 laissait au lot 3 la verification que l'URL de mairie repond, mais
-- statut_resolution ne peut pas porter cette information : il dit ce que declare
-- l'Annuaire, et le seed du run suivant remonterait a 'resolue' toute valeur qu'on
-- aurait retrogradee ici. Les deux faits sont distincts, ils ont donc deux colonnes.
--
-- 'refuse' couvre le cas ou l'Annuaire declare comme site officiel une page de reseau
-- social : le §5 du brief l'interdit, la commune est donc laissee sans crawl plutot
-- que traitee comme injoignable, qui aurait suggere une panne a corriger.
ALTER TABLE commune ADD COLUMN crawl_statut TEXT NOT NULL DEFAULT 'non_tente'
  CHECK (crawl_statut IN ('non_tente','ok','injoignable','interdit_robots','refuse'));

ALTER TABLE commune ADD COLUMN crawl_erreur TEXT;

--------------------------------------------------------------------------------
-- Pages : une ligne par campagne, par commune et par URL
--------------------------------------------------------------------------------

-- La table page etait creee au lot 1 et n'a jamais servi. Trois defauts la rendaient
-- inutilisable, et aucun ne se corrige par ALTER :
--
-- 1. url etait UNIQUE globalement. Or le lot 2 attribue la meme url_mairie a tous
--    les codes INSEE d'une fiche — une commune nouvelle conserve les codes de ses
--    communes deleguees. La seconde commune n'aurait eu aucune ligne, donc aucune
--    page et aucun contact, silencieusement. La cle porte donc le code INSEE.
-- 2. Rien ne distinguait deux passages. Le budget de pages par commune se lit par
--    comptage : sans campagne, la seconde campagne aurait trouve le budget deja
--    consomme par la premiere et n'aurait plus rien crawle, definitivement.
-- 3. Une page planifiee mais jamais visitee n'avait aucune date, et la purge ne
--    supprime que ce qui porte fetched_at. Un arret brutal laissait donc des lignes
--    immortelles qui consommaient le budget pour toujours. D'ou planifiee_at.
--
-- La recreation est sans risque : aucune table ne reference page, et seule la purge
-- la lit. C'est ce qui la distingue du cas de la migration 2, ou la recreation de
-- commune aurait exige de desactiver les cles etrangeres.

CREATE TABLE page_nouvelle (
  -- sha256(campagne + "\\n" + code_insee + "\\n" + url) : la meme URL vue depuis deux
  -- communes, ou lors de deux campagnes, donne autant de lignes distinctes.
  url_hash       TEXT PRIMARY KEY,
  -- Ce qui identifie un passage. Le jour suffit : deux campagnes le meme jour sur la
  -- meme commune sont la meme campagne, et c'est ce qui rend la reprise idempotente.
  campagne       TEXT NOT NULL,
  url            TEXT NOT NULL,
  domaine        TEXT NOT NULL,
  code_insee     TEXT REFERENCES commune (code_insee) ON DELETE CASCADE,
  http_status    INTEGER,
  content_hash   TEXT,
  -- Date d'enfilement. Distincte de fetched_at, qui reste vide tant que la page n'a
  -- pas ete visitee : c'est elle qui rend une page planifiee purgeable.
  planifiee_at   TEXT,
  fetched_at     TEXT,
  cache_path     TEXT,
  score_candidat REAL,
  profondeur     INTEGER NOT NULL DEFAULT 0,
  statut         TEXT NOT NULL DEFAULT 'a_visiter'
                 CHECK (statut IN ('a_visiter','visitee','bloquee','erreur','hors_type')),
  -- Lien parent, sans quoi la provenance d'une page de profondeur 2 serait perdue.
  url_source     TEXT
) STRICT;

INSERT INTO page_nouvelle
  (url_hash, campagne, url, domaine, code_insee, http_status, content_hash,
   planifiee_at, fetched_at, cache_path, score_candidat, profondeur, statut)
SELECT
  url_hash, 'heritee', url, domaine, code_insee, http_status, content_hash,
  fetched_at, fetched_at, cache_path, score_candidat, profondeur,
  CASE WHEN fetched_at IS NULL THEN 'a_visiter' ELSE 'visitee' END
FROM page;

DROP TABLE page;

ALTER TABLE page_nouvelle RENAME TO page;

CREATE INDEX idx_page_domaine ON page (domaine);
CREATE INDEX idx_page_fetched_at ON page (fetched_at);
CREATE INDEX idx_page_code_insee ON page (code_insee);

-- Deux communes peuvent partager une URL, une commune ne peut pas l'avoir deux fois
-- dans la meme campagne : c'est cette contrainte qui rend l'enfilement idempotent.
CREATE UNIQUE INDEX idx_page_campagne_url ON page (campagne, code_insee, url);

-- Lecture du budget, faite a chaque enfilement.
CREATE INDEX idx_page_budget ON page (campagne, code_insee);

-- Purge des pages planifiees mais jamais visitees.
CREATE INDEX idx_page_planifiee_at ON page (planifiee_at);
`,
  },
  {
    version: 4,
    name: "prefiltre-et-temporalite-rna",
    sql: `
--------------------------------------------------------------------------------
-- Pages : verdict de l'etape [4]
--------------------------------------------------------------------------------

-- Le verdict du pre-filtre est une **derivee**, pas une donnee collectee : il ne
-- porte donc pas de contrainte de provenance comme en porte 'contact'. Sa provenance
-- est la ligne 'page' elle-meme — url, fetched_at — completee par les deux colonnes
-- ci-dessous : le motif dit la methode, la version dit la regle appliquee.
ALTER TABLE page ADD COLUMN prefiltre_score REAL;

ALTER TABLE page ADD COLUMN prefiltre_verdict TEXT
  CHECK (prefiltre_verdict IN ('retenue','ecartee'));

-- Signal dominant ayant emporte la decision. « Ecartee » sans raison n'est pas
-- auditable, et l'etape [8] devra pouvoir presenter ce verdict a un humain.
ALTER TABLE page ADD COLUMN prefiltre_motif TEXT;

ALTER TABLE page ADD COLUMN prefiltre_at TEXT;

-- Constante du code, incrementee des que l'heuristique change. C'est elle qui rend
-- repondable « quels verdicts sont perimes » : sans elle, un reglage de seuil
-- laisserait en base un melange indiscernable d'anciens et de nouveaux verdicts.
ALTER TABLE page ADD COLUMN prefiltre_version INTEGER;

-- Ce que l'etape [5] a trouve sur la page. Le §6 ouvre le fallback LLM « UNIQUEMENT
-- si pre-filtre positif ET extraction DOM sous seuil » : sans ce compte, la seconde
-- condition ne serait pas evaluable apres coup, donc pas mesurable avant d'ecrire
-- la moindre ligne d'inference.
ALTER TABLE page ADD COLUMN contacts_extraits INTEGER;

CREATE INDEX idx_page_prefiltre ON page (campagne, prefiltre_verdict);

--------------------------------------------------------------------------------
-- Associations : temporalite du RNA (ADR-013)
--------------------------------------------------------------------------------

-- L'ADR-013 laisse le taux de couverture ininterpretable : son denominateur compte
-- toutes les associations non dissoutes, dont une part inconnue de structures
-- dormantes, et aucun champ temporel n'etait stocke. Les quatre colonnes sont
-- ajoutees d'un coup : elles coutent quatre ALTER et evitent une seconde migration
-- quand le seuil de dormance se raffinera.
ALTER TABLE association ADD COLUMN date_creation TEXT;
ALTER TABLE association ADD COLUMN date_declaration TEXT;

-- 'position' et 'maj_time' du RNA : etat declare de la structure, et date de
-- derniere mise a jour de la fiche. Conserves bruts, sans interpretation ici.
ALTER TABLE association ADD COLUMN position_rna TEXT;
ALTER TABLE association ADD COLUMN maj_rna TEXT;

-- Sert l'histogramme de 'annuaire dormance' et, une fois le seuil fige, le
-- denominateur « non dormantes » du taux de couverture.
CREATE INDEX idx_association_declaration ON association (date_declaration);
`,
  },
  {
    version: 5,
    name: "normalisation-scoring-et-mx",
    sql: `
--------------------------------------------------------------------------------
-- Contacts : score de revue de l'etape [8]
--------------------------------------------------------------------------------

-- Colonne distincte de 'confiance', et ce n'est pas un doublon. 'confiance' dit
-- comment le contact a ete **lu** — un lien mailto: vaut 0,9, une forme desobfusquee
-- 0,45 (ADR-012) : c'est une provenance, elle ne bouge plus une fois ecrite. Le score
-- ci-dessous dit si le contact vaut d'etre **publie**, ce qui melange la lecture, le
-- MX du domaine, le regime juridique de l'adresse et la page d'ou elle vient. Les
-- ecraser dans une seule colonne perdrait la provenance a chaque reglage du bareme.
ALTER TABLE contact ADD COLUMN score REAL
  CHECK (score IS NULL OR (score >= 0.0 AND score <= 1.0));

-- Contributions ayant fait le score, en JSON. Un score qu'on ne peut pas expliquer
-- n'est pas revisable : meme argument que 'prefiltre_motif' au lot 4, et c'est cet
-- ecran de revue que le §6.8 designe comme destinataire.
ALTER TABLE contact ADD COLUMN score_motifs TEXT;

-- Constante du code, incrementee des que le bareme change. Sans elle, un reglage
-- laisserait en base un melange indiscernable d'anciens et de nouveaux scores.
ALTER TABLE contact ADD COLUMN score_version INTEGER;

ALTER TABLE contact ADD COLUMN score_at TEXT;

-- L'ecran de revue lit les contacts les moins surs d'abord : c'est la qu'un humain
-- apporte quelque chose. L'index est partiel, un contact non score n'y figure pas.
CREATE INDEX idx_contact_score ON contact (score) WHERE score IS NOT NULL;

--------------------------------------------------------------------------------
-- Associations : classification de l'etape [7]
--------------------------------------------------------------------------------

-- 'type_classifie' et 'source_classification' existent depuis le lot 1 et n'ont
-- jamais ete renseignes. Les deux colonnes ajoutees ici sont ce qui manquait pour
-- pouvoir repondre « quels verdicts sont perimes » — meme discipline que
-- 'prefiltre_version'.
ALTER TABLE association ADD COLUMN classification_at TEXT;
ALTER TABLE association ADD COLUMN classification_version INTEGER;

CREATE INDEX idx_association_type ON association (type_classifie)
  WHERE type_classifie IS NOT NULL;

--------------------------------------------------------------------------------
-- Pages : retrouver la page d'ou vient un contact
--------------------------------------------------------------------------------

-- La notation [8] lit le verdict du pre-filtre de la page source de chaque contact.
-- Les index existants portent la campagne en tete, donc aucun ne sert une recherche
-- par URL : sans celui-ci, chaque contact declencherait un parcours complet de 'page'.
CREATE INDEX idx_page_url_commune ON page (url, code_insee);

--------------------------------------------------------------------------------
-- Domaines de messagerie : verdict MX (ADR-017)
--------------------------------------------------------------------------------

-- Le MX est un fait de **domaine**, jamais d'adresse : « contact@mairie-x.fr » et
-- « nimportequoi@mairie-x.fr » ont exactement le meme verdict. La table porte donc le
-- domaine en cle, et une adresse n'herite du resultat que par jointure. Nommer cette
-- colonne autrement — 'email_valide' par exemple — laisserait croire a une garantie
-- que le DNS ne donne pas : il dit que le domaine sait recevoir du courrier, pas que
-- la boite existe.
--
-- C'est une donnee collectee, elle porte donc sa provenance en NOT NULL comme partout
-- ailleurs (invariant 5) : la methode dit d'ou vient le verdict, verifie_at quand.
CREATE TABLE domaine_mail (
  domaine    TEXT PRIMARY KEY,
  -- 1 le domaine annonce un MX, 0 il n'en annonce pas, NULL la resolution a echoue.
  -- Les trois cas different : une panne de resolveur n'est pas une absence de MX, et
  -- les confondre condamnerait un domaine sur un incident reseau passager.
  mx         INTEGER CHECK (mx IS NULL OR mx IN (0, 1)),
  -- Hotes annonces, du plus prioritaire au moins. Conserves pour que le verdict soit
  -- verifiable a la main par qui en douterait.
  mx_hotes   TEXT,
  methode    TEXT NOT NULL,
  verifie_at TEXT NOT NULL,
  erreur     TEXT
) STRICT;

-- Sert la purge a trois ans et la fenetre de fraicheur : un verdict MX vieillit, le
-- domaine d'une association peut expirer entre deux campagnes.
CREATE INDEX idx_domaine_mail_verifie_at ON domaine_mail (verifie_at);
`,
  },
  {
    version: 6,
    name: "revue-humaine",
    sql: `
--------------------------------------------------------------------------------
-- Revue humaine : la correction d'un contact
--------------------------------------------------------------------------------

-- 'review_statut' porte 'corrige' depuis le lot 1, mais rien n'a jamais eu ou ranger la
-- correction. C'est cette colonne qui manquait.
--
-- 'valeur' n'est **jamais** reecrite : c'est ce qui a ete lu sur la page, donc de la
-- provenance au sens de l'invariant 5. La saisie humaine vit a cote, et l'export sort
-- les deux — celle qui se publie et celle d'ou elle vient.
ALTER TABLE contact ADD COLUMN valeur_corrigee TEXT;

-- Quand l'arbitrage a eu lieu. Sans elle, un statut de revue est une affirmation sans
-- date, et la purge a trois ans n'aurait rien a mordre.
ALTER TABLE contact ADD COLUMN review_at TEXT;

-- Un contact 'corrige' sans valeur corrigee est une contradiction : le statut dit qu'un
-- humain a reecrit la valeur, et il n'y en a pas. SQLite ne sait pas ajouter un CHECK de
-- table par ALTER ; le trigger tient la meme promesse au meme endroit — l'incoherence
-- echoue en base, pas dans un test du serveur HTTP. Meme logique que les UNIQUE du lot 1.
CREATE TRIGGER contact_correction_exige_valeur_insert
BEFORE INSERT ON contact
WHEN NEW.review_statut = 'corrige' AND NEW.valeur_corrigee IS NULL
BEGIN
  SELECT RAISE(ABORT, 'un contact corrige doit porter sa valeur corrigee');
END;

CREATE TRIGGER contact_correction_exige_valeur_update
BEFORE UPDATE OF review_statut, valeur_corrigee ON contact
WHEN NEW.review_statut = 'corrige' AND NEW.valeur_corrigee IS NULL
BEGIN
  SELECT RAISE(ABORT, 'un contact corrige doit porter sa valeur corrigee');
END;

-- L'ecran de revue tire sa file d'ici : les contacts a arbitrer, les moins surs d'abord.
-- L'index de score du lot 5 porte le score en tete et ne sert pas ce filtre.
CREATE INDEX idx_contact_a_revoir
  ON contact (review_statut, score)
  WHERE review_statut = 'a_revoir';
`,
  },
  {
    version: 7,
    name: "phase-du-run",
    sql: `
--------------------------------------------------------------------------------
-- Phase du run : ou en est l'entonnoir
--------------------------------------------------------------------------------

-- Le lot 8 permet de lancer un run depuis l'interface (ADR-024), donc de le suivre
-- depuis un ecran qui ne voit pas la console. Restait a savoir *quoi* montrer : la file
-- de jobs dit combien il reste a faire, pas dans laquelle des trois passes on se trouve.
--
-- Cette colonne est ecrite par executerRun a chaque transition, et remise a NULL a la
-- fin. Elle est persistee plutot que gardee en memoire par l'interface pour deux
-- raisons : un run lance dans un terminal doit s'afficher pareil, et l'information doit
-- survivre au redemarrage de l'interface. Pas de CHECK : une phase inconnue apres une
-- mise a jour vaut mieux qu'un run qui echoue a s'annoncer.
ALTER TABLE run ADD COLUMN phase TEXT;
`,
  },
  {
    version: 8,
    name: "provenance-complete-de-la-commune",
    sql: `
--------------------------------------------------------------------------------
-- Provenance de la resolution : les quatre elements, pas deux
--------------------------------------------------------------------------------

-- Les triggers de la migration 2 ne controlaient que l'URL source et l'horodatage.
-- L'invariant 5 en demande quatre : « URL source, horodatage, methode d'extraction,
-- score de confiance ». La methode (source_resolution) et le score (resolution_confiance)
-- existaient en colonnes, et le code les renseignait toujours — mais par discipline
-- applicative, ce que le CLAUDE.md interdit explicitement pour cet invariant : c'est la
-- base qui doit refuser, pas l'applicatif qui doit penser.
--
-- Un trigger se remplace ; la migration 2 n'est pas touchee, et une base deja migree
-- recoit simplement la version complete.

DROP TRIGGER commune_resolution_provenance_insert;
DROP TRIGGER commune_resolution_provenance_update;

CREATE TRIGGER commune_resolution_provenance_insert
BEFORE INSERT ON commune
WHEN NEW.statut_resolution = 'resolue'
 AND (NEW.url_mairie IS NULL
   OR NEW.resolution_source_url IS NULL
   OR NEW.resolution_collected_at IS NULL
   OR NEW.source_resolution IS NULL
   OR NEW.resolution_confiance IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'commune resolue sans provenance complete');
END;

CREATE TRIGGER commune_resolution_provenance_update
BEFORE UPDATE ON commune
WHEN NEW.statut_resolution = 'resolue'
 AND (NEW.url_mairie IS NULL
   OR NEW.resolution_source_url IS NULL
   OR NEW.resolution_collected_at IS NULL
   OR NEW.source_resolution IS NULL
   OR NEW.resolution_confiance IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'commune resolue sans provenance complete');
END;
`,
  },
  {
    version: 9,
    name: "url-finale-de-la-page",
    sql: `
--------------------------------------------------------------------------------
-- L'URL reellement atteinte, distincte de celle qui a ete demandee
--------------------------------------------------------------------------------

-- La provenance d'un contact (§4.5) doit nommer la page qui porte la donnee, donc l'URL
-- d'arrivee et non celle de depart : apres redirection, la premiere ne contient rien de
-- ce qu'on lui attribue. Mais \`page.url\` est la cle de planification — elle porte
-- l'index unique par campagne, et c'est elle qui rend le crawl reprenable —, elle ne
-- peut donc pas changer de sens.
--
-- D'ou cette colonne. Elle vaut \`url\` quand il n'y a pas eu de redirection, et la
-- normalisation joint desormais sur \`coalesce(final_url, url)\` : les lignes ecrites
-- avant cette migration continuent de se rattacher par \`url\`, sans reprise de donnees.
ALTER TABLE page ADD COLUMN final_url TEXT;
`,
  },
  {
    version: 10,
    name: "liste-d-exclusion",
    sql: `
--------------------------------------------------------------------------------
-- Droit d'opposition et d'effacement : ce qui ne doit plus jamais entrer
--------------------------------------------------------------------------------

-- L'outil produit un fichier de donnees personnelles collectees indirectement. Son
-- utilisateur est responsable de traitement, et devra honorer des demandes d'opposition
-- (art. 21) et d'effacement (art. 17). Jusqu'ici il ne le pouvait pas : « rejeter » en
-- revue n'ecrit qu'un \`review_statut\`, que l'option \`--avec-rejetes\` remet dans le CSV,
-- et le run suivant recollecte l'adresse.
--
-- D'ou cette table, et non une simple suppression. Supprimer une ligne ne survit pas a
-- la campagne suivante : sans trace de l'opposition, le crawl la retrouve et la reecrit.
-- L'exclusion est donc l'objet durable, et la suppression n'en est que la consequence
-- immediate.
--
-- Ce n'est pas une liste noire de collecte : elle ne dit pas ou l'outil a le droit
-- d'aller — robots.txt seul en decide (§4.2) — mais ce qu'il n'a pas le droit de
-- **retenir**. Voir docs/adr/026-droit-a-l-effacement.md.

CREATE TABLE exclusion (
  id         INTEGER PRIMARY KEY,
  -- 'contact' : une valeur normalisee precise. 'domaine' : tout ce qui vient d'un
  -- domaine de messagerie. 'commune' : tout ce qui est rattache a un code INSEE.
  portee     TEXT NOT NULL CHECK (portee IN ('contact', 'domaine', 'commune')),
  valeur     TEXT NOT NULL,
  -- Le motif est obligatoire : un responsable de traitement doit pouvoir dire au nom de
  -- quoi il a efface, et le prouver.
  motif      TEXT NOT NULL,
  origine    TEXT NOT NULL CHECK (origine IN ('cli', 'revue')),
  created_at TEXT NOT NULL,
  UNIQUE (portee, valeur)
) STRICT;

-- La consultation a lieu a chaque ecriture de contact : elle doit etre gratuite.
CREATE INDEX idx_exclusion_portee_valeur ON exclusion (portee, valeur);
`,
  },
];
