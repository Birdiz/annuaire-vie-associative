import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import {
  ETIQUETTES_DE_MESSAGERIE,
  FOURNISSEURS_PUBLICS,
  SQL_NON_MESSAGERIE,
  estEtiquetteDeMessagerie,
  estMessagerie,
} from "../../src/normalisation/messageries.ts";

/**
 * Une messagerie dit ou l'on releve son courrier, jamais qui l'on est (ADR-033). La liste
 * sert a deux endroits — ne pas nommer une structure d'apres elle a l'export, et decoller
 * une adresse soudee au mot suivant a l'extraction — et elle a un miroir SQL.
 */

test("une messagerie se reconnait quel que soit son suffixe", () => {
  for (const domaine of [
    "gmail.com",
    "gmail.fr",
    "hotmail.be",
    "yahoo.co.uk",
    "ymail.com",
    "protonmail.ch",
    "proton.me",
    "riseup.net",
    "netcourrier.com",
    "laposte.fr",
    "wanadoo.com",
    "ik.me",
    "GMAIL.COM",
  ]) {
    assert.equal(estMessagerie(domaine), true, domaine);
  }
});

test("un club dont le nom commence comme une messagerie reste un club", () => {
  for (const domaine of ["orange-sport-bruzou.fr", "livecafe.fr", "gmailclub.fr", "freeride-bruzou.fr", "tennis.fr"]) {
    assert.equal(estMessagerie(domaine), false, domaine);
  }
  // `me`, `mac` et `ik` ne valent qu'en domaine exact : en etiquette, ils ne diraient rien.
  assert.equal(estMessagerie("me.bruzou.fr"), false);
});

test("l'etiquette de tete suffit a reconnaitre une messagerie, pour decoller", () => {
  assert.equal(estEtiquetteDeMessagerie("gmail"), true);
  assert.equal(estEtiquetteDeMessagerie("Hotmail"), true);
  assert.equal(estEtiquetteDeMessagerie("ik"), true, "domaine exact ik.me");
  assert.equal(estEtiquetteDeMessagerie("tennisbruzou"), false);
});

test("les listes inlinees dans le SQL ne peuvent pas en sortir", () => {
  // Interpolees dans la requete d'export, sans parametre lie — parce qu'elles sont des
  // constantes du code et non des entrees. Ce test rend l'interpolation sure **par
  // construction**, et non par la vigilance de qui ajoutera la quarantieme entree.
  for (const domaine of FOURNISSEURS_PUBLICS) assert.match(domaine, /^[a-z0-9.-]+$/, domaine);
  for (const etiquette of ETIQUETTES_DE_MESSAGERIE) assert.match(etiquette, /^[a-z0-9-]+$/, etiquette);
  assert.ok(SQL_NON_MESSAGERIE.includes("'gmail.'"));
  assert.ok(SQL_NON_MESSAGERIE.includes("'gmail.com'"));
});

test("le miroir SQL rend exactement le verdict du code", () => {
  // `compterLignes` et `lignesCsv` doivent accepter les memes domaines que l'export juge
  // en TypeScript : un ecran qui annonce un nombre que le fichier ne tient pas est pire
  // qu'un ecran muet.
  const db = new DatabaseSync(":memory:");
  const juger = db.prepare(`SELECT (${SQL_NON_MESSAGERIE}) AS non FROM (SELECT ? AS domaine)`);
  for (const domaine of [
    "gmail.com",
    "gmail.fr",
    "gmail.comhttps",
    "yahoo.co.uk",
    "ik.me",
    "me.bruzou.fr",
    "orange-sport-bruzou.fr",
    "tennis-club-bruzou.fr",
    "livecafe.fr",
    "pagesperso-orange.fr",
  ]) {
    const ligne = juger.get(domaine) as { non: number };
    assert.equal(ligne.non === 1, !estMessagerie(domaine), domaine);
  }
  db.close();
});
