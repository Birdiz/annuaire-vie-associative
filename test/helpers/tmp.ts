/**
 * Repertoire jetable par test.
 *
 * **Le menage ne peut pas etre un `t.after` ordinaire.** Les hooks `after` de `node:test`
 * s'executent dans leur ordre d'enregistrement : celui du repertoire est pose ici, donc
 * en premier, avant le `db.close()` que l'appelant enregistre juste apres. Linux delie
 * sans broncher un fichier encore ouvert ; **Windows repond EPERM**. C'est la premiere
 * chose qu'a trouvee la suite Windows de la CI — trente-six tests, tous verts sur leurs
 * assertions, tous rouges sur leur nettoyage.
 *
 * D'ou deux temps plutot qu'un, et aucune ligne a changer dans les tests :
 *
 * - a la fin du test, on **tente** la suppression. Elle reussit partout ou plus rien ne
 *   tient le fichier, et garde le disque propre pendant les fichiers de test longs ;
 * - a la sortie du process — donc apres tous les `after`, toutes les fermetures de base
 *   et la fin des sous-processus — on **balaie** ce qui reste.
 *
 * Un echec au premier temps n'est donc pas une erreur : c'est le cas normal sous Windows.
 * Un echec au second est signale sur stderr sans faire echouer la suite : le repertoire
 * est dans `%TEMP%`, l'OS en fera son affaire, et un test vert ne doit pas devenir rouge
 * pour une question de menage.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

const restants = new Set<string>();
let balayageArme = false;

export function makeTempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "annuaire-test-"));
  restants.add(dir);
  armerBalayage();

  t.after(() => {
    if (supprimer(dir)) restants.delete(dir);
  });

  return dir;
}

/**
 * `maxRetries` couvre le cas ou un handle vient d'etre relache et ou Windows n'a pas
 * encore rendu la main — un sous-processus tue, typiquement. Il ne couvre pas un fichier
 * toujours ouvert : c'est le balayage de sortie qui s'en charge.
 */
function supprimer(dir: string): boolean {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    return true;
  } catch {
    return false;
  }
}

function armerBalayage(): void {
  if (balayageArme) return;
  balayageArme = true;
  // `exit` n'accepte que du synchrone, et `rmSync` en est.
  process.on("exit", () => {
    for (const dir of restants) {
      if (!supprimer(dir)) {
        process.stderr.write(`menage : ${dir} n'a pas pu etre supprime (handle encore ouvert ?)\n`);
      }
    }
  });
}
