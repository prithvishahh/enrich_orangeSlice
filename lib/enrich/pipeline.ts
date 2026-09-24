import { normalizeDomain } from "./domain";
import { scrapeCompanySite } from "./firecrawl";
import { searchFirmographics, searchPersona } from "./exa";
import {
  buildEmailFromPattern,
  hunterDomainSearch,
  hunterDomainUrl,
  hunterVerify,
  splitName,
  type HunterDomainResult,
} from "./hunter";
import { answerCustomColumns, extractFirmographics, identifyPersona } from "./llm";
import type { Cell, CustomColumn, EmailStatus, EnrichEvent, SourceDoc } from "./types";
import { UsageMeter } from "./usage";

export interface EnrichOptions {
  persona: string;
  customColumns?: CustomColumn[];
}

export type Emit = (e: EnrichEvent) => void;

const EMPTY: Cell = { value: null, source_url: null, confidence: 0 };

/** Render Hunter's known emails as a citable source for the persona step. */
function hunterAsSource(domain: string, h: HunterDomainResult): SourceDoc | null {
  if (!h.emails.length) return null;
  const lines = h.emails.map(
    (e) => `- ${[e.first_name, e.last_name].filter(Boolean).join(" ") || "(no name)"} | ${e.position ?? "(no title)"} | ${e.value}`,
  );
  return {
    url: hunterDomainUrl(domain),
    title: `Hunter.io people at ${domain}`,
    kind: "search",
    text: `Email pattern: ${h.pattern ?? "unknown"}\nKnown people and emails at ${domain}:\n${lines.join("\n")}`,
  };
}

/**
 * Enrich a single domain. Emits `cell` events as each field resolves so the
 * UI can stream them in. Never throws; failures surface as a row `error`.
 */
export async function enrichDomain(rowId: string, rawDomain: string, opts: EnrichOptions, emit: Emit): Promise<void> {
  const domain = normalizeDomain(rawDomain);
  if (!domain) {
    emit({ type: "row_status", rowId, status: "error", error: `Invalid domain: "${rawDomain}"` });
    return;
  }
  const meter = new UsageMeter(domain);
  const errors: string[] = [];
  const log = (message: string) => emit({ type: "log", rowId, message });
  const cell = (field: string, c: Cell) => emit({ type: "cell", rowId, field, cell: c });
  const fail = (step: string, err: unknown) => {
    const msg = `${step}: ${(err as Error).message}`;
    console.error(`[enrich] ${domain} ${msg}`);
    errors.push(msg);
  };

  emit({ type: "row_status", rowId, status: "running" });
  const started = Date.now();

  try {
    // 1 + 2 (+ Hunter domain search, needed later): all independent, run in parallel.
    const hunterP = hunterDomainSearch(domain, meter).catch((err) => {
      fail("hunter", err);
      return null;
    });
    const [site, search] = await Promise.all([
      scrapeCompanySite(domain, meter).catch((err) => {
        fail("scrape", err);
        return [] as SourceDoc[];
      }),
      searchFirmographics(domain, meter),
    ]);
    log(`scraped ${site.length} pages, ${search.length} search results`);
    const docs = [...site, ...search];
    if (!docs.length) throw new Error(errors[0] ?? "no sources found for domain");

    // 3. Firmographics and custom columns in parallel (same context).
    const firmoP = extractFirmographics(domain, docs, meter).then((fields) => {
      for (const [k, v] of Object.entries(fields)) cell(k, v);
      return fields;
    });
    const customP = answerCustomColumns(domain, opts.customColumns ?? [], docs, meter)
      .then((answers) => {
        for (const [k, v] of Object.entries(answers)) cell(k, v);
      })
      .catch((err) => fail("custom columns", err));

    // 4. Persona needs the company name for a good search.
    const personaP = firmoP
      .catch((err) => {
        fail("firmographics", err);
        return null;
      })
      .then((firmo) => runPersona(domain, firmo?.company_name.value ?? null, opts.persona, site, hunterP, meter, cell))
      .catch((err) => {
        fail("persona", err);
        for (const f of ["persona_name", "persona_title", "persona_email"]) cell(f, EMPTY);
        cell("email_status", { value: "not_found", source_url: null, confidence: 0 });
      });

    await Promise.all([personaP, customP]);
  } catch (err) {
    fail("pipeline", err);
  }

  meter.logSummary();
  console.log(`[enrich] ${domain} finished in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  emit({ type: "row_cost", rowId, usage: meter.usage });
  emit(
    errors.length
      ? { type: "row_status", rowId, status: "error", error: errors.join("; ") }
      : { type: "row_status", rowId, status: "done" },
  );
}

async function runPersona(
  domain: string,
  company: string | null,
  persona: string,
  site: SourceDoc[],
  hunterP: Promise<HunterDomainResult | null>,
  meter: UsageMeter,
  cell: (field: string, c: Cell) => void,
) {
  const [people, hunter] = await Promise.all([searchPersona(domain, company, persona, meter), hunterP]);
  const hunterDoc = hunter ? hunterAsSource(domain, hunter) : null;
  const docs = [...people, ...site, ...(hunterDoc ? [hunterDoc] : [])];

  const found = await identifyPersona(domain, company, persona, docs, meter);
  cell("persona_name", found.persona_name);
  cell("persona_title", found.persona_title);

  const { email, status } = await resolveEmail(domain, found.persona_name, found.known_email, hunter, meter);
  cell("persona_email", email);
  cell("email_status", status);
}

async function resolveEmail(
  domain: string,
  name: Cell,
  knownEmail: string | null,
  hunter: HunterDomainResult | null,
  meter: UsageMeter,
): Promise<{ email: Cell; status: Cell }> {
  const notFound = { email: EMPTY, status: { value: "not_found" satisfies EmailStatus, source_url: null, confidence: 0 } };
  if (!name.value || !hunter) return notFound;

  // Candidate A: Hunter already indexes this exact person's address.
  const known = knownEmail
    ? hunter.emails.find((e) => e.value.toLowerCase() === knownEmail.toLowerCase())
    : undefined;
  let candidate: string | null = known?.value ?? null;
  let source = known?.sources?.[0]?.uri ?? hunterDomainUrl(domain);

  // Candidate B: build from the domain's pattern.
  if (!candidate && hunter.pattern) {
    const parts = splitName(name.value);
    if (parts) candidate = buildEmailFromPattern(hunter.pattern, parts.first, parts.last, domain);
    source = hunterDomainUrl(domain);
  }
  if (!candidate) return notFound;

  let verdict: string;
  try {
    verdict = await hunterVerify(candidate, meter);
  } catch (err) {
    console.warn(`[hunter] verify ${candidate} failed: ${(err as Error).message}`);
    verdict = "unknown";
  }

  let status: EmailStatus;
  let confidence: number;
  if (verdict === "valid") {
    status = "verified";
    confidence = 0.95;
  } else if (verdict === "invalid") {
    return notFound; // Hunter says the mailbox doesn't exist.
  } else {
    status = "pattern_guessed";
    confidence = known ? Math.min(0.85, (known.confidence ?? 50) / 100) : 0.5;
  }
  confidence = Math.round(confidence * Math.max(name.confidence, 0.5) * 100) / 100;
  return {
    email: { value: candidate, source_url: source, confidence },
    status: { value: status, source_url: hunterDomainUrl(domain), confidence },
  };
}

/** Run many rows with bounded concurrency (default 5). */
export async function enrichMany(
  rows: { rowId: string; domain: string }[],
  opts: EnrichOptions,
  emit: Emit,
  concurrency = Number(process.env.ENRICH_CONCURRENCY ?? 5),
  signal?: AbortSignal,
): Promise<void> {
  for (const r of rows) emit({ type: "row_status", rowId: r.rowId, status: "queued" });
  const queue = [...rows];
  const worker = async () => {
    while (queue.length && !signal?.aborted) {
      const r = queue.shift()!;
      await enrichDomain(r.rowId, r.domain, opts, emit);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));
}
