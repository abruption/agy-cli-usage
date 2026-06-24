// Sample payloads captured from live agy traffic / rendered panels, used by the
// unit tests so they run without credentials or network access.

import type { RawQuotaResponse } from '../src/types.js';

export const SAMPLE_QUOTA_RESPONSE: RawQuotaResponse = {
  groups: [
    {
      displayName: 'Gemini Models',
      description: 'Models within this group: Gemini Flash, Gemini Pro',
      buckets: [
        {
          bucketId: 'gemini-weekly',
          displayName: 'Weekly Limit',
          window: 'weekly',
          resetTime: '2026-06-27T03:53:09Z',
          description: 'You have used some of your weekly limit, it will fully refresh in 3 days, 1 hour.',
          remainingFraction: 0.9164178,
        },
        {
          bucketId: 'gemini-5h',
          displayName: 'Five Hour Limit',
          window: '5h',
          resetTime: '2026-06-24T04:32:07Z',
          remainingFraction: 0.9436444,
        },
      ],
    },
    {
      displayName: 'Claude and GPT models',
      description: 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS',
      buckets: [
        { bucketId: '3p-weekly', displayName: 'Weekly Limit', window: 'weekly', resetTime: '2026-06-25T04:47:04Z', remainingFraction: 0.9777988 },
        { bucketId: '3p-5h', displayName: 'Five Hour Limit', window: '5h', resetTime: '2026-06-24T07:24:43Z', remainingFraction: 1 },
      ],
    },
  ],
  description: 'Within each group, models share a weekly limit and a 5-hour limit.',
};

// Reconstructed /usage screen text (what @xterm/headless yields from the PTY).
export const SAMPLE_PANEL_TEXT = `
└ Models & Quota
  Account: cursor.chat@gmail.com
GEMINI MODELS
  Models within this group: Gemini Flash, Gemini Pro
  Weekly Limit
    [██████████████████████████████████████████████░░░░] 91.55%
    92% remaining · Refreshes in 73h 18m
  Five Hour Limit
    [███████████████████████████████████████████████░░░] 93.83%
    94% remaining · Refreshes in 1h 57m
CLAUDE AND GPT MODELS
  Models within this group: Claude Opus, Claude Sonnet, GPT-OSS
  Weekly Limit
    [█████████████████████████████████████████████████░] 97.78%
    98% remaining · Refreshes in 26h 12m
  Five Hour Limit
    [██████████████████████████████████████████████████] 100.00%
    Quota available
`;

// A fixed reference time so resetsInSeconds is deterministic in tests.
export const NOW_MS = Date.parse('2026-06-24T03:00:00Z');
