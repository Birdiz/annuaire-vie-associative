import { test } from "node:test";
import assert from "node:assert/strict";

import { openDatabase } from "../../src/db/index.ts";
import { fixedClock } from "../../src/clock.ts";
import { Counters } from "../../src/metrics/counters.ts";
import { JobQueue } from "../../src/jobs/queue.ts";
import { NOM_COOKIE, hoteAccepte, router, verifierAcces } from "../../src/ui/routes.ts";
import type { ContexteUi, RequeteUi } from "../../src/ui/routes.ts";
import { CODE_INSEE, DEPARTEMENT, preparerCorpus } from "../helpers/corpus.ts";
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
  const { dbFile } = preparerCorpus(t);
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
  ctx.pilote.poser({ kind: "en_cours", departement: DEPARTEMENT, demarre: "2026-09-01T10:00:00.000Z", runId: 7 });

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
  ctx.pilote.poser({ kind: "en_cours", departement: DEPARTEMENT, demarre: "t", runId: 7 });

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

  assert.match(suivi, /phase decouverte/, "la phase vient de la base, pas de la memoire de l'interface");
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

  assert.match(ecran, /0 pret\(s\) a arbitrer/, "la file est vide, le compteur doit le dire");
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
  assert.match(ecran, /Telecharger l'annuaire/, "un reste de kill -9 ne doit pas condamner l'export");

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
