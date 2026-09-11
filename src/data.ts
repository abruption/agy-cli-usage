import { stripVTControlCharacters } from 'node:util';
import type { RawQuotaResponse } from './types.js';

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function normalizeFraction(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null;
}

export function normalizeDate(value: unknown): string | null {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  return value;
}

export function assertQuotaResponse(value: unknown): asserts value is RawQuotaResponse {
  const strings = (obj: Record<string, unknown>, keys: string[]): boolean =>
    keys.every((key) => obj[key] == null || typeof obj[key] === 'string');
  if (!isRecord(value) || !strings(value, ['description']) || !Array.isArray(value.groups)
    || !value.groups.every((g: unknown) => isRecord(g) && strings(g, ['displayName', 'description'])
      && (g.buckets == null || (Array.isArray(g.buckets) && g.buckets.every((b: unknown) =>
        isRecord(b) && strings(b, ['displayName', 'window', 'description', 'resetTime'])))))) {
    throw new Error('Invalid quota response');
  }
}

/** Apply at the human-output boundary; JSON retains the source text. */
export function terminalText(value: string): string {
  return Array.from(stripVTControlCharacters(value), (char) => {
    const code = char.charCodeAt(0);
    return code < 32 || (code >= 127 && code <= 159) ? ' ' : char;
  }).join('');
}
