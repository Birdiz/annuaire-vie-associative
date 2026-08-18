import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appartientAuDepartement,
  choisirDernierDumpAnnuaire,
  departementDeCodeInsee,
  estEntreeRnaDuDepartement,
  urlDumpRna,
  URL_RNA_IMPORT,
  URL_RNA_WALDEC,
} from "../src/sources.ts";

/** Extrait d'un index de serveur, reduit aux lignes utiles. */
const LISTING = `<html><head><title>Index of /donnees_locales_v4/all/</title></head><body>
<h1>Index of /donnees_locales_v4/all/</h1><hr><pre><a href="../">../</a>
<a href="2026-08-16_050014-data.gouv_local.json">2026-08-16_050014-data.gouv_local.json</a>  16-Aug-2026 07:00  272680000
<a href="2026-08-18_053123-data.gouv_local.json">2026-08-18_053123-data.gouv_local.json</a>  18-Aug-2026 07:00  272682821
<a href="2026-08-17_051200-data.gouv_local.json">2026-08-17_051200-data.gouv_local.json</a>  17-Aug-2026 07:00  272681000
<a href="2026-08-18_050021-data.gouv_commune.zip">2026-08-18_050021-data.gouv_commune.zip</a>  18-Aug-2026 07:00  351208603
</pre><hr></body></html>`;

test("retient le dump le plus recent du listing", () => {
  const url = choisirDernierDumpAnnuaire(LISTING);
  assert.equal(
    url,
    "https://lecomarquage.service-public.gouv.fr/donnees_locales_v4/all/2026-08-18_053123-data.gouv_local.json",
  );
});

test("ignore le dump de competence geographique, qui ne porte aucune URL de mairie", () => {
  const url = choisirDernierDumpAnnuaire(LISTING);
  assert.ok(url !== undefined && !url.includes("commune.zip"));
});

test("un listing sans dump attendu ne rend rien", () => {
  assert.equal(choisirDernierDumpAnnuaire("<pre><a href='../'>../</a></pre>"), undefined);
});

test("le departement se deduit du code INSEE, y compris outre-mer et en Corse", () => {
  assert.equal(departementDeCodeInsee("35238"), "35");
  assert.equal(departementDeCodeInsee("01243"), "01");
  assert.equal(departementDeCodeInsee("97101"), "971");
  assert.equal(departementDeCodeInsee("97612"), "976");
  assert.equal(departementDeCodeInsee("2A004"), "2A");
  assert.equal(departementDeCodeInsee("2b033"), "2B");
});

test("un code INSEE malforme ne rattache a aucun departement", () => {
  assert.equal(departementDeCodeInsee(""), undefined);
  assert.equal(departementDeCodeInsee("352"), undefined);
  assert.equal(departementDeCodeInsee("352380"), undefined);
  assert.equal(departementDeCodeInsee("ABCDE"), undefined);
});

test("l'appartenance a un departement ne confond pas metropole et outre-mer", () => {
  assert.equal(appartientAuDepartement("35238", "35"), true);
  assert.equal(appartientAuDepartement("97101", "97"), false);
  assert.equal(appartientAuDepartement("97101", "971"), true);
  assert.equal(appartientAuDepartement("2A004", "2A"), true);
  assert.equal(appartientAuDepartement("2A004", "2B"), false);
  assert.equal(appartientAuDepartement("29019", "35"), false);
});

test("reconnait l'entree du departement dans un ZIP RNA", () => {
  assert.equal(estEntreeRnaDuDepartement("rna_waldec_20260801_dpt_35.csv", "35"), true);
  assert.equal(estEntreeRnaDuDepartement("rna_waldec_20260801_dpt_29.csv", "35"), false);
  // Le suffixe doit etre exact : le departement 5 n'existe pas et ne doit pas capter le 35.
  assert.equal(estEntreeRnaDuDepartement("rna_waldec_20260801_dpt_35.csv", "5"), false);
  assert.equal(estEntreeRnaDuDepartement("rna_waldec_20260801_dpt_2A.csv", "2a"), true);
});

test("chaque source RNA a son URL", () => {
  assert.equal(urlDumpRna("rna_waldec"), URL_RNA_WALDEC);
  assert.equal(urlDumpRna("rna_import"), URL_RNA_IMPORT);
});
