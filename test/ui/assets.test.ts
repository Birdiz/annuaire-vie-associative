import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { HTMX_SHA256, HTMX_VERSION, lireAsset, nomsAssets } from "../../src/ui/assets.ts";

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

test("seuls les noms enumeres sont servis", () => {
  assert.deepEqual([...nomsAssets()].sort(), ["annuaire.css", "htmx.LICENSE.txt", "htmx.min.js"]);

  // Deduire le chemin de l'URL ouvrirait la traversee de repertoire sur la machine de
  // l'utilisateur : un serveur local tourne avec ses droits a lui.
  for (const tentative of ["../config.json", "../../package.json", "/etc/passwd", "htmx.min.js.map"]) {
    assert.equal(lireAsset(tentative), undefined, tentative);
  }
});
