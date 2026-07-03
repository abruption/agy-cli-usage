// Pure-logic tests — no credentials, keyring, network, or agy required.
// Run against compiled output with: node --test dist/test/unit.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fromApi, fromPty, formatDuration } from '../src/quota.js';
import { parsePanel } from '../src/pty-fallback.js';
import { renderPanel } from '../src/render.js';
import { decodeSecret } from '../src/credentials.js';
import { semverCompare, currentVersion } from '../src/update.js';
import { parseArgs, readCache, writeCache } from '../src/main.js';
import { createApp } from '../src/server.js';
import type { Snapshot } from '../src/types.js';
import { SAMPLE_QUOTA_RESPONSE, SAMPLE_PANEL_TEXT, NOW_MS } from './fixtures.js';

test('semverCompare orders versions numerically', () => {
  assert.ok(semverCompare('0.3.0', '0.2.0') > 0);
  assert.ok(semverCompare('0.2.0', '0.10.0') < 0); // numeric, not lexical
  assert.equal(semverCompare('1.2.3', '1.2.3'), 0);
  assert.equal(semverCompare('v1.0.0', '1.0.0'), 0); // tolerates leading v
  assert.ok(semverCompare('1.0.0', '1.0.0-rc.1') === 0); // prerelease ignored
});

test('currentVersion reads a valid semver from package.json', () => {
  assert.match(currentVersion(), /^\d+\.\d+\.\d+/);
});

const TOKEN_JSON = {
  token: {
    access_token: 'ya29.fake',
    token_type: 'Bearer',
    refresh_token: '1//fake',
    expiry: '2099-01-01T00:00:00Z',
  },
  auth_method: 'consumer',
};

test('decodeSecret reads the plain-JSON token file (headless Linux)', () => {
  const cred = decodeSecret(JSON.stringify(TOKEN_JSON));
  assert.equal(cred.accessToken, 'ya29.fake');
  assert.equal(cred.refreshToken, '1//fake');
  assert.equal(cred.authMethod, 'consumer');
  assert.ok(cred.expiry instanceof Date);
});

test('decodeSecret reads the go-keyring-base64 keyring value (desktop)', () => {
  const raw = 'go-keyring-base64:' + Buffer.from(JSON.stringify(TOKEN_JSON)).toString('base64');
  const cred = decodeSecret(raw);
  assert.equal(cred.accessToken, 'ya29.fake');
  assert.equal(cred.refreshToken, '1//fake');
});

test('formatDuration formats like agy', () => {
  assert.equal(formatDuration(73 * 3600 + 18 * 60), '73h 18m');
  assert.equal(formatDuration(2 * 3600 + 7 * 60), '2h 7m');
  assert.equal(formatDuration(12 * 60), '12m');
  assert.equal(formatDuration(null), null);
});

test('fromApi normalizes the quota response', () => {
  const snap = fromApi({ raw: SAMPLE_QUOTA_RESPONSE, host: 'h', account: 'a@b.com', tier: 'free-tier' }, NOW_MS);
  assert.equal(snap.source, 'api');
  assert.equal(snap.account, 'a@b.com');
  assert.equal(snap.groups.length, 2);

  const gWeekly = snap.groups[0].buckets[0];
  assert.equal(gWeekly.kind, 'weekly');
  assert.equal(gWeekly.remainingFraction, 0.9164178);
  assert.ok(gWeekly.usedFraction !== null && Math.abs(gWeekly.usedFraction - (1 - 0.9164178)) < 1e-9);
  assert.equal(gWeekly.resetAt, '2026-06-27T03:53:09Z');
  assert.ok(gWeekly.resetsInSeconds !== null && gWeekly.resetsInSeconds > 0);
  assert.equal(gWeekly.available, false);

  const claude5h = snap.groups[1].buckets[1];
  assert.equal(claude5h.kind, '5h');
  assert.equal(claude5h.available, true);
  assert.equal(claude5h.remainingFraction, 1);
});

test('parsePanel parses a reconstructed /usage screen', () => {
  const parsed = parsePanel(SAMPLE_PANEL_TEXT);
  assert.equal(parsed.account, 'cursor.chat@gmail.com');
  assert.equal(parsed.groups.length, 2);

  assert.equal(parsed.groups[0].name, 'GEMINI MODELS');
  assert.equal(parsed.groups[0].models, 'Gemini Flash, Gemini Pro');
  assert.equal(parsed.groups[0].buckets[0].kind, 'weekly');
  assert.equal(parsed.groups[0].buckets[0].remainingFraction, 0.9155);
  assert.equal(parsed.groups[0].buckets[0].resetsInSeconds, 73 * 3600 + 18 * 60);

  const claude5h = parsed.groups[1].buckets[1];
  assert.equal(claude5h.available, true);
  assert.equal(claude5h.remainingFraction, 1);
});

test('fromPty + fromApi yield the same shape', () => {
  const apiSnap = fromApi({ raw: SAMPLE_QUOTA_RESPONSE, host: 'h', account: null, tier: null }, NOW_MS);
  const ptySnap = fromPty(parsePanel(SAMPLE_PANEL_TEXT), NOW_MS);
  assert.equal(ptySnap.source, 'pty');
  assert.equal(apiSnap.groups.length, ptySnap.groups.length);
  for (const snap of [apiSnap, ptySnap]) {
    for (const g of snap.groups) {
      assert.ok(typeof g.name === 'string');
      for (const b of g.buckets) {
        assert.ok(['weekly', '5h'].includes(b.kind));
        assert.ok(b.remainingFraction == null || (b.remainingFraction >= 0 && b.remainingFraction <= 1));
      }
    }
  }
});

test('renderPanel produces a non-empty panel with expected markers', () => {
  const snap = fromApi({ raw: SAMPLE_QUOTA_RESPONSE, host: 'h', account: 'a@b.com', tier: 'free-tier' }, NOW_MS);
  const out = renderPanel(snap);
  assert.match(out, /Models & Quota/);
  assert.match(out, /GEMINI MODELS/);
  assert.match(out, /Quota available/);
  assert.match(out, /Weekly Limit/);
});

// --- main.ts: parseArgs --------------------------------------------------

test('parseArgs accepts every documented --source/--channel value', () => {
  assert.equal(parseArgs(['--source', 'auto']).source, 'auto');
  assert.equal(parseArgs(['--source', 'api']).source, 'api');
  assert.equal(parseArgs(['--source', 'pty']).source, 'pty');
  assert.equal(parseArgs(['--channel', 'auto']).channel, 'auto');
  assert.equal(parseArgs(['--channel', 'daily']).channel, 'daily');
  assert.equal(parseArgs(['--channel', 'prod']).channel, 'prod');
});

test('parseArgs rejects an unrecognized --source instead of silently behaving like "auto"', () => {
  assert.throws(() => parseArgs(['--source', 'bogus']), /invalid --source 'bogus'/);
});

test('parseArgs rejects an unrecognized --channel instead of silently falling through to all hosts', () => {
  assert.throws(() => parseArgs(['--channel', 'bogus']), /invalid --channel 'bogus'/);
});

// --- main.ts: cache (readCache/writeCache) --------------------------------

function withTmpCacheFile(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'agy-usage-cache-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'quota.json');
}

function sampleSnapshot(source: 'api' | 'pty') {
  const snap = fromApi({ raw: SAMPLE_QUOTA_RESPONSE, host: 'h', account: 'a@b.com', tier: 'free-tier' }, NOW_MS);
  return { ...snap, source };
}

test('readCache returns null when no cache file exists yet', (t) => {
  const cacheFile = withTmpCacheFile(t);
  assert.equal(readCache('auto', 'auto', cacheFile), null);
});

test('writeCache + readCache round-trips when source and channel match', (t) => {
  const cacheFile = withTmpCacheFile(t);
  const snap = sampleSnapshot('api');
  writeCache(snap, 'api', 'daily', cacheFile);
  const hit = readCache('api', 'daily', cacheFile);
  assert.ok(hit);
  assert.equal(hit!.account, snap.account);
});

test('readCache misses when the requested source differs from the cached source (regression: cross-mode stale data)', (t) => {
  const cacheFile = withTmpCacheFile(t);
  // Simulates: `--source auto` fell back to PTY and cached a pty-sourced
  // snapshot; a later `--source api` call must NOT silently reuse it —
  // it must miss and go hit the real API (or throw, per the `api` contract).
  writeCache(sampleSnapshot('pty'), 'auto', 'auto', cacheFile);
  assert.equal(readCache('api', 'auto', cacheFile), null);
});

test('readCache misses when the requested channel differs from the cached channel', (t) => {
  const cacheFile = withTmpCacheFile(t);
  writeCache(sampleSnapshot('api'), 'api', 'daily', cacheFile);
  assert.equal(readCache('api', 'prod', cacheFile), null);
});

test('readCache misses on a pre-existing cache file in the old (source/channel-less) format', (t) => {
  const cacheFile = withTmpCacheFile(t);
  writeFileSync(cacheFile, JSON.stringify({ ts: Date.now(), snap: sampleSnapshot('api') }));
  assert.equal(readCache('auto', 'auto', cacheFile), null);
});

// --- pty-fallback.ts: parseDuration (via parsePanel's "Refreshes in …" line) ---
// parseDuration has no exported surface of its own, so these drive it through
// parsePanel with a minimal single-bucket panel — the same way the real
// "Refreshes in …" text reaches it from a reconstructed /usage screen.

function panelWithRefresh(refreshText: string): string {
  return `TEST MODELS
  Weekly Limit
    50%
    Refreshes in ${refreshText}
`;
}

test('parseDuration (via parsePanel) parses abbreviated day units like "3d 2h"', () => {
  const parsed = parsePanel(panelWithRefresh('3d 2h'));
  assert.equal(parsed.groups[0].buckets[0].resetsInSeconds, 3 * 86400 + 2 * 3600);
});

test('parseDuration (via parsePanel) parses a bare abbreviated day unit like "1d"', () => {
  const parsed = parsePanel(panelWithRefresh('1d'));
  assert.equal(parsed.groups[0].buckets[0].resetsInSeconds, 1 * 86400);
});

test('parseDuration (via parsePanel) still parses hours+minutes with no day component', () => {
  const parsed = parsePanel(panelWithRefresh('2h 30m'));
  assert.equal(parsed.groups[0].buckets[0].resetsInSeconds, 2 * 3600 + 30 * 60);
});

test('parseDuration (via parsePanel) still parses the spelled-out "day"/"days" form', () => {
  assert.equal(parsePanel(panelWithRefresh('1 day')).groups[0].buckets[0].resetsInSeconds, 86400);
  assert.equal(
    parsePanel(panelWithRefresh('3 days 2 hours')).groups[0].buckets[0].resetsInSeconds,
    3 * 86400 + 2 * 3600,
  );
});

test('parseDuration (via parsePanel) combines day + hour + minute abbreviations', () => {
  const parsed = parsePanel(panelWithRefresh('1d 2h 30m'));
  assert.equal(parsed.groups[0].buckets[0].resetsInSeconds, 86400 + 2 * 3600 + 30 * 60);
});

// --- render.ts: clamped percentage + multi-line wrap ------------------------

test('renderPanel clamps an out-of-range remainingFraction for both the bar and the percentage text', () => {
  const snap = fromApi({ raw: SAMPLE_QUOTA_RESPONSE, host: 'h', account: 'a@b.com', tier: 'free-tier' }, NOW_MS);
  // Simulate a bad value from the undocumented endpoint: > 1 (would print "150.00%" unclamped).
  snap.groups[0].buckets[0].remainingFraction = 1.5;
  snap.groups[0].buckets[0].available = false;
  const out = renderPanel(snap);
  assert.doesNotMatch(out, /150\.00%/);
  assert.doesNotMatch(out, /150% remaining/);
  assert.match(out, /100\.00%/);
  assert.match(out, /100% remaining/);
});

test('renderPanel clamps a negative remainingFraction to 0%', () => {
  const snap = fromApi({ raw: SAMPLE_QUOTA_RESPONSE, host: 'h', account: 'a@b.com', tier: 'free-tier' }, NOW_MS);
  snap.groups[0].buckets[0].remainingFraction = -0.3;
  snap.groups[0].buckets[0].available = false;
  const out = renderPanel(snap);
  assert.doesNotMatch(out, /-30\.00%/);
  assert.match(out, /0\.00%/);
  assert.match(out, /0% remaining/);
});

test('renderPanel wraps a long note across multiple prefixed lines', () => {
  const snap = fromApi({ raw: SAMPLE_QUOTA_RESPONSE, host: 'h', account: 'a@b.com', tier: 'free-tier' }, NOW_MS);
  const longNote =
    'Within each group, models share a weekly limit and a five hour limit, and this sentence ' +
    'is deliberately long enough that it must wrap across more than one rendered line in the panel footer.';
  snap.note = longNote;
  const out = renderPanel(snap);
  const wrappedLines = out.split('\n').filter((l) => l.includes('│'));
  assert.ok(wrappedLines.length > 1, 'expected the long note to wrap across multiple lines');
  // Strip ANSI SGR codes (e.g. dim) without a literal control character in the
  // source, so as not to trip the `no-control-regex` lint rule.
  const stripAnsi = (s: string): string => s.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');
  for (const line of wrappedLines) {
    // width(76) + '  │' prefix, generously bounded to allow for ANSI dim codes when colorized.
    assert.ok(stripAnsi(line).length <= 76 + 4);
  }
  // Reassembling the wrapped lines (minus the '  │' prefix) should reproduce every word.
  const rejoined = wrappedLines.map((l) => stripAnsi(l).replace(/^\s*│/, '').trim()).join(' ');
  for (const word of longNote.split(/\s+/)) {
    assert.ok(rejoined.includes(word), `expected wrapped output to contain "${word}"`);
  }
});

// --- server.ts: HTTP routing (createApp with an injected snapshot fetcher) ---

function listenEphemeral(server: ReturnType<typeof createApp>): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') resolve(addr.port);
      else resolve(0);
    });
  });
}

function closeServer(server: ReturnType<typeof createApp>): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

test('GET /healthz returns { ok: true }', async (t) => {
  const server = createApp(async () => { throw new Error('should not be called'); });
  const port = await listenEphemeral(server);
  t.after(() => closeServer(server));

  const res = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/json');
  assert.deepEqual(await res.json(), { ok: true });
});

test('GET /quota returns the snapshot JSON with caching headers on success', async (t) => {
  const sampleSnap: Snapshot = fromApi(
    { raw: SAMPLE_QUOTA_RESPONSE, host: 'h', account: 'a@b.com', tier: 'free-tier' },
    NOW_MS,
  );
  let receivedOpts: unknown;
  const server = createApp(async (opts) => {
    receivedOpts = opts;
    return sampleSnap;
  });
  const port = await listenEphemeral(server);
  t.after(() => closeServer(server));

  const res = await fetch(`http://127.0.0.1:${port}/quota`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal(res.headers.get('cache-control'), 'public, max-age=300');
  const body = (await res.json()) as Snapshot;
  assert.equal(body.account, 'a@b.com');
  assert.deepEqual(receivedOpts, { source: 'auto', channel: 'auto', cache: true });
});

test('GET /quota?refresh=1 requests an uncached snapshot', async (t) => {
  let receivedOpts: unknown;
  const server = createApp(async (opts) => {
    receivedOpts = opts;
    return fromApi({ raw: SAMPLE_QUOTA_RESPONSE, host: 'h', account: null, tier: null }, NOW_MS);
  });
  const port = await listenEphemeral(server);
  t.after(() => closeServer(server));

  const res = await fetch(`http://127.0.0.1:${port}/quota?refresh=1`);
  assert.equal(res.status, 200);
  assert.deepEqual(receivedOpts, { source: 'auto', channel: 'auto', cache: false });
});

test('GET /quota returns 502 with an error body when the snapshot fetch fails', async (t) => {
  const server = createApp(async () => { throw new Error('upstream unavailable'); });
  const port = await listenEphemeral(server);
  t.after(() => closeServer(server));

  const res = await fetch(`http://127.0.0.1:${port}/quota`);
  assert.equal(res.status, 502);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, 'upstream unavailable');
});

test('unknown routes return 404 with an error body', async (t) => {
  const server = createApp(async () => { throw new Error('should not be called'); });
  const port = await listenEphemeral(server);
  t.after(() => closeServer(server));

  const res = await fetch(`http://127.0.0.1:${port}/nope`);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'not found' });
});
