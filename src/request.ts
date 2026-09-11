// Deadlines cover both response headers and JSON body consumption.
export const REQUEST_TIMEOUT_MS = 10_000;
export interface RequestDeps {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export async function requestJson<T>(
  url: string,
  init: RequestInit,
  statusError: (status: number) => Error,
  deps: RequestDeps = {},
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? REQUEST_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await (deps.fetch ?? fetch)(url, { ...init, signal: controller.signal, redirect: 'error' });
    } catch {
      throw new Error(controller.signal.aborted ? 'Request timed out' : 'Request failed');
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw statusError(response.status);
    }
    try {
      return await response.json() as T;
    } catch {
      throw new Error(controller.signal.aborted ? 'Request timed out' : 'Invalid JSON response');
    }
  } finally {
    clearTimeout(timer);
  }
}
