import { cached } from "./cache";
import { fetchJson, HttpError, requireEnv, withRetry } from "./http";
import type { SourceDoc } from "./types";
import type { UsageMeter } from "./usage";

const BASE = process.env.FIRECRAWL_API_URL ?? "https://api.firecrawl.dev/v2";
const MAX_PAGE_CHARS = Number(process.env.ENRICH_MAX_PAGE_CHARS ?? 12_000);

interface ScrapeResponse {
  success: boolean;
  data?: {
    markdown?: string;
    metadata?: { title?: string; sourceURL?: string; url?: string; statusCode?: number };
  };
}

/** Scrape one URL to markdown. Returns null for 404s / empty pages. Cached per URL. */
export function scrapeUrl(url: string, meter: UsageMeter): Promise<SourceDoc | null> {
  return cached(`scrape:${url}`, async () => {
    meter.count("firecrawl");
    try {
      const res = await withRetry(`firecrawl ${url}`, () =>
        fetchJson<ScrapeResponse>(`${BASE}/scrape`, {
          method: "POST",
          headers: { Authorization: `Bearer ${requireEnv("FIRECRAWL_API_KEY")}`, "Content-Type": "application/json" },
          body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
          timeoutMs: 60_000,
        }),
      );
      const md = res.data?.markdown?.trim();
      const status = res.data?.metadata?.statusCode ?? 200;
      if (!res.success || !md || status >= 400) return null;
      return {
        url: res.data?.metadata?.url ?? res.data?.metadata?.sourceURL ?? url,
        title: res.data?.metadata?.title,
        kind: "scrape",
        text: md.length > MAX_PAGE_CHARS ? `${md.slice(0, MAX_PAGE_CHARS)}\n[...truncated]` : md,
      } satisfies SourceDoc;
    } catch (err) {
      // A missing /team or /careers page is normal; don't fail the row for it.
      if (err instanceof HttpError && err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 402) return null;
      throw err;
    }
  });
}

export const SCRAPE_PATHS = ["", "/about", "/team", "/careers"];

/** Scrape homepage + /about + /team + /careers in parallel. Dedupes redirects to the same final URL. */
export async function scrapeCompanySite(domain: string, meter: UsageMeter): Promise<SourceDoc[]> {
  const results = await Promise.allSettled(SCRAPE_PATHS.map((p) => scrapeUrl(`https://${domain}${p}`, meter)));
  const docs: SourceDoc[] = [];
  const seen = new Set<string>();
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      console.warn(`[firecrawl] ${domain}${SCRAPE_PATHS[i]} failed: ${(r.reason as Error).message}`);
      if (i === 0) throw r.reason; // homepage failure is fatal for the site scrape (e.g. bad key)
      return;
    }
    const doc = r.value;
    if (!doc) return;
    const key = doc.url.replace(/\/+$/, "");
    if (seen.has(key)) return;
    seen.add(key);
    docs.push(doc);
  });
  return docs;
}
