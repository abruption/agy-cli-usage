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
