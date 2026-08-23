/**
 * Le run vu depuis l'interface.
 *
 * **Le worker tourne dans ce process**, et non dans un sous-processus (ADR-024). Un
 * sous-processus demanderait trois facons de se relancer — sources en developpement,
 * bundle CJS, executable unique — et perdrait surtout l'arret propre sous Windows, ou il
 * n'y a pas de SIGTERM : « on cesse de prendre des jobs, on laisse finir ceux en cours »
 * redeviendrait une terminaison brutale. Ici l'AbortController de `Worker.run` suffit.
 *
 * Ce module ne connait pas HTTP. Il expose une machine a etats que `routes.ts` interroge
 * et que `cli.ts` arrete, ce qui la rend testable sans ouvrir de port ni de socket.
 */

import { toIso } from "../clock.ts";
import { executerRun, refusDepartement, optionsDecouvertePardefaut } from "../pipeline.ts";
import type { App } from "../app.ts";
import type { OptionsRun, ResultatRun } from "../pipeline.ts";
import { messageDe } from "../log.ts";

export type IssueRun = "termine" | "interrompu" | "echec";

export type EtatPilote =
  | { kind: "inactif" }
  | { kind: "en_cours"; departement: string; demarre: string; runId: number | undefined }
  | { kind: "fini"; departement: string; issue: IssueRun; message: string | undefined };

export type Demarrage = { kind: "lance" } | { kind: "refus"; message: string };

/**
 * Ce que le routeur voit du pilote. Un type structurel plutot que la classe : `routes.ts`
 * n'a pas besoin de savoir qu'un worker existe, et ses tests s'en passent d'autant mieux.
 */
export type SurfacePilote = {
  etat(): EtatPilote;
  refus(): string | undefined;
  demarrer(departement: string | undefined): Demarrage;
  arreter(): boolean;
};

type Executer = (app: App, options: OptionsRun, signal: AbortSignal, onRunId?: (id: number) => void) => Promise<ResultatRun>;

export class PiloteRun implements SurfacePilote {
  readonly #app: App;
  readonly #executer: Executer;
  #etat: EtatPilote = { kind: "inactif" };
  #refus: string | undefined;
  #controller: AbortController | undefined;
  #enCours: Promise<void> | undefined;
  #arrete = false;

  /** `executer` est injectable pour que la machine a etats se teste sans file reelle. */
  constructor(app: App, executer: Executer = executerRun) {
    this.#app = app;
    this.#executer = executer;
  }

  etat(): EtatPilote {
    return this.#etat;
  }

  /**
   * Le dernier refus, garde jusqu'au demarrage suivant.
   *
   * Il n'est pas rendu dans la reponse au POST et oublie ensuite : le bloc de suivi se
   * rafraichit toutes les deux secondes, et un message qui disparait au bout de deux
   * secondes n'est pas un message. C'est le pilote qui se souvient de ce qu'il a refuse.
   */
  refus(): string | undefined {
    return this.#refus;
  }

  /**
   * Rend la main **sans attendre** : le routeur est synchrone, et un run dure des
   * minutes. La promesse vit dans ce pilote, ses erreurs atterrissent dans l'etat
   * plutot que dans un rejet que personne n'observerait.
   */
  demarrer(departement: string | undefined): Demarrage {
    const refuser = (message: string): Demarrage => {
      this.#refus = message;
      return { kind: "refus", message };
    };

    // Premier controle, et il n'est pas theorique : rien n'empechait un POST /run
    // d'arriver entre la resolution de `attendre()` et la fin de `fermer()`. L'etat
    // valait alors « fini », le depart etait accepte, et `app.close()` fermait la base
    // sous un worker qui venait de naitre.
    if (this.#arrete) return refuser("L'interface est en cours d'arret.");

    if (this.#etat.kind === "en_cours") {
      return refuser("Un run est deja en cours dans cette interface.");
    }

    const refus = refusDepartement(departement);
    if (refus !== undefined || departement === undefined) {
      return refuser(refus ?? "Un departement est requis.");
    }

    // §4.4 : pas d'URL de contact, pas de collecte. Le message dit ou la renseigner —
    // l'ecran l'offre juste au-dessus.
    if (this.#app.config.contactUrl === undefined) {
      return refuser(
        "Aucune URL de contact n'est configuree. Elle est annoncee dans le User-Agent " +
          "pour qu'un webmestre puisse vous joindre, et aucune collecte ne part sans elle.",
      );
    }

    this.#refus = undefined;
    const controller = new AbortController();
    this.#controller = controller;
    this.#etat = {
      kind: "en_cours",
      departement,
      demarre: toIso(this.#app.clock.now()),
      runId: undefined,
    };

    const options: OptionsRun = {
      departement,
      avecImport: false,
      rnaFile: undefined,
      sansDecouverte: false,
      decouverte: optionsDecouvertePardefaut(),
    };

    this.#enCours = this.#executer(this.#app, options, controller.signal, (runId) => {
      if (this.#etat.kind === "en_cours") this.#etat = { ...this.#etat, runId };
    }).then(
      (resultat) => {
        this.#terminer(departement, resultat.interrompu ? "interrompu" : "termine", undefined);
      },
      (cause: unknown) => {
        this.#app.logger.error("Le run lance depuis l'interface a echoue", {
          departement,
          erreur: messageDe(cause),
        });
        this.#terminer(departement, "echec", messageDe(cause));
      },
    );

    return { kind: "lance" };
  }

  /** Demande l'arret. Les jobs en cours finissent : c'est le contrat du worker. */
  arreter(): boolean {
    if (this.#etat.kind !== "en_cours") return false;
    this.#controller?.abort();
    return true;
  }

  /**
   * Ferme la porte : plus aucun run ne demarrera. A appeler avant `attendre()`, sans quoi
   * l'attente peut porter sur un run deja termine pendant qu'un autre commence.
   */
  fermer(): void {
    this.#arrete = true;
  }

  /**
   * Attend la fin du run pilote, s'il y en a un. Appele a l'arret de l'interface :
   * fermer la base sous un worker vivant serait la seule facon de perdre du travail.
   */
  async attendre(): Promise<void> {
    await this.#enCours;
  }

  #terminer(departement: string, issue: IssueRun, message: string | undefined): void {
    this.#etat = { kind: "fini", departement, issue, message };
    this.#controller = undefined;
    this.#enCours = undefined;
  }
}
