import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { cached, peekCached, remember } from "./cache";
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

/**
 * GEMINI_MODEL may be a comma-separated list, tried in order: when a model is
 * overloaded (503), retired (404) or out of quota, calls fall through to the next.
 */
export function geminiModels(): string[] {
  const list = (process.env.GEMINI_MODEL ?? "").split(",").map((m) => m.trim()).filter(Boolean);
  return list.length ? list : ["gemini-flash-latest"];
}

export function activeModel(provider = activeProvider()): string {
  return provider === "anthropic" ? (process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5") : geminiModels().join(", ");
}

const g = globalThis as unknown as {
  __anthropic?: Anthropic;
  __gemini?: GoogleGenAI;
  __geminiNext?: number;
  /** Set when Google reports the free-tier daily quota is used up; later calls fail fast. */
  __geminiDailyExhausted?: Record<string, { message: string; until: number }>;
};

const GEMINI_TIMEOUT_MS = 60_000;

/** Classify a Gemini 429: a daily quota won't clear by retrying; a per-minute one says how long to wait. */
/**
 * HTTP status of a Gemini SDK error. Duck-typed rather than `instanceof ApiError`,
 * because Next.js can bundle a second copy of the SDK's error class.
 */
function geminiStatus(err: unknown): number | undefined {
  const status = (err as { status?: unknown })?.status;
  if (typeof status === "number") return status;
  const code = String((err as Error)?.message ?? "").match(/"code":\s*(\d{3})/)?.[1];
  return code ? Number(code) : undefined;
}

function geminiRateLimit(msg: string): { daily: boolean; retryMs: number } {
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
  const hash = createHash("sha256").update(system).update("\0").update(user).digest("hex");
  const keyFor = (model: string) => `llm:${model}:${step}:${hash}`;

  if (provider === "anthropic") {
    const model = activeModel(provider);
    return cached(keyFor(model), () => callAnthropic(model, step, schema, system, user, meter)) as Promise<z.infer<T>>;
  }

  return (async () => {
    const models = geminiModels();
    // Reuse a result from any configured model, so switching models keeps finished work.
    for (const m of models) {
      const hit = peekCached<z.infer<T>>(keyFor(m));
      if (hit) return hit;
    }
    let lastErr: unknown;
    for (const [i, model] of models.entries()) {
      const hasFallback = i < models.length - 1;
      // Skip a model whose daily quota is already known to be used up (logged once when detected).
      const exhausted = g.__geminiDailyExhausted?.[model];
      if (hasFallback && exhausted && exhausted.until > Date.now()) continue;
      try {
        const data = await callGemini(model, step, schema, system, user, meter, hasFallback ? 1 : 3, hasFallback ? 1500 : 4000);
        remember(keyFor(model), data);
        return data;
      } catch (err) {
        lastErr = err;
        if (hasFallback) console.warn(`[gemini] ${model} failed for ${step} (${(err as Error).message.slice(0, 120)}); falling back to ${models[i + 1]}`);
      }
    }
    throw lastErr;
  })();
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
  retries: number,
  backoffMs: number,
): Promise<z.infer<T>> {
  const client = (g.__gemini ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }));
  const responseJsonSchema = toGeminiSchema(schema);

  // Free-tier 429/503s are common: retry with long backoff (4s, 8s, 16s), fewer when a fallback model exists.
  return withRetry(
    `gemini ${step}`,
    async () => {
      const exhausted = g.__geminiDailyExhausted?.[model];
      if (exhausted && exhausted.until > Date.now()) throw new HttpError(exhausted.message, 429, undefined, false);
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
        const status = geminiStatus(err);
        const fullMessage = String((err as Error)?.message ?? err);
        const detail = fullMessage.slice(0, 300);
        if (status === 429) {
          const { daily, retryMs } = geminiRateLimit(fullMessage);
          if (daily) {
            const message = `Gemini free-tier daily quota for ${model} is used up. Use a key from another Google project, or add another model to GEMINI_MODEL.`;
            (g.__geminiDailyExhausted ??= {})[model] = { message, until: Date.now() + 60 * 60 * 1000 };
            console.error(`[gemini] ${message}`);
            throw new HttpError(message, 429, undefined, false);
          }
          // Per-minute limit: push every queued Gemini call back by Google's suggested delay.
          if (retryMs) g.__geminiNext = Math.max(g.__geminiNext ?? 0, Date.now() + retryMs);
        }
        if (status) throw new HttpError(`gemini ${step} -> ${status}: ${detail}`, status);
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
    retries,
    backoffMs,
  );
}
