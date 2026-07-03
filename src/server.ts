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

const PORT = Number(process.env.PORT) || 3007;
const HOST = process.env.HOST || '127.0.0.1';

type SnapshotFetcher = (opts: { source: 'auto'; channel: 'auto'; cache: boolean }) => Promise<Snapshot>;

/**
 * Builds the HTTP server without binding a port.
 * `fetchSnapshot` defaults to the real `getSnapshot` (network/keyring/PTY) —
 * exposed as a parameter purely so tests can inject a stub and exercise the
 * routing/response-shape logic without live credentials or a PTY.
 */
export function createApp(fetchSnapshot: SnapshotFetcher = getSnapshot): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (url.pathname === '/quota') {
      try {
        const noCache = url.searchParams.get('refresh') === '1';
        const snap = await fetchSnapshot({ source: 'auto', channel: 'auto', cache: !noCache });
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=300',
        });
        res.end(JSON.stringify(snap));
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
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
  const server = createApp();
  server.listen(PORT, HOST, () => {
    process.stdout.write(`agy-usage server on http://${HOST}:${PORT}  (GET /quota)\n`);
  });
}
