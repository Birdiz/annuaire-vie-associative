import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { MIGRATIONS } from "./migrations.ts";
import type { Migration } from "./migrations.ts";
import { toIso } from "../clock.ts";
import type { Clock } from "../clock.ts";
import { systemClock } from "../clock.ts";

export type Database = DatabaseSync;

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
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA synchronous = NORMAL");
  migrate(db, clock);
  return db;
}

export function checksum(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

type AppliedRow = { version: number; checksum: string };

export function migrate(db: Database, clock: Clock = systemClock, migrations: readonly Migration[] = MIGRATIONS): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      checksum   TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT
  `);

  const applied = new Map<number, string>();
  for (const row of db.prepare("SELECT version, checksum FROM schema_migrations").all() as AppliedRow[]) {
    applied.set(row.version, row.checksum);
  }

  let count = 0;
  for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
    const expected = checksum(migration.sql);
    const seen = applied.get(migration.version);

    if (seen !== undefined) {
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

    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migration.sql);
      db.prepare(
        "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
      ).run(migration.version, migration.name, expected, toIso(clock.now()));
      db.exec("COMMIT");
    } catch (cause) {
      db.exec("ROLLBACK");
      throw new MigrationError(
        `Echec de la migration ${migration.version} (${migration.name}) : ${(cause as Error).message}`,
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
    db.exec("ROLLBACK");
    throw cause;
  }
}
