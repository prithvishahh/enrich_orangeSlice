import { z } from "zod";
import { enrichMany } from "@/lib/enrich/pipeline";
import { activeModel, activeProvider } from "@/lib/enrich/providers";
import type { EnrichEvent } from "@/lib/enrich/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const Body = z.object({
  rows: z.array(z.object({ rowId: z.string().max(64), domain: z.string().max(300) })).min(1).max(200),
  persona: z.string().trim().min(1).max(120).default("Head of Sales"),
  customColumns: z
    .array(z.object({ id: z.string().regex(/^custom_\d+$/), prompt: z.string().trim().min(1).max(500) }))
    .max(10)
    .default([]),
});

/** Which backends are configured — shown in the top bar. */
export async function GET() {
  let provider: string | null = null;
  let model: string | null = null;
  try {
    provider = activeProvider();
    model = activeModel();
  } catch {
    /* no LLM key */
  }
  return Response.json({
    provider,
    model,
    keys: {
      llm: !!provider,
      exa: !!process.env.EXA_API_KEY,
      hunter: !!process.env.HUNTER_API_KEY,
      firecrawl: !!process.env.FIRECRAWL_API_KEY,
    },
  });
}

/**
 * Run the pipeline and stream events as Server-Sent Events.
 * POST (not GET/EventSource) because the request carries rows + columns;
 * the response body is standard `text/event-stream`.
 */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.message }, { status: 400 });
  const { rows, persona, customColumns } = parsed.data;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let open = true;
      const write = (chunk: string) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          open = false; // client went away
        }
      };
      const send = (e: EnrichEvent | { type: "done" } | { type: "fatal"; error: string }) => write(`data: ${JSON.stringify(e)}\n\n`);
      const ping = setInterval(() => write(": ping\n\n"), 15_000);
      req.signal.addEventListener("abort", () => (open = false));

      try {
        activeProvider(); // fail fast with a clear message if no LLM key
        await enrichMany(rows, { persona, customColumns }, send, undefined, req.signal);
        send({ type: "done" });
      } catch (err) {
        send({ type: "fatal", error: (err as Error).message });
      } finally {
        clearInterval(ping);
        if (open) controller.close();
        open = false;
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
