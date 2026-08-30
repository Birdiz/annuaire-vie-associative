/**
 * Routage et garde-fous de l'UI, sans socket.
 *
 * Tout ce qui decide vit ici et prend une requete decrite par un objet ordinaire : les
 * refus — hote inattendu, jeton absent, requete croisee — se testent alors sans ouvrir
 * de port. `serveur.ts` ne fait plus que de l'entree-sortie.
 *
 * **Le jeton.** Un serveur local n'est pas un serveur inoffensif : n'importe quelle page
 * ouverte par ailleurs dans le meme navigateur peut adresser `127.0.0.1`. L'outil tient
 * des donnees personnelles et sait ecrire en base ; il ne se contente donc pas d'ecouter
 * sur la boucle locale. Le jeton est tire a chaque demarrage, imprime par la CLI, et
 * echange contre un cookie `SameSite=Strict` des la premiere page.
 *
 * **L'hote.** Verifier `Host` ferme le rebinding DNS : sans lui, un nom controle par un
 * tiers qui resout vers 127.0.0.1 suffirait a faire porter les requetes du navigateur
 * sur cette base.
 */

import { timingSafeEqual } from "node:crypto";
import type { Database } from "../db/index.ts";
import type { JobQueue } from "../jobs/queue.ts";
import type { Counters } from "../metrics/counters.ts";
import type { Clock } from "../clock.ts";
import { lireAsset } from "./assets.ts";
import { page } from "./rendu.ts";
import type { EtatCollecte } from "./rendu.ts";
import {
  departementParDefaut,
  departementsConnus,
  distributionRevue,
  fileRevue,
  runsRecents,
} from "./requetes.ts";
import { arbitrer, estActionRevue } from "./revue.ts";
import { ecranSynthese, fragmentSuivi, fragmentReglages, fragmentChiffres } from "./vues/synthese.ts";
import type { DonneesSuivi, DonneesReglages, DonneesSynthese } from "./vues/synthese.ts";
import type { SurfacePilote } from "./pilote.ts";
import { ecranRevue, fragmentFile } from "./vues/revue.ts";
import { ecranExport } from "./vues/export.ts";
import { derniereCampagne, distributionPrefiltre } from "../decouverte/rejeu.ts";
import { distributionNormalisation } from "../normalisation/rejeu.ts";
import { mesurerCouverture } from "../metrics/couverture.ts";
import { mesurerDormance } from "../metrics/dormance.ts";
import { compterLignes, lignesCsv } from "../export/csv.ts";

export const NOM_COOKIE = "annuaire_jeton";

/** Contacts affiches d'un coup dans la file de revue. */
export const TAILLE_FILE = 10;

export type RequeteUi = {
  methode: string;
  chemin: string;
  requete: URLSearchParams;
  entetes: Record<string, string | undefined>;
  corps: string;
};

export type ReponseUi = {
  statut: number;
  entetes: Record<string, string>;
  /** Une chaine, un binaire, ou un flux de morceaux pour l'export. */
  corps: string | Uint8Array | Iterable<string>;
};

export type ContexteUi = {
  db: Database;
  queue: JobQueue;
  counters: Counters;
  clock: Clock;
  jeton: string;
  port: number;
  version: string;
  /** Departement affiche quand la base n'en connait aucun. */
  departementSecours: string;
  /**
   * Le run que cette interface pilote (ADR-024). Le worker tourne dans ce process : le
   * routeur ne fait que demander, il n'attend jamais — un run dure des minutes.
   */
  pilote: SurfacePilote;
  /** L'URL de contact du §4.4, lue et ecrite depuis l'ecran. */
  reglages: SurfaceReglages;
  /**
   * Efface une entree du cache HTTP, designee par le chemin relatif de `page.cache_path`.
   * Sert a l'oubli : le cache garde le HTML brut, donc la donnee elle-meme.
   */
  supprimerCache: (cheminRelatif: string) => boolean;
};

export type SurfaceReglages = {
  contactUrl(): string | undefined;
  /** Vrai quand la variable d'environnement l'emporte : le fichier n'y peut rien. */
  parEnvironnement(): boolean;
  enregistrer(valeur: string): { url: string } | { erreur: string };
};

/**
 * `default-src 'self'` suffit : htmx est servi depuis cette origine et l'UI n'ecrit
 * aucun script en ligne — c'est pour cela que le selecteur de departement porte un
 * bouton plutot qu'un `onchange`. `no-referrer` evite qu'un clic sur l'URL source d'un
 * contact annonce a la mairie visitee l'adresse de l'ecran de revue.
 */
const ENTETES_COMMUNES: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
};

function html(corps: string, statut = 200): ReponseUi {
  return {
    statut,
    entetes: { ...ENTETES_COMMUNES, "Content-Type": "text/html; charset=utf-8" },
    corps,
  };
}

function texte(corps: string, statut: number): ReponseUi {
  return {
    statut,
    entetes: { ...ENTETES_COMMUNES, "Content-Type": "text/plain; charset=utf-8" },
    corps,
  };
}

function redirection(vers: string, entetes: Record<string, string> = {}): ReponseUi {
  return { statut: 303, entetes: { ...ENTETES_COMMUNES, ...entetes, Location: vers }, corps: "" };
}

function comparerJetons(attendu: string, recu: string): boolean {
  const a = Buffer.from(attendu, "utf8");
  const b = Buffer.from(recu, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function lireCookie(entete: string | undefined, nom: string): string | undefined {
  if (entete === undefined) return undefined;
  for (const morceau of entete.split(";")) {
    const separateur = morceau.indexOf("=");
    if (separateur === -1) continue;
    if (morceau.slice(0, separateur).trim() === nom) return morceau.slice(separateur + 1).trim();
  }
  return undefined;
}

const HOTES_LOCAUX = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function hoteAccepte(host: string | undefined, port: number): boolean {
  if (host === undefined) return false;
  const separateur = host.lastIndexOf(":");
  const nom = separateur === -1 || host.endsWith("]") ? host : host.slice(0, separateur);
  const portRecu = separateur === -1 || host.endsWith("]") ? "" : host.slice(separateur + 1);
  return HOTES_LOCAUX.has(nom) && portRecu === String(port);
}

/**
 * Rend une reponse quand l'acces doit etre refuse, `undefined` quand il peut continuer.
 * Le cas particulier du jeton passe en query est traite ici : il est echange contre un
 * cookie, puis l'URL est nettoyee — le jeton ne doit pas rester dans la barre d'adresse
 * ni dans l'historique.
 */
export function verifierAcces(ctx: ContexteUi, requete: RequeteUi): ReponseUi | undefined {
  if (!hoteAccepte(requete.entetes["host"], ctx.port)) {
    return texte(
      "Hote inattendu. Ce serveur ne repond qu'a 127.0.0.1 et localhost sur son propre port.\n",
      403,
    );
  }

  const parCookie = lireCookie(requete.entetes["cookie"], NOM_COOKIE);
  if (parCookie !== undefined && comparerJetons(ctx.jeton, parCookie)) {
    // Une requete d'ecriture venue d'une autre origine n'a rien a faire ici. L'en-tete
    // manque sur les navigateurs anciens : le cookie SameSite=Strict tient alors seul.
    const provenance = requete.entetes["sec-fetch-site"];
    if (requete.methode === "POST" && provenance !== undefined && provenance !== "same-origin") {
      return texte("Requete croisee refusee.\n", 403);
    }
    return undefined;
  }

  const parUrl = requete.requete.get("jeton");
  if (parUrl !== null && comparerJetons(ctx.jeton, parUrl)) {
    const propre = new URLSearchParams(requete.requete);
    propre.delete("jeton");
    const suffixe = propre.size === 0 ? "" : `?${propre.toString()}`;
    return redirection(`${requete.chemin}${suffixe}`, {
      "Set-Cookie": `${NOM_COOKIE}=${ctx.jeton}; Path=/; SameSite=Strict; HttpOnly`,
    });
  }

  return texte(
    "Jeton absent ou invalide.\n\n" +
      "Ouvrez l'adresse imprimee par « annuaire ui » : elle porte le jeton tire au\n" +
      "demarrage. Il change a chaque lancement.\n",
    401,
  );
}

export function router(ctx: ContexteUi, requete: RequeteUi): ReponseUi {
  const asset = requete.chemin.startsWith("/assets/") ? requete.chemin.slice("/assets/".length) : undefined;
  if (asset !== undefined) {
    if (requete.methode !== "GET") return texte("Methode non autorisee.\n", 405);
    const fichier = lireAsset(asset);
    if (fichier === undefined) return texte("Introuvable.\n", 404);
    return {
      statut: 200,
      entetes: { ...ENTETES_COMMUNES, "Content-Type": fichier.type, "Cache-Control": "no-cache" },
      corps: fichier.corps,
    };
  }

  const departement = departementParDefaut(
    ctx.db,
    requete.requete.get("departement"),
    ctx.departementSecours,
  );
  const departements = departementsConnus(ctx.db);

  if (requete.methode === "GET" && requete.chemin === "/") {
    return html(
      page({
        titre: "Synthese",
        onglet: "synthese",
        departement,
        version: ctx.version,
        contenu: syntheseComplete(ctx, departement, departements, donneesReglages(ctx)),
      }),
    );
  }

  if (requete.methode === "GET" && requete.chemin === "/suivi") {
    return html(fragmentSuivi(donneesSuivi(ctx, departement)));
  }

  if (requete.methode === "GET" && requete.chemin === "/chiffres") {
    return html(fragmentChiffres(donneesSynthese(ctx, departement, departements, donneesReglages(ctx))));
  }

  // Lancer et arreter. Rien n'est attendu ici : le pilote rend la main aussitot, et
  // c'est le bloc de suivi — deja rafraichi toutes les deux secondes — qui rend compte.
  if (requete.methode === "POST" && requete.chemin === "/run") {
    const champs = new URLSearchParams(requete.corps);
    ctx.pilote.demarrer(champs.get("departement") ?? departement);
    return reponseSuivi(ctx, requete, departement);
  }

  if (requete.methode === "POST" && requete.chemin === "/run/arret") {
    ctx.pilote.arreter();
    return reponseSuivi(ctx, requete, departement);
  }

  if (requete.methode === "POST" && requete.chemin === "/reglages") {
    return enregistrerReglages(ctx, requete, departement, departements);
  }

  if (requete.methode === "GET" && requete.chemin === "/revue") {
    return html(
      page({
        titre: "Revue",
        onglet: "revue",
        departement,
        version: ctx.version,
        contenu: ecranRevue(donneesRevue(ctx, departement, departements, undefined)),
      }),
    );
  }

  if (requete.methode === "POST" && requete.chemin.startsWith("/revue/")) {
    return arbitrage(ctx, requete, departement, departements);
  }

  if (requete.methode === "GET" && requete.chemin === "/export") {
    const scoreMin = requete.requete.get("score-min") ?? "";
    const avecRejetes = requete.requete.get("avec-rejetes") === "1";
    const options = {
      departement,
      scoreMin: seuilTolerant(scoreMin),
      avecRejetes,
    };
    return html(
      page({
        titre: "Export",
        onglet: "export",
        departement,
        version: ctx.version,
        contenu: ecranExport({
          departement,
          departements,
          scoreMin,
          avecRejetes,
          lignes: compterLignes(ctx.db, options),
          rejetes: distributionRevue(ctx.db, departement).rejetes,
          collecte: etatCollecte(ctx),
        }),
      }),
    );
  }

  if (requete.methode === "GET" && requete.chemin === "/export.csv") {
    // Retirer le bouton ne suffit pas : l'URL du formulaire se garde en favori, et un
    // fichier telecharge pendant un run sortirait sans les contacts a venir ni le score
    // de ceux que l'etape [8] n'a pas encore vus. La CLI, elle, n'est pas bridee : qui
    // tape `annuaire exporter` sait ce qu'il demande.
    if (etatCollecte(ctx).kind === "pilote") {
      return texte(
        "Export suspendu : un run est en cours depuis cette interface.\n\n" +
          "Un fichier pris maintenant serait incomplet — les contacts a venir y manqueraient, et\n" +
          "ceux que l'etape [8] n'a pas encore notes en sortiraient sans score. Arretez le run ou\n" +
          "attendez sa fin ; rien n'est perdu entre-temps.\n",
        409,
      );
    }

    const options = {
      departement,
      scoreMin: seuilTolerant(requete.requete.get("score-min") ?? ""),
      avecRejetes: requete.requete.get("avec-rejetes") === "1",
    };
    return {
      statut: 200,
      entetes: {
        ...ENTETES_COMMUNES,
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="annuaire-${departement}.csv"`,
      },
      corps: lignesCsv(ctx.db, options),
    };
  }

  return texte("Introuvable.\n", 404);
}

/**
 * L'ecran de synthese au complet. Huit champs, ecrits deux fois a l'identique : la seule
 * chose qui variait entre les deux appels etait le bloc de reglages.
 */
function syntheseComplete(
  ctx: ContexteUi,
  departement: string,
  departements: readonly string[],
  reglages: DonneesReglages,
): string {
  return ecranSynthese(donneesSynthese(ctx, departement, departements, reglages));
}

function donneesSynthese(
  ctx: ContexteUi,
  departement: string,
  departements: readonly string[],
  reglages: DonneesReglages,
): DonneesSynthese {
  return {
    departement,
    departements,
    suivi: donneesSuivi(ctx, departement),
    reglages,
    couverture: mesurerCouverture(ctx.db, departement),
    dormance: mesurerDormance(ctx.db, departement, ctx.clock.now()),
    prefiltre: distributionDuJour(ctx, departement),
    normalisation: distributionNormalisation(ctx.db, departement),
    revue: distributionRevue(ctx.db, departement),
  };
}

/**
 * Y a-t-il une collecte en cours, et l'interface en repond-elle ?
 *
 * La distinction est ce qui autorise a barrer l'export sans risquer de le barrer pour
 * toujours : le pilote est un fait de ce process, alors qu'une ligne `run` restee « en
 * cours » peut n'etre qu'un reste de `kill -9`. On barre sur le premier, on previent sur
 * la seconde.
 */
function etatCollecte(ctx: ContexteUi): EtatCollecte {
  const pilote = ctx.pilote.etat();
  const ligne = runsRecents(ctx.db).find((run) => run.statut === "en_cours");

  if (pilote.kind === "en_cours") {
    return { kind: "pilote", departement: pilote.departement, phase: ligne?.phase ?? null };
  }
  if (ligne !== undefined) {
    return { kind: "orphelin", departement: ligne.departement, phase: ligne.phase };
  }
  return { kind: "inactif" };
}

function donneesSuivi(ctx: ContexteUi, departement: string): DonneesSuivi {
  return {
    runs: runsRecents(ctx.db),
    jobs: ctx.queue.counts(),
    departement,
    pilote: ctx.pilote.etat(),
    refus: ctx.pilote.refus(),
    collecteConfiguree: ctx.reglages.contactUrl() !== undefined,
  };
}

function donneesReglages(
  ctx: ContexteUi,
  message?: string,
  erreur?: string,
): DonneesReglages {
  return {
    contactUrl: ctx.reglages.contactUrl(),
    parEnvironnement: ctx.reglages.parEnvironnement(),
    message,
    erreur,
  };
}

function distributionDuJour(ctx: ContexteUi, departement: string) {
  const campagne = derniereCampagne(ctx.db, departement);
  return campagne === undefined ? undefined : distributionPrefiltre(ctx.db, departement, campagne);
}

function donneesRevue(
  ctx: ContexteUi,
  departement: string,
  departements: readonly string[],
  refus: string | undefined,
) {
  return {
    departement,
    departements,
    file: fileRevue(ctx.db, departement, TAILLE_FILE),
    distribution: distributionRevue(ctx.db, departement),
    refus,
    collecte: etatCollecte(ctx),
  };
}

/**
 * Reponse aux commandes de run : le fragment de suivi pour htmx, une redirection sinon
 * — sans quoi un rechargement de page relancerait la commande.
 */
function reponseSuivi(ctx: ContexteUi, requete: RequeteUi, departement: string): ReponseUi {
  if (requete.entetes["hx-request"] === "true") return html(fragmentSuivi(donneesSuivi(ctx, departement)));
  return redirection(`/?departement=${encodeURIComponent(departement)}`);
}

/**
 * L'URL de contact (§4.4). Le refus est rendu sur place, jamais renvoye dans l'URL : la
 * valeur saisie y passerait, et l'historique du navigateur la garderait.
 */
function enregistrerReglages(
  ctx: ContexteUi,
  requete: RequeteUi,
  departement: string,
  departements: readonly string[],
): ReponseUi {
  const saisie = new URLSearchParams(requete.corps).get("contactUrl") ?? "";
  const resultat = ctx.reglages.enregistrer(saisie);
  const erreur = "erreur" in resultat ? resultat.erreur : undefined;
  const message =
    erreur === undefined ? "URL de contact enregistree. La collecte peut demarrer." : undefined;

  const donnees = donneesReglages(ctx, message, erreur);
  const statut = erreur === undefined ? 200 : 422;

  if (requete.entetes["hx-request"] === "true") return html(fragmentReglages(donnees), statut);
  if (erreur === undefined) return redirection(`/?departement=${encodeURIComponent(departement)}`);
  return html(
    page({
      titre: "Synthese",
      onglet: "synthese",
      departement,
      version: ctx.version,
      contenu: syntheseComplete(ctx, departement, departements, donnees),
    }),
    statut,
  );
}

/**
 * Un arbitrage. La reponse depend de qui demande : htmx recoit la file recalculee et
 * remplace le bloc, un formulaire ordinaire est redirige — sans quoi un rechargement de
 * page rejouerait l'arbitrage. Un refus, lui, est rendu sur place dans les deux cas : le
 * faire voyager dans l'URL y ferait passer la valeur saisie.
 */
function arbitrage(
  ctx: ContexteUi,
  requete: RequeteUi,
  departement: string,
  departements: readonly string[],
): ReponseUi {
  const htmx = requete.entetes["hx-request"] === "true";
  const rendre = (refus: string | undefined, statut: number): ReponseUi => {
    const donnees = donneesRevue(ctx, departement, departements, refus);
    if (htmx) return html(fragmentFile(donnees), statut);
    return html(
      page({
        titre: "Revue",
        onglet: "revue",
        departement,
        version: ctx.version,
        contenu: ecranRevue(donnees),
      }),
      statut,
    );
  };

  const id = Number(requete.chemin.slice("/revue/".length));
  if (!Number.isInteger(id) || id <= 0) return rendre("Contact inconnu.", 400);

  const champs = new URLSearchParams(requete.corps);
  const action = champs.get("action") ?? "";
  if (!estActionRevue(action)) return rendre("Action de revue inconnue.", 400);

  const resultat = arbitrer(
    ctx.db,
    ctx.clock,
    ctx.counters,
    {
      id,
      action,
      valeur: champs.get("valeur") ?? undefined,
      note: champs.get("note") ?? undefined,
    },
    ctx.supprimerCache,
  );

  if (resultat.kind === "introuvable") return rendre("Ce contact n'existe plus.", 404);
  if (resultat.kind === "refus") return rendre(resultat.message, 422);
  if (htmx) return rendre(undefined, 200);
  return redirection(`/revue?departement=${encodeURIComponent(departement)}`);
}

/**
 * Un seuil illisible ne filtre rien : mieux vaut tout sortir que sortir au hasard.
 *
 * Le nom dit « tolerant » a dessein. La CLI a sa propre lecture, `lireScoreMin`, qui rend
 * elle aussi `undefined` sur une valeur invalide — mais pour en faire une erreur d'usage
 * et sortir en code 2. Meme signature, decisions opposees : les deux se defendent, ce qui
 * ne se defendait pas etait qu'elles portent le meme nom.
 */
function seuilTolerant(brut: string): number | undefined {
  if (brut.trim() === "") return undefined;
  const valeur = Number(brut.replace(",", "."));
  if (!Number.isFinite(valeur) || valeur < 0 || valeur > 1) return undefined;
  return valeur;
}
