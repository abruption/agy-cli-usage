// Direct client for the Antigravity / Gemini Code Assist "Cloud Code" internal API.
//
// Reproduces exactly what `agy` does on startup to populate its /usage panel:
//   1. POST /v1internal:loadCodeAssist  {metadata:{ideType:"ANTIGRAVITY"}}
//        -> { cloudaicompanionProject, currentTier, ... }
//   2. POST /v1internal:retrieveUserQuotaSummary  {project:<cloudaicompanionProject>}
//        -> { groups:[ { displayName, description, buckets:[ {bucketId, displayName,
//             window, resetTime, description?, remainingFraction} ] } ], description }
//
// Captured from live agy traffic (mitmproxy). The internal endpoint is undocumented;
// the PTY fallback exists for when it changes.

const UA = `antigravity-usage-monitor/0.1 ${process.platform}/${process.arch}`;

// Antigravity ships against the "daily" Cloud Code host; stable builds use the
// plain host. Try daily first (matches current CLI), fall back to prod.
const HOSTS = ['daily-cloudcode-pa.googleapis.com', 'cloudcode-pa.googleapis.com'];

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function extractEmail(uri) {
  const m = uri?.match(/[?&]Email=([^&]+)/);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

async function postInternal(host, accessToken, method, body) {
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
  return res.json();
}

/**
 * Fetch the raw quota summary from the Cloud Code API.
 * @param {string} accessToken
 * @param {{ host?: string, channel?: 'daily'|'prod' }} [opts]
 * @returns {Promise<{ raw: object, host: string, account: string|null, tier: string|null }>}
 */
export async function fetchQuotaSummary(accessToken, opts = {}) {
  const candidates = opts.host
    ? [opts.host]
    : opts.channel === 'prod'
      ? ['cloudcode-pa.googleapis.com']
      : opts.channel === 'daily'
        ? ['daily-cloudcode-pa.googleapis.com']
        : HOSTS;

  let lastErr;
  for (const host of candidates) {
    try {
      const lca = await postInternal(host, accessToken, 'loadCodeAssist', {
        metadata: { ideType: 'ANTIGRAVITY' },
      });
      const project = lca.cloudaicompanionProject;
      if (!project) throw new ApiError('loadCodeAssist returned no cloudaicompanionProject', 0);

      const raw = await postInternal(host, accessToken, 'retrieveUserQuotaSummary', { project });
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
