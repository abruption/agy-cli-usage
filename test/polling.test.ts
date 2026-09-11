import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { singleFlight, watchLoop } from '../src/polling.js';
import { snapshotKey } from '../src/main.js';
import { captureViaPython, captureViaNodePty } from '../src/pty-capture.js';

test('identical requests share a fetch; failure releases the slot and different options remain isolated', async () => {
  let calls = 0;
  const run = singleFlight(snapshotKey, async () => { calls++; await delay(5); throw new Error('retry'); });
  const opts = { source: 'auto', channel: 'auto', cache: true } as const;
  const a = run(opts), b = run(opts), c = run({ ...opts, cache: false });
  assert.equal(a, b);
  assert.notEqual(a, c);
  await Promise.allSettled([a, b, c]);
  assert.equal(calls, 2);
  await assert.rejects(run(opts), /retry/);
  assert.equal(calls, 3);
  assert.notEqual(snapshotKey(opts), snapshotKey({ ...opts, source: 'api' }));
  assert.notEqual(snapshotKey(opts), snapshotKey({ ...opts, channel: 'prod' }));
  assert.notEqual(snapshotKey(opts), snapshotKey({ ...opts, cacheFile: '/fixture' }));
});

test('watch waits for each slow tick before starting the interval and aborts its idle timer', async () => {
  const controller = new AbortController();
  let active = 0, peak = 0, ticks = 0;
  await watchLoop(async () => {
    active++; peak = Math.max(peak, active); ticks++;
    await delay(15);
    active--;
    if (ticks === 3) controller.abort();
  }, 2, controller.signal);
  assert.equal(peak, 1);
  assert.equal(ticks, 3);
  const idle = new AbortController();
  const task = watchLoop(async () => { setTimeout(() => idle.abort(), 10); }, 60_000, idle.signal);
  await task;
});

test('node-pty output limits and early exits kill the process and dispose listeners', async () => {
  for (const overflow of [false, true]) {
    let killed = 0, disposed = 0;
    let onData: (s: string) => void = () => {};
    let onExit: () => void = () => {};
    const listeners = process.listenerCount('SIGINT');
    const task = captureViaNodePty({ bin: 'fake', maxBytes: 10, durationMs: 1000 }, async () => ({ spawn: () => ({
      write() {}, kill(signal?: string) {
        assert.equal(signal, process.platform === 'win32' ? undefined : 'SIGKILL');
        killed++;
      },
      onData(cb: typeof onData) { onData = cb; return { dispose() { disposed++; } }; },
      onExit(cb: typeof onExit) { onExit = cb; return { dispose() { disposed++; } }; },
    }) }));
    await delay(0);
    onData(overflow ? 'x'.repeat(11) : 'ok');
    onExit();
    if (overflow) await assert.rejects(task, /exceeded/);
    else assert.equal((await task)?.toString(), 'ok');
    assert.equal(killed, 1);
    assert.equal(disposed, 2);
    assert.equal(process.listenerCount('SIGINT'), listeners);
  }
});

test('Python PTY capture is bounded and leaves no capture directories', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-pty-test-'));
  const bin = join(dir, 'fake agy');
  const listeners = process.listenerCount('SIGINT');
  try {
    writeFileSync(bin, '#!/usr/bin/env python3\nimport time\nprint("fixture", flush=True)\ntime.sleep(60)\n', { mode: 0o700 });
    const raw = await captureViaPython({ bin, durationMs: 1000, usageAtMs: 2000, deadlineMs: 5000 });
    assert.match(raw!.toString(), /fixture/);
    await assert.rejects(captureViaPython({ bin, durationMs: 60_000, deadlineMs: 150 }), /timed out/);
    writeFileSync(bin, '#!/usr/bin/env python3\nprint("x" * 10000, flush=True)\n', { mode: 0o700 });
    await assert.rejects(captureViaPython({ bin, maxBytes: 100, deadlineMs: 5000 }), /exceeded/);
    assert.equal(process.listenerCount('SIGINT'), listeners);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
