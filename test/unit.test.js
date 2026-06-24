// Pure-logic tests — no credentials, keyring, network, or agy required.
// Run with: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fromApi, fromPty, formatDuration } from '../src/quota.js';
import { parsePanel } from '../src/pty-fallback.js';
import { renderPanel } from '../src/render.js';
import { SAMPLE_QUOTA_RESPONSE, SAMPLE_PANEL_TEXT, NOW_MS } from './fixtures.js';

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
  assert.ok(Math.abs(gWeekly.usedFraction - (1 - 0.9164178)) < 1e-9);
  assert.equal(gWeekly.resetAt, '2026-06-27T03:53:09Z');
  assert.ok(gWeekly.resetsInSeconds > 0);
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
