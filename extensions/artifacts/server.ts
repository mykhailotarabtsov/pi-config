import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { extname } from "node:path";

import { HOST, MERMAID_ASSET_PATH } from "./config.js";
import { listArtifacts, readStoredArtifact, safeArtifactPath } from "./utils.js";
import { renderIndexPage, sanitizeStoredHtml } from "./templates.js";

interface ServerState {
  port: number;
  token: string;
  server: Server;
  clients: Set<ServerResponse>;
}

let state: ServerState | null = null;
let starting: Promise<ServerState> | null = null;
const trustedArtifacts = new Map<string, string>();
const SAFE_CSP = "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; style-src 'none'; img-src 'none'; script-src 'none'";
const INDEX_CSP = "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; style-src 'unsafe-inline'; img-src 'none'; script-src 'none'";
const require = createRequire(import.meta.url);
const MERMAID_ASSET = readFileSync(require.resolve("@mermaid-js/tiny/dist/mermaid.tiny.js"));

function digest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function markArtifactTrusted(slug: string, content: string): void {
  trustedArtifacts.set(slug, digest(content));
}

function cookieValue(raw: string | undefined, name: string): string | null {
  const match = raw?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  if (!match) return null;
  try { return decodeURIComponent(match.slice(name.length + 1)); } catch { return null; }
}

function authorized(candidate: string | null, expected: string): boolean {
  if (!candidate) return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function artifactUrl(slug?: string): Promise<string> {
  const active = await ensureServer();
  const path = slug ? `/${slug}.html` : "/";
  return `http://${HOST}:${active.port}${path}?token=${encodeURIComponent(active.token)}`;
}

export function displayArtifactUrl(slug?: string): string | undefined {
  if (!state) return undefined;
  return `http://${HOST}:${state.port}${slug ? `/${slug}.html` : "/"}`;
}

export function notifyReload(slug: string): void {
  if (!state) return;
  const payload = `event: reload\ndata: ${slug}\n\n`;
  for (const response of state.clients) {
    try { response.write(payload); } catch { state.clients.delete(response); }
  }
}

export function isRunning(): boolean { return state !== null; }
export function runningPort(): number | null { return state?.port ?? null; }

export async function ensureServer(): Promise<{ port: number; token: string }> {
  if (state) return state;
  if (starting) return starting;
  starting = (async () => {
    const clients = new Set<ServerResponse>();
    const token = randomBytes(32).toString("hex");
    const server = createServer((req, res) => handle(req, res, clients, token));
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, HOST, () => {
        server.removeListener("error", reject);
        const address = server.address();
        resolve(typeof address === "object" && address ? address.port : 0);
      });
    });
    state = { port, token, server, clients };
    return state;
  })();
  try {
    return await starting;
  } finally {
    starting = null;
  }
}

export function stopServer(): void {
  if (!state) return;
  for (const response of state.clients) { try { response.end(); } catch {} }
  state.clients.clear();
  state.server.close();
  state = null;
  trustedArtifacts.clear();
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer, extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-origin",
    ...extra,
  });
  res.end(body);
}

function handle(req: IncomingMessage, res: ServerResponse, clients: Set<ServerResponse>, token: string): void {
  if (req.method !== "GET") {
    send(res, 405, "text/plain; charset=utf-8", "method not allowed");
    return;
  }
  let parsed: URL;
  try { parsed = new URL(req.url ?? "/", `http://${HOST}`); } catch {
    send(res, 400, "text/plain; charset=utf-8", "bad request");
    return;
  }
  const queryToken = parsed.searchParams.get("token");
  const suppliedToken = queryToken ?? cookieValue(req.headers.cookie, "artifact_token");
  if (!authorized(suppliedToken, token)) {
    send(res, 404, "text/plain; charset=utf-8", "not found");
    return;
  }
  const authHeaders = queryToken ? { "Set-Cookie": `artifact_token=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/` } : {};

  if (parsed.pathname === MERMAID_ASSET_PATH) {
    send(res, 200, "application/javascript; charset=utf-8", MERMAID_ASSET, authHeaders);
    return;
  }

  if (parsed.pathname === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Content-Type-Options": "nosniff",
      ...authHeaders,
    });
    res.write(": connected\n\n");
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  if (parsed.pathname === "/") {
    const indexHtml = renderIndexPage(listArtifacts(), token);
    send(res, 200, "text/html; charset=utf-8", indexHtml, { "Content-Security-Policy": extractCsp(indexHtml) ?? INDEX_CSP, ...authHeaders });
    return;
  }

  const match = parsed.pathname.match(/^\/([a-z0-9-]+)\.html$/i);
  const safe = match ? safeArtifactPath(match[1]) : null;
  if (!safe) {
    send(res, 404, "text/plain; charset=utf-8", "not found");
    return;
  }
  const raw = readStoredArtifact(safe);
  if (raw === null) {
    send(res, 404, "text/plain; charset=utf-8", "not found");
    return;
  }
  const trusted = trustedArtifacts.get(match[1]) === digest(raw);
  const body = trusted ? raw : sanitizeStoredHtml(raw);
  const policy = trusted ? extractCsp(raw) ?? SAFE_CSP : SAFE_CSP;
  send(res, 200, mimeType(safe), req.method === "HEAD" ? "" : body, { "Content-Security-Policy": policy, ...authHeaders });
}

function extractCsp(html: string): string | null {
  const match = html.match(/<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]+content="([^"]+)"/i)
    ?? html.match(/<meta[^>]+content="([^"]+)"[^>]+http-equiv=["']Content-Security-Policy["']/i)
    ?? html.match(/<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]+content='([^']+)'/i)
    ?? html.match(/<meta[^>]+content='([^']+)'[^>]+http-equiv=["']Content-Security-Policy["']/i);
  return match?.[1] ?? null;
}

function mimeType(path: string): string {
  const ext = extname(path).toLowerCase();
  return ext === ".html" ? "text/html; charset=utf-8" : "application/octet-stream";
}
