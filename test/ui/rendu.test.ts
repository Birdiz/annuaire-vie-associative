import { test } from "node:test";
import assert from "node:assert/strict";

import { barre, dateHeure, duree, ecart, echapperHtml, jour, lienSur, pourcent, tableau } from "../../src/ui/rendu.ts";

/**
 * Ce qui est defendu ici : une valeur lue sur un site de mairie ne peut pas devenir du
 * balisage. L'ecran de revue est precisement l'endroit ou on regarde ces valeurs de
 * pres, et la CSP du serveur ne dispense pas d'echapper — elle ferme la porte une
 * seconde fois, pas la premiere.
 */

test("l'echappement couvre le texte et les valeurs d'attribut", () => {
  assert.equal(echapperHtml("Comite des fetes"), "Comite des fetes");
  assert.equal(
    echapperHtml('<script>alert("xss")</script>'),
    "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;",
  );
  // Le guillemet simple compte autant que le double : un attribut peut etre delimite
  // par l'un ou par l'autre, et un seul echappement doit valoir pour les deux contextes.
  assert.equal(echapperHtml("' onmouseover='x"), "&#39; onmouseover=&#39;x");
  assert.equal(echapperHtml("a & b"), "a &amp; b");
  assert.equal(echapperHtml(null), "");
});

test("une URL collectee ne devient un lien que si elle est http(s)", () => {
  assert.equal(lienSur("https://bruzou.example/a"), "https://bruzou.example/a");
  // Echapper ne suffirait pas : `javascript:` est une URL syntaxiquement valide.
  assert.equal(lienSur("javascript:alert(1)"), undefined);
  assert.equal(lienSur("data:text/html,<script>"), undefined);
  assert.equal(lienSur('https://a.example/"><script>'), "https://a.example/&quot;&gt;&lt;script&gt;");
});

test("le tableau echappe ses en-tetes et laisse passer ses cellules deja rendues", () => {
  const rendu = tableau(["<x>"], [["<b>deja rendu</b>"]]);
  assert.match(rendu, /&lt;x&gt;/);
  assert.match(rendu, /<b>deja rendu<\/b>/);
  assert.match(tableau(["a"], []), /Rien à afficher/);
});

test("un pourcentage sans denominateur ne vaut pas zero", () => {
  // Zero sur zero affiche « — » : annoncer 0,0 % ferait passer une absence de mesure
  // pour un resultat.
  assert.equal(pourcent(0, 0), "—");
  assert.equal(pourcent(1, 4), "25,0 %");
});

test("une colonne de nombres s'aligne a droite, en-tete comprise", () => {
  const rendu = tableau(
    ["etat", "volume"],
    [["pending", '<span class="n">1 608</span>']],
  );

  // Le CSS n'alignait que la cellule : sur la table des etats de la file, chaque valeur
  // flottait a droite d'un titre reste a gauche, et on ne savait plus quel chiffre allait
  // avec quel etat.
  assert.match(rendu, /<th class="num">volume<\/th>/);
  assert.match(rendu, /<td class="num"><span class="n">1 608<\/span><\/td>/);

  // La colonne de texte, elle, ne bouge pas.
  assert.match(rendu, /<th>etat<\/th>/);
  assert.match(rendu, /<td>pending<\/td>/);
});

/**
 * Les dates et la barre.
 *
 * Ce qui est defendu ici : la base garde de l'ISO 8601 UTC — c'est ce qui rend les
 * comparaisons justes — et l'ecran, lui, se lit sans conversion de fuseau de tete. Et la
 * barre porte sa valeur dans un attribut : la CSP `default-src 'self'` refuse un
 * `style=` en ligne, et une barre reglee ainsi resterait vide sans rien signaler.
 */

/** Fixe le fuseau pour la duree d'un test, sans le laisser fuir sur les suivants. */
function sousFuseau<T>(tz: string, corps: () => T): T {
  const initial = process.env["TZ"];
  process.env["TZ"] = tz;
  try {
    return corps();
  } finally {
    if (initial === undefined) delete process.env["TZ"];
    else process.env["TZ"] = initial;
  }
}

test("un horodatage se rend dans le fuseau de la machine", () => {
  assert.equal(sousFuseau("Europe/Paris", () => dateHeure("2026-08-30T11:05:29.852Z")), "30/08/2026 13:05");
  assert.equal(sousFuseau("UTC", () => dateHeure("2026-08-30T11:05:29.852Z")), "30/08/2026 11:05");
  // Passage a minuit : c'est le cas ou une date brute induit le plus surement en erreur.
  assert.equal(sousFuseau("Europe/Paris", () => dateHeure("2026-08-30T23:30:00.000Z")), "31/08/2026 01:30");
});

test("une date absente donne un tiret, une date illisible se rend telle quelle", () => {
  assert.equal(dateHeure(null), "—");
  assert.equal(dateHeure(undefined), "—");
  assert.equal(dateHeure(""), "—");
  // Masquer une valeur corrompue derriere un tiret la ferait passer pour une absence.
  assert.equal(dateHeure("pas une date"), "pas une date");
  assert.equal(dateHeure("<script>"), "&lt;script&gt;", "une valeur rendue telle quelle reste echappee");
});

test("une date seule ne passe pas par Date : elle reculerait d'un jour a l'ouest", () => {
  // `new Date("2023-08-30")` vaut minuit UTC ; rendu en heure locale a New York, c'est
  // le 29. Une borne de dormance decalee d'un jour se lirait comme une erreur de calcul.
  assert.equal(sousFuseau("America/New_York", () => jour("2023-08-30")), "30/08/2023");
  assert.equal(jour("2023-08-30"), "30/08/2023");
  assert.equal(jour(null), "—");
  assert.equal(jour("hier"), "hier");
});

test("les durees se lisent en trois paliers", () => {
  assert.equal(duree(0), "0 s");
  assert.equal(duree(38_000), "38 s");
  assert.equal(duree(59_400), "59 s");
  assert.equal(duree(60_000), "1 min");
  assert.equal(duree(42 * 60_000), "42 min");
  assert.equal(duree(67 * 60_000), "1 h 07");
  assert.equal(duree(-5_000), "0 s", "une horloge qui recule ne doit pas afficher un negatif");
});

test("l'ecart refuse de calculer sur une date illisible", () => {
  assert.equal(ecart("2026-08-30T10:00:00.000Z", "2026-08-30T10:42:00.000Z"), 42 * 60_000);
  assert.equal(ecart("2026-08-30T10:00:00.000Z", Date.parse("2026-08-30T10:42:00.000Z")), 42 * 60_000);
  assert.equal(ecart("jamais", "2026-08-30T10:42:00.000Z"), undefined);
  assert.equal(ecart("2026-08-30T10:00:00.000Z", "jamais"), undefined);
});

test("la barre porte sa valeur en attribut, jamais dans un style en ligne", () => {
  const rendu = barre(8, 20, "communes explorées");

  assert.match(rendu, /<progress max="20" value="8"/);
  assert.doesNotMatch(rendu, /style=/, "`style-src 'self'` refuserait l'attribut, sans rien signaler");
  assert.match(rendu, /aria-label="8 sur 20 communes explorées"/, "la barre doit s'entendre autant qu'elle se voit");
  assert.match(rendu, /40,0 %/);
});

test("la barre ne deborde pas et echappe son libelle", () => {
  // Un numerateur au-dessus du denominateur n'est pas theorique : les deux chiffres
  // viennent de deux requetes, et rien ne les prend au meme instant.
  assert.match(barre(25, 20, "communes"), /value="20"/);
  assert.match(barre(-3, 20, "communes"), /value="0"/);
  assert.match(barre(1, 2, '<img src=x onerror="alert(1)">'), /&lt;img/);
});
