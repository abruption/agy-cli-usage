// Update state is advisory and independent of the five-minute quota cache.
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CACHE_FILE } from './cache.js';
import { acquireCacheLease, readPrivateJson, writePrivateJson } from './private-cache.js';
import { singleFlight } from './polling.js';
import { currentVersion, latestVersion, semverCompare, stableVersion } from './update.js';
import type { ClientUpdate } from './types.js';

export const UPDATE_CACHE_FILE = join(dirname(CACHE_FILE), 'update.json');
export const UPDATE_TTL_MS = 24 * 60 * 60 * 1000;
export const UPDATE_MAX_BYTES = 4096;
export const UPDATE_WORKER_DEADLINE_MS = 20_000;
const LEASE_MS = 30_000;

export interface UpdateRecord {
  schemaVersion: 1;
  /** ISO timestamp of the attempt, including unsuccessful/pending checks. */
  checkedAt: string;
  latest: string | null;
}

function validRecord(value: unknown): value is UpdateRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return v.schemaVersion === 1 && typeof v.checkedAt === 'string'
    && Number.isFinite(Date.parse(v.checkedAt)) && new Date(v.checkedAt).toISOString() === v.checkedAt
    && (v.latest === null || (typeof v.latest === 'string' && stableVersion(v.latest) === v.latest));
}

export function readUpdateCache(file = UPDATE_CACHE_FILE, nowMs = Date.now()): UpdateRecord | null {
  const value = readPrivateJson(file, UPDATE_MAX_BYTES);
  if (!validRecord(value)) return null;
  const age = nowMs - Date.parse(value.checkedAt);
  if (!Number.isFinite(age) || age < 0 || age >= UPDATE_TTL_MS) return null;
  return { schemaVersion: 1, checkedAt: value.checkedAt, latest: value.latest };
}

export function writeUpdateCache(value: UpdateRecord, file = UPDATE_CACHE_FILE): boolean {
  if (!validRecord(value)) return false;
  // Whitelist fields: no npm configuration, registry response, or quota data.
  return writePrivateJson(file, { schemaVersion: 1, checkedAt: value.checkedAt, latest: value.latest }, UPDATE_MAX_BYTES);
}

interface RefreshOptions {
  cacheFile?: string;
  force?: boolean;
  latest?: () => Promise<string | null>;
  now?: () => number;
}

/** One lookup per cache path in this process; workers also take a filesystem lease. */
export const refreshUpdateCache = singleFlight(
  (opts: RefreshOptions) => resolve(opts.cacheFile ?? UPDATE_CACHE_FILE),
  async (opts: RefreshOptions): Promise<string | null> => {
    const file = opts.cacheFile ?? UPDATE_CACHE_FILE;
    const now = opts.now ?? Date.now;
    const release = acquireCacheLease(`${file}.lock`, LEASE_MS, now());
    // Explicit checks retain their result/exit code even if caching is denied.
    if (!release && !opts.force) return null;
    try {
      const existing = readUpdateCache(file, now());
      if (!opts.force && existing) return existing.latest;
      const record: UpdateRecord = { schemaVersion: 1, checkedAt: new Date(now()).toISOString(), latest: null };
      // Persist the attempt first: offline/crashed workers cannot cause a check
      // on each subsequent CLI invocation. If storage fails, skip automatic IO.
      const persisted = writeUpdateCache(record, file);
      if (!persisted && !opts.force) return null;
      let latest: string | null = null;
      try { latest = stableVersion(await (opts.latest ?? latestVersion)()); }
      catch { /* optional check failures never escape into quota reporting */ }
      const successor = readUpdateCache(file, now());
      if (!successor || Date.parse(successor.checkedAt) <= Date.parse(record.checkedAt)) {
        writeUpdateCache({ ...record, latest }, file);
      }
      return latest;
    } finally { release?.(); }
  },
);

/** Detached, silent worker: no npm call or registry wait in the quota process. */
export function launchUpdateWorker(cacheFile: string): void {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./update-worker.js', import.meta.url)), resolve(cacheFile)], {
    detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.on('error', () => { /* advisory only, including absent worker files */ });
  child.unref();
}

interface NotifierDeps {
  cacheFile?: string;
  now?: () => number;
  current?: () => string;
  launch?: (cacheFile: string) => void;
}

/** A process-wide retry ceiling also covers cache permission and spawn failures. */
export function createUpdateNotifier(deps: NotifierDeps = {}): (enabled?: boolean) => ClientUpdate | undefined {
  let attemptedAt: number | undefined;
  return (enabled = true) => {
    if (!enabled || process.env.AGY_NO_UPDATE_CHECK === '1') return undefined;
    try {
      const now = (deps.now ?? Date.now)();
      const file = deps.cacheFile ?? UPDATE_CACHE_FILE;
      const record = readUpdateCache(file, now);
      if (!record) {
        if (attemptedAt === undefined || now < attemptedAt || now - attemptedAt >= UPDATE_TTL_MS) {
          attemptedAt = now;
          (deps.launch ?? launchUpdateWorker)(file);
        }
        return undefined;
      }
      const current = stableVersion((deps.current ?? currentVersion)());
      if (!current || !record.latest || semverCompare(record.latest, current) <= 0) return undefined;
      return {
        schemaVersion: 1, status: 'available', current, latest: record.latest,
        checkedAt: record.checkedAt, source: 'npm_registry_cache', command: 'agy-cli-usage update',
      };
    } catch { return undefined; }
  };
}

export const getClientUpdate = createUpdateNotifier();
