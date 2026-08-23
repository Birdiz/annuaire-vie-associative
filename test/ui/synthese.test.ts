import { test } from "node:test";
import assert from "node:assert/strict";
import { fragmentSuivi, fragmentReglages } from "../../src/ui/vues/synthese.ts";
import type { DonneesSuivi, DonneesReglages } from "../../src/ui/vues/synthese.ts";

/**
 * L'ecran de synthese, rendu isolement.
 *
 * Il n'etait couvert qu'a travers le routeur, ce qui laissait ses 279 lignes de rendu sans
 * assertion directe. Ce qui est defendu ici : le bloc de suivi est rafraichi toutes les
 * deux secondes, donc **tout ce qu'il affiche doit survivre a un rafraichissement** — un
 * message rendu une fois disparaitrait avant d'etre lu — et **toute valeur venue du crawl
 * doit etre echappee**, la CSP ne dispensant pas de l'echappement.
 */

const JOBS = { pending: 0, leased: 0, done: 0, failed: 0, dead: 0, skipped: 0 };

function suivi(surcharges: Partial<DonneesSuivi> = {}): DonneesSuivi {
  return {
    runs: [],
    jobs: { ...JOBS },
    departement: "35",
    pilote: { kind: "inactif" },
    refus: undefined,
    collecteConfiguree: true,
    ...surcharges,
  };
}

test("sans run, le bloc le dit et offre de demarrer", () => {
  const html = fragmentSuivi(suivi());
  assert.match(html, /Aucun run en cours/);
  assert.match(html, /name="action"|\/run/, "le bloc doit porter la commande de lancement");
});

test("un run en cours annonce son numero et sa phase", () => {
  const html = fragmentSuivi(
    suivi({
      runs: [
        {
          id: 7,
          departement: "35",
          started_at: "2026-08-23T10:00:00.000Z",
          finished_at: null,
          statut: "en_cours",
          phase: "decouverte",
        },
      ],
      jobs: { ...JOBS, pending: 12 },
    }),
  );
  assert.match(html, /Run #7/);
  assert.match(html, /phase decouverte/);
});

test("sans URL de contact, le lancement n'est pas offert (§4.4)", () => {
  const html = fragmentSuivi(suivi({ collecteConfiguree: false }));
  assert.doesNotMatch(html, /<button[^>]*value="lancer"/, "aucune collecte ne part sans URL de contact");
});

test("le refus du pilote est rendu a chaque rafraichissement, pas une seule fois", () => {
  // Le bloc se rafraichit toutes les deux secondes : un message rendu une fois dans la
  // reponse au POST disparaitrait avant d'etre lu. C'est le pilote qui s'en souvient.
  const html = fragmentSuivi(suivi({ refus: "Un run est deja en cours dans cette interface." }));
  assert.match(html, /Un run est deja en cours/);
});

test("une valeur venue du crawl est echappee avant d'entrer dans la page", () => {
  // La CSP ferme la meme porte une seconde fois ; aucune des deux ne dispense de l'autre.
  const html = fragmentSuivi(
    suivi({
      runs: [
        {
          id: 1,
          departement: `35"><script>alert(1)</script>`,
          started_at: "2026-08-23T10:00:00.000Z",
          finished_at: null,
          statut: "en_cours",
          phase: null,
        },
      ],
    }),
  );
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
});

test("un run fini en echec est signale comme tel", () => {
  const html = fragmentSuivi(
    suivi({ pilote: { kind: "fini", departement: "35", issue: "echec", message: "la base est en lecture seule" } }),
  );
  assert.match(html, /la base est en lecture seule/);
});

test("l'URL de contact fixee par l'environnement est annoncee comme non modifiable", () => {
  const donnees: DonneesReglages = {
    contactUrl: "https://mairie.example/contact",
    parEnvironnement: true,
    message: undefined,
    erreur: undefined,
  };
  const html = fragmentReglages(donnees);
  assert.match(html, /mairie\.example/);
  assert.match(html, /ANNUAIRE_CONTACT_URL|environnement/i);
});

test("une erreur de reglage est rendue sur place, jamais dans l'URL", () => {
  const html = fragmentReglages({
    contactUrl: undefined,
    parEnvironnement: false,
    message: undefined,
    erreur: "contactUrl doit etre joignable depuis Internet",
  });
  assert.match(html, /joignable depuis Internet/);
});
