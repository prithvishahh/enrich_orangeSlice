import { z } from "zod";
import { callStructured } from "./providers";
import type { Cell, CustomColumn, FirmographicField, SourceDoc } from "./types";
import type { UsageMeter } from "./usage";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const cellSchema = (valueDesc: string, value: z.ZodType<string | null> = z.string().nullable()) =>
  z
    .object({
      value: value.describe(valueDesc),
      source_url: z.string().nullable().describe("Exact URL of the <source> that supports the value. null iff value is null."),
      evidence: z.string().nullable().describe("Short verbatim quote (<= 200 chars) from that source supporting the value."),
      confidence: z.number().describe("0.0-1.0: how directly the source states this value."),
    })
    .describe(valueDesc);

export const EMPLOYEE_RANGES = ["1-10", "11-50", "51-200", "201-500", "501-1000", "1001-5000", "5001-10000", "10001+"] as const;
export const FUNDING_STAGES = [
  "Bootstrapped",
  "Pre-seed",
  "Seed",
  "Series A",
  "Series B",
  "Series C",
  "Series D+",
  "Private Equity",
  "Public",
  "Acquired",
] as const;

const FirmographicsSchema = z.object({
  company_name: cellSchema("Official company name as the company writes it."),
  one_liner: cellSchema("One sentence (<= 20 words) on what the company sells and to whom, paraphrased from the source."),
  industry: cellSchema("Concise industry / category, e.g. 'Developer tools', 'Fintech - payments', 'HR software'."),
  hq_location: cellSchema("Headquarters as 'City, Region/State, Country' (omit unknown parts)."),
  employee_range: cellSchema("Headcount bucket.", z.enum(EMPLOYEE_RANGES).nullable()),
  funding_stage: cellSchema("Latest known funding stage.", z.enum(FUNDING_STAGES).nullable()),
  last_round: cellSchema("Most recent round as '<amount> <round> · <Mon YYYY>', e.g. '$25M Series B · Mar 2024'."),
});

const PersonaSchema = z.object({
  persona_name: cellSchema("Full name of the person currently in the target role (or the closest match) at THIS company."),
  persona_title: cellSchema("That person's current title, as written in the source."),
  known_email: z
    .string()
    .nullable()
    .describe("If the Hunter source lists this exact person's email, copy it here; otherwise null."),
});

const CustomSchema = z.object({
  answers: z.array(
    z.object({
      column_id: z.string(),
      value: z.string().nullable().describe("Short direct answer (<= 25 words). null if the sources don't support an answer."),
      source_url: z.string().nullable(),
      evidence: z.string().nullable(),
      confidence: z.number(),
    }),
  ),
});

// ---------------------------------------------------------------------------
// Prompting helpers
// ---------------------------------------------------------------------------

const GROUNDING_RULES = `Rules:
- Use ONLY the <source> documents provided. Do not use prior knowledge about the company.
- Every non-null value MUST have source_url set to the exact url attribute of the <source> that states it, plus a short verbatim evidence quote from that source.
- If no source supports a field, return value=null, source_url=null, evidence=null, confidence=0. Do not guess, estimate or infer from vibes. A null is better than an unsupported value.
- Be careful of sources about a different company with a similar name; check the domain.
- Confidence: 0.9+ when the source states it explicitly and is the company itself or a reputable outlet; 0.6-0.8 when stated but indirect or possibly stale; below 0.5 when weakly supported.`;

function renderSources(docs: SourceDoc[]): string {
  return docs
    .map((d) => {
      const attrs = [`url="${d.url}"`, `kind="${d.kind}"`, d.title ? `title="${d.title.replace(/"/g, "'")}"` : "", d.published ? `published="${d.published}"` : ""]
        .filter(Boolean)
        .join(" ");
      return `<source ${attrs}>\n${d.text}\n</source>`;
    })
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// Grounding validation — enforce "every value has a real source"
// ---------------------------------------------------------------------------

const urlKey = (u: string) =>
  u.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[#?].*$/, "").replace(/\/+$/, "");

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9$%]+/g, " ").trim();

interface RawCell {
  value: string | null;
  source_url: string | null;
  evidence: string | null;
  confidence: number;
}

/**
 * Drop any value whose source_url isn't one of the documents we supplied, and
 * down-weight values whose evidence quote can't be found in that document.
 */
export function groundCell(raw: RawCell, docs: SourceDoc[]): Cell {
  const empty: Cell = { value: null, source_url: null, confidence: 0 };
  const value = raw.value?.trim();
  if (!value || !raw.source_url) return empty;
  const doc = docs.find((d) => urlKey(d.url) === urlKey(raw.source_url!));
  if (!doc) return empty;
  let confidence = Math.max(0, Math.min(1, raw.confidence));
  const quote = raw.evidence ? squash(raw.evidence) : "";
  if (!quote || !squash(doc.text).includes(quote.slice(0, 80))) confidence *= 0.6;
  return {
    value,
    source_url: doc.url,
    confidence: Math.round(confidence * 100) / 100,
    ...(raw.evidence ? { evidence: raw.evidence } : {}),
  };
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

export async function extractFirmographics(
  domain: string,
  docs: SourceDoc[],
  meter: UsageMeter,
): Promise<Record<FirmographicField, Cell>> {
  const system = `You extract B2B firmographics for sales research. Return strict JSON matching the schema.\n\n${GROUNDING_RULES}`;
  const user = `Company domain: ${domain}\n\n${renderSources(docs)}\n\nExtract the firmographic fields for the company at ${domain}.`;
  const out = await callStructured("firmographics", FirmographicsSchema, system, user, meter);
  return Object.fromEntries(Object.entries(out).map(([k, raw]) => [k, groundCell(raw, docs)])) as Record<FirmographicField, Cell>;
}

export async function identifyPersona(
  domain: string,
  company: string | null,
  persona: string,
  docs: SourceDoc[],
  meter: UsageMeter,
): Promise<{ persona_name: Cell; persona_title: Cell; known_email: string | null }> {
  const system = `You identify a specific person at a company for sales outreach. Return strict JSON matching the schema.\n\n${GROUNDING_RULES}
- The person must currently work at the company at ${domain}. Ignore former employees and people at other companies.
- Prefer the exact target role; otherwise the closest senior person in the same function (e.g. VP Sales for "Head of Sales"). Lower confidence for a near match.`;
  const user = `Company: ${company ?? "(unknown name)"} — domain ${domain}\nTarget persona: ${persona}\n\n${renderSources(docs)}\n\nWho is the ${persona} at ${company ?? domain}?`;
  const out = await callStructured("persona", PersonaSchema, system, user, meter);
  return {
    persona_name: groundCell(out.persona_name, docs),
    persona_title: groundCell(out.persona_title, docs),
    known_email: out.known_email,
  };
}

export async function answerCustomColumns(
  domain: string,
  columns: CustomColumn[],
  docs: SourceDoc[],
  meter: UsageMeter,
): Promise<Record<string, Cell>> {
  if (!columns.length) return {};
  const system = `You answer research questions about a company for sales teams. Return strict JSON matching the schema, one answer per column_id.\n\n${GROUNDING_RULES}
- Lead with a direct answer, then the specifics that back it, e.g. "Yes: 2 open SDR roles (NYC, Remote)".
- A "No" also needs a source. You may answer "No" when a source is a complete listing that would show it (e.g. a job board listing all open roles: "No: 14 open roles, none in sales development"). Absence from an unrelated page is not evidence; return null instead.`;
  const questions = columns.map((c) => `- column_id="${c.id}": ${c.prompt}`).join("\n");
  const user = `Company domain: ${domain}\n\n${renderSources(docs)}\n\nAnswer each question about the company at ${domain}:\n${questions}`;
  const out = await callStructured("custom_columns", CustomSchema, system, user, meter);
  const result: Record<string, Cell> = {};
  for (const c of columns) {
    const a = out.answers.find((x) => x.column_id === c.id);
    result[c.id] = a ? groundCell(a, docs) : { value: null, source_url: null, confidence: 0 };
  }
  return result;
}
