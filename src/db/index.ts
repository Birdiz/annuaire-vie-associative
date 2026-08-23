import { DatabaseSync } from "node:sqlite";
import type { StatementSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { MIGRATIONS } from "./migrations.ts";
import type { Migration } from "./migrations.ts";
import { toIso } from "../clock.ts";
import type { Clock } from "../clock.ts";
import { systemClock } from "../clock.ts";
import { messageDe } from "../log.ts";

export type Database = DatabaseSync;
/** Ordre prepare, reutilisable : `node:sqlite` n'en garde aucun cache. */
export type Ordre = StatementSync;

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

/**
 * Ouvre la base et applique les migrations en attente.
 *
 * WAL : un lecteur (l'UI) et un ecrivain (le worker) coexistent dans le meme process
 * sans se bloquer. busy_timeout couvre les contentions courtes plutot que de faire
 * remonter un SQLITE_BUSY jusqu'a l'appelant.
 */
export function openDatabase(dbFile: string, clock: Clock = systemClock): Database {
  const db = new DatabaseSync(dbFile);
  // `busy_timeout` en premier : le passage en WAL prend lui-meme un verrou, et se heurte
  // donc a une autre connexion deja ouverte. Le poser apres laissait ce cas remonter en
  // SQLITE_BUSY immediat.
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA synchronous = NORMAL");
  migrate(db, clock);
  return db;
}

export function checksum(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}


export function migrate(db: Database, clock: Clock = systemClock, migrations: readonly Migration[] = MIGRATIONS): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      checksum   TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT
  `);

  let count = 0;
  for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
    const expected = checksum(migration.sql);

    // L'etat applique est relu **sous le verrou d'ecriture**, migration par migration.
    // Le lire une fois avant la boucle ouvrait une course : `annuaire ui` et
    // `annuaire run` lances ensemble sur une base neuve voyaient tous deux une table
    // vide, et le perdant reappliquait une migration deja faite — « table already
    // exists », donc un demarrage refuse sur un message incomprehensible.
    db.exec("BEGIN IMMEDIATE");
    const seen = (
      db
        .prepare("SELECT checksum FROM schema_migrations WHERE version = ?")
        .get(migration.version) as { checksum?: string } | undefined
    )?.checksum;

    if (seen !== undefined) {
      annulerSansMasquer(db);
      // Une migration deja appliquee qui a change en cours de route signifie que la
      // base et le code ne decrivent plus le meme schema. Refuser de demarrer vaut
      // mieux qu'ecrire dans une structure qu'on croit connaitre.
      if (seen !== expected) {
        throw new MigrationError(
          `La migration ${migration.version} (${migration.name}) a change apres avoir ete appliquee. ` +
            "Une migration appliquee ne se modifie jamais : ajoutez-en une nouvelle.",
        );
      }
      continue;
    }

    try {
      db.exec(migration.sql);
      db.prepare(
        "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
      ).run(migration.version, migration.name, expected, toIso(clock.now()));
      db.exec("COMMIT");
    } catch (cause) {
      annulerSansMasquer(db);
      throw new MigrationError(
        `Echec de la migration ${migration.version} (${migration.name}) : ${messageDe(cause)}`,
      );
    }
    count += 1;
  }

  return count;
}

/**
 * Execute `fn` dans une transaction. Sert surtout a garantir qu'un effet et le
 * compteur qui le mesure sont commites ensemble (§8).
 */
export function transaction<T>(db: Database, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (cause) {
    annulerSansMasquer(db);
    throw cause;
  }
}

/**
 * Annule la transaction en cours, s'il y en a une.
 *
 * SQLite annule lui-meme sur certaines erreurs — `SQLITE_FULL`, `SQLITE_IOERR`. Le
 * `ROLLBACK` leve alors « cannot rollback - no transaction is active », et cette seconde
 * erreur remplacait la premiere : on perdait la cause exacte au moment ou elle etait la
 * plus utile.
 */
function annulerSansMasquer(db: Database): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // Deja annulee par SQLite : c'est le resultat voulu.
  }
}
