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

const UA = `antigravity-usage-monitor/0.1 ${process.platform}/${process.arch}`;

// Antigravity ships against the "daily" Cloud Code host; stable builds use the
// plain host. Try daily first (matches current CLI), fall back to prod.
const HOSTS = ['daily-cloudcode-pa.googleapis.com', 'cloudcode-pa.googleapis.com'];

class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

interface LoadCodeAssistResponse {
  cloudaicompanionProject?: string;
  currentTier?: { id?: string; upgradeSubscriptionUri?: string };
}

export interface FetchOptions {
  host?: string;
  channel?: 'daily' | 'prod';
}

function extractEmail(uri: string | undefined): string | null {
  const m = uri?.match(/[?&]Email=([^&]+)/);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

async function postInternal<T>(host: string, accessToken: string, method: string, body: unknown): Promise<T> {
  const res = await fetch(`https://${host}/v1internal:${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': UA,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new ApiError(`${method} -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status);
  }
  return (await res.json()) as T;
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
      });
      const project = lca.cloudaicompanionProject;
      if (!project) throw new ApiError('loadCodeAssist returned no cloudaicompanionProject', 0);

      const raw = await postInternal<RawQuotaResponse>(host, accessToken, 'retrieveUserQuotaSummary', { project });
      return {
        raw,
        host,
        tier: lca.currentTier?.id ?? null,
        account: extractEmail(lca.currentTier?.upgradeSubscriptionUri),
      };
    } catch (err) {
      lastErr = err;
      // 404 / wrong-host -> try next candidate; auth errors -> stop early.
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) throw err;
    }
  }
  throw lastErr ?? new ApiError('No Cloud Code host responded', 0);
}

export { ApiError };
