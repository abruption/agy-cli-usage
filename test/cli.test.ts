import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { parseArgs } from '../src/main.js';
import { latestVersion, npmInvocation, runUpdate, defaultExecNpmView, installVersion } from '../src/update.js';

test('CLI rejects unknown arguments, invalid watch values and conflicting commands', () => {
  for (const argv of [['--wat'], ['unexpected'], ['--check'], ['update', '--json'], ['update', 'update'],
    ...['0', '-1', 'NaN', 'Infinity', '2147484', '', 'abc'].map((n) => ['--watch', n])]) {
    assert.throws(() => parseArgs(argv), Error);
  }
  assert.equal(parseArgs(['--watch']).watch, 60);
  assert.equal(parseArgs(['--watch', '--json']).watch, 60);
  assert.equal(parseArgs(['--watch', '1']).watch, 5);
  assert.equal(parseArgs(['--watch', '12.5']).watch, 12.5);
  assert.equal(parseArgs(['update', '--check']).check, true);
});

test('registry versions must be safe stable semver and interrupted installs fail', async () => {
  assert.equal(await latestVersion({ execNpmView: () => '1.0.0 & command', fetchRegistry: async () => new Response('{"version":null}') }), null);
  assert.equal(await latestVersion({ execNpmView: () => '1.0.0-rc.1', fetchRegistry: async () => new Response('{"version":"9.8.7"}') }), '9.8.7');
  for (const result of [{ status: null, signal: 'SIGTERM' }, { status: null }, { status: 2 }]) {
    assert.notEqual(await runUpdate({}, { latest: async () => '999.0.0', install: () => result }), 0);
  }
  let calls = 0;
  assert.equal(await runUpdate({ checkOnly: true }, { latest: async () => '999.0.0', install: () => { calls++; return { status: 0 }; } }), 0);
  assert.equal(calls, 0);
  assert.throws(() => npmInvocation(['install', 'pkg@1.0.0&evil'], 'win32'));
  assert.equal(npmInvocation(['view', 'agy-cli-usage', 'version'], 'win32').args.at(-1), 'npm.cmd view agy-cli-usage version');
});

test('npm check and install invoke a fake executable on the current platform', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-npm-test-'));
  const log = join(dir, 'args.txt');
  const oldPath = process.env.PATH;
  const oldLog = process.env.AGY_TEST_NPM_LOG;
  t.after(() => { process.env.PATH = oldPath; if (oldLog === undefined) delete process.env.AGY_TEST_NPM_LOG; else process.env.AGY_TEST_NPM_LOG = oldLog; rmSync(dir, { recursive: true, force: true }); });
  const windows = process.platform === 'win32';
  writeFileSync(join(dir, windows ? 'npm.cmd' : 'npm'), windows
    ? '@echo off\r\necho %*>>"%AGY_TEST_NPM_LOG%"\r\necho 9.8.7\r\n'
    : '#!/bin/sh\nprintf "%s\\n" "$*" >> "$AGY_TEST_NPM_LOG"\nprintf "9.8.7\\n"\n', { mode: 0o700 });
  process.env.PATH = dir + delimiter + (oldPath ?? '');
  process.env.AGY_TEST_NPM_LOG = log;
  assert.equal(defaultExecNpmView('agy-cli-usage', 2000).trim(), '9.8.7');
  assert.equal(installVersion('9.8.7').status, 0);
  const lines = readFileSync(log, 'utf8');
  assert.match(lines, /view agy-cli-usage version/);
  assert.match(lines, /install -g agy-cli-usage@9.8.7/);
});
