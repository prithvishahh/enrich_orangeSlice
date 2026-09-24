/** Error carrying an HTTP status so retry logic can decide what's transient. */
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
  ) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isRetryable(err: unknown): boolean {
  if (err instanceof HttpError) return err.status === 408 || err.status === 429 || err.status >= 500;
  return true; // network errors, timeouts
}

/**
 * Run `fn`, retrying up to `retries` times (default 2) with exponential
 * backoff + jitter on transient failures. 4xx (except 408/429) fail fast.
 */
export async function withRetry<T>(label: string, fn: () => Promise<T>, retries = 2, baseMs = 800): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isRetryable(err)) throw err;
      const delay = baseMs * 2 ** attempt + Math.random() * 250;
      attempt++;
      console.warn(`[retry] ${label} failed (${(err as Error).message}); retry ${attempt}/${retries} in ${Math.round(delay)}ms`);
      await sleep(delay);
    }
  }
}

/** fetch + JSON with timeout and HttpError on non-2xx. */
export async function fetchJson<T>(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const { timeoutMs = 45_000, ...rest } = init;
  const res = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  if (!res.ok) {
    throw new HttpError(`${rest.method ?? "GET"} ${new URL(url).host}${new URL(url).pathname} -> ${res.status}`, res.status, text.slice(0, 500));
  }
  return JSON.parse(text) as T;
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}. Add it to .env.local (see .env.example).`);
  return v;
}
