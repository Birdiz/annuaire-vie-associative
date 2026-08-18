/**
 * Contexte et payloads des jobs de decouverte.
 *
 * Le budget de pages et le drapeau des mobiles voyagent dans le payload plutot que
 * dans la configuration : ils s'appliquent a un travail precis, ils doivent donc etre
 * persistes avec lui. Apres un `kill -9`, la reprise retrouve les memes reglages que
 * ceux sous lesquels le crawl avait commence.
 */

import { createHash } from "node:crypto";

import type { Clock } from "../clock.ts";
import type { Database } from "../db/index.ts";
import type { HttpClient } from "../http/client.ts";
import type { JobQueue } from "../jobs/queue.ts";
import type { Logger } from "../log.ts";
import type { Counters } from "../metrics/counters.ts";

export type ContexteDecouverte = {
  db: Database;
  client: HttpClient;
  counters: Counters;
  clock: Clock;
  logger: Logger;
  queue: JobQueue;
  runId: number | null;
};

export type PayloadDecouverte = {
  departement: string;
  campagne: string;
  maxPages: number;
  avecMobiles: boolean;
};

export type PayloadPage = {
  codeInsee: string;
  url: string;
  campagne: string;
  profondeur: number;
  maxPages: number;
  avecMobiles: boolean;
};

/**
 * Identifie un passage. Le jour suffit : deux lancements le meme jour sur le meme
 * departement sont la meme campagne, et c'est precisement ce qui fait qu'une reprise
 * ne recommence pas le travail deja fait.
 */
export function campagneDuJour(maintenantMs: number): string {
  return new Date(maintenantMs).toISOString().slice(0, 10);
}

/**
 * Cle primaire d'une page. Elle porte la campagne et la commune, sans quoi deux
 * communes partageant un site — courant apres une fusion de communes — se
 * disputeraient une seule ligne, et la seconde n'aurait aucune page.
 */
export function hashPage(campagne: string, codeInsee: string, url: string): string {
  return createHash("sha256").update(`${campagne}\n${codeInsee}\n${url}`).digest("hex");
}

export function cleDecouverte(departement: string, campagne: string): string {
  return `decouverte:${departement}:${campagne}`;
}

export function clePage(hash: string): string {
  return `page:${hash}`;
}

/** Les liens les mieux scores doivent etre pris en premier : le budget est fini. */
export function prioriteDeScore(score: number): number {
  return Math.max(1, Math.min(200, 100 - Math.round(score * 4)));
}

export function lirePayloadDecouverte(payload: unknown): PayloadDecouverte | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const brut = payload as Record<string, unknown>;
  const departement = brut["departement"];
  const campagne = brut["campagne"];
  if (typeof departement !== "string" || departement === "") return undefined;
  if (typeof campagne !== "string" || campagne === "") return undefined;
  return {
    departement,
    campagne,
    maxPages: entierPositif(brut["maxPages"]) ?? 0,
    avecMobiles: brut["avecMobiles"] === true,
  };
}

export function lirePayloadPage(payload: unknown): PayloadPage | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const brut = payload as Record<string, unknown>;
  const codeInsee = brut["codeInsee"];
  const url = brut["url"];
  const campagne = brut["campagne"];
  if (typeof codeInsee !== "string" || codeInsee === "") return undefined;
  if (typeof url !== "string" || url === "") return undefined;
  if (typeof campagne !== "string" || campagne === "") return undefined;
  return {
    codeInsee,
    url,
    campagne,
    profondeur: entierPositif(brut["profondeur"]) ?? 0,
    maxPages: entierPositif(brut["maxPages"]) ?? 0,
    avecMobiles: brut["avecMobiles"] === true,
  };
}

function entierPositif(valeur: unknown): number | undefined {
  if (typeof valeur !== "number" || !Number.isFinite(valeur) || valeur < 0) return undefined;
  return Math.floor(valeur);
}
