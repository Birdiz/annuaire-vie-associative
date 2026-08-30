import { test } from "node:test";
import assert from "node:assert/strict";
import { fragmentSuivi, fragmentReglages, fragmentMobiles } from "../../src/ui/vues/synthese.ts";
import type { DonneesSuivi, DonneesReglages, DonneesMobiles } from "../../src/ui/vues/synthese.ts";

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

/** Instant du rendu, fixe : les durees affichees doivent etre des valeurs, pas des aleas. */
const MAINTENANT = Date.parse("2026-08-23T10:12:00.000Z");

function suivi(surcharges: Partial<DonneesSuivi> = {}): DonneesSuivi {
  return {
    runs: [],
    jobs: { ...JOBS },
    departement: "35",
    pilote: { kind: "inactif" },
    refus: undefined,
    collecteConfiguree: true,
    progression: undefined,
    mobilesActifs: false,
    maintenant: MAINTENANT,
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
      progression: {
        phase: "decouverte",
        avancement: { faits: 8, total: 20, unite: "communes explorees", detail: undefined },
      },
    }),
  );
  assert.match(html, /Run #7/);
  assert.match(html, /<li class="courante">decouverte<\/li>/, "l'etape se lit dans l'indicateur");
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
    suivi({ pilote: { kind: "fini", departement: "35", issue: "echec", message: "la base est en lecture seule", avecMobiles: false } }),
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

/**
 * Le drapeau des mobiles (§4.6) et l'avancement du run.
 *
 * Ce qui est defendu ici : l'avertissement RGPD est present **des que le drapeau est
 * arme**, et il l'est aux deux endroits — dans le reglage, ou l'on decide, et a cote du
 * bouton, ou l'on agit. Un opt-in visible seulement au moment ou on le coche serait un
 * opt-in qu'on oublie avoir donne.
 */

function mobiles(surcharges: Partial<DonneesMobiles> = {}): DonneesMobiles {
  return { actif: false, verrouille: false, refus: undefined, ...surcharges };
}

test("les mobiles sont annonces exclus par defaut, sans avertissement inutile", () => {
  const html = fragmentMobiles(mobiles());
  assert.match(html, /exclus/);
  assert.doesNotMatch(html, /class="avertissement"/, "un avertissement permanent finit par ne plus etre lu");
  assert.doesNotMatch(html, /checked/, "la case suit l'etat : rien n'est coche quand rien n'est arme");
});

test("le drapeau arme porte l'avertissement RGPD et dit qu'il ne dure qu'une session", () => {
  const html = fragmentMobiles(mobiles({ actif: true }));

  assert.match(html, /class="avertissement"/);
  assert.match(html, /personne physique/, "c'est ce qui distingue un 06 d'une ligne fixe d'association");
  assert.match(html, /art\. 14/, "l'information des personnes est l'obligation la plus oubliee (ADR-025)");
  assert.match(html, /cette session/, "rien n'est persiste : l'ecran doit le dire");
  assert.match(html, /checked/);
});

test("pendant un run, la case du drapeau est inerte et le dit", () => {
  const html = fragmentMobiles(mobiles({ actif: true, verrouille: true }));
  assert.match(html, /<input[^>]*disabled/);
  assert.match(html, /<button[^>]*disabled/);
  assert.match(html, /Fige pendant le run/);
});

test("le refus du basculement est rendu sur place", () => {
  const html = fragmentMobiles(mobiles({ refus: "Le drapeau des mobiles ne change pas en cours de run" }));
  assert.match(html, /class="refus"/);
  assert.match(html, /ne change pas en cours de run/);
});

test("le bouton de lancement porte l'avertissement quand le drapeau est arme", () => {
  const arme = fragmentSuivi(suivi({ mobilesActifs: true }));
  assert.match(arme, /Ce run conservera les numeros mobiles/);

  const desarme = fragmentSuivi(suivi());
  assert.doesNotMatch(desarme, /conservera les numeros mobiles/);
});

test("un run en cours dit ce qu'il fait des mobiles, pas ce qui est coche a l'ecran", () => {
  // Le drapeau a ete desarme apres le depart : le run, lui, applique toujours celui
  // qu'il a fige. C'est l'etat du pilote qui fait foi, pas le reglage courant.
  const html = fragmentSuivi(
    suivi({
      mobilesActifs: false,
      pilote: {
        kind: "en_cours",
        departement: "35",
        demarre: "2026-08-23T10:00:00.000Z",
        runId: 7,
        avecMobiles: true,
      },
    }),
  );
  assert.match(html, /Ce run conserve les numeros mobiles/);
});

test("l'indicateur d'etape situe la passe en cours, faites derriere et a venir devant", () => {
  const html = fragmentSuivi(
    suivi({
      progression: {
        phase: "normalisation",
        avancement: { faits: 40, total: 100, unite: "contacts notes", detail: undefined },
      },
    }),
  );
  assert.match(html, /<li class="faite">amorce<\/li>/);
  assert.match(html, /<li class="faite">decouverte<\/li>/);
  assert.match(html, /<li class="courante">normalisation<\/li>/);
});

test("la barre porte sa valeur en attribut : la CSP interdit un style en ligne", () => {
  const html = fragmentSuivi(
    suivi({
      progression: {
        phase: "decouverte",
        avancement: { faits: 8, total: 20, unite: "communes explorees", detail: "31 pages visitees" },
      },
    }),
  );

  assert.match(html, /<progress max="20" value="8"/);
  // `style="width: 40%"` serait refuse par `default-src 'self'`, et la barre resterait
  // vide sans que rien ne le signale.
  assert.doesNotMatch(html, /style="/);
  assert.match(html, /8 sur 20 communes explorees — 40,0 %/);
  assert.match(html, /31 pages visitees/);
});

test("l'amorce n'invente pas de denominateur", () => {
  const html = fragmentSuivi(suivi({ progression: { phase: "amorce", avancement: undefined } }));
  assert.match(html, /<li class="courante">amorce<\/li>/);
  assert.doesNotMatch(html, /<progress/, "une barre inventee serait pire qu'aucune barre");
  assert.match(html, /pas de decompte/);
});

/**
 * Les dates. La base porte de l'ISO 8601 UTC, et c'est ce qu'il faut pour trier ; l'ecran,
 * lui, doit se lire. Le fuseau du test est fixe a `Europe/Paris` par `TZ`, sans quoi
 * l'heure attendue dependrait de la machine qui execute la suite.
 */

test("les horodatages sont rendus lisibles, dans le fuseau de la machine", () => {
  const tzInitial = process.env["TZ"];
  process.env["TZ"] = "Europe/Paris";
  try {
    const html = fragmentSuivi(
      suivi({
        runs: [
          {
            id: 1,
            departement: "35",
            started_at: "2026-08-30T11:05:29.852Z",
            finished_at: "2026-08-30T11:47:29.852Z",
            statut: "termine",
            phase: null,
          },
        ],
      }),
    );

    assert.match(html, /30\/08\/2026 13:05/, "l'ISO brut demandait une conversion de fuseau de tete");
    assert.doesNotMatch(html, /2026-08-30T11:05/);
    assert.match(html, /42 min/, "la duree repond a « combien de temps ca prend »");
  } finally {
    if (tzInitial === undefined) delete process.env["TZ"];
    else process.env["TZ"] = tzInitial;
  }
});

test("un run reste ouvert sans fin n'est pas chronometre jusqu'a aujourd'hui", () => {
  // Une ligne laissee 'en_cours' par un kill -9 afficherait « 3 j » : le compteur dirait
  // l'age de la panne, pas la duree d'un travail.
  const html = fragmentSuivi(
    suivi({
      runs: [
        {
          id: 1,
          departement: "35",
          started_at: "2026-01-01T00:00:00.000Z",
          finished_at: null,
          statut: "interrompu",
          phase: null,
        },
      ],
    }),
  );
  assert.doesNotMatch(html, /\d+ h \d\d/);
});
