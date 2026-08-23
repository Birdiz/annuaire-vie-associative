/**
 * Ouverture de l'etape [3] : transformer les URL de mairie resolues au lot 2 en pages
 * a visiter.
 *
 * Ce handler ne fait aucun travail asynchrone. Tout son effet tient dans son
 * `commit(db)`, donc dans la transaction qui marque aussi le job termine : il n'y a
 * aucune fenetre ou des pages seraient planifiees sans que le job le soit, ni
 * l'inverse. C'est le contrat de l'ADR-002, sans l'entorse que l'ADR-008 avait du
 * consentir aux jobs de flux du lot 2.
 */

import { toIso } from "../clock.ts";
import { ETAPE } from "../metrics/counters.ts";
import type { JobHandler } from "../jobs/worker.ts";
import type { ContexteDecouverte } from "./contexte.ts";
import { clePage, hashPage, lirePayloadDecouverte, prioritePage } from "./contexte.ts";
import { PAGES_MAX_PAR_COMMUNE, estReseauSocial } from "./scoring.ts";

type CommuneAVisiter = { code_insee: string; url_mairie: string };

const SQL_COMMUNES = `
  SELECT code_insee, url_mairie
    FROM commune
   WHERE departement = ?
     AND url_mairie IS NOT NULL
   ORDER BY code_insee
`;

const SQL_INSERER_PAGE = `
  INSERT OR IGNORE INTO page
    (url_hash, campagne, url, domaine, code_insee, planifiee_at, profondeur, statut, score_candidat)
  VALUES (?, ?, ?, ?, ?, ?, 0, 'a_visiter', NULL)
`;

const SQL_REFUSER = `
  UPDATE commune SET crawl_statut = 'refuse', crawl_erreur = ?, updated_at = ? WHERE code_insee = ?
`;

export function handlerDecouverte(ctx: ContexteDecouverte): JobHandler {
  return async (job) => {
    const payload = lirePayloadDecouverte(job.payload);
    if (payload === undefined) return { kind: "skipped", reason: "payload sans departement ni campagne" };

    const maxPages = payload.maxPages > 0 ? payload.maxPages : PAGES_MAX_PAR_COMMUNE;
    const communes = ctx.db.prepare(SQL_COMMUNES).all(payload.departement) as unknown as CommuneAVisiter[];

    return {
      kind: "done",
      commit: (db) => {
        const maintenant = toIso(ctx.clock.now());
        let planifiees = 0;
        let refusees = 0;
        let invalides = 0;

        for (const commune of communes) {
          const url = analyserUrlMairie(commune.url_mairie);
          if (url === undefined) {
            invalides += 1;
            continue;
          }
          if (estReseauSocial(url.hostname)) {
            // §5 du brief : on ne collecte pas sur les reseaux sociaux, quelle que
            // soit la source qui les declare.
            db.prepare(SQL_REFUSER).run("site declare sur un reseau social", maintenant, commune.code_insee);
            refusees += 1;
            continue;
          }

          const href = url.href;
          const hash = hashPage(payload.campagne, commune.code_insee, href);
          const insere = db
            .prepare(SQL_INSERER_PAGE)
            .run(hash, payload.campagne, href, url.hostname, commune.code_insee, maintenant).changes;

          // Deja planifiee par une execution precedente de cette campagne : le job
          // existe aussi, l'enfilement serait sans effet. On ne la compte pas deux fois.
          if (Number(insere) === 0) continue;

          ctx.queue.enqueue(
            "page_crawl",
            clePage(hash),
            {
              codeInsee: commune.code_insee,
              url: href,
              campagne: payload.campagne,
              profondeur: 0,
              maxPages,
              avecMobiles: payload.avecMobiles,
            },
            // Une racine passe avant tout lien decouvert, quel que soit le score de
            // celui-ci : c'est ce qui etale les requetes sur des /24 distincts.
            { runId: ctx.runId, priority: prioritePage(0) },
          );
          planifiees += 1;
        }

        ctx.counters.inc(ETAPE.decouverte, "communes_planifiees", planifiees);
        ctx.counters.inc(ETAPE.decouverte, "sites_refuses", refusees);
        ctx.counters.inc(ETAPE.decouverte, "urls_mairie_invalides", invalides);
      },
    };
  };
}

/**
 * Le lot 2 enregistre l'URL telle que l'Annuaire la declare. Elle peut etre vide de
 * sens, sans schema, ou pointer ailleurs que sur le web : on la valide ici plutot que
 * de laisser un job echouer sur chaque commune mal declaree.
 */
function analyserUrlMairie(brut: string): URL | undefined {
  const valeur = brut.trim();
  if (valeur === "") return undefined;
  let url: URL;
  try {
    url = new URL(valeur);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.hostname === "") return undefined;
  url.hash = "";
  return url;
}

