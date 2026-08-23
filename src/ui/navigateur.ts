/**
 * Ouvrir le navigateur de l'utilisateur sur l'interface — le « puis ouvre le navigateur »
 * du §2 du brief.
 *
 * **Ce n'est pas une sortie reseau.** Rien ne part d'ici : on demande au systeme
 * d'ouvrir une URL locale, et c'est le navigateur, process tiers, qui l'atteindra. La
 * regle de `src/http/` vise ce qui quitte la machine ; celle-ci ne la concerne pas.
 *
 * En revanche c'est le seul endroit du projet qui lance un processus, et un test
 * d'architecture le verifie — avec deux exigences :
 *
 * - **jamais de shell.** `cmd /c start "" <url>` est la recette repandue sous Windows,
 *   et sa citation est un piege : `&` dans une URL y devient un separateur de commandes.
 *   `rundll32` prend l'URL comme un argument, sans interpretation.
 * - **l'echec est ignore.** Ne pas trouver de navigateur n'est pas une raison pour que
 *   l'interface refuse de servir : l'adresse reste imprimee sur la sortie standard.
 *
 * L'URL porte le jeton, donc elle apparait dans la liste des processus de la machine.
 * C'est un jeton local, tire a ce demarrage, et qui ne vaut que pour cette boucle
 * locale : le meme secret est deja imprime sur le terminal, a cote.
 */

import { spawn } from "node:child_process";

type Commande = { fichier: string; args: readonly string[] };

export function commandeOuverture(url: string, plateforme: string = process.platform): Commande {
  if (plateforme === "darwin") return { fichier: "open", args: [url] };
  if (plateforme === "win32") {
    return { fichier: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] };
  }
  return { fichier: "xdg-open", args: [url] };
}

/**
 * Detache le processus et l'oublie : l'interface ne doit pas attendre la fermeture d'un
 * navigateur pour rendre la main, ni mourir avec lui.
 */
export function ouvrirNavigateur(url: string): void {
  const { fichier, args } = commandeOuverture(url);
  try {
    const enfant = spawn(fichier, [...args], { stdio: "ignore", detached: true });
    enfant.on("error", () => {});
    enfant.unref();
  } catch {
    // Volontairement muet : voir l'en-tete.
  }
}
