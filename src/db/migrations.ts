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
];
