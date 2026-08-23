import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync } from "node:fs";

import { openApp } from "../src/app.ts";
import { makeTempDir } from "./helpers/tmp.ts";
import type { TestContext } from "node:test";

/**
 * L'assemblage de l'application, du cote ou le lot 8 l'a fait bouger : l'URL de contact
 * se renseigne desormais depuis l'interface, donc le client HTTP doit pouvoir naitre
 * apres coup — sans qu'aucune requete anonyme n'ait pu partir entre-temps (§4.4).
 */

function application(t: TestContext, processEnv: Record<string, string | undefined> = {}) {
  const app = openApp({ dataDir: join(makeTempDir(t), "instance"), console: false, processEnv });
  t.after(() => app.close());
  return app;
}

test("sans URL de contact, aucun client n'existe — et il apparait des qu'elle est reglee", (t) => {
  const app = application(t);
  assert.equal(app.client, undefined, "un client sans URL de contact emettrait des requetes anonymes");

  const resultat = app.configurerContactUrl("https://exemple.example/contact");

  assert.deepEqual(resultat, { url: "https://exemple.example/contact" });
  assert.notEqual(app.client, undefined);
  assert.equal(app.config.contactUrl, "https://exemple.example/contact");
  assert.match(readFileSync(app.paths.configFile, "utf8"), /exemple\.example/);
});

test("une saisie invalide ne cree pas de client et n'ecrit rien", (t) => {
  const app = application(t);

  const resultat = app.configurerContactUrl("mairie-de-bruzou");

  assert.ok("erreur" in resultat);
  assert.equal(app.client, undefined);
  assert.equal(app.config.contactUrl, undefined);
});

test("la variable d'environnement l'emporte, et le dire vaut mieux qu'ecrire pour rien", (t) => {
  const app = application(t, { ANNUAIRE_CONTACT_URL: "https://exemple.example/depuis-l-environnement" });

  const resultat = app.configurerContactUrl("https://exemple.example/depuis-l-ecran");

  assert.ok("erreur" in resultat);
  assert.match(resultat.erreur, /ANNUAIRE_CONTACT_URL/);
  assert.equal(app.config.contactUrl, "https://exemple.example/depuis-l-environnement");
});
