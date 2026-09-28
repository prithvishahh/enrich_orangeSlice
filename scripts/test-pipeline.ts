/**
 * Offline test of the pipeline: every external API (Firecrawl / company
 * sites, Exa, Hunter, Anthropic / Gemini) is mocked at the fetch layer.
 * Runs once per mode: TEST_PROVIDER=anthropic (Claude + Firecrawl) or
 * TEST_PROVIDER=gemini (free mode: Gemini + direct HTML fetch). Exercises domain normalization,
 * retries, grounding validation, email building/verification, streaming
 * events, and the scrape cache.
 *
 *   npm run test:pipeline
 */
import assert from "node:assert/strict";

const MODE = process.env.TEST_PROVIDER === "gemini" ? "gemini" : "anthropic";
process.env.ENRICH_DISK_CACHE = "0";
delete process.env.LLM_PROVIDER;
if (MODE === "anthropic") {
  process.env.ANTHROPIC_API_KEY = "test";
  process.env.FIRECRAWL_API_KEY = "test";
} else {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.FIRECRAWL_API_KEY;
  process.env.GEMINI_API_KEY = "test";
  process.env.GEMINI_RPM = "60000";
}
process.env.EXA_API_KEY = "test";
process.env.HUNTER_API_KEY = "test";

const calls: Record<string, number> = {};
let exaFailuresLeft = 1; // first Exa call returns 503 to exercise retry
let geminiDailyQuotaUsedUp = false;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const PAGES: Record<string, string | null> = {
  "https://acme.io": "# Acme\nAcme builds AI forecasting software for B2B revenue teams.\nHeadquartered in Austin, Texas.",
  "https://acme.io/about": "## About\nAcme Inc. was founded in 2019. Today we are a team of about 120 people.",
  "https://acme.io/team": "## Leadership\nJane Doe — Head of Sales\nBob Roe — CEO",
  "https://acme.io/careers": "## Careers\nWe're hiring! See all open roles at https://jobs.ashbyhq.com/acme and join our growing team of builders.",
};

function llmReply(system: string, user: string) {
  const c = (value: unknown, source_url: string | null, evidence: string | null, confidence = 0.9) => ({
    value,
    source_url,
    evidence,
    confidence,
  });
  if (system.includes("firmographics")) {
    return {
      company_name: c("Acme Inc.", "https://acme.io/about", "Acme Inc. was founded in 2019"),
      one_liner: c("AI forecasting software for B2B revenue teams.", "https://acme.io", "Acme builds AI forecasting software for B2B revenue teams"),
      industry: c("Sales software", "https://made-up.example.com/acme", "totally real"), // hallucinated source -> must be dropped
      hq_location: c("Austin, Texas, USA", "https://acme.io", "Headquartered in Austin, Texas"),
      employee_range: c("51-200", "https://acme.io/about", "a team of about 120 people", 0.8),
      funding_stage: c("Series B", "https://news.example.com/acme-series-b", "Acme raises $25M Series B"),
      last_round: c("$25M Series B · Mar 2024", "https://news.example.com/acme-series-b", "paraphrase that is not in the text"),
    };
  }
  if (system.includes("identify a specific person")) {
    assert.ok(user.includes("Acme Inc."), "persona step should receive company name from firmographics");
    return {
      persona_name: c("Jane Doe", "https://acme.io/team", "Jane Doe — Head of Sales"),
      persona_title: c("Head of Sales", "https://acme.io/team", "Jane Doe — Head of Sales"),
      known_email: null,
    };
  }
  if (system.includes("research questions")) {
    return {
      answers: user.includes("https://jobs.ashbyhq.com/acme")
        ? [
            { column_id: "custom_1", value: "Yes: 1 open SDR role (Austin)", source_url: "https://jobs.ashbyhq.com/acme", evidence: "Sales Development Representative | Sales | Austin", confidence: 0.9 },
            { column_id: "custom_2", value: "No SWE interns listed.", source_url: null, evidence: null, confidence: 0.4 },
          ]
        : [],
    };
  }
  throw new Error("unexpected LLM call");
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  const key = `${url.host}${url.pathname}`;
  calls[key] = (calls[key] ?? 0) + 1;

  if (url.host === "api.firecrawl.dev") {
    const md = PAGES[body.url];
    if (md === undefined) return json({ error: "not found" }, 404);
    if (md === null) return json({ success: true, data: { markdown: "Not found", metadata: { statusCode: 404 } } });
    return json({ success: true, data: { markdown: md, metadata: { sourceURL: body.url, statusCode: 200 } } });
  }
  if (url.host === "acme.io") {
    assert.equal(MODE, "gemini", "direct fetch only without Firecrawl key");
    const md = PAGES[`https://acme.io${url.pathname === "/" ? "" : url.pathname}`];
    if (!md) return new Response("not found", { status: 404 });
    const html = `<html><head><title>Acme</title><script>var x=1</script></head><body><nav>Home</nav>${md
      .split("\n")
      .map((l) => `<p>${l.replace(/^#+ /, "").replace(/&/g, "&amp;")}</p>`)
      .join("")}</body></html>`;
    return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if (url.host === "generativelanguage.googleapis.com") {
    if (url.pathname.includes("gemini-busy")) {
      return json({ error: { code: 503, status: "UNAVAILABLE", message: "This model is currently experiencing high demand." } }, 503);
    }
    if (url.pathname.includes("gemini-retired")) {
      return json({ error: { code: 404, status: "NOT_FOUND", message: "This model models/gemini-retired is no longer available to new users." } }, 404);
    }
    if (geminiDailyQuotaUsedUp) {
      return json(
        {
          error: {
            code: 429,
            status: "RESOURCE_EXHAUSTED",
            message: "You exceeded your current quota. Quota exceeded for metric: generate_content_free_tier_requests, quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier. Please retry in 41.2s.",
          },
        },
        429,
      );
    }
    const raw = JSON.stringify(body);
    assert.ok(raw.includes("responseJsonSchema"), "should request JSON schema output");
    const out = llmReply(raw, raw);
    return json({
      candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify(out) }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 3000, candidatesTokenCount: 400, totalTokenCount: 3400 },
    });
  }
  if (url.host === "api.exa.ai") {
    if (exaFailuresLeft-- > 0) return json({ error: "unavailable" }, 503);
    if (body.query.includes("funding")) {
      return json({
        results: [
          { url: "https://news.example.com/acme-series-b", title: "Acme raises $25M", publishedDate: "2024-03-12", text: "Acme raises $25M Series B led by Example Ventures." },
        ],
      });
    }
    return json({ results: [] });
  }
  if (url.host === "api.hunter.io") {
    if (url.pathname.endsWith("/domain-search")) return json({ data: { pattern: "{first}.{last}", organization: "Acme", emails: [] } });
    if (url.pathname.endsWith("/email-verifier")) {
      return json({ data: { status: url.searchParams.get("email") === "jane.doe@acme.io" ? "valid" : "unknown" } });
    }
  }
  if (url.host === "api.ashbyhq.com") {
    assert.equal(url.pathname, "/posting-api/job-board/acme");
    return json({ jobs: [{ title: "Sales Development Representative", department: "Sales", location: "Austin" }, { title: "Senior Engineer", department: "Engineering", location: "Remote" }] });
  }
  if (url.host === "api.anthropic.com") {
    const system = typeof body.system === "string" ? body.system : JSON.stringify(body.system);
    assert.equal(body.model, "claude-sonnet-5");
    assert.ok(body.output_config?.format?.type === "json_schema", "should request structured output");
    const out = llmReply(system, body.messages[0].content);
    return json({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: body.model,
      content: [{ type: "text", text: JSON.stringify(out) }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 3000, output_tokens: 400, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });
  }
  throw new Error(`unmocked fetch: ${url}`);
}) as typeof fetch;

async function main() {
  const { normalizeDomain, parseDomainList } = await import("../lib/enrich/domain");
  const { buildEmailFromPattern, splitName } = await import("../lib/enrich/hunter");
  const { enrichDomain } = await import("../lib/enrich/pipeline");

  // --- unit checks ---
  assert.equal(normalizeDomain("https://www.Stripe.com/about?x=1"), "stripe.com");
  assert.equal(normalizeDomain("  http://linear.app/  "), "linear.app");
  assert.equal(normalizeDomain("ramp.com:443/path"), "ramp.com");
  assert.equal(normalizeDomain("not a domain"), null);
  assert.equal(normalizeDomain("192.168.0.1"), null);
  assert.deepEqual(parseDomainList("stripe.com\nhttps://www.stripe.com\nramp.com, linear.app\n\n"), ["stripe.com", "ramp.com", "linear.app"]);
  assert.equal(buildEmailFromPattern("{first}.{last}", "José", "O'Brien", "x.com"), "jose.obrien@x.com");
  assert.equal(buildEmailFromPattern("{f}{last}", "Jane", "Doe", "x.com"), "jdoe@x.com");
  assert.equal(buildEmailFromPattern("{first}", "", "Doe", "x.com"), null);
  const { findJobBoardLinks } = await import("../lib/enrich/jobs");
  assert.deepEqual(
    findJobBoardLinks('<a href="https://jobs.ashbyhq.com/posthog/abc">x</a> <script src="https://boards.greenhouse.io/embed/job_board/js?for=vanta"></script> https://jobs.lever.co/zapier'),
    [
      { ats: "ashby", token: "posthog" },
      { ats: "greenhouse", token: "vanta" },
      { ats: "lever", token: "zapier" },
    ],
  );
  assert.deepEqual(splitName("Dr. Jane Q. Doe"), { first: "Jane", last: "Doe" });
  assert.equal(splitName("Cher"), null);

  // --- full pipeline, mocked ---
  const run = async () => {
    const cells: Record<string, { value: string | null; source_url: string | null; confidence: number }> = {};
    const statuses: string[] = [];
    let usage: { scrape_calls: number; exa_calls: number; llm_calls: number; llm_cost_usd: number } | undefined;
    await enrichDomain(
      "r1",
      "https://www.acme.io/pricing",
      { persona: "Head of Sales", customColumns: [
          { id: "custom_1", prompt: "Are they hiring SDRs?" },
          { id: "custom_2", prompt: "Are they hiring SWE interns?" },
        ],
      },
      (e) => {
        if (e.type === "cell") cells[e.field] = e.cell;
        if (e.type === "row_status") statuses.push(e.status + (e.error ? `:${e.error}` : ""));
        if (e.type === "row_cost") usage = e.usage;
      },
    );
    return { cells, statuses, usage: usage! };
  };

  const first = await run();
  assert.deepEqual(first.statuses, ["running", "done"]);
  const c = first.cells;
  assert.equal(c.company_name.value, "Acme Inc.");
  assert.equal(c.company_name.source_url, "https://acme.io/about");
  assert.equal(c.industry.value, null, "value citing an unknown URL must be dropped");
  assert.equal(c.last_round.value, "$25M Series B · Mar 2024");
  assert.ok(c.last_round.confidence < 0.9, "unverifiable evidence quote should lower confidence");
  assert.equal(c.persona_name.value, "Jane Doe");
  assert.equal(c.persona_email.value, "jane.doe@acme.io");
  assert.equal(c.email_status.value, "verified");
  assert.equal(c.custom_1.value, "Yes: 1 open SDR role (Austin)", "hiring answer should come from the linked job board");
  assert.equal(c.custom_1.source_url, "https://jobs.ashbyhq.com/acme");
  assert.equal(c.custom_2.value, null, "custom answer without source must be null");
  for (const [field, cell] of Object.entries(c)) {
    if (cell.value !== null) assert.ok(cell.source_url, `${field} has a value but no source_url`);
  }
  assert.equal(calls["api.exa.ai/search"], 4 + 2 + 1, "4 Exa queries + 1 per custom column + 1 retried 503");
  assert.equal(calls["api.ashbyhq.com/posting-api/job-board/acme"], 1, "linked Ashby board fetched once");
  if (MODE === "anthropic") assert.ok(first.usage.llm_cost_usd > 0);
  else assert.equal(first.usage.llm_cost_usd, 0, "Gemini free tier costs $0");

  // Re-run: scrape + search served from cache.
  const second = await run();
  assert.equal(second.usage.scrape_calls, 0, "scrapes should be cached");
  assert.equal(second.usage.exa_calls, 0, "searches should be cached");
  assert.equal(second.usage.llm_calls, 0, "LLM results should be cached");
  assert.equal(second.cells.persona_email.value, "jane.doe@acme.io");

  // Invalid input surfaces as a row error.
  const errs: string[] = [];
  await enrichDomain("r2", "not a domain", { persona: "Head of Sales" }, (e) => {
    if (e.type === "row_status") errs.push(e.status);
  });
  assert.deepEqual(errs, ["error"]);

  if (MODE === "gemini") {
    const { clearCache } = await import("../lib/enrich/cache");
    const geminiCalls = (m: string) => calls[`generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`] ?? 0;

    // Switching models reuses results saved under any model in the list: no new calls.
    process.env.GEMINI_MODEL = "gemini-retired, gemini-flash-latest";
    const reused = await run();
    assert.equal(reused.usage.llm_calls, 0, "cached results from the fallback model should be reused");
    assert.equal(geminiCalls("gemini-retired"), 0);
    assert.equal(reused.cells.company_name.value, "Acme Inc.");

    // Overloaded first model (503): falls back to the next model and succeeds.
    clearCache("llm:");
    process.env.GEMINI_MODEL = "gemini-busy,gemini-flash-latest";
    const fallback = await run();
    delete process.env.GEMINI_MODEL;
    assert.deepEqual(fallback.statuses, ["running", "done"]);
    assert.equal(fallback.cells.company_name.value, "Acme Inc.");
    assert.equal(geminiCalls("gemini-busy"), 3 * 2, "each of 3 steps tries the busy model twice before falling back");

    // Used-up daily quota: the row fails fast with a clear message instead of retrying for minutes.
    clearCache("llm:");
    geminiDailyQuotaUsedUp = true;
    const before = calls["generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent"] ?? 0;
    const t0 = Date.now();
    let error = "";
    await enrichDomain("r3", "acme.io", { persona: "Head of Sales" }, (e) => {
      if (e.type === "row_status" && e.error) error = e.error;
    });
    assert.ok(Date.now() - t0 < 3000, `quota error should fail fast (took ${Date.now() - t0}ms)`);
    assert.match(error, /daily quota/);
    const after = calls["generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent"] ?? 0;
    assert.equal(after - before, 1, "only one request should hit Google once the daily quota is known to be used up");

    // Retired model (404): not retried, fails fast with Google's message.
    geminiDailyQuotaUsedUp = false;
    process.env.GEMINI_MODEL = "gemini-retired";
    const t1 = Date.now();
    let error404 = "";
    await enrichDomain("r4", "acme.io", { persona: "Head of Sales" }, (e) => {
      if (e.type === "row_status" && e.error) error404 = e.error;
    });
    delete process.env.GEMINI_MODEL;
    assert.ok(Date.now() - t1 < 3000, `404 should not be retried (took ${Date.now() - t1}ms)`);
    assert.match(error404, /404.*no longer available/);
    assert.equal(calls["generativelanguage.googleapis.com/v1beta/models/gemini-retired:generateContent"], 2, "firmographics + persona, one request each");
  }

  console.log(`\n✅ pipeline tests passed (${MODE})`);
}

main().catch((err) => {
  console.error("\n❌", err);
  process.exit(1);
});
