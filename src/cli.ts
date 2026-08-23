// Surface de commandes de l'outil. Le point d'entree, lui, vit dans `bin.ts` : ce
// module n'expose que `main`, ce qui le rend testable et bundlable (ADR-022).
import { parseArgs } from "node:util";
import sea from "node:sea";
import { existsSync, createWriteStream } from "node:fs";
import { once } from "node:events";
import { openApp, requireClient, startupPurge } from "./app.ts";
import type { PurgeResult } from "./purge.ts";
import type { App } from "./app.ts";
import { writeConfigTemplate, ConfigError } from "./config.ts";
import { installShutdownHandlers } from "./jobs/worker.ts";
import type { JobState } from "./jobs/queue.ts";
import { MIGRATIONS } from "./db/migrations.ts";
import { VERSION } from "./version.ts";
import { executerRun, executerDecouverteSeule, refusDepartement, departementBienForme } from "./pipeline.ts";
import type { OptionsDecouverte } from "./pipeline.ts";
import { PAGES_MAX_PAR_COMMUNE, estReseauSocial } from "./decouverte/scoring.ts";
import { SEUIL_EXTRACTION, SEUIL_PAR_DEFAUT } from "./decouverte/prefiltre.ts";
import { derniereCampagne, distributionPrefiltre, rejouerPrefiltre } from "./decouverte/rejeu.ts";
import { distributionNormalisation } from "./normalisation/rejeu.ts";
import { normaliser } from "./normalisation/rejeu.ts";
import { compterLignes, lignesCsv } from "./export/csv.ts";
import { demarrerServeur, ADRESSE_ECOUTE } from "./ui/serveur.ts";
import { PiloteRun } from "./ui/pilote.ts";
import { ouvrirNavigateur } from "./ui/navigateur.ts";
import { mesurerDormance } from "./metrics/dormance.ts";
import { mesurerCouverture } from "./metrics/couverture.ts";
import { ETATS_JOB } from "./jobs/queue.ts";
import { messageDe } from "./log.ts";
import { oublier } from "./oubli.ts";
import type { Portee } from "./oubli.ts";
import { formaterOctets } from "./texte.ts";

/** Port d'ecoute de l'interface locale. Le port est reglable, l'adresse ne l'est pas. */
const PORT_UI_PAR_DEFAUT = 8787;

/** D2 : departement de validation, quand la base est vide et qu'aucun n'est demande. */
const DEPARTEMENT_PAR_DEFAUT = "35";

const USAGE = `annuaire ${VERSION} — annuaire de la vie associative locale

Usage : annuaire <commande> [options]

Commandes
  init                    Prepare le repertoire de donnees et la base
  run --departement <dd>  Execute un run complet : amorce, resolution, puis decouverte
  decouvrir --departement <dd>  Rejoue la seule decouverte sur une base deja amorcee
  communes --departement <dd>   Communes du departement et URL de leur mairie
  prefiltrer --departement <dd> Rejoue le pre-filtre [4] depuis le cache, sans reseau
  normaliser --departement <dd> Rejoue la normalisation [7] et le scoring [8]
  exporter --departement <dd>   Exporte l'annuaire en CSV
  contacts --departement <dd>   Contacts collectes, avec leur provenance
  pages --departement <dd>      Pages explorees et verdict du pre-filtre
  associations --departement <dd>  Associations amorcees, avec leur commune
  dormance --departement <dd>   Anciennete de declaration des associations
  dumps                   Etat des dumps ouverts et de leur reprise
  ui [--port <n>]         Sert l'interface locale : lancement et suivi d'un run,
                          revue, export — puis ouvre le navigateur
  status                  Etat de l'installation et de la file de jobs
  metrics [--json]        Compteurs du §8
  jobs [--state <etat>]   Liste les jobs d'un etat donne (defaut : dead)
  requeue <id|cle>        Remet en attente un job termine, ecarte ou mort
          [--state <etat>]  ... ou tous ceux d'un etat donne
  purge                   Force la purge des donnees de plus de trois ans
  fetch <url>             Recupere une URL via le client conforme (diagnostic)
  oublier --contact <v>   Efface une donnee et l'empeche de revenir (art. 17 et 21)
          | --domaine <d> | --commune <insee>   --motif <texte> obligatoire

Options de run
  --avec-import           Ajoute l'extraction RNA « import » (associations sans
                          mouvement declare depuis 2009, souvent dormantes)
  --rna-file <chemin>     Lit un ZIP RNA officiel telecharge a la main plutot que le
                          miroir agrege : 6,5 Mo au lieu de 1,25 Go pour un departement
  --sans-decouverte       S'arrete apres l'amorce, sans explorer les sites de mairie

Options de decouverte
  --max-pages <n>         Pages explorees au maximum par commune (defaut : ${PAGES_MAX_PAR_COMMUNE})
  --avec-mobiles          RISQUE. Conserve les numeros en 06/07, que le brief exclut
                          par defaut (§4.6) : un mobile associatif est presque toujours
                          la ligne personnelle d'un benevole. A n'activer qu'en
                          connaissance du regime applicable.

Options de pre-filtre
  --seuil <n>             Score a partir duquel une page est retenue (defaut : ${SEUIL_PAR_DEFAUT})
  --campagne <aaaa-mm-jj> Campagne rejouee (defaut : la derniere connue)
  --tout                  Recalcule aussi les verdicts deja a jour
  --verdict <r>           Filtre la liste des pages : retenue ou ecartee

Options de normalisation
  --tout                  Reclasse et renote aussi ce qui est deja a jour, et
                          reinterroge les verdicts MX encore frais

Options d'export
  --fichier <chemin>      Ecrit dans un fichier plutot que sur la sortie standard
  --score-min <n>         Ne retient que les contacts notes au moins a cette valeur
                          (entre 0 et 1, par exemple 0.6)
  --avec-rejetes          Sort aussi les contacts qu'un humain a rejetes en revue,
                          exclus par defaut

Options d'oubli
  --contact <valeur>      Efface cette adresse ou ce numero, sous sa forme normalisee
  --domaine <domaine>     Efface toutes les adresses de ce domaine de messagerie
  --commune <insee>       Efface tout ce qui est rattache a cette commune
  --motif <texte>         Obligatoire : au nom de quoi l'effacement a lieu. Il est
                          conserve, et fait la preuve de la demande honoree.

Options d'interface
  --port <n>              Port d'ecoute (defaut : ${PORT_UI_PAR_DEFAUT}). L'interface
                          n'ecoute que sur ${ADRESSE_ECOUTE}, et cela n'est pas reglable.
  --sans-navigateur       N'ouvre pas le navigateur au demarrage

Codes de sortie
  0                       Succes. C'est aussi le code de « ui » arrete par Ctrl+C :
                          l'interrompre est sa facon normale de finir.
  1                       Echec d'execution
  2                       Erreur d'usage : argument absent, invalide ou refuse
  130                     Collecte interrompue par Ctrl+C. Le travail deja commite est
                          conserve, et relancer la meme commande reprend ou elle en
                          etait (§4.9).

Options communes
  --data-dir <chemin>     Repertoire de donnees (defaut : emplacement systeme)
  --limit <n>             Nombre de lignes listees (defaut : 50)
  --verbose               Journalisation detaillee
  --help, --version

Les invariants — respect de robots.txt, delai de 2 s par domaine, purge a trois ans —
ne sont pas configurables et n'ont donc pas d'option.
`;


/**
 * Ce que fait l'outil quand on ne lui demande rien.
 *
 * Double-cliquer sur l'executable Windows, c'est lancer `annuaire` sans argument. Le §2
 * du brief decrit pourtant l'artefact comme « un serveur HTTP sur localhost qui sert une
 * UI, puis ouvre le navigateur » : y repondre par une page d'aide dans une console rate
 * la cible. L'emballage est donc interroge — `sea.isSea()` est un fait de construction,
 * pas une heuristique d'environnement comme celle que l'ADR-023 a ecartee pour le
 * conteneur. `npx` et l'image Docker, dont les utilisateurs ont un terminal sous les
 * yeux, gardent l'aide et son code de sortie.
 */
function commandeParDefaut(): string | undefined {
  return sea.isSea() ? "ui" : undefined;
}

export async function main(argv: readonly string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        "data-dir": { type: "string" },
        departement: { type: "string" },
        state: { type: "string" },
        "rna-file": { type: "string" },
        "avec-import": { type: "boolean", default: false },
        "sans-decouverte": { type: "boolean", default: false },
        "avec-mobiles": { type: "boolean", default: false },
        "max-pages": { type: "string" },
        campagne: { type: "string" },
        seuil: { type: "string" },
        verdict: { type: "string" },
        fichier: { type: "string" },
        "score-min": { type: "string" },
        "avec-rejetes": { type: "boolean", default: false },
        contact: { type: "string" },
        domaine: { type: "string" },
        commune: { type: "string" },
        motif: { type: "string" },
        port: { type: "string" },
        "sans-navigateur": { type: "boolean", default: false },
        tout: { type: "boolean", default: false },
        limit: { type: "string" },
        json: { type: "boolean", default: false },
        verbose: { type: "boolean", default: false },
        help: { type: "boolean", default: false },
        version: { type: "boolean", default: false },
      },
    });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }

  const { values, positionals } = parsed;
  if (values.version === true) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const commande = positionals[0] ?? commandeParDefaut();
  if (values.help === true || commande === undefined || commande === "help") {
    process.stdout.write(USAGE);
    return commande === undefined && values.help !== true ? 2 : 0;
  }

  /**
   * Ouvre l'application, **et purge**.
   *
   * §4.8 dit « execute au demarrage », pas « execute par les commandes qui y pensent ».
   * L'appel vivait dans cinq fonctions sur dix-neuf : `exporter` — la seule commande dont
   * la sortie quitte la machine — pouvait livrer un CSV portant des contacts de plus de
   * trois ans. Le mettre ici est ce qui rend l'invariant vrai par construction : il n'y a
   * plus de liste a tenir a jour. Sur une base propre l'operation ne coute rien.
   */
  let dernierePurge: PurgeResult | undefined;
  const ouvrir = (): App => {
    const app = openApp({
      dataDir: values["data-dir"],
      logLevel: values.verbose === true ? "debug" : "info",
      // En sortie JSON, le journal ne doit pas polluer stdout.
      console: !(values.json === true),
    });
    dernierePurge = startupPurge(app);
    return app;
  };

  const decouverte = lireOptionsDecouverte(values["max-pages"], values["avec-mobiles"] === true);
  if (decouverte === undefined) {
    process.stderr.write(`--max-pages attend un entier positif, recu « ${values["max-pages"]} »\n`);
    return 2;
  }

  try {
    switch (commande) {
      case "init":
        return commandeInit(ouvrir);
      case "ui":
        return await commandeUi(
          ouvrir,
          values.port,
          values.departement,
          values["sans-navigateur"] === true,
        );
      case "status":
        return commandeStatus(ouvrir);
      case "metrics":
        return commandeMetrics(ouvrir, values.json === true);
      case "jobs":
        return commandeJobs(ouvrir, values.state);
      case "requeue":
        return commandeRequeue(ouvrir, positionals[1], values.state);
      case "purge":
        return commandePurge(ouvrir, () => dernierePurge);
      case "run":
        return await commandeRun(ouvrir, values.departement, {
          avecImport: values["avec-import"] === true,
          rnaFile: values["rna-file"],
          sansDecouverte: values["sans-decouverte"] === true,
          decouverte,
        });
      case "decouvrir":
        return await commandeDecouvrir(ouvrir, values.departement, decouverte);
      case "prefiltrer":
        return commandePrefiltrer(ouvrir, values.departement, {
          campagne: values.campagne,
          seuil: values.seuil,
          tout: values.tout === true,
          avecMobiles: values["avec-mobiles"] === true,
          json: values.json === true,
        });
      case "normaliser":
        return await commandeNormaliser(ouvrir, values.departement, {
          tout: values.tout === true,
          json: values.json === true,
        });
      case "exporter":
        return commandeExporter(ouvrir, values.departement, {
          fichier: values.fichier,
          scoreMin: values["score-min"],
          avecRejetes: values["avec-rejetes"] === true,
        });
      case "contacts":
        return commandeContacts(ouvrir, values.departement, values.json === true, values.limit);
      case "pages":
        return commandePages(ouvrir, values.departement, values.verdict, values.json === true, values.limit);
      case "dormance":
        return commandeDormance(ouvrir, values.departement, values.json === true);
      case "communes":
        return commandeCommunes(ouvrir, values.departement, values.json === true, values.limit);
      case "associations":
        return commandeAssociations(ouvrir, values.departement, values.json === true, values.limit);
      case "dumps":
        return commandeDumps(ouvrir, values.json === true);
      case "fetch":
        return await commandeFetch(ouvrir, positionals[1]);
      case "oublier":
        return commandeOublier(ouvrir, {
          contact: values.contact,
          domaine: values.domaine,
          commune: values.commune,
          motif: values.motif,
          json: values.json === true,
        });
      default:
        process.stderr.write(`Commande inconnue : ${commande}\n\n${USAGE}`);
        return 2;
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      return 78; // EX_CONFIG
    }
    process.stderr.write(`Echec : ${messageDe(error)}\n`);
    return 1;
  }
}

function commandeInit(ouvrir: () => App): number {
  const app = ouvrir();
  try {
    const cree = writeConfigTemplate(app.paths.configFile);
    process.stdout.write(
      [
        `Repertoire de donnees : ${app.paths.dataDir}`,
        `Base                  : ${app.paths.dbFile}`,
        `Schema                : version ${MIGRATIONS.length}`,
        `Configuration         : ${app.paths.configFile}${cree ? " (creee)" : " (existante)"}`,
        "",
        app.config.contactUrl === undefined
          ? "Renseignez contactUrl dans la configuration avant toute collecte : le\n" +
            "User-Agent doit inclure une URL permettant a un webmestre de vous joindre.\n"
          : `URL de contact        : ${app.config.contactUrl}\n`,
      ].join("\n"),
    );
    return 0;
  } finally {
    app.close();
  }
}

/**
 * Sert l'interface locale jusqu'au premier signal d'arret.
 *
 * **Depuis le lot 8, un run se lance d'ici** (ADR-024) : le worker tourne dans ce
 * process, et `PiloteRun` en tient l'etat. Un `annuaire run` demarre dans un autre
 * terminal reste par ailleurs visible a travers le WAL, sans que les deux process aient a
 * se connaitre — c'est pour cela que le mode WAL a ete choisi au lot 1.
 *
 * La subtilite de cette fonction est **l'ordre d'arret**, et il n'est pas negociable :
 *
 * 1. le gestionnaire de signal est installe avant l'ecoute et avant l'ouverture du
 *    navigateur — pose apres, un Ctrl+C dans cette fenetre prend le gestionnaire par
 *    defaut de Node et saute la fermeture propre ;
 * 2. `pilote.fermer()` ferme la porte : plus aucun run ne demarre ;
 * 3. `pilote.attendre()` laisse finir celui qui tourne ;
 * 4. `serveur.fermer()` cesse d'ecouter ;
 * 5. `app.close()` ferme la base — sous un worker vivant, ce serait la seule facon de
 *    perdre du travail dans ce lot.
 */
async function commandeUi(
  ouvrir: () => App,
  port: string | undefined,
  departement: string | undefined,
  sansNavigateur: boolean,
): Promise<number> {
  const numero = port === undefined ? PORT_UI_PAR_DEFAUT : Number(port);
  if (!Number.isInteger(numero) || numero < 0 || numero > 65535) {
    process.stderr.write(`--port attend un entier entre 0 et 65535, recu « ${port} »\n`);
    return 2;
  }

  const app = ouvrir();
  const pilote = new PiloteRun(app);

  // Installe **avant** l'ecoute et l'ouverture du navigateur. Pose apres, il laissait une
  // fenetre — le spawn du navigateur, quelques lignes sur stdout — pendant laquelle un
  // Ctrl+C prenait le gestionnaire par defaut de Node : terminaison immediate, et le
  // `finally { app.close() }` jamais execute.
  const controller = installShutdownHandlers(() => {
    process.stdout.write("Arret de l'interface.\n");
    if (pilote.arreter()) {
      process.stdout.write("Un run est en cours : les jobs deja pris vont finir.\n");
    }
  });

  let serveur;
  try {
    serveur = await demarrerServeur({
      port: numero,
      db: app.db,
      queue: app.queue,
      counters: app.counters,
      clock: app.clock,
      version: VERSION,
      departementSecours: departement ?? DEPARTEMENT_PAR_DEFAUT,
      pilote,
      reglages: {
        contactUrl: () => app.config.contactUrl,
        parEnvironnement: () => {
          const valeur = process.env["ANNUAIRE_CONTACT_URL"];
          return valeur !== undefined && valeur !== "";
        },
        enregistrer: (valeur) => app.configurerContactUrl(valeur),
      },
      supprimerCache: (chemin) => app.cache.supprimerParChemin(chemin),
      logger: app.logger,
    });
  } catch (cause) {
    app.close();
    if ((cause as { code?: string }).code === "EADDRINUSE") {
      process.stderr.write(
        `Le port ${numero} est deja pris. Choisissez-en un autre : annuaire ui --port ${numero + 1}\n`,
      );
      return 1;
    }
    throw cause;
  }

  process.stdout.write(
    [
      "Interface locale disponible :",
      "",
      `  ${serveur.url}`,
      "",
      `Le serveur n'ecoute que sur ${ADRESSE_ECOUTE} et rien n'en sort. Le jeton de`,
      "l'adresse est tire a ce demarrage et change au suivant : c'est lui qui empeche une",
      "page ouverte par ailleurs dans le navigateur d'ecrire dans cette base.",
      "",
      "Ctrl+C pour arreter.",
      "",
    ].join("\n"),
  );

  // Le §2 du brief : l'artefact « sert une UI web, puis ouvre le navigateur ». Un echec
  // ne coute rien — l'adresse vient d'etre imprimee juste au-dessus.
  if (!sansNavigateur) ouvrirNavigateur(serveur.url);

  try {
    if (!controller.signal.aborted) {
      await new Promise<void>((resoudre) => {
        controller.signal.addEventListener("abort", () => resoudre(), { once: true });
      });
    }
    // L'ordre compte : plus aucun run ne peut demarrer, on attend celui qui tourne, on
    // ferme l'ecoute, et seulement alors la base. Fermer la base sous un worker vivant
    // est la seule facon de perdre du travail dans ce lot.
    pilote.fermer();
    await pilote.attendre();
    await serveur.fermer();
    return 0;
  } finally {
    app.close();
  }
}

function commandeStatus(ouvrir: () => App): number {
  const app = ouvrir();
  try {
    const counts = app.queue.counts();
    const runs = app.db
      .prepare("SELECT id, departement, started_at, finished_at, statut FROM run ORDER BY id DESC LIMIT 5")
      .all() as { id: number; departement: string; started_at: string; finished_at: string | null; statut: string }[];

    const lignes = [
      `Repertoire   : ${app.paths.dataDir}`,
      `Schema       : version ${MIGRATIONS.length}`,
      `Contact      : ${app.config.contactUrl ?? "non configure — collecte impossible"}`,
      `LLM          : ${app.config.llm.provider}`,
      "",
      `Jobs         : ${ETATS_JOB.map((etat) => `${etat}=${counts[etat]}`).join("  ")}`,
      "",
      runs.length === 0 ? "Aucun run enregistre." : "Derniers runs :",
      ...runs.map(
        (run) =>
          `  #${run.id}  dept ${run.departement}  ${run.statut}  debut ${run.started_at}` +
          `${run.finished_at === null ? "" : `  fin ${run.finished_at}`}`,
      ),
    ];
    process.stdout.write(`${lignes.join("\n")}\n`);
    return counts.dead > 0 ? 1 : 0;
  } finally {
    app.close();
  }
}

function commandeMetrics(ouvrir: () => App, json: boolean): number {
  const app = ouvrir();
  try {
    const globales = app.counters.snapshot();
    const runs = app.db.prepare("SELECT id, departement FROM run ORDER BY id").all() as {
      id: number;
      departement: string;
    }[];

    const parRun = runs.map((run) => ({
      run: run.id,
      departement: run.departement,
      metriques: app.counters.forRun(run.id).snapshot(),
    }));

    if (json) {
      process.stdout.write(`${JSON.stringify({ version: VERSION, globales, runs: parRun }, null, 2)}\n`);
      return 0;
    }

    process.stdout.write(`${formatMetrics("Global", globales)}\n`);
    for (const entree of parRun) {
      process.stdout.write(`${formatMetrics(`Run #${entree.run} (dept ${entree.departement})`, entree.metriques)}\n`);
    }
    return 0;
  } finally {
    app.close();
  }
}

function formatMetrics(titre: string, metriques: Record<string, Record<string, number>>): string {
  const etapes = Object.entries(metriques);
  if (etapes.length === 0) return `${titre}\n  (aucun compteur)`;
  return [
    titre,
    ...etapes.flatMap(([etape, valeurs]) => [
      `  ${etape}`,
      ...Object.entries(valeurs).map(([nom, valeur]) => `    ${nom.padEnd(28)} ${valeur}`),
    ]),
  ].join("\n");
}

function commandeJobs(ouvrir: () => App, etatDemande: string | undefined): number {
  const etat = (etatDemande ?? "dead") as JobState;
  if (!ETATS_JOB.includes(etat)) {
    process.stderr.write(`Etat inconnu : ${etat} (attendu : ${ETATS_JOB.join(", ")})\n`);
    return 2;
  }

  const app = ouvrir();
  try {
    const jobs = app.queue.list(etat);
    if (jobs.length === 0) {
      process.stdout.write(`Aucun job dans l'etat ${etat}.\n`);
      return 0;
    }
    for (const job of jobs) {
      const detail = job.lastError ?? job.reason ?? "";
      process.stdout.write(
        `#${job.id}  ${job.type}  ${job.dedupKey}  tentatives ${job.attempts}/${job.maxAttempts}` +
          `${detail === "" ? "" : `\n      ${detail}`}\n`,
      );
    }
    return 0;
  } finally {
    app.close();
  }
}

/**
 * Reenfile un job. Existe parce que les cles de deduplication portent une periode : le
 * jour pour l'Annuaire, le mois pour le RNA. Elles raisonnent sur la source et jamais
 * sur le lecteur, si bien qu'une migration qui lit de nouvelles colonnes dans le meme
 * fichier ne peut pas se rejouer avant la periode suivante. Le seul recours etait
 * jusqu'ici d'ouvrir la base au SQL.
 */
function commandeRequeue(
  ouvrir: () => App,
  selecteur: string | undefined,
  etatDemande: string | undefined,
): number {
  if (selecteur === undefined && etatDemande === undefined) {
    process.stderr.write(
      "Un job est requis : annuaire requeue <id|cle>, ou annuaire requeue --state dead\n",
    );
    return 2;
  }
  if (etatDemande !== undefined && !ETATS_JOB.includes(etatDemande as JobState)) {
    process.stderr.write(`Etat inconnu : ${etatDemande} (attendu : ${ETATS_JOB.join(", ")})\n`);
    return 2;
  }

  const app = ouvrir();
  try {
    // Un identifiant numerique et une cle de deduplication ne se confondent pas : les
    // cles du projet portent toutes un « : ».
    const cible =
      selecteur === undefined
        ? { state: etatDemande as JobState }
        : /^\d+$/.test(selecteur)
          ? { id: Number(selecteur) }
          : { dedupKey: selecteur };

    const remis = app.queue.requeue(cible);
    if (remis === 0) {
      process.stdout.write(
        "Aucun job remis en attente. Seuls les jobs termines, en echec, morts ou ecartes\n" +
          "peuvent l'etre : un job deja en attente y est deja, un job en vol ne doit pas\n" +
          "etre double. Verifiez avec : annuaire jobs --state <etat>\n",
      );
      return 1;
    }
    process.stdout.write(
      `${remis} ${remis === 1 ? "job remis" : "jobs remis"} en attente. ` +
        "Relancez la commande qui les traite.\n",
    );
    return 0;
  } finally {
    app.close();
  }
}

/**
 * La purge n'est plus declenchee ici : `ouvrir()` l'a faite, comme pour toute autre
 * commande (§4.8). Cette commande-ci en **rend compte** — elle reste le moyen de voir la
 * borne de retention et ce qu'elle a emporte, sans avoir a lancer un run.
 */
function commandePurge(ouvrir: () => App, purgeFaite: () => PurgeResult | undefined): number {
  const app = ouvrir();
  try {
    const resultat = purgeFaite();
    if (resultat === undefined) throw new Error("La purge d'ouverture n'a pas eu lieu.");
    process.stdout.write(
      `Purge jusqu'au ${resultat.cutoff} : ${resultat.contacts} contacts, ${resultat.pages} pages, ` +
        `${resultat.runs} runs, ${resultat.domaines} verdicts MX, ${resultat.entreesCache} entrees de cache.\n`,
    );
    return 0;
  } finally {
    app.close();
  }
}

async function commandeRun(
  ouvrir: () => App,
  departement: string | undefined,
  options: {
    avecImport: boolean;
    rnaFile: string | undefined;
    sansDecouverte: boolean;
    decouverte: OptionsDecouverte;
  },
): Promise<number> {
  const refus = refusDepartement(departement);
  if (refus !== undefined || departement === undefined) {
    process.stderr.write(`${refus ?? ""}\nExemple : annuaire run --departement 35\n`);
    return 2;
  }

  if (options.rnaFile !== undefined && !existsSync(options.rnaFile)) {
    process.stderr.write(`Fichier RNA introuvable : ${options.rnaFile}\n`);
    return 2;
  }

  const app = ouvrir();
  try {
    const controller = installShutdownHandlers(() => {
      app.logger.warn("Arret demande : plus aucun job n'est pris, les jobs en cours vont finir");
    });

    const { interrompu } = await executerRun(app, { departement, ...options }, controller.signal);

    resumeRun(app, departement);
    return interrompu ? 130 : 0;
  } finally {
    app.close();
  }
}

/**
 * Art. 17 et 21 : effacer, et empecher de revenir.
 *
 * La suppression seule ne suffirait pas — le run suivant recollecterait la donnee et
 * personne ne s'en apercevrait. C'est l'exclusion qui est l'objet durable ; la
 * suppression n'en est que la consequence immediate.
 */
function commandeOublier(
  ouvrir: () => App,
  options: {
    contact: string | undefined;
    domaine: string | undefined;
    commune: string | undefined;
    motif: string | undefined;
    json: boolean;
  },
): number {
  const portees: [Portee, string | undefined][] = [
    ["contact", options.contact],
    ["domaine", options.domaine],
    ["commune", options.commune],
  ];
  const choisies = portees.filter(([, valeur]) => valeur !== undefined);
  if (choisies.length !== 1) {
    process.stderr.write(
      "Indiquez exactement une portee : --contact, --domaine ou --commune.\n" +
        "  annuaire oublier --contact prenom.nom@mairie.example --motif « opposition du 12/03 »\n",
    );
    return 2;
  }
  const [portee, valeur] = choisies[0] as [Portee, string];

  if (options.motif === undefined || options.motif.trim() === "") {
    process.stderr.write(
      "--motif est obligatoire : un responsable de traitement doit pouvoir dire au nom de\n" +
        "quoi il a efface, et le prouver.\n",
    );
    return 2;
  }

  const app = ouvrir();
  try {
    const resultat = oublier(
      app.db,
      app.clock,
      app.counters,
      { portee, valeur, motif: options.motif, origine: "cli" },
      (chemin) => app.cache.supprimerParChemin(chemin),
    );

    if (options.json) {
      process.stdout.write(`${JSON.stringify(resultat, null, 2)}\n`);
      return 0;
    }

    process.stdout.write(
      `${resultat.contactsSupprimes} contact(s) supprime(s), ` +
        `${resultat.entreesCacheSupprimees} entree(s) de cache effacee(s).\n` +
        (resultat.nouvelle
          ? `L'exclusion est inscrite : ${portee} « ${resultat.valeur} » ne rentrera plus.\n`
          : `L'exclusion existait deja pour ${portee} « ${resultat.valeur} ».\n`) +
        "Le site tiers, lui, publie toujours cette donnee : un nouveau crawl la remettra\n" +
        "dans le cache HTTP, ou la purge a trois ans l'emportera. Ce qui est garanti est\n" +
        "qu'elle ne rentrera plus dans l'annuaire exporte.\n",
    );
    return 0;
  } finally {
    app.close();
  }
}

function hoteDe(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/**
 * Diagnostic : passe une URL par le client conforme et rend compte de ce qui s'est
 * applique. Sert a verifier une installation sans attendre le lot 2.
 */
async function commandeFetch(ouvrir: () => App, url: string | undefined): Promise<number> {
  if (url === undefined) {
    process.stderr.write("Une URL est requise : annuaire fetch https://exemple.fr/associations\n");
    return 2;
  }

  // §5 du brief : l'interdit des reseaux sociaux est absolu. Les trois chemins de crawl
  // le tiennent sur l'hote final ; cette commande-ci, qui court-circuite le crawl, ne le
  // tenait pas — et ce qu'elle telecharge entre dans le cache, d'ou le rejeu le relit.
  // Le robots.txt de ces sites n'y change rien : l'interdit ne dit pas « sauf s'il
  // l'autorise ».
  const hote = hoteDe(url);
  if (hote === undefined) {
    process.stderr.write(`URL invalide : ${url}\n`);
    return 2;
  }
  if (estReseauSocial(hote)) {
    process.stderr.write(
      `${hote} est un reseau social : le §5 du brief l'exclut sans exception, y compris ici.\n`,
    );
    return 2;
  }

  const app = ouvrir();
  try {
    const client = requireClient(app);
    const resultat = await client.fetch(url);

    switch (resultat.kind) {
      case "blocked":
        process.stdout.write(`Ecarte : ${resultat.reason}\n`);
        return 0;
      case "status":
        process.stdout.write(`Statut ${resultat.status} sur ${resultat.finalUrl}\n`);
        return 1;
      case "ok":
        process.stdout.write(
          [
            `Source        : ${resultat.source}`,
            `Statut        : ${resultat.meta.status}`,
            `URL finale    : ${resultat.meta.finalUrl}`,
            `Type          : ${resultat.meta.contentType ?? "inconnu"}`,
            `Taille        : ${resultat.meta.size} octets`,
            `Recupere le   : ${resultat.meta.fetchedAt}`,
            `Cache         : ${client.cachePathFor(url)}`,
            "",
          ].join("\n"),
        );
        return 0;
    }
  } finally {
    app.close();
  }
}

/** Nombre de lignes listees par defaut, pour ne pas noyer un terminal. */
const LIMITE_PAR_DEFAUT = 50;

function lireLimite(brut: string | undefined): number {
  if (brut === undefined) return LIMITE_PAR_DEFAUT;
  const valeur = Number(brut);
  return Number.isInteger(valeur) && valeur > 0 ? valeur : LIMITE_PAR_DEFAUT;
}

/**
 * Controle de forme des commandes de lecture. Le motif n'est plus recopie ici : il vivait
 * en double, et la copie avait deja perdu le refus d'Alsace-Moselle — `decouvrir`, qui
 * collecte, passait par elle. Cette commande-ci passe desormais par `pipeline.ts`, et
 * `decouvrir` par le controle complet.
 */
function exigerDepartement(departement: string | undefined, commande: string): departement is string {
  if (departementBienForme(departement)) return true;
  process.stderr.write(`Un departement est requis : annuaire ${commande} --departement 35\n`);
  return false;
}

/**
 * Le jalon du lot 2 : les communes d'un departement avec l'URL de leur mairie.
 */
function commandeCommunes(
  ouvrir: () => App,
  departement: string | undefined,
  json: boolean,
  limite: string | undefined,
): number {
  if (!exigerDepartement(departement, "communes")) return 2;
  const app = ouvrir();
  try {
    const lignes = app.db
      .prepare(
        "SELECT code_insee, nom, url_mairie, statut_resolution, resolution_source_url " +
          "FROM commune WHERE departement = ? ORDER BY code_insee LIMIT ?",
      )
      .all(departement, lireLimite(limite));

    const total = Number(
      (app.db.prepare("SELECT count(*) AS n FROM commune WHERE departement = ?").get(departement) as { n?: number })
        ?.n ?? 0,
    );
    const resolues = Number(
      (
        app.db
          .prepare("SELECT count(*) AS n FROM commune WHERE departement = ? AND statut_resolution = 'resolue'")
          .get(departement) as { n?: number }
      )?.n ?? 0,
    );

    if (json) {
      process.stdout.write(`${JSON.stringify({ departement, total, resolues, communes: lignes }, null, 2)}\n`);
      return 0;
    }

    if (total === 0) {
      process.stdout.write(`Aucune commune connue pour le departement ${departement}.\n` +
        `Lancez : annuaire run --departement ${departement}\n`);
      return 0;
    }

    for (const ligne of lignes) {
      const url = ligne.url_mairie === null ? "—" : String(ligne.url_mairie);
      process.stdout.write(`${String(ligne.code_insee).padEnd(6)} ${String(ligne.nom).padEnd(32)} ${url}\n`);
    }
    const taux = total === 0 ? 0 : Math.round((resolues / total) * 100);
    process.stdout.write(`\n${resolues}/${total} communes avec une URL de mairie (${taux} %).\n`);
    return 0;
  } finally {
    app.close();
  }
}

/** Les associations amorcees, rattachees a leur commune. */
function commandeAssociations(
  ouvrir: () => App,
  departement: string | undefined,
  json: boolean,
  limite: string | undefined,
): number {
  if (!exigerDepartement(departement, "associations")) return 2;
  const app = ouvrir();
  try {
    // Les associations dissoutes restent en base pour que leur disparition soit tracee,
    // mais un annuaire de la vie associative ne les presente pas.
    const filtre =
      "FROM association a JOIN commune c ON c.code_insee = a.code_insee " +
      "WHERE c.departement = ? AND a.date_dissolution IS NULL";
    const lignes = app.db
      .prepare(
        `SELECT a.rna_id, a.nom, a.type_classifie, c.nom AS commune, c.url_mairie ${filtre} ` +
          "ORDER BY c.nom, a.nom LIMIT ?",
      )
      .all(departement, lireLimite(limite));
    const total = Number(
      (app.db.prepare(`SELECT count(*) AS n ${filtre}`).get(departement) as { n?: number })?.n ?? 0,
    );
    const rattachees = Number(
      (
        app.db
          .prepare(
            "SELECT count(*) AS n FROM association a JOIN commune c ON c.code_insee = a.code_insee " +
              "WHERE c.departement = ? AND a.date_dissolution IS NULL AND c.url_mairie IS NOT NULL",
          )
          .get(departement) as { n?: number }
      )?.n ?? 0,
    );

    if (json) {
      process.stdout.write(
        `${JSON.stringify({ departement, total, avecUrlMairie: rattachees, associations: lignes }, null, 2)}\n`,
      );
      return 0;
    }

    if (total === 0) {
      process.stdout.write(`Aucune association amorcee pour le departement ${departement}.\n` +
        `Lancez : annuaire run --departement ${departement}\n`);
      return 0;
    }

    for (const ligne of lignes) {
      const type = ligne.type_classifie === null ? "non classee" : String(ligne.type_classifie);
      process.stdout.write(
        `${String(ligne.rna_id).padEnd(11)} ${String(ligne.nom).slice(0, 40).padEnd(42)} ` +
          `${type.padEnd(18)} ${String(ligne.commune)}\n`,
      );
    }
    process.stdout.write(`\n${total} associations actives, dont ${rattachees} dans une commune dont l'URL est connue.\n`);
    return 0;
  } finally {
    app.close();
  }
}

/** Etat des dumps ouverts : ce qui a ete consomme, et ou une reprise repartirait. */
function commandeDumps(ouvrir: () => App, json: boolean): number {
  const app = ouvrir();
  try {
    const lignes = app.db
      .prepare(
        "SELECT source, statut, consumed_bytes, total_bytes, etag, started_at, finished_at, derniere_erreur " +
          "FROM dump ORDER BY started_at DESC, id DESC LIMIT 20",
      )
      .all();

    if (json) {
      process.stdout.write(`${JSON.stringify({ dumps: lignes }, null, 2)}\n`);
      return 0;
    }
    if (lignes.length === 0) {
      process.stdout.write("Aucun dump n'a encore ete lu.\n");
      return 0;
    }
    for (const ligne of lignes) {
      const total = ligne.total_bytes === null ? "?" : formaterOctets(Number(ligne.total_bytes));
      const lu = formaterOctets(Number(ligne.consumed_bytes ?? 0));
      process.stdout.write(
        `${String(ligne.source).padEnd(16)} ${String(ligne.statut).padEnd(9)} ${lu} / ${total}\n`,
      );
      if (ligne.derniere_erreur !== null) {
        process.stdout.write(`  ${String(ligne.derniere_erreur)}\n`);
      }
    }
    return 0;
  } finally {
    app.close();
  }
}

/** Rend `undefined` sur une valeur invalide : c'est une erreur d'usage, pas d'execution. */
function lireOptionsDecouverte(
  maxPages: string | undefined,
  avecMobiles: boolean,
): OptionsDecouverte | undefined {
  if (maxPages === undefined) return { maxPages: PAGES_MAX_PAR_COMMUNE, avecMobiles };
  const valeur = Number.parseInt(maxPages, 10);
  if (!Number.isInteger(valeur) || valeur < 1 || String(valeur) !== maxPages.trim()) return undefined;
  return { maxPages: valeur, avecMobiles };
}

async function commandeDecouvrir(
  ouvrir: () => App,
  departement: string | undefined,
  options: OptionsDecouverte,
): Promise<number> {
  // Cette commande collecte : elle releve du controle complet, refus d'Alsace-Moselle
  // compris, et pas du simple controle de forme des commandes de lecture.
  const refus = refusDepartement(departement);
  if (refus !== undefined || departement === undefined) {
    process.stderr.write(`${refus ?? "Un departement est requis."}\n`);
    return 2;
  }

  const app = ouvrir();
  try {
    const communes = Number(
      (app.db
        .prepare("SELECT count(*) AS n FROM commune WHERE departement = ? AND url_mairie IS NOT NULL")
        .get(departement) as { n?: number } | undefined)?.n ?? 0,
    );
    if (communes === 0) {
      process.stderr.write(
        `Aucune URL de mairie connue pour le departement ${departement}.\n` +
          `Lancez d'abord l'amorce : annuaire run --departement ${departement}\n`,
      );
      return 2;
    }

    const controller = installShutdownHandlers(() => {
      app.logger.warn("Arret demande : plus aucun job n'est pris, les jobs en cours vont finir");
    });

    // Le cycle de vie d'un run — ouverture de la ligne, phases, cloture — vit dans
    // `pipeline.ts` et nulle part ailleurs. Cette commande n'en est plus que la
    // restitution.
    const { interrompu } = await executerDecouverteSeule(
      app,
      { departement, decouverte: options },
      controller.signal,
    );

    resumeRun(app, departement);
    return interrompu ? 130 : 0;
  } finally {
    app.close();
  }
}

type LigneContact = {
  commune: string;
  association: string | null;
  kind: string;
  valeur: string;
  is_generique: number | null;
  methode_extraction: string;
  confiance: number;
  score: number | null;
  source_url: string;
  review_statut: string;
};

function commandeContacts(
  ouvrir: () => App,
  departement: string | undefined,
  json: boolean,
  limite: string | undefined,
): number {
  if (!exigerDepartement(departement, "contacts")) return 2;

  const app = ouvrir();
  try {
    const lignes = app.db
      .prepare(
        `SELECT c.nom AS commune, a.nom AS association, ct.kind, ct.valeur, ct.is_generique,
                ct.methode_extraction, ct.confiance, ct.score, ct.source_url, ct.review_statut
           FROM contact ct
           JOIN commune c ON c.code_insee = ct.code_insee
           LEFT JOIN association a ON a.id = ct.association_id
          WHERE c.departement = ?
          ORDER BY coalesce(ct.score, ct.confiance) DESC, c.nom, ct.valeur
          LIMIT ?`,
      )
      .all(departement, lireLimite(limite)) as unknown as LigneContact[];

    if (json) {
      process.stdout.write(`${JSON.stringify(lignes, null, 2)}\n`);
      return 0;
    }

    if (lignes.length === 0) {
      process.stdout.write(
        `Aucun contact pour le departement ${departement}.\n` +
          `Lancez la decouverte : annuaire decouvrir --departement ${departement}\n`,
      );
      return 0;
    }

    for (const ligne of lignes) {
      const regime = ligne.kind !== "email" ? "" : ligne.is_generique === 1 ? " [generique]" : ligne.is_generique === 0 ? " [nominatif]" : " [indetermine]";
      const cible = ligne.association ?? `${ligne.commune} (commune)`;
      // Les deux chiffres sont montres ensemble, et jamais l'un a la place de l'autre :
      // la confiance dit comment le contact a ete lu, le score s'il vaut d'etre publie.
      const score = ligne.score === null ? "  —  " : ligne.score.toFixed(2).padStart(5);
      process.stdout.write(
        `${ligne.valeur.padEnd(38)} score ${score} lu ${ligne.confiance.toFixed(2)} ` +
          `${ligne.methode_extraction.padEnd(18)}${regime}\n    ${cible}\n    source : ${ligne.source_url}\n`,
      );
    }
    return 0;
  } finally {
    app.close();
  }
}

/**
 * Rejeu de l'etape [4]. Ne sort jamais sur le reseau : les corps sont relus dans le
 * cache disque. C'est ce qui permet de regler un seuil en quelques secondes plutot
 * qu'en recrawlant un departement — treize minutes plancher, et autant de requetes
 * vers de vraies mairies pour un resultat qu'on possede deja.
 */
function commandePrefiltrer(
  ouvrir: () => App,
  departement: string | undefined,
  options: {
    campagne: string | undefined;
    seuil: string | undefined;
    tout: boolean;
    avecMobiles: boolean;
    json: boolean;
  },
): number {
  if (!exigerDepartement(departement, "prefiltrer")) return 2;

  const seuil = lireSeuil(options.seuil);
  if (seuil === undefined) {
    process.stderr.write(`--seuil attend un entier, recu « ${options.seuil} »\n`);
    return 2;
  }

  const app = ouvrir();
  try {
    const campagne = options.campagne ?? derniereCampagne(app.db, departement);
    if (campagne === undefined) {
      process.stderr.write(
        `Aucune page exploree pour le departement ${departement}.\n` +
          `Lancez d'abord la decouverte : annuaire decouvrir --departement ${departement}\n`,
      );
      return 2;
    }

    const resultat = rejouerPrefiltre(app.db, app.cache, app.clock, {
      departement,
      campagne,
      tout: options.tout,
      avecMobiles: options.avecMobiles,
      onTranche: (ecrites) => app.logger.debug("Tranche de pre-filtre ecrite", { pages: ecrites }),
      ...(seuil === null ? {} : { seuil }),
    });
    const distribution = distributionPrefiltre(app.db, departement, campagne);

    if (options.json) {
      process.stdout.write(
        `${JSON.stringify({ departement, seuil: seuil ?? SEUIL_PAR_DEFAUT, rejeu: resultat, distribution }, null, 2)}\n`,
      );
      return 0;
    }

    const part = (n: number): string =>
      distribution.jugees === 0 ? "—" : `${((n / distribution.jugees) * 100).toFixed(1)} %`;

    process.stdout.write(
      `Campagne ${campagne}, seuil ${seuil ?? SEUIL_PAR_DEFAUT}.\n` +
        `${resultat.evaluees} pages evaluees, ${resultat.aJour} deja a jour, ` +
        `${resultat.sansCache} sans corps en cache.\n\n` +
        `${distribution.retenues} pages retenues (${part(distribution.retenues)}), ` +
        `${distribution.ecartees} ecartees (${part(distribution.ecartees)}) sur ${distribution.jugees} jugees.\n` +
        `${distribution.candidatesLlm} atteindraient le fallback [6] : retenues et sous ` +
        `${SEUIL_EXTRACTION} contacts extraits.\n`,
    );

    if (distribution.parMotif.length > 0) {
      process.stdout.write("\nMotif dominant :\n");
      for (const ligne of distribution.parMotif) {
        process.stdout.write(`  ${ligne.motif.padEnd(14)} ${String(ligne.pages).padStart(6)}\n`);
      }
    }

    // L'histogramme est la sortie utile de cette commande : c'est lui, et non une
    // opinion, qui doit fixer le seuil (meme discipline que l'ADR-013 pour la dormance).
    if (distribution.histogramme.length > 0) {
      const maximum = Math.max(...distribution.histogramme.map((ligne) => ligne.pages));
      process.stdout.write("\nDistribution des scores :\n");
      for (const ligne of distribution.histogramme) {
        const barre = "#".repeat(Math.max(1, Math.round((ligne.pages / maximum) * 40)));
        process.stdout.write(
          `  ${String(ligne.borne).padStart(4)} ${String(ligne.pages).padStart(6)}  ${barre}\n`,
        );
      }
    }
    return 0;
  } finally {
    app.close();
  }
}

/** `null` signifie « non precise » ; `undefined`, « valeur invalide ». */
function lireSeuil(brut: string | undefined): number | null | undefined {
  if (brut === undefined) return null;
  const valeur = Number.parseInt(brut, 10);
  if (!Number.isInteger(valeur) || String(valeur) !== brut.trim()) return undefined;
  return valeur;
}

/**
 * Rejeu des etapes [7] et [8]. Contrairement a `prefiltrer`, cette commande peut sortir
 * sur le reseau : les domaines de messagerie dont le verdict MX n'est pas encore connu
 * sont resolus (ADR-017). Tout le reste — deduplication, classification, notation — est
 * un recalcul local.
 */
async function commandeNormaliser(
  ouvrir: () => App,
  departement: string | undefined,
  options: { tout: boolean; json: boolean },
): Promise<number> {
  if (!exigerDepartement(departement, "normaliser")) return 2;

  const app = ouvrir();
  try {
    const contacts = Number(
      (
        app.db
          .prepare(
            "SELECT count(*) AS n FROM contact ct JOIN commune c ON c.code_insee = ct.code_insee " +
              "WHERE c.departement = ?",
          )
          .get(departement) as { n?: number } | undefined
      )?.n ?? 0,
    );
    if (contacts === 0) {
      process.stderr.write(
        `Aucun contact collecte pour le departement ${departement}.\n` +
          `Lancez d'abord la decouverte : annuaire decouvrir --departement ${departement}\n`,
      );
      return 2;
    }

    const controller = installShutdownHandlers(() => {
      app.logger.warn("Arret demande : la tranche en cours va finir");
    });

    const resultat = await normaliser(app.db, app.clock, app.resolveurMx, {
      departement,
      tout: options.tout,
      counters: app.counters,
      signal: controller.signal,
      onTranche: (passe, ecrites) =>
        app.logger.debug("Tranche de normalisation ecrite", { passe, ecrites }),
    });
    const distribution = distributionNormalisation(app.db, departement);

    if (options.json) {
      process.stdout.write(`${JSON.stringify({ rejeu: resultat, distribution }, null, 2)}\n`);
      return controller.signal.aborted ? 130 : 0;
    }

    process.stdout.write(
      `${resultat.doublonsSupprimes} doublons commune/association supprimes.\n` +
        `${resultat.associationsClassees} associations classees, ${resultat.associationsAJour} deja a jour.\n` +
        `${resultat.mx.distincts} domaines de messagerie distincts : ${resultat.mx.verifies} verifies, ` +
        `${resultat.mx.deja} deja connus.\n` +
        `${resultat.contactsNotes} contacts notes, ${resultat.contactsAJour} deja a jour.\n` +
        `${distribution.invalides} contacts notes a zero : leur valeur n'a pas la forme ` +
        "d'une adresse\nni d'un numero. Ils restent en base pour la trace, et tout seuil " +
        "d'export les ecarte.\n\n" +
        `Emails : ${distribution.emailsAvecMx} sur un domaine qui annonce un MX, ` +
        `${distribution.emailsSansMx} sans, ${distribution.emailsMxInconnu} indetermines.\n` +
        "Le MX est un fait de domaine : il dit que le domaine sait recevoir du courrier,\n" +
        "pas que la boite existe.\n",
    );

    if (distribution.parType.length > 0) {
      process.stdout.write("\nTypes classifies :\n");
      for (const ligne of distribution.parType) {
        const part = ((ligne.associations / distribution.associations) * 100).toFixed(1);
        process.stdout.write(
          `  ${ligne.type.padEnd(18)} ${String(ligne.associations).padStart(6)}  ${part} %\n`,
        );
      }
    }

    // Meme discipline qu'au lot 4 : c'est la distribution, et non une opinion, qui doit
    // dire ou placer un seuil de publication.
    if (distribution.histogramme.length > 0) {
      const maximum = Math.max(...distribution.histogramme.map((ligne) => ligne.contacts));
      process.stdout.write("\nDistribution des scores :\n");
      for (const ligne of distribution.histogramme) {
        const barre = "#".repeat(Math.max(1, Math.round((ligne.contacts / maximum) * 40)));
        process.stdout.write(
          `  ${(ligne.borne / 10).toFixed(1)} ${String(ligne.contacts).padStart(6)}  ${barre}\n`,
        );
      }
    }

    return controller.signal.aborted ? 130 : 0;
  } finally {
    app.close();
  }
}

/** L'artefact que l'outil produit : un CSV avec la provenance de chaque ligne. */
async function commandeExporter(
  ouvrir: () => App,
  departement: string | undefined,
  options: { fichier: string | undefined; scoreMin: string | undefined; avecRejetes: boolean },
): Promise<number> {
  if (!exigerDepartement(departement, "exporter")) return 2;

  const scoreMin = lireScoreMin(options.scoreMin);
  if (scoreMin === undefined) {
    process.stderr.write(`--score-min attend un nombre entre 0 et 1, recu « ${options.scoreMin} »\n`);
    return 2;
  }

  const app = ouvrir();
  try {
    const parametres = {
      departement,
      avecRejetes: options.avecRejetes,
      ...(scoreMin === null ? {} : { scoreMin }),
    };
    const total = compterLignes(app.db, parametres);
    if (total === 0) {
      process.stderr.write(
        `Aucun contact a exporter pour le departement ${departement}.\n` +
          `Lancez la decouverte puis la normalisation : annuaire normaliser --departement ${departement}\n`,
      );
      return 1;
    }

    if (options.fichier === undefined) {
      for (const ligne of lignesCsv(app.db, parametres)) process.stdout.write(ligne);
      return 0;
    }

    // Le generateur existe pour tenir l'echelle du §1 ; l'accumuler dans une chaine
    // defaisait exactement ce qu'il apporte. `src/ui/serveur.ts` honore deja le contrat
    // cote interface, avec la meme attente de `drain`.
    const flux = createWriteStream(options.fichier, { encoding: "utf8" });
    try {
      for (const ligne of lignesCsv(app.db, parametres)) {
        if (!flux.write(ligne)) await once(flux, "drain");
      }
    } finally {
      await new Promise<void>((resoudre, rejeter) => flux.end((erreur?: Error | null) => (erreur ? rejeter(erreur) : resoudre())));
    }
    process.stdout.write(`${total} contacts exportes dans ${options.fichier}.\n`);
    return 0;
  } finally {
    app.close();
  }
}

/** `null` signifie « non precise » ; `undefined`, « valeur invalide ». */
function lireScoreMin(brut: string | undefined): number | null | undefined {
  if (brut === undefined) return null;
  const valeur = Number(brut);
  if (!Number.isFinite(valeur) || valeur < 0 || valeur > 1) return undefined;
  return valeur;
}

type LignePage = {
  commune: string;
  url: string;
  prefiltre_score: number | null;
  prefiltre_verdict: string | null;
  prefiltre_motif: string | null;
  contacts_extraits: number | null;
  profondeur: number;
};

/** Les pages explorees et ce que le pre-filtre en dit — l'etage [4] de l'entonnoir. */
function commandePages(
  ouvrir: () => App,
  departement: string | undefined,
  verdict: string | undefined,
  json: boolean,
  limite: string | undefined,
): number {
  if (!exigerDepartement(departement, "pages")) return 2;
  if (verdict !== undefined && verdict !== "retenue" && verdict !== "ecartee") {
    process.stderr.write(`--verdict attend « retenue » ou « ecartee », recu « ${verdict} »\n`);
    return 2;
  }

  const app = ouvrir();
  try {
    const filtreVerdict = verdict === undefined ? "" : "AND p.prefiltre_verdict = ? ";
    const params: (string | number)[] = verdict === undefined ? [] : [verdict];

    const lignes = app.db
      .prepare(
        `SELECT c.nom AS commune, p.url, p.prefiltre_score, p.prefiltre_verdict,
                p.prefiltre_motif, p.contacts_extraits, p.profondeur
           FROM page p
           JOIN commune c ON c.code_insee = p.code_insee
          WHERE c.departement = ? AND p.statut = 'visitee' ${filtreVerdict}
          ORDER BY p.prefiltre_score DESC, p.url
          LIMIT ?`,
      )
      .all(departement, ...params, lireLimite(limite)) as unknown as LignePage[];

    if (json) {
      process.stdout.write(`${JSON.stringify({ departement, pages: lignes }, null, 2)}\n`);
      return 0;
    }

    if (lignes.length === 0) {
      process.stdout.write(
        `Aucune page exploree pour le departement ${departement}.\n` +
          `Lancez la decouverte : annuaire decouvrir --departement ${departement}\n`,
      );
      return 0;
    }

    for (const ligne of lignes) {
      const score = ligne.prefiltre_score === null ? "  —  " : ligne.prefiltre_score.toFixed(1).padStart(5);
      const verdictAffiche = (ligne.prefiltre_verdict ?? "non juge").padEnd(9);
      const motif = (ligne.prefiltre_motif ?? "—").padEnd(12);
      process.stdout.write(
        `${score} ${verdictAffiche} ${motif} ${String(ligne.contacts_extraits ?? 0).padStart(3)} contacts\n` +
          `    ${ligne.url}\n`,
      );
    }
    return 0;
  } finally {
    app.close();
  }
}

/**
 * Anciennete de declaration des associations. C'est la mesure que l'ADR-013 reclame
 * avant de pouvoir lire le taux de couverture : le seuil de dormance doit sortir de
 * cette distribution, pas d'une intuition.
 */
function commandeDormance(ouvrir: () => App, departement: string | undefined, json: boolean): number {
  if (!exigerDepartement(departement, "dormance")) return 2;

  const app = ouvrir();
  try {
    const mesure = mesurerDormance(app.db, departement, app.clock.now());

    if (json) {
      process.stdout.write(`${JSON.stringify(mesure, null, 2)}\n`);
      return 0;
    }

    if (mesure.actives === 0) {
      process.stdout.write(
        `Aucune association amorcee pour le departement ${departement}.\n` +
          `Lancez : annuaire run --departement ${departement}\n`,
      );
      return 0;
    }

    const part = (n: number): string => `${((n / mesure.actives) * 100).toFixed(1)} %`;
    process.stdout.write(
      `${mesure.actives} associations actives.\n` +
        `${mesure.nonDormantes} ont declare depuis le ${mesure.borne} (${part(mesure.nonDormantes)}), ` +
        `${mesure.dormantes} avant (${part(mesure.dormantes)}), ` +
        `${mesure.sansDate} sans date de declaration (${part(mesure.sansDate)}).\n` +
        `Seuil applique : ${mesure.seuilAnnees} ans.\n`,
    );

    if (mesure.parAnnee.length > 0) {
      const maximum = Math.max(...mesure.parAnnee.map((ligne) => ligne.associations));
      process.stdout.write("\nDeclarations par annee :\n");
      for (const ligne of mesure.parAnnee) {
        const barre = "#".repeat(Math.max(1, Math.round((ligne.associations / maximum) * 40)));
        process.stdout.write(
          `  ${ligne.annee} ${String(ligne.associations).padStart(6)}  ${barre}\n`,
        );
      }
    }
    return 0;
  } finally {
    app.close();
  }
}

/** Resume ce que le run a produit, pour que le jalon soit lisible sans autre commande. */
function resumeRun(app: App, departement: string): void {
  const compte = (sql: string): number =>
    Number((app.db.prepare(sql).get(departement) as { n?: number })?.n ?? 0);

  const communes = compte("SELECT count(*) AS n FROM commune WHERE departement = ?");
  if (communes === 0) {
    process.stdout.write("Aucune commune n'a ete resolue : verifiez l'acces reseau avec annuaire dumps.\n");
    return;
  }
  const resolues = compte(
    "SELECT count(*) AS n FROM commune WHERE departement = ? AND statut_resolution = 'resolue'",
  );
  const associations = compte(
    "SELECT count(*) AS n FROM association a JOIN commune c ON c.code_insee = a.code_insee " +
      "WHERE c.departement = ? AND a.date_dissolution IS NULL",
  );
  process.stdout.write(
    `${communes} communes, dont ${resolues} avec l'URL de leur mairie. ${associations} associations actives.\n`,
  );

  const pagesVisitees = compte(
    "SELECT count(*) AS n FROM page p JOIN commune c ON c.code_insee = p.code_insee " +
      "WHERE c.departement = ? AND p.statut = 'visitee'",
  );
  if (pagesVisitees === 0) {
    process.stdout.write(
      `Aucune page exploree. Detail : annuaire communes --departement ${departement}\n`,
    );
    return;
  }

  // Detaille plutot qu'agrege : « sans collecte possible » melangeait trois causes de
  // nature differente. Un site injoignable est un incident, un site interdit par
  // robots.txt est une limite assumee du produit (§4.2), et une commune non tentee est
  // un run inacheve. Les confondre empeche de savoir s'il faut relancer, corriger, ou
  // ne rien faire.
  const bloquees = compte(
    "SELECT count(*) AS n FROM commune WHERE departement = ? AND crawl_statut = 'interdit_robots'",
  );
  const injoignables = compte(
    "SELECT count(*) AS n FROM commune WHERE departement = ? AND crawl_statut IN ('injoignable','refuse')",
  );
  const nonTentees = compte(
    "SELECT count(*) AS n FROM commune WHERE departement = ? AND url_mairie IS NOT NULL AND crawl_statut = 'non_tente'",
  );
  const contacts = compte(
    "SELECT count(*) AS n FROM contact ct JOIN commune c ON c.code_insee = ct.code_insee " +
      "WHERE c.departement = ?",
  );
  // Les deux denominateurs sont affiches ensemble (ADR-013). Ne montrer que le second,
  // plus favorable, reviendrait a ameliorer le chiffre en changeant la question : le
  // taux sur les actives reste donc en premier, et le critere qui produit l'autre est
  // ecrit en toutes lettres.
  //
  // §8 du brief : le taux de couverture est la metrique qui fera le README. Les chiffres
  // viennent de `mesurerCouverture`, et d'elle seule — c'est ce que son en-tete promet,
  // et cette commande le defaisait en recalculant les siens sans le filtre de revue.
  const dormance = mesurerDormance(app.db, departement, app.clock.now());
  const couverture = mesurerCouverture(app.db, departement, dormance.borne);
  const couvertes = couverture.avecEmail;
  const couvertesNonDormantes = couverture.avecEmailNonDormantes ?? 0;

  const taux = associations === 0 ? 0 : (couvertes / associations) * 100;
  const tauxQualifie =
    dormance.nonDormantes === 0 ? undefined : (couvertesNonDormantes / dormance.nonDormantes) * 100;

  const reste =
    nonTentees === 0
      ? ""
      : `${nonTentees} communes restent a explorer : relancez la meme commande, rien ne sera refait.\n`;

  process.stdout.write(
    `${pagesVisitees} pages explorees.${resumePrefiltre(app, departement)}\n` +
      `${bloquees} communes interdites par robots.txt, ${injoignables} injoignables.\n` +
      reste +
      `${contacts} contacts collectes. Couverture : ${couvertes} associations avec au moins ` +
      `un email, soit ${taux.toFixed(1)} % des ${associations} actives` +
      (tauxQualifie === undefined
        ? ".\n"
        : ` — ${tauxQualifie.toFixed(1)} % des ${dormance.nonDormantes} ayant declare ` +
          `depuis moins de ${dormance.seuilAnnees} ans.\n`) +
      resumeNormalisation(app, departement, associations) +
      `Detail : annuaire contacts --departement ${departement}\n` +
      `Export : annuaire exporter --departement ${departement} --fichier annuaire-${departement}.csv\n`,
  );
}

/**
 * L'etage [4] de l'entonnoir, en une phrase. Le ratio de pages qui atteindraient le
 * fallback LLM est la metrique que le §8 reclame — et ce lot la rend lisible sans
 * qu'une seule ligne d'inference ait ete ecrite.
 */
function resumePrefiltre(app: App, departement: string): string {
  const campagne = derniereCampagne(app.db, departement);
  if (campagne === undefined) return "";
  const d = distributionPrefiltre(app.db, departement, campagne);
  if (d.jugees === 0) return "";
  const part = ((d.retenues / d.jugees) * 100).toFixed(1);
  return (
    `\n${d.retenues} ${pluriel(d.retenues, "page retenue", "pages retenues")} par le pre-filtre ` +
    `(${part} %), ${d.ecartees} ${pluriel(d.ecartees, "ecartee", "ecartees")} ; ` +
    `${d.candidatesLlm} ${pluriel(d.candidatesLlm, "atteindrait", "atteindraient")} le fallback LLM.`
  );
}

/**
 * Les etages [7] et [8], en deux phrases. Le second chiffre de couverture est celui qui
 * compte vraiment : une association dont le seul email est sur un domaine qui n'annonce
 * aucun MX n'est pas joignable, et la compter comme couverte flatterait la mesure.
 */
function resumeNormalisation(app: App, departement: string, associations: number): string {
  const d = distributionNormalisation(app.db, departement);
  if (d.notes === 0) {
    return (
      `Contacts non notes : lancez annuaire normaliser --departement ${departement} ` +
      "pour l'etage [7]/[8].\n"
    );
  }

  const joignables = mesurerCouverture(app.db, departement).avecEmailJoignable;
  const part = associations === 0 ? 0 : (joignables / associations) * 100;
  const types = d.parType.map((ligne) => `${ligne.type} ${ligne.associations}`).join(", ");

  return (
    `${joignables} de ces associations ont un email dont le domaine annonce un MX, ` +
    `soit ${part.toFixed(1)} % des actives.\n` +
    `${d.notes} contacts notes. Types classifies : ${types === "" ? "aucun" : types}.\n`
  );
}

/** Zero prend le pluriel en francais, un prend le singulier. */
function pluriel(nombre: number, singulier: string, pluriels: string): string {
  return nombre === 1 ? singulier : pluriels;
}
