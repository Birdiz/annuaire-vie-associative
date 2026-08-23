import { test } from "node:test";
import assert from "node:assert/strict";
import { DomainThrottle, subnetKey } from "../../src/http/throttle.ts";
import type { LookupFn } from "../../src/http/throttle.ts";

/**
 * Le delai reel de production (2 s) est verifie de bout en bout dans client.test.ts.
 * Ici on verifie la mecanique de file avec un delai court, pour ne pas faire durer la
 * suite de tests.
 */
const DELAI = 60;

function lookupFixe(mapping: Record<string, string>): LookupFn {
  return async (hostname) => {
    const address = mapping[hostname];
    if (address === undefined) throw new Error(`hote inconnu : ${hostname}`);
    return { address, family: 4 };
  };
}

async function mesurer(fn: () => Promise<unknown>): Promise<number> {
  const debut = performance.now();
  await fn();
  return performance.now() - debut;
}

test("le decoupage en sous-reseau regroupe les hotes voisins", () => {
  assert.equal(subnetKey("192.0.2.42", 4), "net:192.0.2");
  assert.equal(subnetKey("192.0.2.99", 4), "net:192.0.2");
  assert.notEqual(subnetKey("192.0.3.1", 4), subnetKey("192.0.2.1", 4));
  assert.equal(subnetKey("2001:db8:1::1", 6), "net6:2001:db8:1");
  assert.equal(subnetKey("pas-une-ip", 4), null);
});

test("deux requetes vers le meme hote sont espacees du delai", async () => {
  const throttle = new DomainThrottle({ minDelayMs: DELAI, lookup: lookupFixe({ "a.example": "192.0.2.1" }) });
  const url = new URL("https://a.example/page");

  await throttle.acquire(url);
  const attente = await mesurer(() => throttle.acquire(url));

  assert.ok(attente >= DELAI - 5, `attendu >= ${DELAI} ms, obtenu ${attente.toFixed(0)} ms`);
});

test("deux hotes distincts sur des reseaux distincts partent en parallele", async () => {
  const throttle = new DomainThrottle({
    minDelayMs: DELAI,
    lookup: lookupFixe({ "a.example": "192.0.2.1", "b.example": "198.51.100.1" }),
  });

  await throttle.acquire(new URL("https://a.example/"));
  const attente = await mesurer(() => throttle.acquire(new URL("https://b.example/")));

  assert.ok(attente < DELAI / 2, `aucune attente attendue, obtenu ${attente.toFixed(0)} ms`);
});

test("deux hotes du meme /24 sont espaces : l'hebergement mutualise ne contourne pas la regle", async () => {
  const throttle = new DomainThrottle({
    minDelayMs: DELAI,
    lookup: lookupFixe({ "mairie-a.example": "192.0.2.10", "mairie-b.example": "192.0.2.11" }),
  });

  await throttle.acquire(new URL("https://mairie-a.example/"));
  const attente = await mesurer(() => throttle.acquire(new URL("https://mairie-b.example/")));

  assert.ok(attente >= DELAI - 5, `attendu >= ${DELAI} ms, obtenu ${attente.toFixed(0)} ms`);
});

test("des acquisitions concurrentes vers un meme hote se serialisent sans se chevaucher", async () => {
  const throttle = new DomainThrottle({ minDelayMs: DELAI, lookup: lookupFixe({ "a.example": "192.0.2.1" }) });
  const url = new URL("https://a.example/page");

  const departs: number[] = [];
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      await throttle.acquire(url);
      departs.push(performance.now());
    }),
  );

  departs.sort((x, y) => x - y);
  for (let i = 1; i < departs.length; i += 1) {
    const ecart = departs[i]! - departs[i - 1]!;
    assert.ok(ecart >= DELAI - 5, `depart ${i} trop proche du precedent : ${ecart.toFixed(0)} ms`);
  }
});

test("une resolution DNS en echec n'empeche pas la requete mais garde le throttle par hote", async () => {
  const throttle = new DomainThrottle({
    minDelayMs: DELAI,
    lookup: () => Promise.reject(new Error("NXDOMAIN")),
  });
  const url = new URL("https://inconnu.invalid/");

  await throttle.acquire(url);
  const attente = await mesurer(() => throttle.acquire(url));

  assert.ok(attente >= DELAI - 5, `le throttle par hote doit continuer de s'appliquer (${attente.toFixed(0)} ms)`);
});

test("un delai superieur demande par le site est respecte", async () => {
  const throttle = new DomainThrottle({ minDelayMs: DELAI, lookup: lookupFixe({ "a.example": "192.0.2.1" }) });
  const url = new URL("https://a.example/");

  await throttle.acquire(url, DELAI * 3);
  const attente = await mesurer(() => throttle.acquire(url, DELAI * 3));

  assert.ok(attente >= DELAI * 3 - 5, `attendu >= ${DELAI * 3} ms, obtenu ${attente.toFixed(0)} ms`);
});

test("un delai inferieur au plancher est ignore", async () => {
  const throttle = new DomainThrottle({ minDelayMs: DELAI, lookup: lookupFixe({ "a.example": "192.0.2.1" }) });
  const url = new URL("https://a.example/");

  await throttle.acquire(url, 1);
  const attente = await mesurer(() => throttle.acquire(url, 1));

  assert.ok(attente >= DELAI - 5, `le plancher doit primer (${attente.toFixed(0)} ms)`);
});

test("une penalite repousse le prochain creneau", async () => {
  const throttle = new DomainThrottle({ minDelayMs: 1, lookup: lookupFixe({ "a.example": "192.0.2.1" }) });
  const url = new URL("https://a.example/");

  throttle.penalize(url, DELAI * 2);
  const attente = await mesurer(() => throttle.acquire(url));

  assert.ok(attente >= DELAI * 2 - 5, `attendu >= ${DELAI * 2} ms, obtenu ${attente.toFixed(0)} ms`);
});

test("l'attente est interruptible", async () => {
  const throttle = new DomainThrottle({ minDelayMs: 5_000, lookup: lookupFixe({ "a.example": "192.0.2.1" }) });
  const url = new URL("https://a.example/");
  await throttle.acquire(url);

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);

  await assert.rejects(() => throttle.acquire(url, undefined, controller.signal), { name: "AbortError" });
});
