import { cached } from "./cache";
import { fetchJson, HttpError, requireEnv, withRetry } from "./http";
import type { SourceDoc } from "./types";
import type { UsageMeter } from "./usage";

/**
 * Site scraping. Uses Firecrawl when FIRECRAWL_API_KEY is set (renders JS,
 * cleaner markdown); otherwise fetches HTML directly and converts it to text
 * (free, no key, but misses content that only renders client-side).
 */
const FIRECRAWL_BASE = process.env.FIRECRAWL_API_URL ?? "https://api.firecrawl.dev/v2";
const MAX_PAGE_CHARS = Number(process.env.ENRICH_MAX_PAGE_CHARS ?? 12_000);
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

const clip = (s: string) => (s.length > MAX_PAGE_CHARS ? `${s.slice(0, MAX_PAGE_CHARS)}\n[...truncated]` : s);

interface FirecrawlResponse {
  success: boolean;
  data?: {
    markdown?: string;
    metadata?: { title?: string; sourceURL?: string; url?: string; statusCode?: number };
  };
}

async function scrapeFirecrawl(url: string): Promise<SourceDoc | null> {
  const res = await fetchJson<FirecrawlResponse>(`${FIRECRAWL_BASE}/scrape`, {
    method: "POST",
    headers: { Authorization: `Bearer ${requireEnv("FIRECRAWL_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
    timeoutMs: 60_000,
  });
  const md = res.data?.markdown?.trim();
  const status = res.data?.metadata?.statusCode ?? 200;
  if (!res.success || !md || status >= 400) return null;
  return {
    url: res.data?.metadata?.url ?? res.data?.metadata?.sourceURL ?? url,
    title: res.data?.metadata?.title,
    kind: "scrape",
    text: clip(md),
  };
}

async function scrapeDirect(url: string): Promise<SourceDoc | null> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 404 || res.status === 410) return null;
  if (!res.ok) throw new HttpError(`GET ${url} -> ${res.status}`, res.status);
  if (!(res.headers.get("content-type") ?? "").includes("html")) return null;
  const { title, text } = htmlToText(await res.text());
  if (text.length < 50) return null;
  return { url: res.url || url, title, kind: "scrape", text: clip(text) };
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…" };

function decode(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Crude but dependency-free HTML → readable text. Keeps meta description and JSON-LD (often has address/headcount). */
export function htmlToText(html: string): { title?: string; text: string } {
  const title = decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? "") || undefined;
  const meta = [...html.matchAll(/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]*>/gi)]
    .map((m) => m[0].match(/content=["']([^"']*)["']/i)?.[1])
    .filter(Boolean)
    .map((s) => decode(s!));
  const jsonLd = [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => m[1].trim())
    .filter((s) => /Organization|Corporation|address|numberOfEmployees|founder/i.test(s))
    .map((s) => s.slice(0, 3000));

  const body = html
    .replace(/<(script|style|noscript|svg|template|iframe|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<h([1-6])[^>]*>/gi, (_, n: string) => `\n${"#".repeat(Number(n))} `)
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|header|footer|li|ul|ol|h[1-6]|tr|table|blockquote|nav|main)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  const lines = decode(body)
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .filter((l) => l && l !== "-" && !/^#+$/.test(l));
  // Drop consecutive duplicate lines (menus repeated for mobile/desktop).
  const deduped = lines.filter((l, i) => l !== lines[i - 1]);

  const parts = [
    meta.length ? `Meta description: ${[...new Set(meta)].join(" | ")}` : "",
    deduped.join("\n"),
    jsonLd.length ? `Structured data (JSON-LD):\n${jsonLd.join("\n")}` : "",
  ];
  return { title, text: parts.filter(Boolean).join("\n\n") };
}

/** Scrape one URL. Returns null for 404s / empty pages. Cached per URL. */
export function scrapeUrl(url: string, meter: UsageMeter): Promise<SourceDoc | null> {
  const useFirecrawl = !!process.env.FIRECRAWL_API_KEY;
  return cached(`scrape:${useFirecrawl ? "fc" : "direct"}:${url}`, async () => {
    meter.count("scrape");
    try {
      return await withRetry(`scrape ${url}`, () => (useFirecrawl ? scrapeFirecrawl(url) : scrapeDirect(url)));
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
      console.warn(`[scrape] ${domain}${SCRAPE_PATHS[i]} failed: ${(r.reason as Error).message}`);
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
