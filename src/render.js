// Renders a normalized quota snapshot as a terminal panel, mirroring agy's
// `/usage` layout (progress bar + percent + reset time per bucket).

import { formatDuration } from './quota.js';

const BAR_WIDTH = 50;

const useColor = () => process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor() ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s) => c('2', s);
const bold = (s) => c('1', s);

// remaining-based color: lots left = green, getting low = yellow/red.
function barColor(remaining) {
  if (remaining == null) return '37';
  if (remaining > 0.5) return '32'; // green
  if (remaining > 0.2) return '33'; // yellow
  return '31'; // red
}

function bar(remainingFraction) {
  const frac = remainingFraction == null ? 0 : Math.max(0, Math.min(1, remainingFraction));
  const filled = Math.round(frac * BAR_WIDTH);
  const body = '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
  return useColor() ? `\x1b[${barColor(remainingFraction)}m${body}\x1b[0m` : body;
}

function bucketLine(b) {
  const lines = [];
  lines.push(`    ${bold(b.label)}`);
  if (b.available) {
    lines.push(`    [${bar(1)}] ${c('32', 'Quota available')}`);
  } else {
    const pct = b.remainingFraction == null ? '—' : `${(b.remainingFraction * 100).toFixed(2)}%`;
    const remainPct = b.remainingFraction == null ? '' : `${Math.round(b.remainingFraction * 100)}% remaining`;
    const dur = formatDuration(b.resetsInSeconds);
    const reset = dur ? ` · ${dim(`Refreshes in ${dur}`)}` : '';
    lines.push(`    [${bar(b.remainingFraction)}] ${pct}`);
    lines.push(`    ${dim(remainPct)}${reset}`);
  }
  return lines.join('\n');
}

/** Returns the full panel as a string. */
export function renderPanel(snap) {
  const out = [];
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

function wrap(text, width, prefix) {
  const words = text.split(/\s+/);
  const lines = [];
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
