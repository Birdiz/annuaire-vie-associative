/**
 * Demonstration hors ligne du pipeline de decouverte.
 *
 * Elle sert a repondre a « montre-moi que ca marche » sans envoyer la moindre requete
 * a une vraie mairie : un faux site est servi sur la boucle locale, une commune et
 * ses associations sont deposees a la main comme le lot 2 les aurait ecrites, puis
 * les commandes reelles de la CLI sont appelees dessus.
 *
 * Depuis le lot 4, elle montre aussi le tri de l'etape [4] : quelles pages vaudraient
 * le cout d'une inference, et lesquelles seraient ecartees avant d'en payer une seule.
 * Depuis le lot 5, elle va jusqu'au bout : classification, notation et export CSV.
 *
 * Ce fichier n'est pas du code de production. Il vit dans `scripts/` et n'est jamais
 * importe par `src/` : c'est aussi pourquoi il peut ouvrir un serveur HTTP, ce que la
 * regle de la porte de sortie reseau unique interdit ailleurs.
 */

import { createServer } from "node:http";
import dnsPromises from "node:dns/promises";
import type { AddressInfo } from "node:net";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { openApp } from "../src/app.ts";
import { main } from "../src/cli.ts";
import { normaliserNom } from "../src/texte.ts";

/**
 * Faux site de mairie, ecrit a la main. Il concentre les cas que la decouverte doit
 * savoir traiter : une rubrique associative a suivre, une rubrique d'actualites a
 * ignorer, un tableau qui associe un nom a ses coordonnees, une adresse obfusquee,
 * un mobile que l'invariant §4.6 exclut, et un chemin interdit par robots.txt.
 */
const PAGES: Record<string, [type: string, corps: string]> = {
  "/robots.txt": ["text/plain", "User-agent: *\nDisallow: /prive\n"],
  "/": [
    "text/html",
    `<html><head><title>Mairie de Sainte-Colombe</title></head><body>
      <nav>
        <a href="/vie-associative">Vie associative</a>
        <a href="/actualites">Actualites municipales</a>
        <a href="/marches-publics">Marches publics</a>
        <a href="/plaquette.pdf">Plaquette (PDF)</a>
        <a href="/prive">Espace reserve</a>
      </nav>
      <p>Mairie : <a href="mailto:contact@sainte-colombe.example">contact@sainte-colombe.example</a></p>
    </body></html>`,
  ],
  "/vie-associative": [
    "text/html",
    `<html><head><title>Vie associative</title></head><body>
      <table>
        <tr><th>Association</th><th>Contact</th><th>Telephone</th></tr>
        <tr><td>Club de Sainte-Colombe</td>
            <td><a href="mailto:club@asso.example">ecrire</a></td>
            <td>02 99 00 11 22</td></tr>
        <tr><td>Amicale laique de Sainte-Colombe</td>
            <td>amicale [at] asso [dot] example</td>
            <td>06 12 34 56 78</td></tr>
        <tr><td>Tennis club colombin</td>
            <td>marie.dupont@tennis.example</td>
            <td>02 99 00 11 33</td></tr>
      </table>
      <a href="/annuaire-des-associations">Annuaire complet</a>
    </body></html>`,
  ],
  "/annuaire-des-associations": [
    "text/html",
    `<html><body><ul>
      <li>Comite des fetes de Sainte-Colombe &mdash;
          <a href="mailto:fetes@asso.example">fetes@asso.example</a></li>
    </ul></body></html>`,
  ],
  "/actualites": ["text/html", "<html><body>Conseil municipal du 3 mars.</body></html>"],
  "/marches-publics": ["text/html", "<html><body>Avis d'appel public.</body></html>"],
  "/plaquette.pdf": ["application/pdf", "%PDF-1.4 faux document"],
  "/prive": ["text/html", "<html><body>Cette page ne doit jamais etre demandee.</body></html>"],
};

/**
 * Les associations que le lot 2 aurait deposees, avec leur derniere declaration en
 * prefecture. La date sert au calcul de dormance : le comite des fetes n'a plus
 * declare depuis 2009, il ne compte donc pas dans le denominateur qualifie du taux de
 * couverture, quand bien meme le RNA ne le dit pas dissous.
 */
const ASSOCIATIONS: readonly (readonly [nom: string, declaration: string, objetSocial: string])[] = [
  // Le troisieme champ est le code objet social du RNA. Les trois premiers chiffres
  // donnent le type (ADR-018) — sauf pour le comite des fetes, dont le code dit
  // « loisirs » et dont c'est le nom qui tranche.
  ["Club de Sainte-Colombe", "2025-04-18", "011000"],
  ["Amicale laique de Sainte-Colombe", "2024-09-02", "015000"],
  ["Tennis club colombin", "2023-11-27", "011000"],
  ["Comite des fetes de Sainte-Colombe", "2009-06-15", "007000"],
];

async function demarrerFauxSite(): Promise<{ origin: string; arreter: () => Promise<void> }> {
  const serveur = createServer((req, res) => {
    const entree = PAGES[(req.url ?? "/").split("?")[0] ?? "/"];
    if (entree === undefined) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("introuvable");
      return;
    }
    res.writeHead(200, { "content-type": `${entree[0]}; charset=utf-8` });
    res.end(entree[1]);
  });

  await new Promise<void>((resolve) => serveur.listen(0, "127.0.0.1", resolve));
  const port = (serveur.address() as AddressInfo).port;

  return {
    origin: `http://127.0.0.1:${port}`,
    arreter: () =>
      new Promise<void>((resolve) => {
        serveur.closeAllConnections();
        serveur.close(() => resolve());
      }),
  };
}

/** Depose ce que le lot 2 aurait ecrit : une commune resolue et ses associations. */
function amorcer(dataDir: string, urlMairie: string): void {
  const app = openApp({ dataDir });
  try {
    const maintenant = new Date().toISOString();
    app.db
      .prepare(
        // La provenance est complete : depuis la migration 8, le schema exige les quatre
        // elements du §4.5, methode et score compris.
        `INSERT OR REPLACE INTO commune
           (code_insee, nom, departement, url_mairie, statut_resolution,
            resolution_source_url, resolution_collected_at, source_resolution,
            resolution_confiance, created_at, updated_at)
         VALUES ('35999', 'Sainte-Colombe', '35', ?, 'resolue', ?, ?, 'demo', 0.9, ?, ?)`,
      )
      .run(urlMairie, "https://exemple.fr/demo", maintenant, maintenant, maintenant);

    const inserer = app.db.prepare(
      `INSERT OR IGNORE INTO association
         (rna_id, code_insee, nom, nom_normalise, code_objet_social, source_creation,
          date_declaration, created_at, updated_at)
       VALUES (?, '35999', ?, ?, ?, 'rna', ?, ?, ?)`,
    );
    // Le nom normalise doit passer par la meme fonction que la decouverte, sans quoi
    // le rapprochement echoue sur un simple tiret.
    ASSOCIATIONS.forEach(([nom, declaration, objetSocial], i) => {
      inserer.run(`W3599900${i}`, nom, normaliserNom(nom), objetSocial, declaration, maintenant, maintenant);
    });
  } finally {
    app.close();
  }
}

function titre(texte: string): void {
  process.stdout.write(`\n\x1b[1m${texte}\x1b[0m\n`);
}

const dataDir = join(process.cwd(), "data", "demo");
rmSync(dataDir, { recursive: true, force: true });

// L'URL de contact du User-Agent (§4.4) est obligatoire pour toute collecte. La demo
// n'atteignant qu'un serveur local, une valeur d'exemple suffit.
process.env["ANNUAIRE_CONTACT_URL"] ??= "https://exemple.fr/contact";

// Le lot 5 ouvre une seconde porte de sortie : la resolution MX de l'etape [7]. Elle
// partirait vers le resolveur du systeme, et la promesse « aucune requete ne sort de la
// machine » cesserait d'etre vraie au pied de la lettre. Le resolveur par defaut est
// donc pointe vers un port mort de la boucle locale, exactement comme le fait le
// garde-fou de la suite de tests. Consequence visible et voulue : la demonstration
// affiche des verdicts MX « indetermines », ce qui montre au passage que le code
// distingue « pas de MX » de « je n'ai pas pu savoir ».
dnsPromises.setServers(["127.0.0.1:9"]);

const site = await demarrerFauxSite();
try {
  titre("Faux site de mairie");
  process.stdout.write(`servi sur ${site.origin}, aucune requete ne sort de la machine\n`);

  await main(["init", "--data-dir", dataDir]);
  amorcer(dataDir, `${site.origin}/`);

  titre("Decouverte");
  const code = await main(["decouvrir", "--departement", "35", "--data-dir", dataDir]);

  titre("Contacts collectes");
  await main(["contacts", "--departement", "35", "--data-dir", dataDir]);

  titre("Pre-filtre [4] : ce qui vaudrait le cout d'une inference");
  await main(["pages", "--departement", "35", "--data-dir", dataDir]);

  // Rejeu du filtre depuis le cache disque : aucune requete, pas meme locale. C'est
  // ainsi qu'un seuil se regle sur un vrai corpus sans le recrawler.
  await main(["prefiltrer", "--departement", "35", "--tout", "--data-dir", dataDir]);

  titre("Normalisation [7] et scoring [8]");
  await main(["normaliser", "--departement", "35", "--tout", "--data-dir", dataDir]);

  titre("Associations classees");
  await main(["associations", "--departement", "35", "--data-dir", dataDir]);

  titre("L'annuaire, avec la provenance de chaque ligne");
  const csv = join(dataDir, "annuaire-35.csv");
  await main(["exporter", "--departement", "35", "--data-dir", dataDir, "--fichier", csv]);
  process.stdout.write(readFileSync(csv, "utf8").replace(/\r\n/g, "\n"));

  titre("Dormance des associations");
  await main(["dormance", "--departement", "35", "--data-dir", dataDir]);

  titre("Metriques");
  await main(["metrics", "--data-dir", dataDir]);

  process.stdout.write(
    `\nBase de la demonstration : ${dataDir}\n` +
      "Elle est ignoree par git, et se recree a chaque execution.\n",
  );
  process.exitCode = code;
} finally {
  await site.arreter();
}
