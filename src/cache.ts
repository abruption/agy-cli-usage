import {
  constants, openSync, closeSync, fstatSync, fchmodSync, readFileSync, writeFileSync,
  mkdirSync, lstatSync, renameSync, unlinkSync, fsyncSync, type Stats,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
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

function owned(stat: Stats): boolean {
  return process.platform === 'win32' || stat.uid === process.getuid?.();
}

function secureDirectory(path: string, create: boolean): void {
  if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
  const before = lstatSync(path);
  if (!before.isDirectory() || !owned(before)) throw new Error('Unsafe cache directory');
  // Windows relies on the user's inherited ACL; POSIX mode bits do not apply.
  if (process.platform === 'win32') return;
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_DIRECTORY ?? 0));
  try {
    const after = fstatSync(fd);
    if (!after.isDirectory() || !owned(after) || after.ino !== before.ino || after.dev !== before.dev) throw new Error('Cache directory changed');
    fchmodSync(fd, 0o700);
  } finally { closeSync(fd); }
}

function safeFile(stat: Stats): boolean { return stat.isFile() && owned(stat) && stat.nlink === 1; }

export function readCache(source: Source, channel: Channel, cacheFile = CACHE_FILE): Snapshot | null {
  let fd: number | undefined;
  try {
    secureDirectory(dirname(cacheFile), false);
    const before = lstatSync(cacheFile);
    if (!safeFile(before) || before.size > MAX_BYTES) return null;
    fd = openSync(cacheFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd);
    if (!safeFile(stat) || stat.size > MAX_BYTES || stat.ino !== before.ino || stat.dev !== before.dev) return null;
    if (process.platform !== 'win32') fchmodSync(fd, 0o600);
    const entry: unknown = JSON.parse(readFileSync(fd, 'utf8'));
    if (!object(entry) || entry.source !== source || entry.channel !== channel || typeof entry.ts !== 'number') return null;
    const age = Date.now() - entry.ts;
    if (!Number.isFinite(age) || age < 0 || age >= TTL_MS || !isSnapshot(entry.snap)) return null;
    if (source !== 'auto' && entry.snap.source !== source) return null;
    return entry.snap;
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function writeCache(snap: Snapshot, source: Source, channel: Channel, cacheFile = CACHE_FILE): void {
  let temporary: string | undefined;
  let fd: number | undefined;
  try {
    if (!isSnapshot(snap)) return;
    const body = JSON.stringify({ ts: Date.now(), source, channel, snap });
    if (Buffer.byteLength(body) > MAX_BYTES) return;
    secureDirectory(dirname(cacheFile), true);
    try { if (!safeFile(lstatSync(cacheFile))) return; }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
    temporary = join(dirname(cacheFile), `.quota-${randomUUID()}.tmp`);
    fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeFileSync(fd, body);
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    // rename replaces the directory entry; it never follows a destination symlink.
    renameSync(temporary, cacheFile);
    temporary = undefined;
  } catch { /* quota lookup must still succeed when caching is unavailable */ }
  finally {
    if (fd !== undefined) closeSync(fd);
    if (temporary) { try { unlinkSync(temporary); } catch { /* best effort */ } }
  }
}
