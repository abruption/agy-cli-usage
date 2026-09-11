import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestJson } from '../src/request.js';
import { readRawSecret, runSecretCommand, refreshAccessToken } from '../src/credentials.js';
import { fetchQuotaSummary, ApiError } from '../src/api.js';

test('request deadlines abort delayed headers and delayed bodies', async () => {
  for (const phase of ['headers', 'body']) {
    let aborted = false;
    const fetcher: typeof fetch = async (_url, init) => {
      const signal = init!.signal!;
      if (phase === 'headers') {
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
          aborted = true; reject(new Error('private transport details'));
        }, { once: true }));
      }
      return new Response(new ReadableStream({ start(controller) {
        signal.addEventListener('abort', () => { aborted = true; controller.error(new Error('private body')); }, { once: true });
      } }));
    };
    await assert.rejects(requestJson('https://test.invalid', {}, () => new Error(), { fetch: fetcher, timeoutMs: 20 }), /Request timed out/);
    assert.equal(aborted, true);
  }
});

test('API status keeps authentication classification without exposing response bodies', async () => {
  let calls = 0;
  await assert.rejects(fetchQuotaSummary('fake', { fetch: async () => {
    calls++; return new Response('private-token', { status: 401 });
  } }), (err: unknown) => err instanceof ApiError && err.kind === 'unauthorized' && !err.message.includes('private-token'));
  assert.equal(calls, 1);
  await assert.rejects(refreshAccessToken('fake', { fetch: async () => new Response('private-refresh', { status: 400 }) }),
    (err: unknown) => err instanceof Error && err.message === 'Token refresh failed: HTTP 400');
});

test('non-authentication failures still try the next API channel', async () => {
  let calls = 0;
  const result = await fetchQuotaSummary('fake', { fetch: async () => {
    calls++;
    if (calls === 1) throw new Error('daily unavailable');
    return new Response(JSON.stringify(calls === 2 ? { cloudaicompanionProject: 'project' } : { groups: [] }));
  } });
  assert.equal(result.host, 'cloudcode-pa.googleapis.com');
  assert.equal(calls, 3);
});

test('credential subprocesses are killable without blocking the parent event loop', async () => {
  let ticked = false;
  const timer = setTimeout(() => { ticked = true; }, 10);
  const output = await runSecretCommand(process.execPath, ['-e', 'while(true) {}'], 80);
  clearTimeout(timer);
  assert.equal(output, null);
  assert.equal(ticked, true);
  assert.equal(await runSecretCommand(process.execPath, ['-e', 'process.stdout.write("fixture")']), 'fixture');
  assert.equal(await runSecretCommand(process.execPath, ['-e', 'process.stderr.write("private");process.exit(1)']), null);
});

test('macOS CLI stays first and failed providers continue to the file fallback', async () => {
  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    const order: string[] = [];
    const result = await readRawSecret({ platform,
      cli: async () => { order.push('cli'); return null; },
      native: async () => { order.push('native'); throw new Error('locked'); },
      windows: async () => { order.push('windows'); return null; },
      file: () => { order.push('file'); return 'fixture'; },
    });
    assert.equal(result, 'fixture');
    assert.deepEqual(order, platform === 'darwin' ? ['cli', 'native', 'windows', 'file'] : ['native', 'cli', 'windows', 'file']);
  }
});
