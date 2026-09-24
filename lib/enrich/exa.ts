import { cached } from "./cache";
import { fetchJson, requireEnv, withRetry } from "./http";
import type { SourceDoc } from "./types";
import type { UsageMeter } from "./usage";

interface ExaResponse {
  results: { url: string; title?: string | null; publishedDate?: string | null; text?: string }[];
}

export interface ExaQuery {
  query: string;
  numResults?: number;
  category?: "news" | "company" | "linkedin profile" | "people";
  maxCharacters?: number;
}

/** Exa neural/keyword search with page text. Cached per query. */
export function exaSearch(q: ExaQuery, meter: UsageMeter): Promise<SourceDoc[]> {
  if (!process.env.EXA_API_KEY) return Promise.resolve([]); // search is optional; site scrape still runs
  const body = {
    query: q.query,
    type: "auto",
    numResults: q.numResults ?? 5,
    ...(q.category ? { category: q.category } : {}),
    contents: { text: { maxCharacters: q.maxCharacters ?? 3000 } },
  };
  return cached(`exa:${JSON.stringify(body)}`, async () => {
    meter.count("exa");
    const res = await withRetry(`exa "${q.query}"`, () =>
      fetchJson<ExaResponse>("https://api.exa.ai/search", {
        method: "POST",
        headers: { "x-api-key": requireEnv("EXA_API_KEY"), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    return res.results
      .filter((r) => r.url && r.text)
      .map((r) => ({
        url: r.url,
        title: r.title ?? undefined,
        kind: "search" as const,
        published: r.publishedDate ?? undefined,
        text: r.text!,
      }));
  });
}

/** Firmographic searches: funding news + headcount. Failures degrade to fewer sources. */
export async function searchFirmographics(domain: string, meter: UsageMeter): Promise<SourceDoc[]> {
  const queries: ExaQuery[] = [
    { query: `${domain} raises funding round`, category: "news", numResults: 6 },
    { query: `${domain} company number of employees headcount`, numResults: 4 },
  ];
  const settled = await Promise.allSettled(queries.map((q) => exaSearch(q, meter)));
  return settled.flatMap((r, i) => {
    if (r.status === "fulfilled") return r.value;
    console.warn(`[exa] "${queries[i].query}" failed: ${(r.reason as Error).message}`);
    return [];
  });
}

/** Targeted search for one custom-column question. */
export async function searchQuestion(domain: string, question: string, meter: UsageMeter): Promise<SourceDoc[]> {
  try {
    return await exaSearch({ query: `${domain} ${question}`, numResults: 4, maxCharacters: 2500 }, meter);
  } catch (err) {
    console.warn(`[exa] question "${question}" failed: ${(err as Error).message}`);
    return [];
  }
}

/** Search for the person holding `persona` at the company. */
export async function searchPersona(domain: string, company: string | null, persona: string, meter: UsageMeter) {
  const who = company ? `${company} (${domain})` : domain;
  const queries: ExaQuery[] = [
    { query: `${persona} at ${who}`, category: "linkedin profile", numResults: 6, maxCharacters: 1500 },
    { query: `${who} ${persona}`, numResults: 4, maxCharacters: 2000 },
  ];
  const settled = await Promise.allSettled(queries.map((q) => exaSearch(q, meter)));
  return settled.flatMap((r, i) => {
    if (r.status === "fulfilled") return r.value;
    console.warn(`[exa] "${queries[i].query}" failed: ${(r.reason as Error).message}`);
    return [];
  });
}
