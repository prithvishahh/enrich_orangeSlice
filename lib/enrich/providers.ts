import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { ApiError, GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { cached } from "./cache";
import { HttpError, withRetry } from "./http";
import type { UsageMeter } from "./usage";

/**
 * Two interchangeable backends for structured extraction:
 *  - anthropic: Claude via messages.parse + Zod structured outputs (paid)
 *  - gemini:    Google Gemini free tier via responseJsonSchema (free, rate-limited)
 * Chosen by LLM_PROVIDER, else whichever key is present (Anthropic first).
 */
export type Provider = "anthropic" | "gemini";

export function activeProvider(): Provider {
  const p = process.env.LLM_PROVIDER as Provider | undefined;
  if (p === "anthropic" || p === "gemini") return p;
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.GEMINI_API_KEY) return "gemini";
  throw new Error("No LLM key. Set GEMINI_API_KEY (free) or ANTHROPIC_API_KEY in .env.local.");
}

export function activeModel(provider = activeProvider()): string {
  return provider === "anthropic"
    ? (process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5")
    : (process.env.GEMINI_MODEL ?? "gemini-flash-latest");
}

const g = globalThis as unknown as {
  __anthropic?: Anthropic;
  __gemini?: GoogleGenAI;
  __geminiNext?: number;
  /** Set when Google reports the free-tier daily quota is used up; later calls fail fast. */
  __geminiDailyExhausted?: { model: string; message: string; until: number };
};

const GEMINI_TIMEOUT_MS = 60_000;

/** Classify a Gemini 429: a daily quota won't clear by retrying; a per-minute one says how long to wait. */
function geminiRateLimit(err: ApiError): { daily: boolean; retryMs: number } {
  const msg = err.message;
  const daily = /PerDay|per day|daily/i.test(msg);
  const secs = Number(msg.match(/retry in ([\d.]+)s/i)?.[1] ?? msg.match(/"retryDelay":\s*"(\d+(?:\.\d+)?)s"/)?.[1] ?? 0);
  return { daily, retryMs: Math.min(60_000, Math.ceil(secs * 1000)) };
}

/**
 * Structured call. Results are cached by a hash of (model, prompt), so
 * re-running an unchanged row costs nothing and is instant.
 */
export function callStructured<T extends z.ZodType>(
  step: string,
  schema: T,
  system: string,
  user: string,
  meter: UsageMeter,
): Promise<z.infer<T>> {
  const provider = activeProvider();
  const model = activeModel(provider);
  const key = `llm:${model}:${step}:${createHash("sha256").update(system).update("\0").update(user).digest("hex")}`;
  return cached(key, () =>
    provider === "anthropic"
      ? callAnthropic(model, step, schema, system, user, meter)
      : callGemini(model, step, schema, system, user, meter),
  ) as Promise<z.infer<T>>;
}

async function callAnthropic<T extends z.ZodType>(
  model: string,
  step: string,
  schema: T,
  system: string,
  user: string,
  meter: UsageMeter,
): Promise<z.infer<T>> {
  // SDK retries 408/409/429/5xx and connection errors twice with backoff by default.
  const client = (g.__anthropic ??= new Anthropic({ maxRetries: 2 }));
  const effort = (process.env.ANTHROPIC_EFFORT ?? "medium") as "low" | "medium" | "high";
  const res = await client.messages.parse({
    model,
    max_tokens: 16000,
    system,
    output_config: { effort, format: zodOutputFormat(schema) },
    messages: [{ role: "user", content: user }],
  });
  meter.addLlm(model, step, {
    input: res.usage.input_tokens,
    output: res.usage.output_tokens,
    cacheRead: res.usage.cache_read_input_tokens ?? 0,
    cacheWrite: res.usage.cache_creation_input_tokens ?? 0,
  });
  if (res.stop_reason === "refusal") throw new Error(`${step}: model refused (${res.stop_details?.category ?? "unknown"})`);
  if (res.stop_reason === "max_tokens") throw new Error(`${step}: response truncated at max_tokens`);
  if (!res.parsed_output) throw new Error(`${step}: could not parse structured output`);
  return res.parsed_output as z.infer<T>;
}

/** Space Gemini calls to stay under the free tier's requests-per-minute cap. */
async function geminiSlot(): Promise<void> {
  const rpm = Number(process.env.GEMINI_RPM ?? 10);
  const gap = 60_000 / Math.max(1, rpm);
  const now = Date.now();
  const at = Math.max(now, g.__geminiNext ?? 0);
  g.__geminiNext = at + gap;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

/** Zod → JSON Schema, rewriting `type: [a, null]` as `anyOf` (Gemini's supported subset). */
function toGeminiSchema(schema: z.ZodType): unknown {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) if (k !== "$schema") out[k] = walk(v);
    if (Array.isArray(out.type)) {
      const types = out.type as string[];
      delete out.type;
      out.anyOf = types.map((t) => ({ type: t }));
    }
    return out;
  };
  return walk(z.toJSONSchema(schema));
}

async function callGemini<T extends z.ZodType>(
  model: string,
  step: string,
  schema: T,
  system: string,
  user: string,
  meter: UsageMeter,
): Promise<z.infer<T>> {
  const client = (g.__gemini ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }));
  const responseJsonSchema = toGeminiSchema(schema);

  // Free-tier 429s are common: 3 retries with long backoff (4s, 8s, 16s).
  return withRetry(
    `gemini ${step}`,
    async () => {
      const exhausted = g.__geminiDailyExhausted;
      if (exhausted && exhausted.model === model && exhausted.until > Date.now()) throw new HttpError(exhausted.message, 429, undefined, false);
      await geminiSlot();
      let res;
      try {
        res = await client.models.generateContent({
          model,
          contents: user,
          config: {
            systemInstruction: system,
            responseMimeType: "application/json",
            responseJsonSchema,
            temperature: 0,
            httpOptions: { timeout: GEMINI_TIMEOUT_MS },
          },
        });
      } catch (err) {
        // Normalize to HttpError so withRetry can tell 429/5xx from 4xx.
        if (err instanceof ApiError && err.status === 429) {
          const { daily, retryMs } = geminiRateLimit(err);
          if (daily) {
            const message = `Gemini free-tier daily quota for ${model} is used up. Use a key from another Google project, or set GEMINI_MODEL to a different model.`;
            g.__geminiDailyExhausted = { model, message, until: Date.now() + 60 * 60 * 1000 };
            console.error(`[gemini] ${message}`);
            throw new HttpError(message, 429, undefined, false);
          }
          // Per-minute limit: push every queued Gemini call back by Google's suggested delay.
          if (retryMs) g.__geminiNext = Math.max(g.__geminiNext ?? 0, Date.now() + retryMs);
        }
        if (err instanceof ApiError) throw new HttpError(`gemini ${step} -> ${err.status}: ${err.message.slice(0, 200)}`, err.status);
        throw err;
      }
      const u = res.usageMetadata;
      meter.addLlm(model, step, {
        input: u?.promptTokenCount ?? 0,
        output: (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0),
        cacheRead: u?.cachedContentTokenCount ?? 0,
        cacheWrite: 0,
      });
      const text = res.text;
      if (!text) throw new HttpError(`gemini ${step}: empty response (${res.candidates?.[0]?.finishReason ?? "no candidate"})`, 500);
      const parsed = schema.safeParse(JSON.parse(text));
      // Schema drift is rare but possible; treat as retryable.
      if (!parsed.success) throw new HttpError(`gemini ${step}: output failed schema: ${parsed.error.message.slice(0, 200)}`, 500);
      return parsed.data as z.infer<T>;
    },
    3,
    4000,
  );
}
