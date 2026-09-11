import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readRawSecret } from '../src/credentials.js';

test('each platform selects its OS reader then the token file, with no native dependency', async () => {
  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    for (const behavior of ['success', 'missing', 'locked']) {
      const calls: string[] = [];
      const expected = platform === 'win32' ? 'windows' : 'cli';
      const osRead = (name: string) => async () => {
        calls.push(name);
        if (behavior === 'locked') throw new Error('provider denied');
        return behavior === 'success' ? 'os-fixture' : null;
      };
      const result = await readRawSecret({ platform, cli: osRead('cli'), windows: osRead('windows'),
        file: () => { calls.push('file'); return 'file-fixture'; },
      });
      assert.equal(result, behavior === 'success' ? 'os-fixture' : 'file-fixture');
      assert.deepEqual(calls, behavior === 'success' ? [expected] : [expected, 'file']);
    }
  }
});

test('missing OS utilities and token files leave PTY fallback available to the caller', async () => {
  assert.equal(await readRawSecret({ platform: 'linux', cli: async () => { throw new Error('ENOENT'); }, file: () => null }), null);
});
