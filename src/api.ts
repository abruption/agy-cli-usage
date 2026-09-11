// Direct client for the Antigravity / Gemini Code Assist "Cloud Code" internal API.
//
// Reproduces exactly what `agy` does on startup to populate its /usage panel:
//   1. POST /v1internal:loadCodeAssist  {metadata:{ideType:"ANTIGRAVITY"}}
//        -> { cloudaicompanionProject, currentTier, ... }
//   2. POST /v1internal:retrieveUserQuotaSummary  {project:<cloudaicompanionProject>}
//        -> { groups:[...], description }
//
// Captured from live agy traffic (mitmproxy). The internal endpoint is undocumented;
// the PTY fallback exists for when it changes.

import type { FetchResult, RawQuotaResponse } from './types.js';
import { requestJson, type RequestDeps } from './request.js';
import { currentVersion } from './update.js';

// The UA is load-bearing, not cosmetic: Cloud Code picks the product from the
// User-Agent, not from the request body. Without an `antigravity` substring
// (case-insensitive, position and version format irrelevant) `loadCodeAssist`
// answers HTTP 200 but omits `cloudaicompanionProject`, so the quota call can
// never run — sending `ideType: "ANTIGRAVITY"` does not compensate. Dropping
// that substring is what broke v0.4.5 (#47). Verified against the live daily
// host on 2026-09-07.
/** Exported for direct unit testing — keeps the UA tied to the real package name/version. */
export function buildUserAgent(): string {
  return `antigravity-agy-cli-usage/${currentVersion()} ${process.platform}/${process.arch}`;
}

const UA = buildUserAgent();

// Antigravity ships against the "daily" Cloud Code host; stable builds use the
// plain host. Try daily first (matches current CLI), fall back to prod.
const HOSTS = ['daily-cloudcode-pa.googleapis.com', 'cloudcode-pa.googleapis.com'];

/**
 * Why these are distinct: the endpoint uses 401 and 403 for unrelated problems
 * and only one of them is fixed by signing in again.
 *   unauthorized — the token was rejected (expired/revoked): re-authenticate.
 *   not-entitled — the token is fine but the account has no Antigravity
 *                  license ("You do not have a valid license of this
 *                  product…"): signing in again changes nothing.
 *   no-project   — HTTP 200 without `cloudaicompanionProject`.
 *   http         — anything else (wrong host, 5xx, …).
 */
export type ApiErrorKind = 'unauthorized' | 'not-entitled' | 'no-project' | 'http';

class ApiError extends Error {
  status: number;
  kind: ApiErrorKind;
  constructor(message: string, status: number, kind?: ApiErrorKind) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.kind = kind ?? (status === 401 ? 'unauthorized' : status === 403 ? 'not-entitled' : 'http');
  }
}

interface LoadCodeAssistResponse {
  cloudaicompanionProject?: string;
  currentTier?: { id?: string; upgradeSubscriptionUri?: string };
}

export interface FetchOptions extends RequestDeps {
  host?: string;
  channel?: 'daily' | 'prod';
}

// Known limitation: this is the only email source `loadCodeAssist` exposes —
// the `Email=` query param on `currentTier.upgradeSubscriptionUri`. Accounts
// already on the top tier have nothing left to upgrade to, so that URI (and
// therefore `account`) is `null` for them via the API path even though the
// PTY path can still show `Account: …` (it reads it straight off agy's own
// rendered panel, which has an in-app session it can draw on that this
// unauthenticated-beyond-the-token API response doesn't provide). There is no
// alternative email field in either `loadCodeAssist` or
// `retrieveUserQuotaSummary` today — see README Caveats. Use `--source pty`
// if you need the account email for a top-tier subscriber.
function extractEmail(uri: string | undefined): string | null {
  const m = uri?.match(/[?&]Email=([^&]+)/);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

async function postInternal<T>(host: string, accessToken: string, method: string, body: unknown, deps: RequestDeps): Promise<T> {
  return requestJson<T>(`https://${host}/v1internal:${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': UA,
    },
    body: JSON.stringify(body),
  }, (status) => new ApiError(`${method} -> HTTP ${status}`, status), deps);
}

/** Fetch the raw quota summary from the Cloud Code API. */
export async function fetchQuotaSummary(accessToken: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const candidates = opts.host
    ? [opts.host]
    : opts.channel === 'prod'
      ? ['cloudcode-pa.googleapis.com']
      : opts.channel === 'daily'
        ? ['daily-cloudcode-pa.googleapis.com']
        : HOSTS;

  let lastErr: unknown;
  for (const host of candidates) {
    try {
      const lca = await postInternal<LoadCodeAssistResponse>(host, accessToken, 'loadCodeAssist', {
        metadata: { ideType: 'ANTIGRAVITY' },
      }, opts);
      const project = lca.cloudaicompanionProject;
      if (!project) {
        throw new ApiError(
          `loadCodeAssist on ${host} returned HTTP 200 without cloudaicompanionProject — either the ` +
            `request was not recognized as Antigravity (the API reads the product off the User-Agent, ` +
            `which must contain "antigravity") or the signed-in account has no Antigravity entitlement`,
          0,
          'no-project',
        );
      }

      const raw = await postInternal<RawQuotaResponse>(host, accessToken, 'retrieveUserQuotaSummary', { project }, opts);
      return {
        raw,
        host,
        tier: lca.currentTier?.id ?? null,
        account: extractEmail(lca.currentTier?.upgradeSubscriptionUri),
      };
    } catch (err) {
      lastErr = err;
      // 404 / wrong-host -> try next candidate. A rejected token or a missing
      // license is account-level, identical on every host: stop early.
      // `no-project` deliberately keeps going — an account can be entitled on
      // one channel and not the other, and one extra round trip is cheap.
      if (err instanceof ApiError && (err.kind === 'unauthorized' || err.kind === 'not-entitled')) throw err;
    }
  }
  throw lastErr ?? new ApiError('No Cloud Code host responded', 0);
}

export { ApiError };
