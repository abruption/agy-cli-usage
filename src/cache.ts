import { homedir } from 'node:os';
import { join } from 'node:path';
import { readPrivateJson, writePrivateJson } from './private-cache.js';
import type { Snapshot } from './types.js';

export const CACHE_FILE = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'agy-usage', 'quota.json');
const TTL_MS = 300_000;
const MAX_BYTES = 1024 * 1024;
type Source = 'auto' | 'api' | 'pty';
type Channel = 'auto' | 'daily' | 'prod';
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const nullableString = (v: unknown): boolean => v === null || typeof v === 'string';
const date = (v: unknown): boolean => typeof v === 'string' && Number.isFinite(Date.parse(v));
const fraction = (v: unknown): boolean => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1);

export function isSnapshot(v: unknown): v is Snapshot {
  return object(v) && nullableString(v.account) && nullableString(v.tier) && date(v.fetchedAt)
    && ['api', 'pty'].includes(v.source as string) && nullableString(v.host) && nullableString(v.note)
    && Array.isArray(v.groups) && v.groups.every((g: unknown) => object(g)
      && typeof g.name === 'string' && typeof g.models === 'string' && Array.isArray(g.buckets)
      && g.buckets.every((b: unknown) => object(b) && typeof b.kind === 'string' && typeof b.label === 'string'
        && fraction(b.remainingFraction) && fraction(b.usedFraction)
        && (b.resetAt === null || date(b.resetAt))
        && (b.resetsInSeconds === null || (typeof b.resetsInSeconds === 'number' && Number.isSafeInteger(b.resetsInSeconds) && b.resetsInSeconds >= 0))
        && typeof b.available === 'boolean' && nullableString(b.description)));
}

/** Never accept update metadata from a quota-cache record, including older writers. */
export function quotaOnly(snap: Snapshot): Snapshot {
  const { clientUpdate: _update, ...quota } = snap;
  return quota;
}

export function readCache(source: Source, channel: Channel, cacheFile = CACHE_FILE): Snapshot | null {
  const entry = readPrivateJson(cacheFile, MAX_BYTES);
  if (!object(entry) || entry.source !== source || entry.channel !== channel || typeof entry.ts !== 'number') return null;
  const age = Date.now() - entry.ts;
  if (!Number.isFinite(age) || age < 0 || age >= TTL_MS || !isSnapshot(entry.snap)) return null;
  if (source !== 'auto' && entry.snap.source !== source) return null;
  return quotaOnly(entry.snap);
}

export function writeCache(snap: Snapshot, source: Source, channel: Channel, cacheFile = CACHE_FILE): void {
  if (isSnapshot(snap)) writePrivateJson(cacheFile, { ts: Date.now(), source, channel, snap: quotaOnly(snap) }, MAX_BYTES);
}
