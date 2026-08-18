import { test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { resolveDataDir, buildPaths, resolvePaths, ensurePaths } from "../src/paths.ts";
import type { Environment } from "../src/paths.ts";
import { makeTempDir } from "./helpers/tmp.ts";

const APP = "annuaire-vie-associative";

function env(platform: NodeJS.Platform, vars: Record<string, string | undefined> = {}): Environment {
  return { platform, env: vars, home: platform === "win32" ? "C:\\Users\\test" : "/home/test" };
}

test("l'argument explicite l'emporte sur tout le reste", () => {
  const e = env("linux", { ANNUAIRE_DATA_DIR: "/depuis/env" });
  assert.equal(resolveDataDir("./explicite", e), resolve("./explicite"));
});

test("la variable d'environnement l'emporte sur la convention de plateforme", () => {
  const e = env("linux", { ANNUAIRE_DATA_DIR: "/depuis/env", XDG_DATA_HOME: "/xdg" });
  assert.equal(resolveDataDir(undefined, e), resolve("/depuis/env"));
});

test("windows : LOCALAPPDATA, avec repli sur le profil utilisateur", () => {
  assert.equal(
    resolveDataDir(undefined, env("win32", { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" })),
    join("C:\\Users\\test\\AppData\\Local", APP),
  );
  assert.equal(
    resolveDataDir(undefined, env("win32")),
    join("C:\\Users\\test", "AppData", "Local", APP),
  );
});

test("linux et darwin : XDG_DATA_HOME, avec repli sur ~/.local/share", () => {
  assert.equal(resolveDataDir(undefined, env("linux", { XDG_DATA_HOME: "/xdg" })), join("/xdg", APP));
  assert.equal(resolveDataDir(undefined, env("linux")), join("/home/test", ".local", "share", APP));
  assert.equal(resolveDataDir(undefined, env("darwin")), join("/home/test", ".local", "share", APP));
});

test("une variable vide est traitee comme absente", () => {
  const e = env("linux", { ANNUAIRE_DATA_DIR: "", XDG_DATA_HOME: "" });
  assert.equal(resolveDataDir("", e), join("/home/test", ".local", "share", APP));
});

test("les chemins derives tiennent tous sous le repertoire de donnees", () => {
  const paths = buildPaths("/data");
  for (const p of Object.values(paths)) {
    assert.ok(p.startsWith("/data"), `${p} sort du repertoire de donnees`);
  }
  assert.equal(paths.dbFile, join("/data", "annuaire.sqlite"));
});

test("ensurePaths cree l'arborescence et se rejoue sans erreur", (t) => {
  const dir = makeTempDir(t);
  const paths = resolvePaths(join(dir, "instance"));

  ensurePaths(paths);
  ensurePaths(paths);

  assert.ok(existsSync(paths.dataDir));
  assert.ok(existsSync(paths.cacheDir));
  assert.ok(existsSync(paths.downloadsDir));
});
