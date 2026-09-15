import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { readCache, writeCache } from '../src/cache.js';
import { createSnapshotGetter, parseArgs } from '../src/main.js';
import { acquireCacheLease } from '../src/private-cache.js';
import { fromApi } from '../src/quota.js';
import { renderPanel } from '../src/render.js';
import { createApp } from '../src/server.js';
import { currentVersion, stableVersion } from '../src/update.js';
import { createUpdateNotifier, readUpdateCache, refreshUpdateCache, UPDATE_MAX_BYTES, UPDATE_TTL_MS, writeUpdateCache } from '../src/update-cache.js';
import type { UpdateRecord } from '../src/update-cache.js';
import type { Snapshot } from '../src/types.js';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../src/main.js', import.meta.url));
const record = (latest: string | null = '999.0.0', now = Date.now()): UpdateRecord => ({ schemaVersion: 1, checkedAt: new Date(now).toISOString(), latest });
const sample = (): Snapshot => fromApi({ raw: { groups: [] }, host: 'fixture.invalid', account: null, tier: null });
function fixture(t: TestContext): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'agy-update-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, file: join(dir, 'update.json') };
}
async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 8_000;
  while (!check()) {
    assert.ok(Date.now() < end, 'background operation did not complete');
    await delay(20);
  }
}

test('update cache has a strict stable-version schema, bounded size and 24-hour freshness', (t) => {
  const { file } = fixture(t);
  const now = Date.now();
  const valid = record('9.10.0', now);
  assert.ok(writeUpdateCache(valid, file));
  assert.deepEqual(readUpdateCache(file, now + UPDATE_TTL_MS - 1), valid);
  assert.equal(readUpdateCache(file, now + UPDATE_TTL_MS), null);
  assert.equal(readUpdateCache(file, now - 1), null);
  for (const latest of ['v1.0.0', '1.0.0-rc.1', '1.0.0+build', '01.0.0', '1.0', '1.2.9007199254740992', '1.0.0 & npm', '', 42]) {
    writeFileSync(file, JSON.stringify({ ...valid, latest }));
    assert.equal(readUpdateCache(file, now), null);
    assert.equal(stableVersion(latest), null);
  }
  for (const value of [null, {}, { ...valid, schemaVersion: 2 }, { ...valid, checkedAt: 'invalid' }, { ...valid, checkedAt: 123 }]) {
    writeFileSync(file, JSON.stringify(value));
    assert.equal(readUpdateCache(file, now), null);
  }
  writeFileSync(file, '{');
  assert.equal(readUpdateCache(file, now), null);
  writeFileSync(file, JSON.stringify({ ...valid, padding: 'x'.repeat(UPDATE_MAX_BYTES) }));
  assert.equal(readUpdateCache(file, now), null);
  assert.ok(writeUpdateCache(record(null, now), file));
  assert.equal(readUpdateCache(file, now)?.latest, null);
});

test('update records whitelist fields, write privately and atomically, and refuse unsafe paths', (t) => {
  const { dir, file } = fixture(t);
  const value = { ...record(), token: 'must-not-be-stored', quota: sample() };
  assert.ok(writeUpdateCache(value, file));
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf8'))).sort(), ['checkedAt', 'latest', 'schemaVersion']);
  assert.deepEqual(readdirSync(dir), ['update.json']);
  if (process.platform !== 'win32') {
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const link = join(dir, 'link.json');
    symlinkSync(file, link);
    assert.equal(readUpdateCache(link), null);
    assert.equal(writeUpdateCache(record('888.0.0'), link), false);
    assert.equal(readUpdateCache(file)?.latest, '999.0.0');
  }
  assert.equal(writeUpdateCache(value, join(file, 'denied.json')), false);
});

test('only a fresh newer stable version advertises the invoking client; failures and expiry omit it', (t) => {
  const { file } = fixture(t);
  let now = Date.now(), current = '1.2.0', launches = 0;
  const notice = createUpdateNotifier({ cacheFile: file, now: () => now, current: () => current, launch: () => { launches++; } });
  writeUpdateCache(record('1.10.0', now), file);
  const expected = { schemaVersion: 1, status: 'available', current, latest: '1.10.0', checkedAt: new Date(now).toISOString(), source: 'npm_registry_cache', command: 'agy-cli-usage update' };
  assert.deepEqual(notice(), expected);
  current = '1.10.0'; assert.equal(notice(), undefined);
  current = '2.0.0'; assert.equal(notice(), undefined);
  current = 'invalid'; assert.equal(notice(), undefined);
  current = '1.2.0';
  now += UPDATE_TTL_MS;
  assert.equal(notice(), undefined);
  assert.equal(launches, 1);
  writeUpdateCache(record(null, now), file);
  assert.equal(notice(), undefined);
  assert.equal(launches, 1);
});

test('opt-out suppresses cached notices and IO; spawn/cache failures are isolated and throttled', (t) => {
  const { file } = fixture(t);
  let now = Date.now(), launches = 0;
  const notice = createUpdateNotifier({ cacheFile: file, now: () => now, launch: () => { launches++; throw new Error('spawn denied'); } });
  assert.equal(notice(false), undefined);
  assert.equal(launches, 0);
  const old = process.env.AGY_NO_UPDATE_CHECK;
  t.after(() => { if (old === undefined) delete process.env.AGY_NO_UPDATE_CHECK; else process.env.AGY_NO_UPDATE_CHECK = old; });
  process.env.AGY_NO_UPDATE_CHECK = '1';
  assert.equal(notice(), undefined);
  assert.equal(launches, 0);
  writeUpdateCache(record(), file);
  assert.equal(notice(), undefined);
  process.env.AGY_NO_UPDATE_CHECK = '0';
  assert.ok(notice());
  rmSync(file);
  for (let i = 0; i < 10; i++) assert.equal(notice(), undefined);
  assert.equal(launches, 1);
  now += UPDATE_TTL_MS;
  assert.equal(notice(), undefined);
  assert.equal(launches, 2);
  assert.equal(parseArgs(['--no-update-check']).updateCheck, false);
  assert.throws(() => parseArgs(['update', '--no-update-check']));
});

test('refresh is single-flight, persists negative results, and explicit checks bypass TTL/cache failures', async (t) => {
  const { file } = fixture(t);
  let calls = 0;
  const latest = async () => { calls++; await delay(10); return '999.0.0'; };
  const a = refreshUpdateCache({ cacheFile: file, latest });
  const b = refreshUpdateCache({ cacheFile: file, latest });
  assert.equal(a, b);
  assert.deepEqual(await Promise.all([a, b]), ['999.0.0', '999.0.0']);
  await refreshUpdateCache({ cacheFile: file, latest });
  assert.equal(calls, 1);
  await refreshUpdateCache({ cacheFile: file, force: true, latest: async () => { calls++; throw new Error('offline'); } });
  assert.equal(readUpdateCache(file)?.latest, null);
  await refreshUpdateCache({ cacheFile: file, latest });
  assert.equal(calls, 2);
  assert.equal(await refreshUpdateCache({ cacheFile: join(file, 'denied.json'), force: true, latest }), '999.0.0');
  assert.equal(calls, 3);
  assert.equal(await refreshUpdateCache({ cacheFile: file, force: true, latest: async () => '1.0.0-rc.1' }), null);
  assert.equal(readUpdateCache(file)?.latest, null);
});

test('exclusive refresh leases suppress competing workers and protect newer explicit results', async (t) => {
  const { file } = fixture(t);
  const release = acquireCacheLease(`${file}.lock`, 30_000);
  assert.ok(release);
  assert.equal(acquireCacheLease(`${file}.lock`, 30_000), null);
  let calls = 0;
  await refreshUpdateCache({ cacheFile: file, latest: async () => { calls++; return '999.0.0'; } });
  assert.equal(calls, 0);
  release();
  const started = Date.now();
  assert.equal(await refreshUpdateCache({ cacheFile: file, now: () => started + 10, latest: async () => {
    writeUpdateCache(record('999.0.0', started + 5), file);
    return '888.0.0';
  } }), '888.0.0');
  assert.equal(readUpdateCache(file, started + 10)?.latest, '888.0.0');
  let now = started + 20;
  await refreshUpdateCache({ cacheFile: file, force: true, now: () => now, latest: async () => {
    writeUpdateCache(record('999.0.0', started + 25), file);
    now = started + 30;
    return '777.0.0';
  } });
  assert.equal(readUpdateCache(file, started + 30)?.latest, '999.0.0');
});

test('quota cache strips notices on read/write, and rendering adds only one compact sanitized line', (t) => {
  const { dir, file } = fixture(t);
  writeUpdateCache(record(), file);
  const notice = createUpdateNotifier({ cacheFile: file });
  const quota = sample();
  const snap = { ...quota, clientUpdate: notice() };
  const quotaFile = join(dir, 'quota.json');
  writeCache(snap, 'auto', 'auto', quotaFile);
  assert.deepEqual(readCache('auto', 'auto', quotaFile), quota);
  const raw = JSON.parse(readFileSync(quotaFile, 'utf8'));
  assert.equal(raw.snap.clientUpdate, undefined);
  raw.snap.clientUpdate = { command: 'malicious legacy metadata' };
  writeFileSync(quotaFile, JSON.stringify(raw));
  assert.deepEqual(readCache('auto', 'auto', quotaFile), quota);
  assert.equal(renderPanel(snap).split('\n').filter((s) => s.includes('Update available:')).length, 1);
  assert.match(renderPanel(snap), /999\.0\.0 · agy-cli-usage update/);
  assert.doesNotMatch(renderPanel(quota), /Update available/);
  assert.equal(renderPanel({ ...snap, clientUpdate: { ...snap.clientUpdate!, latest: '\x1b[31m9.0.0' } }).includes('\x1b[31m'), false);
});

test('watch-style ticks and concurrent HTTP requests share refresh without waiting or changing failures', async (t) => {
  const { file } = fixture(t);
  let launches = 0, quotaCalls = 0;
  const notice = createUpdateNotifier({ cacheFile: file, launch: () => { launches++; } });
  const quota = sample();
  const get = createSnapshotGetter(async () => { quotaCalls++; await delay(10); return quota; }, notice);
  const opts = { source: 'auto', channel: 'auto', cache: true } as const;
  const server = createApp(get);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const responses = await Promise.all(Array.from({ length: 8 }, () => fetch(`http://127.0.0.1:${address.port}/quota`)));
  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), quota);
  }
  assert.equal(launches, 1);
  assert.equal(quotaCalls, 1);
  for (let i = 0; i < 3; i++) assert.deepEqual(await get(opts), quota);
  assert.equal(launches, 1);
  writeUpdateCache(record(), file);
  assert.ok((await get(opts)).clientUpdate);
  assert.equal((await get({ ...opts, updateCheck: false })).clientUpdate, undefined);
  assert.deepEqual(await createSnapshotGetter(async () => quota, () => { throw new Error('permission denied'); })(opts), quota);
  await assert.rejects(createSnapshotGetter(async () => { throw new Error('quota failed'); }, notice)(opts), /quota failed/);
});

function runtime(t: TestContext, gated = false) {
  const { dir } = fixture(t);
  const cacheDir = join(dir, 'agy-usage'); mkdirSync(cacheDir);
  const file = join(cacheDir, 'update.json');
  const quota = sample(); writeCache(quota, 'auto', 'auto', join(cacheDir, 'quota.json'));
  const fake = join(dir, 'fake-npm.cjs');
  const log = join(dir, 'npm.log'), release = join(dir, 'release');
  writeFileSync(fake, `const fs = require('node:fs'); fs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ')+'\\n');
const end = Date.now()+6000;
const timer = setInterval(() => { if (${!gated} || fs.existsSync(${JSON.stringify(release)}) || Date.now()>end) {clearInterval(timer); process.stdout.write('999.0.0\\n');} }, 20);`);
  if (process.platform === 'win32') writeFileSync(join(dir, 'npm.cmd'), `@echo off\r\n"${process.execPath}" "${fake}" %*\r\n`);
  else {
    const q = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
    writeFileSync(join(dir, 'npm'), `#!/bin/sh\nexec ${q(process.execPath)} ${q(fake)} "$@"\n`, { mode: 0o700 });
  }
  const env = { ...process.env, PATH: dir + delimiter + process.env.PATH, XDG_CACHE_HOME: dir, AGY_NO_UPDATE_CHECK: '0', NO_COLOR: '1' };
  return { dir, file, quota, log, release, env };
}

test('real one-shot CLI exits while a registry worker is pending; repeated invocations reuse its attempt', async (t) => {
  const f = runtime(t, true);
  t.after(() => { if (existsSync(f.dir)) writeFileSync(f.release, ''); });
  const result = await exec(process.execPath, [cli, '--json'], { env: f.env, timeout: 3000 });
  assert.deepEqual(JSON.parse(result.stdout), f.quota);
  assert.equal(result.stderr, '');
  await until(() => existsSync(f.log));
  assert.equal(readUpdateCache(f.file)?.latest, null);
  const more = await Promise.all(Array.from({ length: 4 }, () => exec(process.execPath, [cli, '--json'], { env: f.env, timeout: 3000 })));
  for (const r of more) assert.deepEqual(JSON.parse(r.stdout), f.quota);
  assert.equal(readFileSync(f.log, 'utf8').trim().split('\n').length, 1);
  writeFileSync(f.release, '');
  await until(() => readUpdateCache(f.file)?.latest === '999.0.0' && !existsSync(`${f.file}.lock`));
  const fresh = await exec(process.execPath, [cli, '--json'], { env: f.env, timeout: 3000 });
  assert.equal(JSON.parse(fresh.stdout).clientUpdate.latest, '999.0.0');
});

test('real CLI JSON and default HTTP endpoint share Snapshot metadata; opt-out leaves quota intact', async (t) => {
  const f = runtime(t);
  const cached = record(); writeUpdateCache(cached, f.file);
  const serverUrl = new URL('../src/server.js', import.meta.url).href;
  const server = spawn(process.execPath, ['--input-type=module', '-e', `import {createApp} from ${JSON.stringify(serverUrl)}; const s=createApp(); s.listen(0,'127.0.0.1',()=>console.log(s.address().port));`], { env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { if (server.exitCode === null) { server.kill(); await once(server, 'exit'); } });
  const [port] = await once(server.stdout!, 'data');
  const url = `http://127.0.0.1:${String(port).trim()}/quota`;
  const result = await exec(process.execPath, [cli, '--json'], { env: f.env });
  const body = JSON.parse(result.stdout);
  assert.equal(body.clientUpdate.current, currentVersion());
  const http = await fetch(url); assert.equal(http.status, 200);
  assert.deepEqual(await http.json(), body);
  writeUpdateCache(record(currentVersion()), f.file);
  assert.deepEqual(await (await fetch(url)).json(), f.quota);
  assert.equal(existsSync(f.log), false);
  writeUpdateCache(cached, f.file);
  for (const flag of [[], ['--no-update-check']]) {
    const disabled = await exec(process.execPath, [cli, '--json', ...flag], { env: { ...f.env, AGY_NO_UPDATE_CHECK: flag.length ? '0' : '1' } });
    assert.deepEqual(JSON.parse(disabled.stdout), f.quota);
    assert.equal(disabled.stderr, '');
  }
});

test('explicit update --check refreshes the shared cache despite opt-out and never installs', async (t) => {
  const f = runtime(t);
  writeUpdateCache(record(currentVersion()), f.file);
  const result = await exec(process.execPath, [cli, 'update', '--check'], { env: { ...f.env, AGY_NO_UPDATE_CHECK: '1' }, timeout: 5000 });
  assert.match(result.stdout, /Update available/);
  assert.equal(readUpdateCache(f.file)?.latest, '999.0.0');
  assert.equal(readFileSync(f.log, 'utf8').trim(), 'view agy-cli-usage version');
});
