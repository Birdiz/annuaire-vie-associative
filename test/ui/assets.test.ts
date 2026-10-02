import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { ATKINSON_SHA256, HTMX_SHA256, HTMX_VERSION, lireAsset, nomsAssets } from "../../src/ui/assets.ts";

/**
 * htmx est vendorise : une copie exacte, servie depuis cette machine. Le fichier est
 * minifie, donc illisible en revue de diff — son empreinte est la seule chose qui puisse
 * dire qu'il n'a pas bouge.
 */

test("le htmx vendorise est exactement la version annoncee", () => {
  const asset = lireAsset("htmx.min.js");
  assert.ok(asset !== undefined);

  const empreinte = createHash("sha256").update(asset.corps).digest("hex");
  assert.equal(
    empreinte,
    HTMX_SHA256,
    `le fichier htmx vendorise ne correspond plus a l'empreinte de la version ${HTMX_VERSION}`,
  );
  assert.ok(asset.corps.includes(`version:"${HTMX_VERSION}"`), "la version annoncee doit etre celle du fichier");
  assert.match(asset.type, /^text\/javascript/);
});

test("la licence du fichier tiers voyage avec lui", () => {
  const licence = lireAsset("htmx.LICENSE.txt");
  assert.ok(licence !== undefined, "un fichier tiers sans sa licence n'est pas distribuable");
  assert.match(licence.corps.toString("utf8"), /Zero-Clause BSD/);
});

test("ADR-041 : la police embarquee est exactement celle qu'on a recuperee, et sa licence la suit", () => {
  const police = lireAsset("atkinson-hyperlegible-next.woff2");
  assert.ok(police !== undefined);
  assert.equal(createHash("sha256").update(police.corps).digest("hex"), ATKINSON_SHA256);
  assert.equal(police.type, "font/woff2");
  assert.equal(police.corps.subarray(0, 4).toString("latin1"), "wOF2");

  const licence = lireAsset("atkinson-hyperlegible-next.OFL.txt");
  assert.ok(licence !== undefined, "une police sans sa licence n'est pas distribuable");
  assert.match(licence.corps.toString("utf8"), /SIL OPEN FONT LICENSE Version 1\.1/);
});

test("le logo et les raccourcis sont servis sous leur vrai type, sans rien de distant", () => {
  assert.equal(lireAsset("logo.svg")?.type, "image/svg+xml");
  const raccourcis = lireAsset("etabli.js");
  assert.match(raccourcis?.type ?? "", /^text\/javascript/);
  assert.doesNotMatch(raccourcis?.corps.toString("utf8") ?? "", /\bfetch\(|XMLHttpRequest|\beval\(|new Function|https?:/);
});

test("seuls les noms enumeres sont servis", () => {
  assert.deepEqual([...nomsAssets()].sort(), [
    "annuaire.css",
    "atkinson-hyperlegible-next.OFL.txt",
    "atkinson-hyperlegible-next.woff2",
    "etabli.js",
    "htmx.LICENSE.txt",
    "htmx.min.js",
    "logo.svg",
  ]);

  // Deduire le chemin de l'URL ouvrirait la traversee de repertoire sur la machine de
  // l'utilisateur : un serveur local tourne avec ses droits a lui.
  for (const tentative of ["../config.json", "../../package.json", "/etc/passwd", "htmx.min.js.map"]) {
    assert.equal(lireAsset(tentative), undefined, tentative);
  }
});
