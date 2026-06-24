#!/usr/bin/env node
// Optional lightweight HTTP endpoint for dashboard integration (e.g. ontology).
// Serves the normalized quota snapshot as JSON, going through the same 5-minute
// cache as the CLI so polling clients never hammer the upstream API.
//
//   PORT=3007 node server.js
//   GET /quota   -> normalized snapshot JSON
//   GET /healthz -> { ok: true }

import { createServer } from 'node:http';
import { getSnapshot } from './src/main.js';

const PORT = Number(process.env.PORT) || 3007;
const HOST = process.env.HOST || '127.0.0.1';

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url.pathname === '/quota') {
    try {
      const noCache = url.searchParams.get('refresh') === '1';
      const snap = await getSnapshot({ source: 'auto', channel: 'auto', cache: !noCache });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=300',
      });
      res.end(JSON.stringify(snap));
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`agy-usage server on http://${HOST}:${PORT}  (GET /quota)\n`);
});
