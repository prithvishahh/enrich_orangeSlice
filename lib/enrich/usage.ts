import type Anthropic from "@anthropic-ai/sdk";
import type { RowUsage } from "./types";

/** USD per 1M tokens. Cache reads bill at 0.1x input, 5-minute cache writes at 1.25x. */
const PRICING: Record<string, { input: number; output: number }> = {
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

export function priceFor(model: string) {
  return PRICING[model] ?? PRICING["claude-sonnet-5"];
}

/** Accumulates token usage and API call counts for one row. */
export class UsageMeter {
  readonly usage: RowUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    llm_calls: 0,
    llm_cost_usd: 0,
    firecrawl_calls: 0,
    exa_calls: 0,
    hunter_calls: 0,
  };

  constructor(readonly label: string) {}

  addLlm(model: string, step: string, u: Anthropic.Usage) {
    const p = priceFor(model);
    const cacheRead = u.cache_read_input_tokens ?? 0;
    const cacheWrite = u.cache_creation_input_tokens ?? 0;
    const cost =
      (u.input_tokens * p.input + cacheRead * p.input * 0.1 + cacheWrite * p.input * 1.25 + u.output_tokens * p.output) / 1e6;
    const t = this.usage;
    t.input_tokens += u.input_tokens;
    t.output_tokens += u.output_tokens;
    t.cache_read_input_tokens += cacheRead;
    t.cache_creation_input_tokens += cacheWrite;
    t.llm_calls++;
    t.llm_cost_usd += cost;
    console.log(
      `[tokens] ${this.label} ${step}: in=${u.input_tokens} out=${u.output_tokens} cache_read=${cacheRead} cache_write=${cacheWrite} cost=$${cost.toFixed(4)}`,
    );
  }

  count(api: "firecrawl" | "exa" | "hunter") {
    this.usage[`${api}_calls`]++;
  }

  logSummary() {
    const t = this.usage;
    console.log(
      `[cost] ${this.label}: llm_calls=${t.llm_calls} in=${t.input_tokens} out=${t.output_tokens} ` +
        `llm_cost=$${t.llm_cost_usd.toFixed(4)} | firecrawl=${t.firecrawl_calls} exa=${t.exa_calls} hunter=${t.hunter_calls} (uncached API calls)`,
    );
  }
}
