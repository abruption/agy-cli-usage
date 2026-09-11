import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createApp } from '../src/server.js';

test('HTTP policy rejects invalid traffic before credential access and stays alive', async (t) => {
  let calls = 0;
  const server = createApp(async () => { calls++; throw new Error('private-upstream-token'); }, {
    allowedOrigins: ['https://dashboard.example'], allowedHosts: ['quota.example'],
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  const send = (method: string, headers: Record<string, string>, path = '/quota') =>
    new Promise<{ status: number; body: string; headers: Record<string, unknown> }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: addr.port, method, headers, path }, (res) => {
        let body = '';
        res.on('data', (d) => { body += d; });
        res.on('end', () => resolve({ status: res.statusCode!, body, headers: res.headers }));
      });
      req.on('error', reject);
      req.end();
    });
  assert.equal((await send('GET', { Host: '[' })).status, 400);
  assert.equal((await send('GET', {}, '/%zz')).status, 400);
  assert.equal((await send('GET', {}, 'http://untrusted.example/quota')).status, 400);
  assert.equal((await send('GET', { Host: 'rebind.example' })).status, 403);
  assert.equal((await send('GET', { Origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await send('GET', { Origin: 'null' })).status, 403);
  assert.equal((await send('GET', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await send('POST', {})).status, 405);
  assert.equal((await send('HEAD', {})).status, 405);
  assert.equal((await send('OPTIONS', {})).status, 405);
  const preflight = await send('OPTIONS', { Origin: 'https://dashboard.example', 'Access-Control-Request-Method': 'GET' });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], 'https://dashboard.example');
  assert.equal(calls, 0);
  assert.equal((await send('GET', {}, '/healthz')).status, 200);
  const result = await send('GET', { Host: 'quota.example', Origin: 'https://dashboard.example' });
  assert.equal(result.status, 502);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(result.headers.vary, 'Origin');
  assert.doesNotMatch(result.body, /private-upstream-token/);
  assert.equal(calls, 1);
});

test('wildcard, opaque and non-origin CORS configuration is rejected', () => {
  for (const origin of ['*', 'null', 'file:///', 'https://example.com/path', 'https://example.com/']) {
    assert.throws(() => createApp(undefined, { allowedOrigins: [origin] }));
  }
});
