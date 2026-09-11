import { setTimeout as delay } from 'node:timers/promises';

/** Rejections are shared only until settlement; the next caller may retry. */
export function singleFlight<A, R>(key: (args: A) => string, run: (args: A) => Promise<R>): (args: A) => Promise<R> {
  const pending = new Map<string, Promise<R>>();
  return (args) => {
    const id = key(args);
    const existing = pending.get(id);
    if (existing) return existing;
    const result = Promise.resolve().then(() => run(args)).finally(() => pending.delete(id));
    pending.set(id, result);
    return result;
  };
}

export async function watchLoop(tick: () => Promise<void>, intervalMs: number, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    await tick();
    if (signal.aborted) break;
    try { await delay(intervalMs, undefined, { signal }); }
    catch (err) { if (!signal.aborted) throw err; }
  }
}
