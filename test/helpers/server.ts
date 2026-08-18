import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { TestContext } from "node:test";

/**
 * Serveur HTTP local jetable.
 *
 * La suite de tests ne sort jamais sur Internet (§5) : tout ce qui touche au reseau se
 * verifie ici, avec des reponses ecrites a la main.
 */

export type Handler = (req: IncomingMessage, res: ServerResponse) => void;

export type TestServer = {
  origin: string;
  /** Journal des requetes recues, dans l'ordre, avec l'instant de reception. */
  requests: { method: string; url: string; headers: NodeJS.Dict<string | string[]>; at: number }[];
  /** Nombre de requetes recues sur un chemin donne. */
  countOf(path: string): number;
};

export async function startServer(t: TestContext, routes: Record<string, Handler>): Promise<TestServer> {
  const requests: TestServer["requests"] = [];

  const server = createServer((req, res) => {
    requests.push({
      method: req.method ?? "GET",
      url: req.url ?? "/",
      headers: req.headers,
      at: performance.now(),
    });

    const path = (req.url ?? "/").split("?")[0] ?? "/";
    const handler = routes[path];
    if (handler === undefined) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("introuvable");
      return;
    }
    handler(req, res);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );

  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("adresse de test introuvable");

  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    countOf: (path) => requests.filter((entry) => (entry.url.split("?")[0] ?? "") === path).length,
  };
}

/** Reponse texte simple. */
export function text(body: string, status = 200, headers: Record<string, string> = {}): Handler {
  return (_req, res) => {
    res.writeHead(status, { "content-type": "text/plain; charset=utf-8", ...headers });
    res.end(body);
  };
}

/** robots.txt autorisant tout. */
export const robotsAllowAll: Handler = text("User-agent: *\nDisallow:\n");
