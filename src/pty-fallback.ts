// Fallback path: drive the real `agy` TUI in a pseudo-terminal, send `/usage`,
// reconstruct the rendered screen with a headless VT emulator, and parse the
// panel. Used only when the direct API path is unavailable (no readable
// keyring, or the internal API changed). Slower and more brittle than the API
// path, but uses agy's own auth so it works wherever agy itself works.
//
// Why a VT emulator: agy renders /usage in the alternate screen buffer using
// cursor addressing, so naive ANSI-stripping yields nothing. We feed the raw
// PTY bytes through @xterm/headless to get the final visible screen, then parse.
//
// Capture backend: python3 `pty` on POSIX (no native build), node-pty on
// Windows (ConPTY). agy shows a welcome screen first, so `/usage` is sent after
// a delay and the session is held open long enough to render.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, delimiter } from 'node:path';
import { captureViaPython, captureViaNodePty, COLS, ROWS } from './pty-capture.js';
import type { BucketKind, ParsedBucket, ParsedGroup, ParsedPanel } from './types.js';

// Resolve the agy binary: explicit AGY_BIN, then PATH, then common install dir.
function resolveAgy(): string {
  const explicit = process.env.AGY_BIN;
  if (explicit) return explicit;
  const exe = process.platform === 'win32' ? 'agy.exe' : 'agy';
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (dir && existsSync(join(dir, exe))) return join(dir, exe);
  }
  const local = join(homedir(), '.local', 'bin', exe);
  if (existsSync(local)) return local;
  return 'agy'; // last resort: let the OS resolve it
}

const AGY_BIN = resolveAgy();
// --- VT reconstruction --------------------------------------------------------

async function reconstructScreen(raw: Buffer): Promise<string> {
  const { Terminal } = await import('@xterm/headless');
  const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true, scrollback: 200 });
  await new Promise<void>((res) => term.write(raw, res));
  const buf = term.buffer.active;
  const lines: string[] = [];
  // include scrollback so a panel taller than the viewport is still captured
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i);
    if (line) lines.push(line.translateToString(true).replace(/\s+$/, ''));
  }
  term.dispose();
  return lines.join('\n');
}

// --- parse --------------------------------------------------------------------

function parseDuration(text: string): number | null {
  let seconds = 0;
  // Matches both the spelled-out form ("3 days", "1 day") and the abbreviated
  // form ("3d") that agy's panel may render instead — without the `\b`
  // fallback, only "day"/"days" was recognized and a bare "3d 2h" silently
  // dropped the day component.
  const d = text.match(/(\d+)\s*d(?:ays?)?\b/i);
  const h = text.match(/(\d+)\s*h(?:our)?/i);
  const m = text.match(/(\d+)\s*m(?:in)?/i);
  if (d) seconds += +d[1] * 86400;
  if (h) seconds += +h[1] * 3600;
  if (m) seconds += +m[1] * 60;
  return seconds || null;
}

/** Parse the reconstructed /usage screen text into { account, groups:[...] }. */
export function parsePanel(text: string): ParsedPanel {
  const lines = text.split(/\r?\n/);
  const account = text.match(/Account:\s*(\S+)/)?.[1] ?? null;

  const groups: ParsedGroup[] = [];
  let group: ParsedGroup | null = null;
  let bucket: ParsedBucket | null = null;
  const pushBucket = (): void => { if (group && bucket) group.buckets.push(bucket); bucket = null; };
  const pushGroup = (): void => { pushBucket(); if (group) groups.push(group); group = null; };

  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;

    if (/^[A-Z][A-Z0-9 &/]*MODELS$/.test(t)) {
      pushGroup();
      group = { name: t.replace(/\s+/g, ' '), models: '', buckets: [] };
      continue;
    }
    const models = t.match(/^Models within this group:\s*(.+)$/i);
    if (models && group) { group.models = models[1].trim(); continue; }

    if (/^(Weekly Limit|Five Hour Limit|5[- ]?Hour Limit)$/i.test(t)) {
      pushBucket();
      const kind: BucketKind = /week/i.test(t) ? 'weekly' : '5h';
      bucket = { kind, label: t, remainingFraction: null, resetsInSeconds: null, available: false, description: null };
      continue;
    }
    if (bucket) {
      const pct = t.match(/(\d+(?:\.\d+)?)\s*%/);
      if (pct && bucket.remainingFraction == null) bucket.remainingFraction = +pct[1] / 100;
      if (/Quota available/i.test(t)) { bucket.available = true; bucket.remainingFraction = 1; }
      const refresh = t.match(/Refreshes in (.+)$/i);
      if (refresh) bucket.resetsInSeconds = parseDuration(refresh[1]);
    }
  }
  pushGroup();
  return { account, groups };
}

/** Run agy, capture /usage, reconstruct + parse the panel. */
export async function captureUsageViaPty(): Promise<ParsedPanel> {
  const order = process.platform === 'win32'
    ? [captureViaNodePty, captureViaPython]
    : [captureViaPython, captureViaNodePty];

  let raw: Buffer | null = null;
  for (const fn of order) {
    raw = await fn({ bin: AGY_BIN });
    if (raw && raw.length) break;
  }
  if (!raw || !raw.length) {
    throw new Error('No PTY backend captured agy output (need python3 on POSIX, or node-pty on Windows)');
  }
  const screen = await reconstructScreen(raw);
  const parsed = parsePanel(screen);
  if (!parsed.groups.length) {
    throw new Error('Could not parse /usage panel from agy output');
  }
  return parsed;
}
