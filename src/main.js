#!/usr/bin/env node
// agy-usage — Antigravity CLI (agy) usage/quota monitor.
//
// Usage:
//   agy-usage                 one-shot panel (like agy's /usage)
//   agy-usage --json          machine-readable JSON
//   agy-usage --watch [secs]  refresh every N seconds (default 60)
//   agy-usage --source api|pty|auto   data source (default auto: api, fall back to pty)
//   agy-usage --channel daily|prod    Cloud Code host (default: auto-detect)
//   agy-usage --no-cache      bypass the 5-minute cache
//   agy-usage --refresh       force a fresh fetch (alias for --no-cache)

import { getAccessToken, CredentialError } from './credentials.js';
import { fetchQuotaSummary } from './api.js';
import { captureUsageViaPty } from './pty-fallback.js';
import { fromApi, fromPty } from './quota.js';
import { renderPanel } from './render.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CACHE_DIR = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'agy-usage');
const CACHE_FILE = join(CACHE_DIR, 'quota.json');
const CACHE_TTL_MS = 5 * 60 * 1000;

function parseArgs(argv) {
  const o = { json: false, watch: null, source: 'auto', channel: 'auto', cache: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--watch') {
      const n = Number(argv[i + 1]);
      if (Number.isFinite(n)) { o.watch = n; i++; } else o.watch = 60;
    } else if (a === '--source') o.source = argv[++i];
    else if (a === '--channel') o.channel = argv[++i];
    else if (a === '--no-cache' || a === '--refresh') o.cache = false;
    else if (a === '-h' || a === '--help') o.help = true;
  }
  return o;
}

const HELP = `agy-usage — Antigravity CLI (agy) usage/quota monitor

  agy-usage                 one-shot panel
  agy-usage --json          machine-readable JSON
  agy-usage --watch [secs]  auto-refresh (default 60s)
  agy-usage --source <auto|api|pty>
  agy-usage --channel <auto|daily|prod>
  agy-usage --no-cache | --refresh
`;

// --- cache -------------------------------------------------------------------

function readCache() {
  try {
    const { ts, snap } = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
    if (Date.now() - ts < CACHE_TTL_MS) return snap;
  } catch {}
  return null;
}

function writeCache(snap) {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify({ ts: Date.now(), snap }));
  } catch {}
}

// --- fetch -------------------------------------------------------------------

export async function getSnapshot(opts) {
  if (opts.cache && opts.source !== 'pty') {
    const cached = readCache();
    if (cached) return cached;
  }

  let snap;
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
      process.stderr.write(`[api failed: ${err.message}] falling back to PTY (agy)…\n`);
      snap = fromPty(await captureUsageViaPty());
    }
  }
  writeCache(snap);
  return snap;
}

// --- main --------------------------------------------------------------------

async function once(opts) {
  const snap = await getSnapshot(opts);
  if (opts.json) process.stdout.write(JSON.stringify(snap, null, 2) + '\n');
  else process.stdout.write(renderPanel(snap) + '\n');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { process.stdout.write(HELP); return; }

  if (opts.watch != null) {
    const intervalMs = Math.max(5, opts.watch) * 1000;
    const tick = async () => {
      try {
        if (!opts.json) process.stdout.write('\x1b[2J\x1b[H'); // clear screen
        await once(opts);
      } catch (err) {
        process.stderr.write(`error: ${err.message}\n`);
      }
    };
    await tick();
    setInterval(tick, intervalMs);
  } else {
    await once(opts);
  }
}

main().catch((err) => {
  if (err instanceof CredentialError) {
    process.stderr.write(`credential error: ${err.message}\n`);
  } else {
    process.stderr.write(`error: ${err.message}\n`);
  }
  process.exit(1);
});
