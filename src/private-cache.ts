import {
  constants, openSync, closeSync, fstatSync, fchmodSync, readSync, writeFileSync,
  mkdirSync, lstatSync, renameSync, unlinkSync, fsyncSync, type Stats,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

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

/** Bounded, owner-controlled JSON shared by the independent cache formats. */
export function readPrivateJson(file: string, maxBytes: number): unknown {
  let fd: number | undefined;
  try {
    secureDirectory(dirname(file), false);
    const before = lstatSync(file);
    if (!safeFile(before) || before.size > maxBytes) return null;
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd);
    if (!safeFile(stat) || stat.size > maxBytes || stat.ino !== before.ino || stat.dev !== before.dev) return null;
    if (process.platform !== 'win32') fchmodSync(fd, 0o600);
    // Read at most the limit even if another owner-controlled writer grows it.
    const buffer = Buffer.alloc(maxBytes + 1);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    if (length > maxBytes) return null;
    return JSON.parse(buffer.subarray(0, length).toString('utf8'));
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function writePrivateJson(file: string, value: unknown, maxBytes: number): boolean {
  let temporary: string | undefined;
  let fd: number | undefined;
  try {
    const body = JSON.stringify(value);
    if (Buffer.byteLength(body) > maxBytes) return false;
    secureDirectory(dirname(file), true);
    try { if (!safeFile(lstatSync(file))) return false; }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
    temporary = join(dirname(file), `.cache-${randomUUID()}.tmp`);
    fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeFileSync(fd, body);
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    renameSync(temporary, file);
    temporary = undefined;
    return true;
  } catch { return false; }
  finally {
    if (fd !== undefined) closeSync(fd);
    if (temporary) { try { unlinkSync(temporary); } catch { /* best effort */ } }
  }
}

/** Exclusive short-lived refresh lease; stale workers cannot remove a successor's lease. */
export function acquireCacheLease(file: string, lifetimeMs: number, nowMs = Date.now()): (() => void) | null {
  try {
    secureDirectory(dirname(file), true);
    try {
      const stat = lstatSync(file);
      if (!safeFile(stat) || nowMs - stat.mtimeMs < lifetimeMs) return null;
      unlinkSync(file);
    } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return null; }
    const fd = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    const id = randomUUID();
    try { writeFileSync(fd, JSON.stringify({ id })); }
    finally { closeSync(fd); }
    return () => {
      const value = readPrivateJson(file, 1024) as { id?: unknown } | null;
      if (value?.id === id) { try { unlinkSync(file); } catch { /* best effort */ } }
    };
  } catch { return null; }
}
