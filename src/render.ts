// Renders a normalized quota snapshot as a terminal panel, mirroring agy's
// `/usage` layout (progress bar + percent + reset time per bucket).

import { formatDuration } from './quota.js';
import type { Bucket, Snapshot } from './types.js';

const BAR_WIDTH = 50;

const useColor = (): boolean => Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const c = (code: string, s: string): string => (useColor() ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s: string): string => c('2', s);
const bold = (s: string): string => c('1', s);

// remaining-based color: lots left = green, getting low = yellow/red.
function barColor(remaining: number | null): string {
  if (remaining == null) return '37';
  if (remaining > 0.5) return '32'; // green
  if (remaining > 0.2) return '33'; // yellow
  return '31'; // red
}

// Clamp to [0,1] — remainingFraction comes from an undocumented private
// endpoint (or PTY-parsed text), so an out-of-range value must not be shown
// as-is. Shared by the bar and the percentage text so they never disagree
// (e.g. bar capped at 100% while the text next to it reads "150.00%").
function clampFraction(remainingFraction: number | null): number | null {
  return remainingFraction == null ? null : Math.max(0, Math.min(1, remainingFraction));
}

function bar(remainingFraction: number | null): string {
  const frac = clampFraction(remainingFraction) ?? 0;
  const filled = Math.round(frac * BAR_WIDTH);
  const body = '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
  return useColor() ? `\x1b[${barColor(remainingFraction)}m${body}\x1b[0m` : body;
}

function bucketLine(b: Bucket): string {
  const lines: string[] = [];
  lines.push(`    ${bold(b.label)}`);
  if (b.available) {
    lines.push(`    [${bar(1)}] ${c('32', 'Quota available')}`);
  } else {
    const clamped = clampFraction(b.remainingFraction);
    const pct = clamped == null ? '—' : `${(clamped * 100).toFixed(2)}%`;
    const remainPct = clamped == null ? '' : `${Math.round(clamped * 100)}% remaining`;
    const dur = formatDuration(b.resetsInSeconds);
    const reset = dur ? ` · ${dim(`Refreshes in ${dur}`)}` : '';
    lines.push(`    [${bar(b.remainingFraction)}] ${pct}`);
    lines.push(`    ${dim(remainPct)}${reset}`);
  }
  return lines.join('\n');
}

/** Returns the full panel as a string. */
export function renderPanel(snap: Snapshot): string {
  const out: string[] = [];
  out.push('');
  out.push(bold('  Models & Quota'));
  if (snap.account) out.push(`  ${dim('Account:')} ${snap.account}`);
  out.push(`  ${dim(`source: ${snap.source}${snap.host ? ` · ${snap.host}` : ''} · ${snap.fetchedAt}`)}`);
  out.push('');

  for (const g of snap.groups) {
    out.push(bold(`  ${g.name.toUpperCase()}`));
    if (g.models) out.push(`  ${dim(`Models within this group: ${g.models}`)}`);
    out.push('');
    for (const b of g.buckets) {
      out.push(bucketLine(b));
      out.push('');
    }
  }
  if (snap.note) {
    out.push(dim(wrap(snap.note, 76, '  │')));
  }
  return out.join('\n');
}

function wrap(text: string, width: number, prefix: string): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > width) {
      lines.push(prefix + cur);
      cur = w;
    } else {
      cur = (cur + ' ' + w).trim();
    }
  }
  if (cur) lines.push(prefix + cur);
  return lines.join('\n');
}
