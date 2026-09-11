import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { log } from 'node:console';

// npm supplies its JS entry point, allowing shell-free invocation on Windows too.
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'Run through npm run smoke:package');
const directory = mkdtempSync(join(tmpdir(), 'agy-package-smoke-'));
const npm = (args, cwd = process.cwd()) => execFileSync(process.execPath, [npmCli, ...args], {
  cwd, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'],
});
try {
  const [packed] = JSON.parse(npm(['pack', '--json', '--ignore-scripts', '--pack-destination', directory]));
  assert.ok(packed.files.every(({ path }) => /^(dist\/src\/.+\.(?:js|d\.ts)|package\.json|README(?:\.ko)?\.md|CHANGELOG\.md|LICENSE)$/.test(path)),
    'Package must contain only runtime JS/types and public documentation');
  for (const path of ['dist/src/main.js', 'dist/src/server.js', 'dist/src/main.d.ts', 'README.ko.md']) {
    assert.ok(packed.files.some((file) => file.path === path), `Missing ${path}`);
  }
  const installDir = join(directory, 'installation');
  mkdirSync(installDir);
  npm(['install', '--prefix', installDir, '--ignore-scripts', '--omit=dev', '--omit=optional', '--no-audit', '--no-fund', join(directory, packed.filename)], installDir);
  const pkgRoot = join(installDir, 'node_modules', 'agy-cli-usage');
  const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
  for (const bin of ['agy-cli-usage', 'agy-usage']) {
    assert.ok(pkg.bin[bin]);
    assert.match(readFileSync(resolve(pkgRoot, pkg.bin[bin]), 'utf8'), /^#!\/usr\/bin\/env node/);
    assert.equal(npm(['exec', '--offline', '--', bin, '--version'], installDir).trim(), pkg.version);
    assert.match(npm(['exec', '--offline', '--', bin, '--help'], installDir), /agy-cli-usage/);
  }
  log('Packed artifact installs and both command aliases pass help/version checks.');
} finally {
  rmSync(directory, { recursive: true, force: true });
}
