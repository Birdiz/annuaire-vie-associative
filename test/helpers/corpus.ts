/**
 * Petit corpus synthetique pour les tests des etapes [7] et [8].
 *
 * Aucune donnee reelle (§5) : les communes, les associations et les adresses sont
 * inventees, et les domaines utilisent `.example`, reserve par la RFC 2606 — un test
 * distrait qui sortirait sur le reseau ne pourrait joindre personne.
 */

import { join } from "node:path";
import type { TestContext } from "node:test";

import { openDatabase } from "../../src/db/index.ts";
import { hashPage } from "../../src/decouverte/contexte.ts";
import { normaliserNom } from "../../src/texte.ts";
import { makeTempDir } from "./tmp.ts";
import type { Database } from "../../src/db/index.ts";

export const CAMPAGNE = "2026-08-22";
export const CODE_INSEE = "35047";
export const DEPARTEMENT = "35";

export type AssociationFixture = { rnaId: string; nom: string; codeObjetSocial: string };

export const ASSOCIATIONS: readonly AssociationFixture[] = [
  { rnaId: "W3510001", nom: "Tennis club de Bruzou", codeObjetSocial: "011000" },
  { rnaId: "W3510002", nom: "Theatre des Grandes Landes", codeObjetSocial: "006030" },
  { rnaId: "W3510003", nom: "Comite des fetes de Bruzou", codeObjetSocial: "007000" },
  { rnaId: "W3510004", nom: "Protection des rives du Ru", codeObjetSocial: "024000" },
];

export type ContactFixture = {
  /** Index dans `ASSOCIATIONS`, ou `null` pour un contact de commune. */
  association: number | null;
  kind: "email" | "phone";
  valeur: string;
  isGenerique: 0 | 1 | null;
  confiance: number;
  methode: string;
  url: string;
};

export type PageFixture = { url: string; verdict: "retenue" | "ecartee" | null };

export const PAGES: readonly PageFixture[] = [
  { url: "https://bruzou.example/associations", verdict: "retenue" },
  { url: "https://bruzou.example/actualites", verdict: "ecartee" },
  { url: "https://bruzou.example/contact", verdict: null },
];

export const CONTACTS: readonly ContactFixture[] = [
  {
    association: 0,
    kind: "email",
    valeur: "contact@tennis-bruzou.example",
    isGenerique: 1,
    confiance: 0.9,
    methode: "dom:mailto+nom",
    url: "https://bruzou.example/associations",
  },
  // Le meme email, vu une seconde fois dans un bloc qui ne nommait aucune association :
  // c'est le doublon commune/association que l'etape [7] doit resorber.
  {
    association: null,
    kind: "email",
    valeur: "contact@tennis-bruzou.example",
    isGenerique: 1,
    confiance: 0.6,
    methode: "texte:motif",
    url: "https://bruzou.example/actualites",
  },
  {
    association: 1,
    kind: "email",
    valeur: "marie.dupont@theatre-landes.example",
    isGenerique: 0,
    confiance: 0.9,
    methode: "dom:mailto+nom",
    url: "https://bruzou.example/associations",
  },
  {
    association: null,
    kind: "email",
    valeur: "mairie@bruzou.example",
    isGenerique: 1,
    confiance: 0.9,
    methode: "dom:mailto",
    url: "https://bruzou.example/contact",
  },
  {
    association: 2,
    kind: "phone",
    valeur: "+33299000000",
    isGenerique: null,
    confiance: 0.6,
    methode: "texte:motif+nom",
    url: "https://bruzou.example/associations",
  },
];

export type Corpus = { dbFile: string; racine: string };

/** Cree une base peuplee et fermee. L'appelant l'ouvre comme il veut. */
export function preparerCorpus(t: TestContext): Corpus {
  const racine = makeTempDir(t);
  const dbFile = join(racine, "corpus.sqlite");
  const db = openDatabase(dbFile);
  try {
    peupler(db);
  } finally {
    db.close();
  }
  return { dbFile, racine };
}

export function peupler(db: Database): void {
  db.prepare(
    "INSERT INTO commune (code_insee, nom, departement, url_mairie, statut_resolution, " +
      "resolution_source_url, resolution_collected_at, source_resolution, resolution_confiance, " +
      "created_at, updated_at) " +
      "VALUES (?, 'Bruzou', ?, 'https://bruzou.example', 'resolue', 'https://source.example', 't', " +
      "'annuaire', 0.9, 't', 't')",
  ).run(CODE_INSEE, DEPARTEMENT);

  const insererAssociation = db.prepare(
    "INSERT INTO association (rna_id, code_insee, nom, nom_normalise, code_objet_social, " +
      "source_creation, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'rna', 't', 't')",
  );
  for (const association of ASSOCIATIONS) {
    insererAssociation.run(
      association.rnaId,
      CODE_INSEE,
      association.nom,
      normaliserNom(association.nom),
      association.codeObjetSocial,
    );
  }

  const insererPage = db.prepare(
    "INSERT INTO page (url_hash, campagne, url, domaine, code_insee, statut, fetched_at, " +
      "profondeur, prefiltre_verdict, prefiltre_version) " +
      "VALUES (?, ?, ?, 'bruzou.example', ?, 'visitee', 't', 1, ?, 1)",
  );
  for (const page of PAGES) {
    insererPage.run(hashPage(CAMPAGNE, CODE_INSEE, page.url), CAMPAGNE, page.url, CODE_INSEE, page.verdict);
  }

  const idParRna = new Map<string, number>();
  for (const ligne of db.prepare("SELECT id, rna_id FROM association").all() as unknown as {
    id: number;
    rna_id: string;
  }[]) {
    idParRna.set(ligne.rna_id, ligne.id);
  }

  const insererContact = db.prepare(
    "INSERT INTO contact (association_id, code_insee, kind, valeur, valeur_normalisee, " +
      "is_generique, source_url, methode_extraction, confiance, collected_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const contact of CONTACTS) {
    const cible = ASSOCIATIONS[contact.association ?? -1];
    insererContact.run(
      cible === undefined ? null : (idParRna.get(cible.rnaId) ?? null),
      CODE_INSEE,
      contact.kind,
      contact.valeur,
      contact.valeur.toLowerCase(),
      contact.isGenerique,
      contact.url,
      contact.methode,
      contact.confiance,
      "2026-08-22T00:00:00.000Z",
    );
  }
}
