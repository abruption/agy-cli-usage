import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readNativeSecret } from '../src/native-keyring.js';
import { readRawSecret } from '../src/credentials.js';

test('native keyring success, missing entry, locked provider and unavailable module preserve read-only fallback', async () => {
  for (const behavior of ['success', 'missing', 'locked', 'unavailable']) {
    const calls: string[] = [];
    const native = () => readNativeSecret(async () => {
      calls.push('load');
      if (behavior === 'unavailable') throw new Error('module unavailable');
      return { Entry: class {
        constructor(service: string, account: string) {
          assert.equal(service, 'gemini'); assert.equal(account, 'antigravity');
        }
        getPassword() {
          calls.push('read');
          if (behavior === 'locked') throw new Error('provider denied private details');
          return behavior === 'success' ? 'fixture' : null;
        }
      } };
    });
    const value = await readRawSecret({ platform: 'linux', native,
      cli: async () => { calls.push('cli'); return null; },
      windows: async () => { calls.push('windows'); return null; },
      file: () => { calls.push('file'); return 'file-fixture'; },
    });
    assert.equal(value, behavior === 'success' ? 'fixture' : 'file-fixture');
    assert.equal(calls.includes('file'), behavior !== 'success');
  }
});

test('macOS CLI success bypasses native module loading entirely', async () => {
  assert.equal(await readRawSecret({ platform: 'darwin', cli: async () => 'fixture',
    native: async () => { assert.fail('native should not load'); },
    windows: async () => { assert.fail('Windows should not run'); },
    file: () => { assert.fail('file should not run'); },
  }), 'fixture');
});
