import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

/** Repertoire jetable, supprime a la fin du test meme en cas d'echec. */
export function makeTempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "annuaire-test-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
