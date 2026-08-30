/**
 * Doublures du pilote et des reglages, pour les tests de routage.
 *
 * `routes.ts` ne voit du pilote qu'une surface — sept methodes, aucun worker — et ces
 * doublures s'en tiennent la. C'est ce qui permet de tester les routes de lancement sans
 * file de jobs, sans client HTTP, et sans le moindre octet sur le reseau.
 */

import type { Demarrage, EtatPilote, Reglage, SurfacePilote } from "../../src/ui/pilote.ts";
import type { SurfaceReglages } from "../../src/ui/routes.ts";

export type PiloteDouble = SurfacePilote & {
  demarrages: (string | undefined)[];
  arrets: number;
  /** Ce que le routeur a demande de regler, dans l'ordre. */
  bascules: boolean[];
  poser(etat: EtatPilote): void;
  refuser(message: string | undefined): void;
  repondre(reponse: Demarrage): void;
  /** Force le refus du basculement, comme le fait le vrai pilote pendant un run. */
  verrouiller(message: string | undefined): void;
};

export function piloteDouble(): PiloteDouble {
  let etat: EtatPilote = { kind: "inactif" };
  let refus: string | undefined;
  let reponse: Demarrage = { kind: "lance" };
  let mobiles = false;
  let verrou: string | undefined;
  let refusMobiles: string | undefined;

  const double: PiloteDouble = {
    demarrages: [],
    arrets: 0,
    bascules: [],
    etat: () => etat,
    refus: () => refus,
    avecMobiles: () => mobiles,
    refusMobiles: () => refusMobiles,
    reglerMobiles(actif): Reglage {
      double.bascules.push(actif);
      if (verrou !== undefined) {
        refusMobiles = verrou;
        return { kind: "refus", message: verrou };
      }
      mobiles = actif;
      refusMobiles = undefined;
      return { kind: "ok" };
    },
    verrouiller(message) {
      verrou = message;
    },
    demarrer(departement) {
      double.demarrages.push(departement);
      if (reponse.kind === "refus") refus = reponse.message;
      return reponse;
    },
    arreter() {
      double.arrets += 1;
      return etat.kind === "en_cours";
    },
    poser(nouveau) {
      etat = nouveau;
    },
    refuser(message) {
      refus = message;
    },
    repondre(nouvelle) {
      reponse = nouvelle;
    },
  };
  return double;
}

export type ReglagesDouble = SurfaceReglages & { ecrites: string[] };

/** `enregistrer` refuse ce que `validerContactUrl` refuserait, sans toucher au disque. */
export function reglagesDouble(initiale?: string, parEnvironnement = false): ReglagesDouble {
  let courante = initiale;
  const double: ReglagesDouble = {
    ecrites: [],
    contactUrl: () => courante,
    parEnvironnement: () => parEnvironnement,
    enregistrer(valeur) {
      if (parEnvironnement) return { erreur: "ANNUAIRE_CONTACT_URL est definie dans l'environnement." };
      if (!/^https?:\/\/\S+$/.test(valeur.trim())) return { erreur: `contactUrl n'est pas une URL absolue : ${valeur}` };
      courante = valeur.trim();
      double.ecrites.push(courante);
      return { url: courante };
    },
  };
  return double;
}
