/**
 * Demonstration hors ligne du pipeline de decouverte.
 *
 * Elle sert a repondre a « montre-moi que ca marche » sans envoyer la moindre requete
 * a une vraie mairie : un faux site est servi sur la boucle locale, une commune et
 * ses associations sont deposees a la main comme le lot 2 les aurait ecrites, puis
 * les commandes reelles de la CLI sont appelees dessus.
 *
 * Ce fichier n'est pas du code de production. Il vit dans `scripts/` et n'est jamais
 * importe par `src/` : c'est aussi pourquoi il peut ouvrir un serveur HTTP, ce que la
 * regle de la porte de sortie reseau unique interdit ailleurs.
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { rmSync } from "node:fs";
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

const ASSOCIATIONS = [
  "Club de Sainte-Colombe",
  "Amicale laique de Sainte-Colombe",
  "Tennis club colombin",
  "Comite des fetes de Sainte-Colombe",
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
        `INSERT OR REPLACE INTO commune
           (code_insee, nom, departement, url_mairie, statut_resolution,
            resolution_source_url, resolution_collected_at, resolution_confiance,
            created_at, updated_at)
         VALUES ('35999', 'Sainte-Colombe', '35', ?, 'resolue', ?, ?, 0.9, ?, ?)`,
      )
      .run(urlMairie, "https://exemple.fr/demo", maintenant, maintenant, maintenant);

    const inserer = app.db.prepare(
      `INSERT OR IGNORE INTO association
         (rna_id, code_insee, nom, nom_normalise, source_creation, created_at, updated_at)
       VALUES (?, '35999', ?, ?, 'rna', ?, ?)`,
    );
    // Le nom normalise doit passer par la meme fonction que la decouverte, sans quoi
    // le rapprochement echoue sur un simple tiret.
    ASSOCIATIONS.forEach((nom, i) => {
      inserer.run(`W3599900${i}`, nom, normaliserNom(nom), maintenant, maintenant);
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
