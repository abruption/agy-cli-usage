import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeSecret, decodeRefreshResponse, CredentialError } from '../src/credentials.js';
import { fromApi, fromPty } from '../src/quota.js';
import { renderPanel } from '../src/render.js';
import { terminalText } from '../src/data.js';
import type { RawQuotaResponse } from '../src/types.js';

test('malformed credential payloads consistently produce safe CredentialError', () => {
  for (const value of [null, [], 'private', { token: null }, { token: [] }, { access_token: '' },
    { access_token: 'fake', expiry: 'invalid' }, { access_token: 'fake', refresh_token: 123 }]) {
    assert.throws(() => decodeSecret(JSON.stringify(value)), (err: unknown) =>
      err instanceof CredentialError && !err.message.includes('private'));
  }
  for (const value of [null, {}, { access_token: 1 }, { access_token: ' ' }]) {
    assert.throws(() => decodeRefreshResponse(value), CredentialError);
  }
  assert.equal(decodeRefreshResponse({ access_token: 'fixture' }), 'fixture');
});

test('quota normalization rejects broken structures and bounds JSON values', () => {
  for (const raw of [null, {}, { groups: {} }, { groups: [null] }, { groups: [{ buckets: [null] }] }]) {
    assert.throws(() => fromApi({ raw: raw as RawQuotaResponse, host: null, account: null, tier: null }), /Invalid quota response/);
  }
  for (const [value, expected] of [[1.5, 1], [-1, 0], [NaN, null], [Infinity, null], [0.25, 0.25]]) {
    const snap = fromApi({ raw: { groups: [{ buckets: [{ remainingFraction: value!, resetTime: 'invalid' }] }] }, host: null, account: null, tier: null });
    const b = snap.groups[0].buckets[0];
    assert.equal(b.remainingFraction, expected);
    assert.equal(b.usedFraction, expected === null ? null : 1 - expected!);
    assert.equal(b.available, expected === 1);
    assert.equal(b.resetAt, null);
    assert.equal(b.resetsInSeconds, null);
  }
  const pty = fromPty({ account: null, groups: [{ name: 'MODELS', models: '', buckets: [{
    kind: 'weekly', label: 'Weekly', remainingFraction: 2, resetsInSeconds: 1e100, available: false, description: null,
  }] }] });
  assert.equal(pty.groups[0].buckets[0].remainingFraction, 1);
  assert.equal(pty.groups[0].buckets[0].resetAt, null);
});

test('human output strips CSI/OSC and control characters without mutating JSON', () => {
  const hostile = '\x1b[2Jname\x1b]52;c;ZmFrZQ==\x07\rforged\x9b31m';
  const snap = fromApi({ raw: { groups: [{ displayName: hostile, description: hostile, buckets: [{ displayName: hostile }] }], description: hostile }, host: hostile, account: hostile, tier: null });
  const output = renderPanel(snap);
  assert.equal(output.includes('\x1b]52'), false);
  assert.equal(output.includes('\x1b[2J'), false);
  assert.equal(output.includes('\r'), false);
  assert.equal(snap.account, hostile);
  assert.equal(terminalText('hello\nworld\t!'), 'hello world !');
});
