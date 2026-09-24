/**
 * Process-wide in-memory TTL cache. Stored on globalThis so it survives
 * Next.js dev-server hot reloads. Caches the in-flight promise, so concurrent
 * callers for the same key share one request.
 */
type Entry = { expires: number; value: Promise<unknown> };

const g = globalThis as unknown as { __enrichCache?: Map<string, Entry> };
const store = (g.__enrichCache ??= new Map());

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6h

export function cached<T>(key: string, fn: () => Promise<T>, ttlMs = DEFAULT_TTL_MS): Promise<T> {
  const hit = store.get(key);
  if (hit && hit.expires > Date.now()) return hit.value as Promise<T>;
  const value = fn();
  store.set(key, { expires: Date.now() + ttlMs, value });
  // Don't cache failures.
  value.catch(() => {
    if (store.get(key)?.value === value) store.delete(key);
  });
  return value;
}

export function isCached(key: string): boolean {
  const hit = store.get(key);
  return !!hit && hit.expires > Date.now();
}

export function clearCache(prefix?: string) {
  for (const k of store.keys()) if (!prefix || k.startsWith(prefix)) store.delete(k);
}
