import { test } from "node:test";
import assert from "node:assert/strict";

import { echapperHtml, lienSur, pourcent, tableau } from "../../src/ui/rendu.ts";

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
  assert.match(tableau(["a"], []), /Rien a afficher/);
});

test("un pourcentage sans denominateur ne vaut pas zero", () => {
  // Zero sur zero affiche « — » : annoncer 0,0 % ferait passer une absence de mesure
  // pour un resultat.
  assert.equal(pourcent(0, 0), "—");
  assert.equal(pourcent(1, 4), "25,0 %");
});
