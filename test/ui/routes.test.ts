import { test } from "node:test";
import assert from "node:assert/strict";

import { openDatabase } from "../../src/db/index.ts";
import { fixedClock } from "../../src/clock.ts";
import { Counters } from "../../src/metrics/counters.ts";
import { JobQueue } from "../../src/jobs/queue.ts";
import { NOM_COOKIE, hoteAccepte, router, verifierAcces } from "../../src/ui/routes.ts";
import type { ContexteUi, RequeteUi } from "../../src/ui/routes.ts";
import { CODE_INSEE, DEPARTEMENT, preparerCorpus } from "../helpers/corpus.ts";
import type { TestContext } from "node:test";

/**
 * Routage et garde-fous, sans ouvrir de port : les refus se testent sur des objets
 * ordinaires. Un serveur local n'est pas un serveur inoffensif — il tient des donnees
 * personnelles et sait ecrire en base.
 */

const JETON = "jeton-de-test";
const PORT = 8787;
const HORLOGE = fixedClock(Date.parse("2026-09-01T10:00:00.000Z"));

function contexte(t: TestContext): ContexteUi {
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
