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
import { messageDe } from "../log.ts";
import type { Logger } from "../log.ts";

/** Ecoute imposee. Voir l'en-tete : ce n'est pas un defaut, c'est une contrainte. */
export const ADRESSE_ECOUTE = "127.0.0.1";

/**
 * Le nom montre a l'utilisateur. **L'ecoute ne bouge pas** — c'est `localhost` qui resout
 * vers elle, et `hoteAccepte` l'admet deja au meme titre que l'adresse numerique.
 *
 * Pourquoi pas un nom plus joli, `annuaire:8787` : il faudrait une ligne dans le fichier
 * `hosts`, donc des droits d'administrateur, sur un outil vendu « rien a installer ». Et
 * `https://` demanderait un certificat, donc un auto-signe et un avertissement de plus.
 *
 * L'adresse numerique reste imprimee a cote : sur un poste ou `localhost` resout d'abord
 * vers `::1`, le navigateur ne trouverait personne — nous n'ecoutons qu'en IPv4.
 */
export const NOM_LOCAL = "localhost";

/** Un formulaire de revue tient en quelques centaines d'octets. */
const CORPS_MAX = 64 * 1024;

export type ServeurUi = {
  port: number;
  jeton: string;
  /** Adresse a montrer et a ouvrir : `localhost`, plus lisible qu'une adresse numerique. */
  url: string;
  /** La meme, en IPv4 littérale — secours si `localhost` resout vers `::1`. */
  urlNumerique: string;
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
  pilote: ContexteUi["pilote"];
  reglages: ContexteUi["reglages"];
  supprimerCache: ContexteUi["supprimerCache"];
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
    pilote: options.pilote,
    reglages: options.reglages,
    supprimerCache: options.supprimerCache,
  };

  const serveur = createServer((req, res) => {
    traiter(ctx, options.logger, req, res).catch((cause: unknown) => {
      // Un client parti n'est pas une panne, et surtout : la reponse est deja engagee,
      // ecrire un 500 par-dessus n'irait nulle part et ferait du bruit dans le journal.
      if (cause instanceof ClientParti) return;
      options.logger?.error("Echec du rendu d'un ecran", { erreur: messageDe(cause) });
      if (res.writableEnded) return;
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
        url: `http://${NOM_LOCAL}:${port}/?jeton=${jeton}`,
        urlNumerique: `http://${ADRESSE_ECOUTE}:${port}/?jeton=${jeton}`,
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
    if (!res.write(morceau)) await attendreDrain(res);
  }
  res.end();
}

/**
 * Attend que le tampon se vide — **ou que le client s'en aille**.
 *
 * Sans les deux ecouteurs de sortie, un onglet ferme pendant un export volumineux
 * detruisait la socket : `write` rendait `false`, `drain` n'arrivait jamais, et la
 * promesse ne se reglait plus. Le generateur, la requete et la reponse restaient en
 * suspens pour la duree du process, un jeu de plus a chaque export interrompu. Un
 * `'error'` sans ecouteur etait par ailleurs une exception non attrapee.
 */
function attendreDrain(res: ServerResponse): Promise<void> {
  return new Promise<void>((resoudre, rejeter) => {
    const finir = (erreur?: Error) => {
      res.off("drain", surDrain);
      res.off("close", surFermeture);
      res.off("error", surErreur);
      if (erreur === undefined) resoudre();
      else rejeter(erreur);
    };
    const surDrain = () => finir();
    const surFermeture = () => finir(new ClientParti());
    const surErreur = (erreur: Error) => finir(erreur);
    res.once("drain", surDrain);
    res.once("close", surFermeture);
    res.once("error", surErreur);
  });
}

/** Le client a ferme avant la fin : ce n'est pas une panne, il n'y a rien a signaler. */
export class ClientParti extends Error {
  constructor() {
    super("Le client a ferme la connexion avant la fin de la reponse.");
    this.name = "ClientParti";
  }
}
