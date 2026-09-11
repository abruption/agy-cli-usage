#!/usr/bin/env node
// Optional lightweight HTTP endpoint for dashboard integration.
// Serves the normalized quota snapshot as JSON, going through the same 5-minute
// cache as the CLI so polling clients never hammer the upstream API.
//
//   PORT=3007 node dist/src/server.js
//   GET /quota   -> normalized snapshot JSON
//   GET /healthz -> { ok: true }

import { createServer, type Server } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getSnapshot } from './main.js';
import type { Snapshot } from './types.js';

export interface ServerPolicy {
  allowedOrigins?: readonly string[];
  allowedHosts?: readonly string[];
}

type SnapshotFetcher = (opts: { source: 'auto'; channel: 'auto'; cache: boolean }) => Promise<Snapshot>;

const splitList = (value: string | undefined): string[] => value?.split(',').map((v) => v.trim()).filter(Boolean) ?? [];

function hostname(value: string): string {
  const url = new URL(`http://${value}`);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || /[\s/\\?#@]/.test(value)) {
    throw new Error('Invalid host');
  }
  return url.hostname;
}

/** No port is bound until listen() is called. Policy defaults to environment configuration. */
export function createApp(fetchSnapshot: SnapshotFetcher = getSnapshot, policy: ServerPolicy = {}): Server {
  const origins = new Set(policy.allowedOrigins ?? splitList(process.env.AGY_ALLOWED_ORIGINS));
  for (const origin of origins) {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) {
      throw new Error('AGY_ALLOWED_ORIGINS must contain exact HTTP(S) origins (no wildcard or path)');
    }
  }
  const hosts = new Set(['localhost', '127.0.0.1', '[::1]',
    ...(policy.allowedHosts ?? splitList(process.env.AGY_ALLOWED_HOSTS)).map(hostname)]);

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Vary', 'Origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const reply = (status: number, body: unknown): void => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const handle = async (): Promise<void> => {
      let url: URL;
      let host: string;
      try {
        if (!req.headers.host || req.rawHeaders.filter((h, i) => i % 2 === 0 && h.toLowerCase() === 'host').length !== 1) {
          throw new Error('Missing or duplicate Host');
        }
        host = hostname(req.headers.host);
        // Parse against a fixed base; never interpret the Host header or an
        // absolute request target as the routing authority.
        const target = req.url ?? '/';
        if (!target.startsWith('/') || target.startsWith('//') || /[\\#]/.test(target)) throw new Error('Invalid target');
        decodeURI(target); // reject malformed percent encoding
        url = new URL(target, 'http://localhost');
      } catch {
        reply(400, { error: 'invalid request' });
        return;
      }
      if (!hosts.has(host)) { reply(403, { error: 'host not allowed' }); return; }
      const origin = req.headers.origin;
      if ((origin && !origins.has(origin)) || (!origin && req.headers['sec-fetch-site'] === 'cross-site')) {
        reply(403, { error: 'origin not allowed' });
        return;
      }
      if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
      if (!['/quota', '/healthz'].includes(url.pathname)) { reply(404, { error: 'not found' }); return; }
      if (req.method === 'OPTIONS' && origin && req.headers['access-control-request-method'] === 'GET'
          && !req.headers['access-control-request-headers']) {
        res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET', 'Allow': 'GET, OPTIONS' });
        res.end();
        return;
      }
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET, OPTIONS');
        reply(405, { error: 'method not allowed' });
        return;
      }
      if (url.pathname === '/healthz') { reply(200, { ok: true }); return; }
      try {
        const snap = await fetchSnapshot({ source: 'auto', channel: 'auto', cache: url.searchParams.get('refresh') !== '1' });
        reply(200, snap);
      } catch {
        reply(502, { error: 'quota unavailable' });
      }
    };
    void handle().catch(() => {
      if (!res.headersSent) reply(500, { error: 'internal error' });
      else res.destroy();
    });
  });
}

// Only bind a real port when this file is executed directly (the `serve`
// script's entry point) — guarded the same way as main.ts's isMainModule()
// so `createApp` can be imported for unit testing without the import itself
// starting a live server as a side effect.
function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const PORT = process.env.PORT === undefined ? 3007 : Number(process.env.PORT);
  const HOST = process.env.HOST || '127.0.0.1';
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('PORT must be an integer from 1 to 65535');
  const server = createApp();
  server.on('error', () => { process.stderr.write('Could not bind HTTP server\n'); process.exitCode = 1; });
  server.listen(PORT, HOST, () => {
    process.stdout.write(`agy-usage server on http://${HOST}:${PORT}  (GET /quota)\n`);
  });
}
