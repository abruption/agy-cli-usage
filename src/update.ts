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

// Both the `npm view` child process and the registry fetch fallback are
// bounded so a slow/unreachable registry can't hang the update check
// indefinitely — a timed-out attempt is treated the same as "unavailable"
// and falls through to the next strategy (or to `latestVersion` returning
// null, which `runUpdate` reports as "could not determine the latest version").
export const NPM_VIEW_TIMEOUT_MS = 8_000;
export const REGISTRY_FETCH_TIMEOUT_MS = 8_000;

/** Exported for direct unit testing via injection — not part of the public surface. */
export interface LatestVersionDeps {
  execNpmView?: (pkgName: string, timeoutMs: number) => string;
  fetchRegistry?: (pkgName: string, timeoutMs: number) => Promise<Response>;
}

/** cmd.exe is needed for npm.cmd. Only fixed, shell-safe tokens may enter this invocation. */
export function npmInvocation(args: string[], platform: NodeJS.Platform = process.platform): { file: string; args: string[] } {
  if (args.some((arg) => !/^[a-zA-Z0-9@._/+:=-]+$/.test(arg))) throw new Error('Invalid npm argument');
  return platform === 'win32'
    ? { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', ['npm.cmd', ...args].join(' ')] }
    : { file: 'npm', args };
}

function stableVersion(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const version = value.trim();
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)
    && version.split('.').every((part) => Number.isSafeInteger(Number(part))) ? version : null;
}

export function defaultExecNpmView(pkgName: string, timeoutMs: number): string {
  const command = npmInvocation(['view', pkgName, 'version']);
  return execFileSync(command.file, command.args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: 8192,
  });
}

function defaultFetchRegistry(pkgName: string, timeoutMs: number): Promise<Response> {
  return fetch(`https://registry.npmjs.org/${pkgName}/latest`, { signal: AbortSignal.timeout(timeoutMs) });
}

/** Latest published version: prefer the user's configured registry (npm view), fall back to public. */
export async function latestVersion(deps: LatestVersionDeps = {}): Promise<string | null> {
  const execNpmView = deps.execNpmView ?? defaultExecNpmView;
  const fetchRegistry = deps.fetchRegistry ?? defaultFetchRegistry;
  try {
    const out = stableVersion(execNpmView(PKG_NAME, NPM_VIEW_TIMEOUT_MS));
    if (out) return out;
  } catch {
    // npm missing, offline, or timed out — try the public registry directly
  }
  try {
    const res = await fetchRegistry(PKG_NAME, REGISTRY_FETCH_TIMEOUT_MS);
    if (res.ok) return stableVersion(((await res.json()) as { version?: unknown } | null)?.version);
  } catch {
    // offline or timed out
  }
  return null;
}

export interface UpdateDeps {
  latest?: () => Promise<string | null>;
  install?: (version: string) => { status: number | null; signal?: string | null; error?: Error };
}

export function installVersion(version: string): { status: number | null; signal?: string | null; error?: Error } {
  if (!stableVersion(version)) throw new Error('Invalid package version');
  const command = npmInvocation(['install', '-g', `${PKG_NAME}@${version}`]);
  return spawnSync(command.file, command.args, { stdio: 'inherit' });
}

/** Run the update flow. Returns the intended process exit code. */
export async function runUpdate({ checkOnly = false }: { checkOnly?: boolean } = {}, deps: UpdateDeps = {}): Promise<number> {
  const current = currentVersion();
  const latest = stableVersion(await (deps.latest ?? latestVersion)());
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
  const r = (deps.install ?? installVersion)(latest);
  if (r.error) {
    process.stderr.write(`Failed to run npm: ${r.error.message}\nInstall manually: npm install -g ${PKG_NAME}@latest\n`);
    return 1;
  }
  if (r.status === 0) process.stdout.write(`Updated to ${latest}.\n`);
  if (r.signal) { process.stderr.write('npm was interrupted before the update completed.\n'); return 1; }
  return r.status ?? 1;
}
