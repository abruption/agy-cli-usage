// Self-update + version helpers for the CLI.
//
// `agy-cli-usage update`        check the registry and `npm install -g` if newer
// `agy-cli-usage update --check` report only, don't install
// `agy-cli-usage --version`     print the installed version

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PKG_NAME = 'agy-cli-usage';

/**
 * Installed version, read from this package's package.json.
 * NOTE: this module compiles to dist/src/update.js, so package.json (at the
 * package root) is two levels up.
 */
export function currentVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    version: string;
  };
  return pkg.version;
}

/**
 * Compare two dotted versions numerically (prerelease tags ignored).
 * Returns negative if a<b, 0 if equal, positive if a>b.
 */
export function semverCompare(a: string, b: string): number {
  const norm = (v: string): number[] =>
    String(v)
      .replace(/^v/, '')
      .split('-')[0]
      .split('.')
      .map((n) => parseInt(n, 10) || 0);
  const pa = norm(a);
  const pb = norm(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Latest published version: prefer the user's configured registry (npm view), fall back to public. */
export async function latestVersion(): Promise<string | null> {
  try {
    const out = execFileSync('npm', ['view', PKG_NAME, 'version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out) return out;
  } catch {
    // npm missing or offline — try the public registry directly
  }
  try {
    const res = await fetch(`https://registry.npmjs.org/${PKG_NAME}/latest`);
    if (res.ok) return ((await res.json()) as { version: string }).version;
  } catch {
    // offline
  }
  return null;
}

/** Run the update flow. Returns the intended process exit code. */
export async function runUpdate({ checkOnly = false }: { checkOnly?: boolean } = {}): Promise<number> {
  const current = currentVersion();
  const latest = await latestVersion();
  if (!latest) {
    process.stderr.write('Could not determine the latest version (offline or npm unavailable).\n');
    return 1;
  }
  if (semverCompare(latest, current) <= 0) {
    process.stdout.write(`agy-cli-usage is up to date (${current}).\n`);
    return 0;
  }
  process.stdout.write(`Update available: ${current} -> ${latest}\n`);
  if (checkOnly) {
    process.stdout.write('Run `agy-cli-usage update` to install it.\n');
    return 0;
  }
  process.stdout.write(`Installing ${PKG_NAME}@${latest} globally…\n`);
  const r = spawnSync('npm', ['install', '-g', `${PKG_NAME}@${latest}`], { stdio: 'inherit' });
  if (r.error) {
    process.stderr.write(`Failed to run npm: ${r.error.message}\nInstall manually: npm install -g ${PKG_NAME}@latest\n`);
    return 1;
  }
  if (r.status === 0) process.stdout.write(`Updated to ${latest}.\n`);
  return r.status ?? 0;
}
