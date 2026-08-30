/**
 * Ce que POSIX garantit et que Windows ne peut pas offrir.
 *
 * Trois proprietes de la suite ne sont pas des proprietes du produit mais du systeme :
 * le nom d'un signal recu, la delivrance d'un Ctrl+C a un autre process, et le bit
 * d'execution d'un fichier. Windows n'a ni l'un ni les autres — `process.kill` y appelle
 * `TerminateProcess`, qui ne porte aucun nom de signal, et NTFS n'a pas de bit `x`.
 *
 * **Ce fichier ne sert pas a sauter des tests.** Ce qui compte — le worker est bien mort
 * sans avoir fini, la reprise ne rejoue ni ne perd rien — reste verifie partout ; c'est la
 * seule assertion qui parle de POSIX qui devient conditionnelle, et elle continue de
 * tourner sur le job Linux, a chaque push. Un test entierement saute serait une couverture
 * perdue ; ici il n'y en a aucune.
 */

import assert from "node:assert/strict";

export const SIGNAUX_POSIX = process.platform !== "win32";

/**
 * La forme minimale d'une sortie de sous-processus. Volontairement large — chaque fichier
 * de test a deja son propre type de sortie, et les faire converger ici couterait plus
 * qu'il ne rapporte.
 */
export type SortieProcessus = {
  code: number | null;
  signal: string | null;
  stderr?: string;
};

/**
 * Le sous-processus a ete tue net, sans passer par sa sortie propre.
 *
 * Sous POSIX cela se lit au nom du signal. Sous Windows il n'y en a pas : `TerminateProcess`
 * rend un code de sortie, et c'est son caractere non nul qui dit que le process n'est pas
 * sorti de lui-meme — ce que la suite veut savoir avant de tester la reprise.
 */
export function assertTueBrutalement(sortie: SortieProcessus, contexte: string): void {
  const detail = sortie.stderr === undefined || sortie.stderr === "" ? "" : ` : ${sortie.stderr}`;
  if (SIGNAUX_POSIX) {
    assert.equal(sortie.signal, "SIGKILL", `${contexte}${detail}`);
    return;
  }
  assert.notEqual(sortie.code, 0, `${contexte}${detail}`);
}
