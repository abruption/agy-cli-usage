import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync, symlinkSync, readdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readCache, writeCache } from '../src/cache.js';
import { fromApi } from '../src/quota.js';

const snap = fromApi({ raw: { groups: [] }, host: null, account: 'fixture@example.invalid', tier: null });

test('cache rejects malformed, expired and future records and preserves a valid snapshot', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-cache-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'quota.json');
  const record = { ts: Date.now(), source: 'api', channel: 'auto', snap };
  for (const value of [null, {}, { ...record, ts: Date.now() + 60_000 }, { ...record, ts: Date.now() - 300_001 },
    { ...record, ts: 'now' }, { ...record, snap: {} }, { ...record, snap: { ...snap, groups: [null] } },
    { ...record, snap: { ...snap, fetchedAt: 'invalid' } }]) {
    writeFileSync(file, JSON.stringify(value));
    assert.equal(readCache('api', 'auto', file), null);
  }
  writeFileSync(file, '{');
  assert.equal(readCache('api', 'auto', file), null);
  writeCache(snap, 'api', 'auto', file);
  assert.deepEqual(readCache('api', 'auto', file), snap);
});

test('cache tightens legacy modes and refuses symlink files/directories', { skip: process.platform === 'win32' }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-cache-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'quota.json');
  writeCache(snap, 'api', 'auto', file);
  chmodSync(dir, 0o755); chmodSync(file, 0o644);
  assert.ok(readCache('api', 'auto', file));
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const link = join(dir, 'link.json');
  symlinkSync(file, link);
  const before = readFileSync(file, 'utf8');
  assert.equal(readCache('api', 'auto', link), null);
  writeCache({ ...snap, account: 'modified' }, 'api', 'auto', link);
  assert.equal(readFileSync(file, 'utf8'), before);
  const dirLink = join(dir, 'directory-link');
  symlinkSync(dir, dirLink);
  assert.equal(readCache('api', 'auto', join(dirLink, 'quota.json')), null);
});

test('independent concurrent writers produce a complete record and remove temporary files', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-cache-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'quota.json');
  const moduleUrl = new URL('../src/cache.js', import.meta.url).href;
  const script = `import {writeCache} from ${JSON.stringify(moduleUrl)}; for(let i=0;i<8;i++) writeCache(${JSON.stringify(snap)},'api','auto',${JSON.stringify(file)});`;
  await Promise.all([1, 2, 3].map(() => promisify(execFile)(process.execPath, ['--input-type=module', '-e', script])));
  assert.deepEqual(readCache('api', 'auto', file), snap);
  assert.deepEqual(readdirSync(dir), ['quota.json']);
  assert.doesNotThrow(() => writeCache(snap, 'api', 'auto', join(file, 'unwritable.json')));
});
