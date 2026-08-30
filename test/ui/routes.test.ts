import { test } from "node:test";
import assert from "node:assert/strict";

import { openDatabase } from "../../src/db/index.ts";
import { fixedClock } from "../../src/clock.ts";
import { Counters } from "../../src/metrics/counters.ts";
import { JobQueue } from "../../src/jobs/queue.ts";
import { NOM_COOKIE, hoteAccepte, router, verifierAcces } from "../../src/ui/routes.ts";
import type { ContexteUi, RequeteUi } from "../../src/ui/routes.ts";
import { CAMPAGNE, CODE_INSEE, DEPARTEMENT, preparerCorpus } from "../helpers/corpus.ts";
import { piloteDouble, reglagesDouble } from "../helpers/pilote-double.ts";
import type { PiloteDouble, ReglagesDouble } from "../helpers/pilote-double.ts";
import type { TestContext } from "node:test";

/**
 * Routage et garde-fous, sans ouvrir de port : les refus se testent sur des objets
 * ordinaires. Un serveur local n'est pas un serveur inoffensif — il tient des donnees
 * personnelles et sait ecrire en base.
 */

const JETON = "jeton-de-test";
const PORT = 8787;
const HORLOGE = fixedClock(Date.parse("2026-09-01T10:00:00.000Z"));

type ContexteTest = ContexteUi & { pilote: PiloteDouble; reglages: ReglagesDouble };

function contexte(t: TestContext): ContexteTest {
  const { dbFile, racine } = preparerCorpus(t);
  const db = openDatabase(dbFile);
  t.after(() => db.close());

  // Les contacts non notes ne figurent pas dans la file de revue : l'etape [8] n'est pas
  // passee sur eux. Une notation minimale suffit ici, le bareme se teste ailleurs.
  db.prepare("UPDATE contact SET score = 0.4, score_version = 1").run();

  const counters = new Counters(db, null);
  return {
    db,
    queue: new JobQueue(db, HORLOGE, counters),
    counters,
    clock: HORLOGE,
    jeton: JETON,
    port: PORT,
    version: "0.1.0",
    departementSecours: DEPARTEMENT,
    dataDir: racine,
    supprimerCache: () => false,
    pilote: piloteDouble(),
    reglages: reglagesDouble("https://exemple.example/contact"),
  };
}

function requete(chemin: string, options: Partial<RequeteUi> = {}): RequeteUi {
  const url = new URL(chemin, "http://127.0.0.1");
  return {
    methode: "GET",
    chemin: url.pathname,
    requete: url.searchParams,
    entetes: { host: `127.0.0.1:${PORT}`, cookie: `${NOM_COOKIE}=${JETON}` },
    corps: "",
    ...options,
  };
}

function corpsTexte(corps: unknown): string {
  if (typeof corps === "string") return corps;
  if (corps instanceof Uint8Array) return Buffer.from(corps).toString("utf8");
  return [...(corps as Iterable<string>)].join("");
}

test("l'hote est verifie : un nom qui resout vers la boucle locale ne suffit pas", () => {
  assert.ok(hoteAccepte(`127.0.0.1:${PORT}`, PORT));
  assert.ok(hoteAccepte(`localhost:${PORT}`, PORT));
  assert.ok(hoteAccepte(`[::1]:${PORT}`, PORT));

  // Rebinding DNS : un nom controle par un tiers peut resoudre vers 127.0.0.1. Sans
  // cette verification, le navigateur porterait ses requetes sur cette base.
  assert.equal(hoteAccepte(`piege.example:${PORT}`, PORT), false);
  assert.equal(hoteAccepte("127.0.0.1:9999", PORT), false);
  assert.equal(hoteAccepte(undefined, PORT), false);
});

test("sans jeton, rien n'est servi", (t) => {
  const ctx = contexte(t);

  const sansCookie = verifierAcces(ctx, requete("/", { entetes: { host: `127.0.0.1:${PORT}` } }));
  assert.equal(sansCookie?.statut, 401);

  const mauvais = verifierAcces(
    ctx,
    requete("/", { entetes: { host: `127.0.0.1:${PORT}`, cookie: `${NOM_COOKIE}=autre` } }),
  );
  assert.equal(mauvais?.statut, 401);

  const hote = verifierAcces(ctx, requete("/", { entetes: { host: "piege.example" } }));
  assert.equal(hote?.statut, 403);

  assert.equal(verifierAcces(ctx, requete("/")), undefined, "un cookie valide laisse passer");
});

test("le jeton de l'URL est echange contre un cookie, puis disparait de l'adresse", (t) => {
  const ctx = contexte(t);
  const reponse = verifierAcces(
    ctx,
    requete(`/revue?departement=35&jeton=${JETON}`, { entetes: { host: `127.0.0.1:${PORT}` } }),
  );

  assert.equal(reponse?.statut, 303);
  assert.equal(reponse?.entetes["Location"], "/revue?departement=35");
  assert.match(String(reponse?.entetes["Set-Cookie"]), /SameSite=Strict/);
  assert.match(String(reponse?.entetes["Set-Cookie"]), /HttpOnly/);
});

test("une ecriture venue d'une autre origine est refusee", (t) => {
  const ctx = contexte(t);
  const croisee = verifierAcces(
    ctx,
    requete("/revue/1", {
      methode: "POST",
      entetes: { host: `127.0.0.1:${PORT}`, cookie: `${NOM_COOKIE}=${JETON}`, "sec-fetch-site": "cross-site" },
    }),
  );
  assert.equal(croisee?.statut, 403);

  assert.equal(
    verifierAcces(
      ctx,
      requete("/revue/1", {
        methode: "POST",
        entetes: {
          host: `127.0.0.1:${PORT}`,
          cookie: `${NOM_COOKIE}=${JETON}`,
          "sec-fetch-site": "same-origin",
        },
      }),
    ),
    undefined,
  );
});

test("les trois ecrans repondent, et portent leurs en-tetes de securite", (t) => {
  const ctx = contexte(t);

  for (const chemin of ["/", "/revue", "/export"]) {
    const reponse = router(ctx, requete(`${chemin}?departement=${DEPARTEMENT}`));
    assert.equal(reponse.statut, 200, chemin);
    assert.match(String(reponse.entetes["Content-Type"]), /text\/html/, chemin);
    assert.match(String(reponse.entetes["Content-Security-Policy"]), /default-src 'self'/, chemin);
    assert.equal(reponse.entetes["Referrer-Policy"], "no-referrer", chemin);
    assert.match(corpsTexte(reponse.corps), /<!doctype html>/, chemin);
  }

  assert.equal(router(ctx, requete("/inconnu")).statut, 404);
  assert.equal(router(ctx, requete("/assets/htmx.min.js")).statut, 200);
  assert.equal(router(ctx, requete("/assets/../cli.ts")).statut, 404);
});

test("htmx est configure pour afficher un refus, et sans une ligne de script en ligne", (t) => {
  const ctx = contexte(t);
  const html = corpsTexte(router(ctx, requete("/revue")).corps);

  // Sans cette configuration, htmx ignore les reponses 4xx : un arbitrage refuse ne
  // produirait rien a l'ecran, et la personne croirait avoir corrige. Elle passe par une
  // balise meta parce que la CSP interdit le script en ligne.
  assert.match(html, /name="htmx-config"/);
  assert.match(html, /\{"code":"422","swap":true\}/);
  assert.doesNotMatch(html, /<script>/, "aucun script en ligne : la CSP le refuserait");
  assert.doesNotMatch(html, /\son[a-z]+="/, "aucun gestionnaire d'evenement en ligne");
});

test("le fragment de suivi est du HTML nu, sans page autour", (t) => {
  const ctx = contexte(t);
  const reponse = router(ctx, requete("/suivi"));
  assert.equal(reponse.statut, 200);
  assert.doesNotMatch(corpsTexte(reponse.corps), /<!doctype html>/);
  assert.match(corpsTexte(reponse.corps), /Aucun run en cours/);
});

test("l'export streame le CSV du lot 5, sans variante propre a l'UI", (t) => {
  const ctx = contexte(t);
  const reponse = router(ctx, requete(`/export.csv?departement=${DEPARTEMENT}`));

  assert.match(String(reponse.entetes["Content-Type"]), /text\/csv/);
  assert.match(String(reponse.entetes["Content-Disposition"]), /attachment; filename="annuaire-35.csv"/);
  const corps = corpsTexte(reponse.corps);
  assert.match(corps, /valeur_publiable/);
  assert.match(corps, /contact@tennis-bruzou\.example/);
});

test("un contact piege ne devient pas du balisage dans l'ecran de revue", (t) => {
  const ctx = contexte(t);
  ctx.db
    .prepare(
      "INSERT INTO contact (code_insee, kind, valeur, valeur_normalisee, is_generique, source_url, " +
        "methode_extraction, confiance, collected_at, score, score_version) " +
        "VALUES (?, 'email', ?, ?, 1, ?, 'texte:motif', 0.3, 't', 0.1, 1)",
    )
    .run(
      CODE_INSEE,
      '<script>alert("xss")</script>@piege.example',
      "xss@piege.example",
      'javascript:alert("source")',
    );

  const corps = corpsTexte(router(ctx, requete(`/revue?departement=${DEPARTEMENT}`)).corps);
  assert.doesNotMatch(corps, /<script>alert/, "la valeur lue ne doit jamais devenir du balisage");
  assert.match(corps, /&lt;script&gt;alert\(&quot;xss&quot;\)/);
  // Une URL non http(s) est rendue en texte, pas en lien : echapper ne suffirait pas.
  assert.doesNotMatch(corps, /href="javascript:/);
});

test("un arbitrage par formulaire redirige, un arbitrage htmx renvoie la file", (t) => {
  const ctx = contexte(t);
  const id = (ctx.db.prepare("SELECT id FROM contact LIMIT 1").get() as { id: number }).id;

  const formulaire = router(
    ctx,
    requete(`/revue/${id}?departement=${DEPARTEMENT}`, {
      methode: "POST",
      corps: "action=valide&note=verifie+au+telephone",
    }),
  );
  assert.equal(formulaire.statut, 303, "sans redirection, un rechargement rejouerait l'arbitrage");
  assert.equal(formulaire.entetes["Location"], "/revue?departement=35");
  // `review_note` existe depuis le lot 1 et n'avait jamais eu de quoi l'ecrire.
  assert.equal(
    (ctx.db.prepare("SELECT review_note FROM contact WHERE id = ?").get(id) as { review_note: string })
      .review_note,
    "verifie au telephone",
  );

  const autre = (ctx.db.prepare("SELECT id FROM contact WHERE id <> ? LIMIT 1").get(id) as { id: number }).id;
  const parHtmx = router(
    ctx,
    requete(`/revue/${autre}?departement=${DEPARTEMENT}`, {
      methode: "POST",
      corps: "action=rejete",
      entetes: { host: `127.0.0.1:${PORT}`, cookie: `${NOM_COOKIE}=${JETON}`, "hx-request": "true" },
    }),
  );
  assert.equal(parHtmx.statut, 200);
  assert.doesNotMatch(corpsTexte(parHtmx.corps), /<!doctype html>/);
});

test("un refus d'arbitrage s'affiche sur place, sans passer par l'URL", (t) => {
  const ctx = contexte(t);
  const id = (ctx.db.prepare("SELECT id FROM contact LIMIT 1").get() as { id: number }).id;

  const reponse = router(
    ctx,
    requete(`/revue/${id}?departement=${DEPARTEMENT}`, {
      methode: "POST",
      corps: "action=corrige&valeur=pas+une+adresse",
    }),
  );

  assert.equal(reponse.statut, 422);
  // La valeur saisie ne doit pas voyager dans une redirection : elle finirait dans
  // l'historique du navigateur.
  assert.equal(reponse.entetes["Location"], undefined);
  assert.match(corpsTexte(reponse.corps), /forme d&#39;une adresse/);
});

/**
 * Lot 8 : lancer, arreter, regler. Le routeur ne fait que transmettre — le pilote,
 * lui, est teste dans `pilote.test.ts`. Ce qui compte ici est qu'aucune de ces routes
 * n'attende quoi que ce soit, et qu'un formulaire ordinaire soit redirige.
 */

function post(chemin: string, corps: string, htmx = false): RequeteUi {
  const entetes: Record<string, string | undefined> = {
    host: `127.0.0.1:${PORT}`,
    cookie: `${NOM_COOKIE}=${JETON}`,
  };
  if (htmx) entetes["hx-request"] = "true";
  return requete(chemin, { methode: "POST", corps, entetes });
}

test("POST /run transmet le departement au pilote et redirige un formulaire ordinaire", (t) => {
  const ctx = contexte(t);

  const reponse = router(ctx, post(`/run?departement=${DEPARTEMENT}`, `departement=${DEPARTEMENT}`));

  assert.deepEqual(ctx.pilote.demarrages, [DEPARTEMENT]);
  assert.equal(reponse.statut, 303, "sans redirection, un rechargement relancerait un run");
  assert.equal(reponse.entetes["Location"], `/?departement=${DEPARTEMENT}`);
});

test("POST /run par htmx rend le seul bloc de suivi", (t) => {
  const ctx = contexte(t);
  ctx.pilote.poser({ kind: "en_cours", departement: DEPARTEMENT, demarre: "2026-09-01T10:00:00.000Z", runId: 7, avecMobiles: false });

  const reponse = router(ctx, post(`/run?departement=${DEPARTEMENT}`, `departement=${DEPARTEMENT}`, true));
  const corps = corpsTexte(reponse.corps);

  assert.equal(reponse.statut, 200);
  assert.doesNotMatch(corps, /<!doctype html>/);
  assert.match(corps, /Arreter le run/, "un run en cours s'arrete, il ne se relance pas");
});

test("un refus de lancement survit au rafraichissement du bloc de suivi", (t) => {
  const ctx = contexte(t);
  ctx.pilote.repondre({ kind: "refus", message: "Un run est deja en cours dans cette interface." });

  router(ctx, post(`/run?departement=${DEPARTEMENT}`, `departement=${DEPARTEMENT}`, true));

  // Le bloc se reechange toutes les deux secondes : un message rendu une seule fois
  // dans la reponse au POST aurait disparu avant d'etre lu.
  const suivi = router(ctx, requete(`/suivi?departement=${DEPARTEMENT}`));
  assert.match(corpsTexte(suivi.corps), /Un run est deja en cours/);
});

test("POST /run/arret demande l'arret", (t) => {
  const ctx = contexte(t);
  ctx.pilote.poser({ kind: "en_cours", departement: DEPARTEMENT, demarre: "t", runId: 7, avecMobiles: false });

  const reponse = router(ctx, post(`/run/arret?departement=${DEPARTEMENT}`, "", true));

  assert.equal(ctx.pilote.arrets, 1);
  assert.equal(reponse.statut, 200);
});

test("le bouton cede la place au reglage tant que l'URL de contact manque (§4.4)", (t) => {
  const ctx = contexte(t);
  ctx.reglages = reglagesDouble();

  const ecran = corpsTexte(router(ctx, requete(`/?departement=${DEPARTEMENT}`)).corps);

  assert.doesNotMatch(ecran, /Lancer un run/);
  assert.match(ecran, /aucune collecte ne part sans elle/);
});

test("POST /reglages enregistre l'URL de contact, et le bouton apparait", (t) => {
  const ctx = contexte(t);
  ctx.reglages = reglagesDouble();

  const reponse = router(
    ctx,
    post("/reglages", `contactUrl=${encodeURIComponent("https://exemple.example/nous-ecrire")}`, true),
  );

  assert.equal(reponse.statut, 200);
  assert.deepEqual(ctx.reglages.ecrites, ["https://exemple.example/nous-ecrire"]);
  assert.match(corpsTexte(router(ctx, requete("/suivi")).corps), /Lancer le run complet/);
});

test("une URL de contact invalide est refusee sur place, sans passer par l'URL", (t) => {
  const ctx = contexte(t);
  ctx.reglages = reglagesDouble();

  const reponse = router(ctx, post("/reglages", "contactUrl=mairie-de-bruzou", true));

  assert.equal(reponse.statut, 422);
  assert.equal(reponse.entetes["Location"], undefined);
  assert.deepEqual(ctx.reglages.ecrites, []);
  assert.match(corpsTexte(reponse.corps), /n&#39;est pas une URL absolue/);
});

test("une URL de contact venue de l'environnement s'affiche sans champ de saisie", (t) => {
  const ctx = contexte(t);
  ctx.reglages = reglagesDouble("https://exemple.example/contact", true);

  const ecran = corpsTexte(router(ctx, requete(`/?departement=${DEPARTEMENT}`)).corps);

  assert.match(ecran, /ANNUAIRE_CONTACT_URL/);
  assert.doesNotMatch(ecran, /name="contactUrl"/, "un champ qui ne servirait a rien vaut mieux absent");
});

test("un run que cette interface ne pilote pas est signale, sans bloquer le bouton", (t) => {
  const ctx = contexte(t);
  ctx.db
    .prepare("INSERT INTO run (departement, started_at, statut, phase) VALUES (?, ?, 'en_cours', 'decouverte')")
    .run(DEPARTEMENT, "2026-09-01T09:00:00.000Z");

  const suivi = corpsTexte(router(ctx, requete(`/suivi?departement=${DEPARTEMENT}`)).corps);

  assert.match(
    suivi,
    /<li class="courante">Decouverte<\/li>/,
    "la phase vient de la base, pas de la memoire de l'interface",
  );
  assert.match(suivi, /n'est pas pilote depuis cette interface/);
  assert.match(suivi, /Lancer le run complet/, "une ligne orpheline ne doit pas condamner l'interface");
});

/**
 * Ce que l'ecran dit pendant un run.
 *
 * Trois ecrans montraient des chiffres qu'un run est en train de changer, et deux d'entre
 * eux se contredisaient : la revue annoncait « 418 a arbitrer » au-dessus de « Rien a
 * arbitrer », parce que le compteur additionnait des lignes que l'etape [8] n'avait pas
 * encore notees — et qui, faute de note, n'entrent pas dans la file.
 */

function lancerRunPilote(ctx: ContexteTest): void {
  ctx.pilote.poser({
    kind: "en_cours",
    departement: DEPARTEMENT,
    demarre: "2026-09-01T09:00:00.000Z",
    runId: 1,
    avecMobiles: false,
  });
}

/** Remet les contacts du corpus dans l'etat « collectes, pas encore notes ». */
function sansNotation(ctx: ContexteTest): void {
  ctx.db.prepare("UPDATE contact SET score = NULL, score_version = NULL").run();
}

test("la revue ne compte comme « a arbitrer » que ce qui est note", (t) => {
  const ctx = contexte(t);
  sansNotation(ctx);

  const ecran = corpsTexte(router(ctx, requete(`/revue?departement=${DEPARTEMENT}`)).corps);

  assert.match(ecran, /0 pret a arbitrer/, "la file est vide, le compteur doit le dire");
  assert.match(ecran, /en attente de notation/);
  assert.doesNotMatch(
    ecran,
    /Rien a arbitrer pour ce departement\./,
    "cette phrase promet qu'il n'y a plus rien a faire, ce qui est faux tant que [8] n'est pas passee",
  );
});

test("pendant un run pilote, la revue le dit et n'invite pas a lancer la normalisation", (t) => {
  const ctx = contexte(t);
  sansNotation(ctx);
  lancerRunPilote(ctx);

  const ecran = corpsTexte(router(ctx, requete(`/revue?departement=${DEPARTEMENT}`)).corps);

  assert.match(ecran, /Run en cours sur le departement 35/);
  assert.match(ecran, /Rien a arbitrer pour l'instant/);
  assert.doesNotMatch(
    ecran,
    /Lancez <code>annuaire normaliser/,
    "la normalisation est la derniere passe du run : la reclamer serait un contresens",
  );
});

test("pendant un run pilote, l'export est retire et l'URL du fichier refuse", (t) => {
  const ctx = contexte(t);
  lancerRunPilote(ctx);

  const ecran = corpsTexte(router(ctx, requete(`/export?departement=${DEPARTEMENT}`)).corps);
  assert.match(ecran, /Run en cours sur le departement 35/);
  assert.doesNotMatch(ecran, /Telecharger l'annuaire/, "un bouton grise invite a chercher comment l'activer");

  // Le bouton retire ne suffit pas : l'URL du formulaire se garde en favori.
  const fichier = router(ctx, requete(`/export.csv?departement=${DEPARTEMENT}`));
  assert.equal(fichier.statut, 409);
  assert.match(corpsTexte(fichier.corps), /Export suspendu/);
});

test("une ligne de run orpheline previent mais ne barre ni l'export ni la revue", (t) => {
  const ctx = contexte(t);
  ctx.db
    .prepare("INSERT INTO run (departement, started_at, statut, phase) VALUES (?, ?, 'en_cours', 'decouverte')")
    .run(DEPARTEMENT, "2026-09-01T09:00:00.000Z");

  const ecran = corpsTexte(router(ctx, requete(`/export?departement=${DEPARTEMENT}`)).corps);
  assert.match(ecran, /sans etre pilote depuis cette interface/);
  assert.match(ecran, /Telecharger le fichier/, "un reste de kill -9 ne doit pas condamner l'export");

  assert.equal(router(ctx, requete(`/export.csv?departement=${DEPARTEMENT}`)).statut, 200);
});

test("les chiffres ont leur propre fragment, rafraichi comme le suivi", (t) => {
  const ctx = contexte(t);

  const ecran = corpsTexte(router(ctx, requete(`/?departement=${DEPARTEMENT}`)).corps);
  assert.match(ecran, /id="chiffres"/);
  assert.match(ecran, /hx-get="\/chiffres\?departement=35"/);

  // Sans cette route, le bloc se viderait a la premiere seconde de rafraichissement.
  const fragment = router(ctx, requete(`/chiffres?departement=${DEPARTEMENT}`));
  assert.equal(fragment.statut, 200);
  assert.match(corpsTexte(fragment.corps), /Entonnoir/);
  assert.doesNotMatch(
    corpsTexte(fragment.corps),
    /<input/,
    "un bloc qui se remplace tout seul efface ce qu'on est en train d'y taper",
  );
});

/**
 * Le drapeau des mobiles (§4.6) vu du routeur.
 *
 * Il se regle par une route a lui, et sa reponse vise `#mobiles` : le bloc de suivi est
 * reechange toutes les deux secondes, une case a cocher qui y vivrait serait decochee
 * pendant la lecture de l'avertissement.
 */


test("POST /mobiles arme le drapeau et rend le bloc de reglage, pas le suivi", (t) => {
  const ctx = contexte(t);

  const reponse = router(ctx, post(`/mobiles?departement=${DEPARTEMENT}`, "avecMobiles=1", true));
  const corps = corpsTexte(reponse.corps);

  assert.deepEqual(ctx.pilote.bascules, [true]);
  assert.equal(reponse.statut, 200);
  assert.match(corps, /class="avertissement"/, "l'avertissement RGPD doit accompagner l'armement");
  assert.doesNotMatch(corps, /Lancer un run/, "la cible est le reglage, pas le bloc de commandes");
});

test("une case decochee n'envoie rien, et l'absence vaut exclusion", (t) => {
  const ctx = contexte(t);
  router(ctx, post(`/mobiles?departement=${DEPARTEMENT}`, "avecMobiles=1", true));

  // Le navigateur n'envoie pas les cases decochees : un corps vide est le cas normal du
  // desarmement, et le lire comme « inchange » laisserait le drapeau arme pour toujours.
  router(ctx, post(`/mobiles?departement=${DEPARTEMENT}`, "", true));

  assert.deepEqual(ctx.pilote.bascules, [true, false]);
  assert.equal(ctx.pilote.avecMobiles(), false);
});

test("un basculement refuse repond 422 et rend le refus sur place", (t) => {
  const ctx = contexte(t);
  ctx.pilote.verrouiller("Le drapeau des mobiles ne change pas en cours de run.");

  const reponse = router(ctx, post(`/mobiles?departement=${DEPARTEMENT}`, "avecMobiles=1", true));

  assert.equal(reponse.statut, 422, "le code doit dire la verite sur ce qui s'est passe");
  assert.match(corpsTexte(reponse.corps), /ne change pas en cours de run/);
});

test("sans htmx, POST /mobiles redirige : un rechargement ne doit pas rejouer le reglage", (t) => {
  const ctx = contexte(t);
  const reponse = router(ctx, post(`/mobiles?departement=${DEPARTEMENT}`, "avecMobiles=1"));

  assert.equal(reponse.statut, 303);
  assert.equal(reponse.entetes["Location"], `/?departement=${DEPARTEMENT}`);
});

test("le POST croise est refuse sur /mobiles comme sur les autres ecritures", (t) => {
  const ctx = contexte(t);
  const refus = verifierAcces(
    ctx,
    requete("/mobiles", {
      methode: "POST",
      corps: "avecMobiles=1",
      entetes: {
        host: `127.0.0.1:${PORT}`,
        cookie: `${NOM_COOKIE}=${JETON}`,
        "sec-fetch-site": "cross-site",
      },
    }),
  );
  assert.equal(refus?.statut, 403);
});

/**
 * L'avancement du run, lu sur la base.
 *
 * Un run lance dans un terminal doit s'afficher comme un run lance d'ici : c'est deja le
 * contrat du bloc de suivi, et la barre n'y fait pas exception. D'ou la lecture sur la
 * table `page` plutot que sur la memoire du pilote.
 */

function ouvrirRun(ctx: ContexteTest, phase: string): void {
  ctx.db
    .prepare("INSERT INTO run (departement, started_at, statut, phase) VALUES (?, ?, 'en_cours', ?)")
    .run(DEPARTEMENT, "2026-09-01T09:00:00.000Z", phase);
}

test("la barre de decouverte compte des communes, jamais des pages", (t) => {
  const ctx = contexte(t);
  ouvrirRun(ctx, "decouverte");

  // Une seconde commune, planifiee mais pas encore exploree : le corpus n'en a qu'une,
  // toutes pages visitees, ce qui donnerait une barre pleine sans rien prouver.
  ctx.db
    .prepare(
      "INSERT INTO commune (code_insee, nom, departement, url_mairie, statut_resolution, " +
        "resolution_source_url, resolution_collected_at, source_resolution, resolution_confiance, " +
        "created_at, updated_at) VALUES ('35048', 'Chantepie', ?, 'https://chantepie.example', " +
        "'resolue', 'https://source.example', 't', 'annuaire', 0.9, 't', 't')",
    )
    .run(DEPARTEMENT);
  ctx.db
    .prepare(
      "INSERT INTO page (url_hash, campagne, url, domaine, code_insee, statut, planifiee_at, profondeur) " +
        "VALUES ('h-attente', ?, 'https://chantepie.example/', 'chantepie.example', '35048', 'a_visiter', 't', 0)",
    )
    .run(CAMPAGNE);

  const suivi = corpsTexte(router(ctx, requete(`/suivi?departement=${DEPARTEMENT}`)).corps);

  assert.match(suivi, /<progress max="2" value="1"/, "une commune sur deux est exploree");
  assert.match(suivi, /1 sur 2 communes explorees/);
  // Les pages sont dites en chiffre, sans denominateur qui pretendrait etre un reste :
  // le crawl en enfile de nouvelles a chaque lien retenu.
  assert.match(suivi, /pages visitees sur \d+ planifiees/);
});

test("la barre de normalisation compte les contacts notes a la version courante", (t) => {
  const ctx = contexte(t);
  ouvrirRun(ctx, "normalisation");

  // Le contexte a note tous les contacts en version 1. Un contact note par une version
  // anterieure du bareme sera renote : le compter comme fait figerait la barre a 100 %.
  const total = Number(
    (ctx.db.prepare("SELECT count(*) AS n FROM contact").get() as { n: number }).n,
  );
  ctx.db.prepare("UPDATE contact SET score_version = 2 WHERE id = (SELECT min(id) FROM contact)").run();

  const suivi = corpsTexte(router(ctx, requete(`/suivi?departement=${DEPARTEMENT}`)).corps);

  assert.match(suivi, new RegExp(`<progress max="${total}" value="1"`));
  assert.match(suivi, /contacts notes/);
});

test("l'amorce sans dump ouvert affiche son etape, mais aucune barre", (t) => {
  const ctx = contexte(t);
  ouvrirRun(ctx, "amorce");

  const suivi = corpsTexte(router(ctx, requete(`/suivi?departement=${DEPARTEMENT}`)).corps);

  assert.match(suivi, /<li class="courante">Amorce<\/li>/);
  assert.doesNotMatch(suivi, /<progress/, "sans octet lu, une barre serait inventee");
});

/**
 * Le decompte de l'amorce existait en base sans etre lu.
 *
 * `dump.consumed_bytes` est l'offset de reprise : il est avance dans la meme transaction
 * que les lignes produites, donc il ne ment pas. L'ecran affichait pourtant « cette passe
 * n'a pas de decompte » pendant les vingt minutes que dure la lecture du registre.
 */
test("l'amorce compte en octets ce que le dump a consomme", (t) => {
  const ctx = contexte(t);
  ouvrirRun(ctx, "amorce");
  ctx.db
    .prepare(
      "INSERT INTO dump (source, url, statut, consumed_bytes, total_bytes, started_at) " +
        "VALUES ('rna_waldec', 'https://exemple.test/rna.csv', 'en_cours', ?, ?, ?)",
    )
    .run(536870912, 1342177280, "2026-09-01T09:00:00.000Z");

  const suivi = corpsTexte(router(ctx, requete(`/suivi?departement=${DEPARTEMENT}`)).corps);

  assert.match(suivi, /<progress max="1342177280" value="536870912"/);
  assert.match(suivi, /512 Mo sur 1,25 Go lus/, "les octets bruts ne se lisent pas");
  assert.match(
    suivi,
    /jamais ecrit sur le disque/,
    "le registre est lu en flux : l'ecran ne doit pas laisser croire a un fichier telecharge",
  );
});

test("sans run ouvert, il n'y a ni etapes ni barre a afficher", (t) => {
  const ctx = contexte(t);
  const suivi = corpsTexte(router(ctx, requete(`/suivi?departement=${DEPARTEMENT}`)).corps);

  assert.doesNotMatch(suivi, /<progress/);
  assert.doesNotMatch(suivi, /class="etapes"/);
});

test("un refus de basculement ne s'affiche pas aussi dans le bloc de suivi", (t) => {
  const ctx = contexte(t);
  ctx.pilote.verrouiller("Le drapeau des mobiles ne change pas en cours de run.");
  router(ctx, post(`/mobiles?departement=${DEPARTEMENT}`, "avecMobiles=1", true));

  // Le suivi se reechange toutes les deux secondes : un refus rendu la aussi se lirait
  // comme un second refus, deux secondes apres le premier.
  const suivi = corpsTexte(router(ctx, requete(`/suivi?departement=${DEPARTEMENT}`)).corps);
  assert.doesNotMatch(suivi, /ne change pas en cours de run/);
});

/**
 * La pagination de la revue.
 *
 * Une file de 418 contacts derriere une fenetre de dix : les 408 autres etaient
 * inatteignables autrement qu'en arbitrant les premiers. Ce n'est pas un catalogue —
 * arbitrer retire la ligne de la file — d'ou les deux proprietes verifiees ici : on garde
 * sa page en arbitrant, et une page qui n'existe plus ramene a la derniere plutot que de
 * rendre une erreur.
 */

/** Ajoute des contacts notes, du plus sur au moins sur, pour remplir plusieurs pages. */
function remplirLaFile(ctx: ContexteTest, combien: number): void {
  const inserer = ctx.db.prepare(
    "INSERT INTO contact (code_insee, kind, valeur, valeur_normalisee, is_generique, source_url, " +
      "methode_extraction, confiance, collected_at, score, score_version, review_statut) " +
      "VALUES (?, 'email', ?, ?, 1, 'https://mairie.example/annuaire', 'dom:mailto', 0.9, " +
      "'2026-08-22T00:00:00.000Z', ?, 1, 'a_revoir')",
  );
  for (let i = 0; i < combien; i += 1) {
    const valeur = `contact${String(i).padStart(3, "0")}@exemple.example`;
    inserer.run(CODE_INSEE, valeur, valeur, 0.1 + i / 1000);
  }
}

function idsAffiches(corps: string): string[] {
  return [...corps.matchAll(/id="contact-(\d+)"/g)].map((m) => m[1] ?? "");
}

test("la file se pagine : la page 2 montre d'autres contacts que la page 1", (t) => {
  const ctx = contexte(t);
  remplirLaFile(ctx, 25);

  const un = corpsTexte(router(ctx, requete(`/revue?departement=${DEPARTEMENT}`)).corps);
  const deux = corpsTexte(router(ctx, requete(`/revue?departement=${DEPARTEMENT}&page=2`)).corps);

  assert.equal(idsAffiches(un).length, 10, "une page tient dix contacts");
  assert.match(un, /page 1 sur/);
  assert.match(deux, /page 2 sur/);

  const communs = idsAffiches(un).filter((id) => idsAffiches(deux).includes(id));
  assert.deepEqual(communs, [], "deux pages ne doivent pas montrer les memes contacts");
});

test("une page hors bornes retombe sur la derniere, sans erreur", (t) => {
  const ctx = contexte(t);
  remplirLaFile(ctx, 25);

  // Le cas arrive tout seul : on arbitre les derniers contacts, et la page se vide sous
  // les pieds de qui y travaille. Un 404 pour un lien valide dix secondes plus tot serait
  // une punition, pas une information.
  const trop = corpsTexte(router(ctx, requete(`/revue?departement=${DEPARTEMENT}&page=99`)).corps);
  assert.match(trop, /page 3 sur 3/);
  assert.ok(idsAffiches(trop).length > 0, "la derniere page doit montrer quelque chose");

  for (const absurde of ["0", "-2", "deux", ""]) {
    const rendu = corpsTexte(
      router(ctx, requete(`/revue?departement=${DEPARTEMENT}&page=${absurde}`)).corps,
    );
    assert.match(rendu, /page 1 sur 3/, `page=${absurde} doit ramener a la premiere`);
  }
});

test("arbitrer depuis une page y laisse la personne qui revoit", (t) => {
  const ctx = contexte(t);
  remplirLaFile(ctx, 25);

  const page3 = corpsTexte(router(ctx, requete(`/revue?departement=${DEPARTEMENT}&page=3`)).corps);
  const cible = idsAffiches(page3)[0];
  assert.ok(cible !== undefined);

  // Le formulaire de chaque carte porte la page : sans elle, le fragment renvoye serait
  // celui de la premiere, et on perdrait sa place a chaque clic.
  assert.match(page3, new RegExp(`action="/revue/${cible}\\?departement=35&page=3"`));

  const apres = router(
    ctx,
    post(`/revue/${cible}?departement=${DEPARTEMENT}&page=3`, "action=valide", true),
  );
  assert.equal(apres.statut, 200);
  assert.match(corpsTexte(apres.corps), /page 3 sur/, "l'arbitrage ne doit pas renvoyer page 1");
});

test("sans deuxieme page, aucun lien de pagination n'est rendu", (t) => {
  const ctx = contexte(t);

  const ecran = corpsTexte(router(ctx, requete(`/revue?departement=${DEPARTEMENT}`)).corps);
  assert.doesNotMatch(ecran, /page 1 sur 1/, "une seule page ne se navigue pas");
});

/**
 * Ouvrir un autre departement.
 *
 * Le selecteur ne s'affichait qu'a partir de deux departements en base et ne listait que
 * l'existant : depuis une base amorcee sur le seul 35, il n'y avait aucun chemin vers le
 * 88. Le departement etait partout a l'ecran et nulle part modifiable, et il fallait la
 * ligne de commande pour en ouvrir un second. La barre de portee est ce chemin.
 */

test("la barre de portee est rendue meme quand la base ne connait qu'un departement", (t) => {
  const ctx = contexte(t);

  for (const chemin of ["/", "/revue", "/export"]) {
    const ecran = corpsTexte(router(ctx, requete(`${chemin}?departement=${DEPARTEMENT}`)).corps);
    assert.match(ecran, /class="portee"/, `${chemin} doit porter la barre`);
    assert.match(
      ecran,
      /<input type="text" id="portee-departement"/,
      `${chemin} doit offrir une saisie libre, pas seulement les departements connus`,
    );
  }
});

test("un departement jamais amorce s'ouvre, et l'ecran dit qu'il est vide", (t) => {
  const ctx = contexte(t);

  const ecran = corpsTexte(router(ctx, requete("/?departement=88")).corps);

  assert.match(ecran, /value="88"/, "le departement demande est celui qu'on affiche");
  assert.match(ecran, /Jamais amorce/, "un ecran de zeros ne dit pas s'il est vide ou non collecte");
  assert.match(ecran, /Deja en base : /, "les departements deja collectes restent joignables");
  assert.match(ecran, /Lancer le run complet/, "c'est le run qui amorcera ce departement");
});

test("un code de departement malforme est refuse, sans emporter l'ecran", (t) => {
  const ctx = contexte(t);

  const ecran = corpsTexte(router(ctx, requete("/?departement=TOUS")).corps);

  // Le message passe par `echapperHtml` : l'apostrophe y devient `&#39;`.
  assert.match(ecran, /pas un code de departement/);
  assert.match(ecran, /« TOUS »/, "le refus redit ce qui a ete saisi");
  assert.match(ecran, /value="35"/, "on retombe sur le departement courant, on ne casse pas la page");
});

test("le departement saisi est normalise : « 2a » et « 2A » sont le meme", (t) => {
  const ctx = contexte(t);

  const ecran = corpsTexte(router(ctx, requete("/?departement=+2a+")).corps);

  assert.match(ecran, /value="2A"/);
});

test("le departement ne se redit plus dans les libelles d'action", (t) => {
  const ctx = contexte(t);

  const synthese = corpsTexte(router(ctx, requete(`/?departement=${DEPARTEMENT}`)).corps);
  const exporter = corpsTexte(router(ctx, requete(`/export?departement=${DEPARTEMENT}`)).corps);

  // La barre de portee le dit une fois. Repete sur chaque bouton, il donnait a l'outil
  // l'air d'etre soude a un departement dont on ne pouvait pas sortir.
  assert.doesNotMatch(synthese, /Lancer le run complet sur le departement/);
  assert.doesNotMatch(exporter, /Telecharger l'annuaire du departement/);
  assert.match(exporter, /Telecharger le fichier/);
});

test("aucun ecran n'affiche de reference ADR ou de numero de paragraphe du brief", (t) => {
  const ctx = contexte(t);

  for (const chemin of ["/", "/revue", "/export"]) {
    const ecran = corpsTexte(router(ctx, requete(`${chemin}?departement=${DEPARTEMENT}`)).corps);
    // Ce qui est lu, et rien d'autre. Les commentaires HTML voyagent jusqu'au navigateur
    // sans etre affiches ; le `<head>` porte la configuration htmx, dont les codes de
    // statut `[23]..` et `[45]..` sont des expressions regulieres, pas des numeros d'etape.
    const visible = ecran
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<head>[\s\S]*?<\/head>/, "");
    assert.doesNotMatch(visible, /ADR-\d+/, `${chemin} : une reference ADR ne parle a personne`);
    assert.doesNotMatch(visible, /§\s*\d/, `${chemin} : un numero de paragraphe du brief non plus`);
    // Les etages de l'entonnoir portaient « [1] associations actives » : la numerotation
    // des etapes du brief, qui ne veut rien dire pour qui lit l'ecran.
    assert.doesNotMatch(visible, /\[\d+\]/, `${chemin} : ni un numero d'etape interne`);
  }
});

test("l'ecran de revue dit ce qu'on arbitre avant de montrer une valeur nue", (t) => {
  const ctx = contexte(t);

  const ecran = corpsTexte(router(ctx, requete(`/revue?departement=${DEPARTEMENT}`)).corps);

  assert.match(ecran, /valeur de contact lue sur une page de/, "une chaine nue ne se juge pas");
  assert.match(ecran, /Que font les quatre boutons/, "la legende des actions est a portee");
  assert.match(ecran, /class="type">Adresse email</, "chaque carte nomme le type de sa valeur");
});

/**
 * Le mode d'emploi.
 *
 * Il vit dans l'outil et non dans le README : celui-ci parle de `npm`, de CSP et renvoie
 * a des ADR — il s'adresse a qui clone le depot. La personne qui utilise l'outil a
 * double-clique sur un executable et regarde un navigateur.
 */

test("le mode d'emploi est servi, et atteignable depuis chaque ecran", (t) => {
  const ctx = contexte(t);

  const aide = router(ctx, requete("/aide"));
  assert.equal(aide.statut, 200);
  assert.match(corpsTexte(aide.corps), /Mode d'emploi/);

  for (const chemin of ["/", "/revue", "/export"]) {
    const ecran = corpsTexte(router(ctx, requete(`${chemin}?departement=${DEPARTEMENT}`)).corps);
    assert.match(ecran, /href="\/aide\?departement=35"/, `${chemin} doit y renvoyer`);
  }
});

test("le mode d'emploi dit ou sont les donnees, et ne porte pas de barre de portee", (t) => {
  const ctx = contexte(t);

  const aide = corpsTexte(router(ctx, requete("/aide")).corps);

  // « Ou sont mes donnees » est la question de quiconque n'ouvrira jamais un terminal.
  assert.match(aide, new RegExp(ctx.dataDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  // Le texte ne depend d'aucun departement : un selecteur y laisserait croire le contraire.
  assert.doesNotMatch(aide, /class="portee"/);
});

test("le mode d'emploi couvre ce qu'on ne peut pas deviner de l'ecran", (t) => {
  const ctx = contexte(t);

  const aide = corpsTexte(router(ctx, requete("/aide")).corps);

  // Les quatre choses qu'un utilisateur non technicien ne peut pas inferer seul, et dont
  // chacune a produit une question.
  assert.match(aide, /deux secondes entre/, "la lenteur doit etre expliquee, pas subie");
  assert.match(aide, /tout reprend ou\s+cela s'etait arrete/, "on peut fermer l'outil sans rien perdre");
  assert.match(aide, /article 14 du RGPD/, "l'obligation d'information n'est pas devinable");
  assert.match(aide, /57, le 67 et le 68/, "un departement hors champ doit se dire avant l'essai");
});
