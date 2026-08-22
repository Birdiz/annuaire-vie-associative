/**
 * Porte d'**entree** de l'application — le pendant de `src/http/`, qui en est la porte
 * de sortie.
 *
 * C'est le seul module autorise a importer `node:http`, et un test d'architecture le
 * verifie en meme temps qu'il verifie qu'il n'appelle jamais `request` ni `get` : ce
 * fichier peut ecouter, il ne peut pas appeler. La regle de la porte de sortie vise le
 * trafic **sortant** — robots.txt, le delai de deux secondes et le User-Agent n'ont de
 * sens que pour ce qui part de la machine. Un serveur qui ecoute sur la boucle locale
 * n'en releve pas, mais il ne doit pas devenir un client par la bande.
 *
 * **127.0.0.1, sans option pour en changer.** Une UI qui ecouterait sur `0.0.0.0`
 * exposerait au reseau local une base de donnees personnelles et une commande d'ecriture.
 * L'adresse d'ecoute n'est donc pas un reglage : c'est le corollaire direct du
 * local-first, au meme titre que les invariants absents du fichier de configuration.
 *
 * Tout le reste — routage, garde-fous, rendu — vit dans `routes.ts`, et se teste sans
 * ouvrir de port.
 */

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { router, verifierAcces } from "./routes.ts";
import type { ContexteUi, ReponseUi, RequeteUi } from "./routes.ts";
import type { Logger } from "../log.ts";

/** Ecoute imposee. Voir l'en-tete : ce n'est pas un defaut, c'est une contrainte. */
export const ADRESSE_ECOUTE = "127.0.0.1";

/** Un formulaire de revue tient en quelques centaines d'octets. */
const CORPS_MAX = 64 * 1024;

export type ServeurUi = {
  port: number;
  jeton: string;
  url: string;
  fermer(): Promise<void>;
};

export type OptionsServeur = {
  port: number;
  db: ContexteUi["db"];
  queue: ContexteUi["queue"];
  counters: ContexteUi["counters"];
  clock: ContexteUi["clock"];
  version: string;
  departementSecours: string;
  logger?: Logger | undefined;
};

export function nouveauJeton(): string {
  return randomBytes(24).toString("base64url");
}

export function demarrerServeur(options: OptionsServeur): Promise<ServeurUi> {
  const jeton = nouveauJeton();

  // Le port n'est connu qu'apres l'ecoute quand on demande 0 : le contexte le lira ici,
  // et la verification de l'en-tete Host s'appuie dessus.
  let port = options.port;
  const ctx: ContexteUi = {
    db: options.db,
    queue: options.queue,
    counters: options.counters,
    clock: options.clock,
    jeton,
    get port() {
      return port;
    },
    version: options.version,
    departementSecours: options.departementSecours,
  };

  const serveur = createServer((req, res) => {
    traiter(ctx, options.logger, req, res).catch((cause: unknown) => {
      options.logger?.error("Echec du rendu d'un ecran", { erreur: (cause as Error).message });
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Erreur interne.\n");
    });
  });

  return new Promise<ServeurUi>((resoudre, rejeter) => {
    serveur.once("error", rejeter);
    serveur.listen(options.port, ADRESSE_ECOUTE, () => {
      serveur.removeListener("error", rejeter);
      const adresse = serveur.address();
      port = typeof adresse === "object" && adresse !== null ? adresse.port : options.port;
      resoudre({
        port,
        jeton,
        url: `http://${ADRESSE_ECOUTE}:${port}/?jeton=${jeton}`,
        fermer: () => fermer(serveur),
      });
    });
  });
}

function fermer(serveur: Server): Promise<void> {
  return new Promise((resoudre) => {
    serveur.closeAllConnections();
    serveur.close(() => resoudre());
  });
}

async function traiter(
  ctx: ContexteUi,
  logger: Logger | undefined,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${ADRESSE_ECOUTE}`);
  const requete: RequeteUi = {
    methode: req.method ?? "GET",
    chemin: url.pathname,
    requete: url.searchParams,
    entetes: entetesUtiles(req),
    corps: req.method === "POST" ? await lireCorps(req) : "",
  };

  const refus = verifierAcces(ctx, requete);
  const reponse = refus ?? router(ctx, requete);
  logger?.debug("UI", { methode: requete.methode, chemin: requete.chemin, statut: reponse.statut });
  await ecrire(res, reponse);
}

/** Seuls les en-tetes dont le routage se sert traversent : le reste ne le regarde pas. */
function entetesUtiles(req: IncomingMessage): Record<string, string | undefined> {
  const lire = (nom: string): string | undefined => {
    const valeur = req.headers[nom];
    return Array.isArray(valeur) ? valeur[0] : valeur;
  };
  return {
    host: lire("host"),
    cookie: lire("cookie"),
    "sec-fetch-site": lire("sec-fetch-site"),
    "hx-request": lire("hx-request"),
  };
}

function lireCorps(req: IncomingMessage): Promise<string> {
  return new Promise((resoudre, rejeter) => {
    const morceaux: Buffer[] = [];
    let taille = 0;
    req.on("data", (morceau: Buffer) => {
      taille += morceau.length;
      if (taille > CORPS_MAX) {
        req.destroy();
        rejeter(new Error("Corps de requete trop volumineux."));
        return;
      }
      morceaux.push(morceau);
    });
    req.on("end", () => resoudre(Buffer.concat(morceaux).toString("utf8")));
    req.on("error", rejeter);
  });
}

/**
 * L'export CSV arrive ici sous forme de generateur : il est ecrit morceau par morceau,
 * avec pause quand le tampon est plein. Un departement tient en memoire, la France
 * entiere non, et le §1 demande que le pipeline reste correct a cette echelle.
 */
async function ecrire(res: ServerResponse, reponse: ReponseUi): Promise<void> {
  res.writeHead(reponse.statut, reponse.entetes);

  const corps = reponse.corps;
  if (typeof corps === "string" || corps instanceof Uint8Array) {
    res.end(corps);
    return;
  }

  for (const morceau of corps) {
    if (!res.write(morceau)) {
      await new Promise<void>((resoudre) => res.once("drain", resoudre));
    }
  }
  res.end();
}
