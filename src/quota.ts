// Normalizes quota data from either source (direct API JSON or PTY-parsed text)
// into one shape consumed by the renderer / JSON output / HTTP endpoint.

import type { BucketKind, FetchResult, ParsedPanel, Snapshot } from './types.js';

function bucketKind(window: string | undefined, label: string): BucketKind {
  if (window === 'weekly' || /week/i.test(label)) return 'weekly';
  if (window === '5h' || /5.?hour|five.?hour/i.test(label)) return '5h';
  return window || label;
}

function secondsUntil(resetAt: string | undefined, now: number): number | null {
  if (!resetAt) return null;
  const ms = new Date(resetAt).getTime() - now;
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms / 1000)) : null;
}

/** Build a normalized snapshot from the raw retrieveUserQuotaSummary response. */
export function fromApi({ raw, host, account, tier }: FetchResult, nowMs: number = Date.now()): Snapshot {
  const groups = (raw.groups ?? []).map((g) => ({
    name: g.displayName ?? 'Models',
    models: (g.description ?? '').replace(/^Models within this group:\s*/i, '').trim(),
    buckets: (g.buckets ?? []).map((b) => {
      const remaining = typeof b.remainingFraction === 'number' ? b.remainingFraction : null;
      return {
        kind: bucketKind(b.window, b.displayName ?? ''),
        label: b.displayName ?? b.window ?? '',
        remainingFraction: remaining,
        usedFraction: remaining == null ? null : 1 - remaining,
        resetAt: b.resetTime ?? null,
        resetsInSeconds: secondsUntil(b.resetTime, nowMs),
        available: remaining === 1,
        description: b.description ?? null,
      };
    }),
  }));
  return {
    account: account ?? null,
    tier: tier ?? null,
    fetchedAt: new Date(nowMs).toISOString(),
    source: 'api',
    host: host ?? null,
    note: raw.description ?? null,
    groups,
  };
}

/** Build a normalized snapshot from PTY-parsed groups (see pty-fallback.ts). */
export function fromPty(parsed: ParsedPanel, nowMs: number = Date.now()): Snapshot {
  const groups = (parsed.groups ?? []).map((g) => ({
    name: g.name,
    models: g.models ?? '',
    buckets: (g.buckets ?? []).map((b) => ({
      kind: b.kind,
      label: b.label,
      remainingFraction: b.remainingFraction ?? null,
      usedFraction: b.remainingFraction == null ? null : 1 - b.remainingFraction,
      resetAt: b.resetsInSeconds != null ? new Date(nowMs + b.resetsInSeconds * 1000).toISOString() : null,
      resetsInSeconds: b.resetsInSeconds ?? null,
      available: b.available ?? b.remainingFraction === 1,
      description: b.description ?? null,
    })),
  }));
  return {
    account: parsed.account ?? null,
    tier: null,
    fetchedAt: new Date(nowMs).toISOString(),
    source: 'pty',
    host: null,
    note: parsed.note ?? null,
    groups,
  };
}

/** Format a seconds duration like agy: "73h 53m" / "2h 7m" / "12m". */
export function formatDuration(seconds: number | null): string | null {
  if (seconds == null) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
