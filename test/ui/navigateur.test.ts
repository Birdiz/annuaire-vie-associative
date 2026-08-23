import { test } from "node:test";
import assert from "node:assert/strict";

import { commandeOuverture } from "../../src/ui/navigateur.ts";

/**
 * L'ouverture du navigateur, verifiee sur la commande construite plutot qu'en lancant
 * quoi que ce soit : une suite de tests qui ouvrirait des fenetres serait invivable, et
 * ce qui compte est la forme des arguments.
 */

test("chaque plateforme recoit l'URL comme un argument, jamais dans une ligne de commande", () => {
  const url = "http://127.0.0.1:8787/?jeton=abc&x=1";

  // Le `&` est le piege : sous un shell, il separerait deux commandes. Aucune des trois
  // formes ne passe par un interpreteur, et l'URL reste un argument entier.
  for (const plateforme of ["darwin", "win32", "linux"]) {
    const { fichier, args } = commandeOuverture(url, plateforme);
    assert.ok(fichier.length > 0, plateforme);
    assert.ok(args.includes(url), `${plateforme} doit recevoir l'URL telle quelle`);
    assert.ok(!fichier.includes("cmd"), "cmd /c start cite mal les URL");
  }
});

test("Windows passe par rundll32, et non par « start »", () => {
  assert.deepEqual(commandeOuverture("http://127.0.0.1:8787/", "win32"), {
    fichier: "rundll32.exe",
    args: ["url.dll,FileProtocolHandler", "http://127.0.0.1:8787/"],
  });
});

test("une plateforme inconnue retombe sur la convention freedesktop", () => {
  assert.equal(commandeOuverture("http://127.0.0.1:8787/", "freebsd").fichier, "xdg-open");
});
