#!/usr/bin/env node
// agy-cli-usage — Antigravity CLI (agy) usage/quota monitor.
//
// Usage:
//   agy-cli-usage                 one-shot panel (like agy's /usage)
//   agy-cli-usage --json          machine-readable JSON
//   agy-cli-usage --watch [secs]  refresh every N seconds (default 60)
//   agy-cli-usage --source api|pty|auto   data source (default auto: api, fall back to pty)
//   agy-cli-usage --channel daily|prod    Cloud Code host (default: auto-detect)
//   agy-cli-usage --no-cache      bypass the 5-minute cache
//   agy-cli-usage --refresh       force a fresh fetch (alias for --no-cache)
//   agy-cli-usage update [--check]  self-update via npm
//   agy-cli-usage --version | -v  print the installed version

import { getAccessToken, CredentialError } from './credentials.js';
import { fetchQuotaSummary } from './api.js';
import { captureUsageViaPty } from './pty-fallback.js';
import { fromApi, fromPty } from './quota.js';
import { renderPanel } from './render.js';
import { currentVersion, runUpdate } from './update.js';
import type { Snapshot } from './types.js';
import { readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CACHE_DIR = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'agy-usage');
const CACHE_FILE = join(CACHE_DIR, 'quota.json');
const CACHE_TTL_MS = 5 * 60 * 1000;

export interface CliOptions {
  json: boolean;
  watch: number | null;
  source: 'auto' | 'api' | 'pty';
  channel: 'auto' | 'daily' | 'prod';
  cache: boolean;
  command: 'update' | null;
  check: boolean;
  version?: boolean;
  help?: boolean;
}

const VALID_SOURCES = ['auto', 'api', 'pty'] as const;
const VALID_CHANNELS = ['auto', 'daily', 'prod'] as const;

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Exported for direct unit testing (no process.argv/exit side effects). */
export function parseArgs(argv: string[]): CliOptions {
  const o: CliOptions = {
    json: false, watch: null, source: 'auto', channel: 'auto', cache: true, command: null, check: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === 'update' && o.command == null) o.command = 'update';
    else if (a === '--json') o.json = true;
    else if (a === '--watch') {
      const n = Number(argv[i + 1]);
      if (Number.isFinite(n)) { o.watch = n; i++; } else o.watch = 60;
    } else if (a === '--source') {
      const v = argv[++i];
      if (!(VALID_SOURCES as readonly string[]).includes(v)) {
        throw new Error(`invalid --source '${v}' — expected one of: ${VALID_SOURCES.join(', ')}`);
      }
      o.source = v as CliOptions['source'];
    } else if (a === '--channel') {
      const v = argv[++i];
      if (!(VALID_CHANNELS as readonly string[]).includes(v)) {
        throw new Error(`invalid --channel '${v}' — expected one of: ${VALID_CHANNELS.join(', ')}`);
      }
      o.channel = v as CliOptions['channel'];
    } else if (a === '--no-cache' || a === '--refresh') o.cache = false;
    else if (a === '--check') o.check = true;
    else if (a === '-v' || a === '--version') o.version = true;
    else if (a === '-h' || a === '--help') o.help = true;
  }
  return o;
}

const HELP = `agy-cli-usage — Antigravity CLI (agy) usage/quota monitor

  agy-cli-usage                 one-shot panel
  agy-cli-usage --json          machine-readable JSON
  agy-cli-usage --watch [secs]  auto-refresh (default 60s)
  agy-cli-usage --source <auto|api|pty>
  agy-cli-usage --channel <auto|daily|prod>
  agy-cli-usage --no-cache | --refresh
  agy-cli-usage update [--check]  self-update via npm (--check: report only)
  agy-cli-usage --version | -v
`;

// --- cache -------------------------------------------------------------------

/**
 * Cached alongside the snapshot: the `source`/`channel` that produced it.
 * Without this, a cache hit from e.g. `--source auto` falling back to PTY
 * would be silently returned to a later `--source api` call within the TTL
 * window (never calling the API, never throwing) — directly contradicting
 * the documented `api: API only (throws on failure)` contract. Requiring an
 * exact match keys the cache by *request mode*, not just time.
 */
interface CacheEntry {
  ts: number;
  source: SnapshotOptions['source'];
  channel: SnapshotOptions['channel'];
  snap: Snapshot;
}

/** Exported for direct unit testing via an injected `cacheFile` — not part of the CLI's public surface. */
export function readCache(
  source: SnapshotOptions['source'],
  channel: SnapshotOptions['channel'],
  cacheFile: string = CACHE_FILE,
): Snapshot | null {
  try {
    const entry = JSON.parse(readFileSync(cacheFile, 'utf8')) as CacheEntry;
    if (entry.source !== source || entry.channel !== channel) return null;
    if (Date.now() - entry.ts < CACHE_TTL_MS) return entry.snap;
  } catch {
    /* no/expired/incompatible-format cache */
  }
  return null;
}

/** Exported for direct unit testing via an injected `cacheFile` — not part of the CLI's public surface. */
export function writeCache(
  snap: Snapshot,
  source: SnapshotOptions['source'],
  channel: SnapshotOptions['channel'],
  cacheFile: string = CACHE_FILE,
): void {
  try {
    mkdirSync(dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify({ ts: Date.now(), source, channel, snap } satisfies CacheEntry));
  } catch {
    /* cache is best-effort */
  }
}

// --- fetch -------------------------------------------------------------------

/** Subset of options needed to produce a snapshot (also usable from server.ts). */
export interface SnapshotOptions {
  source: 'auto' | 'api' | 'pty';
  channel: 'auto' | 'daily' | 'prod';
  cache: boolean;
  /** Override the cache file path — for tests only; defaults to the real user cache. */
  cacheFile?: string;
}

export async function getSnapshot(opts: SnapshotOptions): Promise<Snapshot> {
  if (opts.cache && opts.source !== 'pty') {
    const cached = readCache(opts.source, opts.channel, opts.cacheFile);
    if (cached) return cached;
  }

  let snap: Snapshot;
  if (opts.source === 'pty') {
    snap = fromPty(await captureUsageViaPty());
  } else {
    try {
      const { accessToken } = await getAccessToken();
      const raw = await fetchQuotaSummary(accessToken, { channel: opts.channel === 'auto' ? undefined : opts.channel });
      snap = fromApi(raw);
    } catch (err) {
      if (opts.source === 'api') throw err;
      // auto: fall back to PTY
      process.stderr.write(`[api failed: ${errMessage(err)}] falling back to PTY (agy)…\n`);
      snap = fromPty(await captureUsageViaPty());
    }
  }
  writeCache(snap, opts.source, opts.channel, opts.cacheFile);
  return snap;
}

// --- main --------------------------------------------------------------------

async function once(opts: CliOptions): Promise<void> {
  const snap = await getSnapshot(opts);
  if (opts.json) process.stdout.write(JSON.stringify(snap, null, 2) + '\n');
  else process.stdout.write(renderPanel(snap) + '\n');
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { process.stdout.write(HELP); return; }
  if (opts.version) { process.stdout.write(currentVersion() + '\n'); return; }
  if (opts.command === 'update') { process.exit(await runUpdate({ checkOnly: opts.check })); }

  if (opts.watch != null) {
    const intervalMs = Math.max(5, opts.watch) * 1000;
    const tick = async (): Promise<void> => {
      try {
        if (!opts.json) process.stdout.write('\x1b[2J\x1b[H'); // clear screen
        await once(opts);
      } catch (err) {
        process.stderr.write(`error: ${errMessage(err)}\n`);
      }
    };
    await tick();
    setInterval(tick, intervalMs);
  } else {
    await once(opts);
  }
}

// Only run the CLI when this file is executed directly (as the `bin` entry
// point) — guarded so parseArgs/readCache/writeCache/etc. can be imported
// for unit testing without triggering a full live CLI run (network calls,
// process.exit()) as an import side effect. realpathSync resolves symlinks
// on process.argv[1] (npm global `bin` entries are frequently symlinks);
// import.meta.url is already symlink-resolved by Node's ESM loader.
function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((err: unknown) => {
    if (err instanceof CredentialError) {
      process.stderr.write(`credential error: ${err.message}\n`);
    } else {
      process.stderr.write(`error: ${errMessage(err)}\n`);
    }
    process.exit(1);
  });
}
