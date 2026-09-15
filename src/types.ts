// Shared types for agy-cli-usage.

export type BucketKind = 'weekly' | '5h' | string;

// --- raw Cloud Code retrieveUserQuotaSummary response ------------------------

export interface RawBucket {
  bucketId?: string;
  displayName?: string;
  window?: string;
  resetTime?: string;
  description?: string;
  remainingFraction?: number;
}

export interface RawGroup {
  displayName?: string;
  description?: string;
  buckets?: RawBucket[];
}

export interface RawQuotaResponse {
  groups?: RawGroup[];
  description?: string;
}

/** Result of api.fetchQuotaSummary. */
export interface FetchResult {
  raw: RawQuotaResponse;
  host: string | null;
  account: string | null;
  tier: string | null;
}

// --- PTY-parsed panel (pty-fallback) -----------------------------------------

export interface ParsedBucket {
  kind: BucketKind;
  label: string;
  remainingFraction: number | null;
  resetsInSeconds: number | null;
  available: boolean;
  description: string | null;
}

export interface ParsedGroup {
  name: string;
  models: string;
  buckets: ParsedBucket[];
}

export interface ParsedPanel {
  account: string | null;
  groups: ParsedGroup[];
  note?: string | null;
}

// --- normalized snapshot (renderer / JSON / HTTP) ----------------------------

export interface Bucket {
  kind: BucketKind;
  label: string;
  remainingFraction: number | null;
  usedFraction: number | null;
  resetAt: string | null;
  resetsInSeconds: number | null;
  available: boolean;
  description: string | null;
}

export interface Group {
  name: string;
  models: string;
  buckets: Bucket[];
}

/** Advisory notice for this installed CLI, shared with the session-peer decision model.
 * Present only for a fresh, validated stable latest > current. Absence means no
 * usable notice, not proof of being current. Never part of the quota cache.
 */
export interface ClientUpdate {
  schemaVersion: 1;
  status: 'available';
  current: string;
  latest: string;
  checkedAt: string;
  source: 'npm_registry_cache';
  command: 'agy-cli-usage update';
}

/** Identical contract for CLI JSON and GET /quota; update metadata is optional. */
export interface Snapshot {
  clientUpdate?: ClientUpdate;
  account: string | null;
  tier: string | null;
  fetchedAt: string;
  source: 'api' | 'pty';
  host: string | null;
  note: string | null;
  groups: Group[];
}
