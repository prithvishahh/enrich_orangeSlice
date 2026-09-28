import fs from "node:fs";
import path from "node:path";

/**
 * Process-wide TTL cache. Stored on globalThis so it survives Next.js
 * dev-server hot reloads, and caches the in-flight promise so concurrent
 * callers for the same key share one request.
 *
 * Resolved values are also persisted to .enrich-cache.json (disable with
 * ENRICH_DISK_CACHE=0), so a pre-warmed run replays instantly and for free
 * after a restart — handy before a live demo.
 */
type Entry = { expires: number; value: Promise<unknown> };

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const FILE = path.join(process.cwd(), ".enrich-cache.json");
const diskEnabled = () => process.env.ENRICH_DISK_CACHE !== "0";

const g = globalThis as unknown as {
  __enrichCache?: Map<string, Entry>;
  __enrichDisk?: Record<string, { expires: number; value: unknown }>;
  __enrichFlush?: NodeJS.Timeout;
};
const store = (g.__enrichCache ??= new Map());

function disk() {
  if (g.__enrichDisk) return g.__enrichDisk;
  g.__enrichDisk = {};
  if (diskEnabled()) {
    try {
      g.__enrichDisk = JSON.parse(fs.readFileSync(FILE, "utf8"));
    } catch {
      /* no cache file yet */
    }
  }
  return g.__enrichDisk!;
}

function scheduleFlush() {
  if (!diskEnabled() || g.__enrichFlush) return;
  g.__enrichFlush = setTimeout(() => {
    g.__enrichFlush = undefined;
    const now = Date.now();
    const d = disk();
    for (const [k, v] of Object.entries(d)) if (v.expires < now) delete d[k];
    try {
      fs.writeFileSync(FILE, JSON.stringify(d));
    } catch (err) {
      console.warn(`[cache] could not write ${FILE}: ${(err as Error).message}`);
    }
  }, 500);
}

export function cached<T>(key: string, fn: () => Promise<T>, ttlMs = DEFAULT_TTL_MS): Promise<T> {
  const hit = store.get(key);
  if (hit && hit.expires > Date.now()) return hit.value as Promise<T>;

  const saved = diskEnabled() ? disk()[key] : undefined;
  if (saved && saved.expires > Date.now()) {
    const value = Promise.resolve(saved.value as T);
    store.set(key, { expires: saved.expires, value });
    return value;
  }

  const expires = Date.now() + ttlMs;
  const value = fn();
  store.set(key, { expires, value });
  value.then(
    (v) => {
      if (!diskEnabled()) return;
      disk()[key] = { expires, value: v };
      scheduleFlush();
    },
    () => {
      // Don't cache failures.
      if (store.get(key)?.value === value) store.delete(key);
    },
  );
  return value;
}

/** Cached value for `key` (memory or disk) without computing it, or undefined. */
export function peekCached<T>(key: string): Promise<T> | undefined {
  const hit = store.get(key);
  if (hit && hit.expires > Date.now()) return hit.value as Promise<T>;
  const saved = diskEnabled() ? disk()[key] : undefined;
  if (saved && saved.expires > Date.now()) return cached(key, () => Promise.resolve(saved.value as T));
  return undefined;
}

/** Store an already-computed value. */
export function remember<T>(key: string, value: T): void {
  void cached(key, () => Promise.resolve(value));
}

export function clearCache(prefix?: string) {
  for (const k of store.keys()) if (!prefix || k.startsWith(prefix)) store.delete(k);
  const d = disk();
  for (const k of Object.keys(d)) if (!prefix || k.startsWith(prefix)) delete d[k];
  scheduleFlush();
}
