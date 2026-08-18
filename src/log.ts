import { appendFileSync } from "node:fs";
import { toIso } from "./clock.ts";
import type { Clock } from "./clock.ts";
import { systemClock } from "./clock.ts";

/**
 * Journalisation structuree.
 *
 * JSON par ligne dans le fichier, texte lisible sur la console. Les deux portent le
 * meme contexte (`run_id`, `job_id`), sans quoi un incident dans un run de plusieurs
 * heures est impossible a reconstituer.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDRE: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LoggerOptions = {
  file?: string | undefined;
  level?: LogLevel;
  console?: boolean;
  clock?: Clock;
  context?: Record<string, unknown>;
};

export class Logger {
  readonly #file: string | undefined;
  readonly #level: LogLevel;
  readonly #console: boolean;
  readonly #clock: Clock;
  readonly #context: Record<string, unknown>;

  constructor(options: LoggerOptions = {}) {
    this.#file = options.file;
    this.#level = options.level ?? "info";
    this.#console = options.console ?? true;
    this.#clock = options.clock ?? systemClock;
    this.#context = options.context ?? {};
  }

  /** Derive un journal portant un contexte supplementaire. */
  child(context: Record<string, unknown>): Logger {
    return new Logger({
      file: this.#file,
      level: this.#level,
      console: this.#console,
      clock: this.#clock,
      context: { ...this.#context, ...context },
    });
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.#write("debug", message, fields);
  }
  info(message: string, fields?: Record<string, unknown>): void {
    this.#write("info", message, fields);
  }
  warn(message: string, fields?: Record<string, unknown>): void {
    this.#write("warn", message, fields);
  }
  error(message: string, fields?: Record<string, unknown>): void {
    this.#write("error", message, fields);
  }

  #write(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (ORDRE[level] < ORDRE[this.#level]) return;

    const entry = { ts: toIso(this.#clock.now()), level, message, ...this.#context, ...fields };

    if (this.#file !== undefined) {
      try {
        appendFileSync(this.#file, `${JSON.stringify(entry)}\n`, "utf8");
      } catch {
        // Un journal qui ne peut pas s'ecrire ne doit pas interrompre une collecte.
      }
    }

    if (this.#console) {
      const stream = ORDRE[level] >= ORDRE.warn ? process.stderr : process.stdout;
      const suffixe = formatFields({ ...this.#context, ...fields });
      stream.write(`${level.padEnd(5)} ${message}${suffixe}\n`);
    }
  }
}

function formatFields(fields: Record<string, unknown>): string {
  const parts = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`);
  return parts.length === 0 ? "" : `  ${parts.join(" ")}`;
}
