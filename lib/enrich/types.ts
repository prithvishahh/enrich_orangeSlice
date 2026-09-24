export const FIRMOGRAPHIC_FIELDS = [
  "company_name",
  "one_liner",
  "industry",
  "hq_location",
  "employee_range",
  "funding_stage",
  "last_round",
] as const;

export const PERSONA_FIELDS = ["persona_name", "persona_title", "persona_email", "email_status"] as const;

export type FirmographicField = (typeof FIRMOGRAPHIC_FIELDS)[number];
export type PersonaField = (typeof PERSONA_FIELDS)[number];
export type BuiltinField = FirmographicField | PersonaField;

/** Built-in columns in display order (domain is the input column). */
export const BUILTIN_COLUMNS: readonly ("domain" | BuiltinField)[] = [
  "domain",
  ...FIRMOGRAPHIC_FIELDS,
  ...PERSONA_FIELDS,
];

export type EmailStatus = "verified" | "pattern_guessed" | "not_found";

/** Every filled cell carries its evidence. */
export interface Cell {
  value: string | null;
  source_url: string | null;
  /** 0..1 */
  confidence: number;
  /** Short verbatim quote from the source backing the value. */
  evidence?: string;
}

export interface CustomColumn {
  /** Stable key used as the grid field, e.g. "custom_1". */
  id: string;
  /** Natural-language question, e.g. "Are they hiring SDRs?" */
  prompt: string;
}

export type RowStatus = "queued" | "running" | "done" | "error";

/** Events emitted by the pipeline; the SSE route forwards these verbatim. */
export type EnrichEvent =
  | { type: "row_status"; rowId: string; status: RowStatus; error?: string }
  | { type: "cell"; rowId: string; field: string; cell: Cell }
  | { type: "row_cost"; rowId: string; usage: RowUsage }
  | { type: "log"; rowId: string; message: string };

export interface RowUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  llm_calls: number;
  llm_cost_usd: number;
  scrape_calls: number;
  exa_calls: number;
  hunter_calls: number;
}

/** A source document the LLM is allowed to cite. */
export interface SourceDoc {
  url: string;
  title?: string;
  kind: "scrape" | "search";
  published?: string;
  text: string;
  /** Job-board (ATS) URLs found in the page's raw HTML, which the text conversion drops. */
  links?: string[];
}
