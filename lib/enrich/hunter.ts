import { cached } from "./cache";
import { fetchJson, requireEnv, withRetry } from "./http";
import type { UsageMeter } from "./usage";

const BASE = "https://api.hunter.io/v2";

export interface HunterEmail {
  value: string;
  first_name: string | null;
  last_name: string | null;
  position: string | null;
  confidence: number | null;
  sources?: { uri: string }[];
}

export interface HunterDomainResult {
  pattern: string | null;
  organization: string | null;
  emails: HunterEmail[];
}

export type HunterVerifyStatus = "valid" | "invalid" | "accept_all" | "webmail" | "disposable" | "unknown";

/** Public page for a domain on Hunter — used as the source link for pattern-derived emails. */
export const hunterDomainUrl = (domain: string) => `https://hunter.io/search/${domain}`;

/** Domain search: email pattern + known emails. Cached per domain. */
export function hunterDomainSearch(domain: string, meter: UsageMeter): Promise<HunterDomainResult> {
  return cached(`hunter:domain:${domain}`, async () => {
    meter.count("hunter");
    const url = `${BASE}/domain-search?domain=${encodeURIComponent(domain)}&limit=10&api_key=${requireEnv("HUNTER_API_KEY")}`;
    const res = await withRetry(`hunter domain-search ${domain}`, () =>
      fetchJson<{ data: Partial<HunterDomainResult> }>(url),
    );
    return {
      pattern: res.data.pattern ?? null,
      organization: res.data.organization ?? null,
      emails: res.data.emails ?? [],
    };
  });
}

/** Verify a single address. Cached per email. */
export function hunterVerify(email: string, meter: UsageMeter): Promise<HunterVerifyStatus> {
  return cached(`hunter:verify:${email}`, async () => {
    meter.count("hunter");
    const url = `${BASE}/email-verifier?email=${encodeURIComponent(email)}&api_key=${requireEnv("HUNTER_API_KEY")}`;
    const res = await withRetry(`hunter verify ${email}`, () =>
      fetchJson<{ data?: { status?: HunterVerifyStatus } }>(url, { timeoutMs: 60_000 }),
    );
    // 202 responses (verification still running) come back without a status.
    return res.data?.status ?? "unknown";
  });
}

function slug(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

/**
 * Fill a Hunter pattern such as "{first}.{last}" or "{f}{last}".
 * Returns null when the pattern needs a part we don't have.
 */
export function buildEmailFromPattern(pattern: string, first: string, last: string, domain: string): string | null {
  const f = slug(first);
  const l = slug(last);
  const parts: Record<string, string> = { first: f, last: l, f: f[0] ?? "", l: l[0] ?? "" };
  let missing = false;
  const local = pattern.replace(/\{(first|last|f|l)\}/g, (_, k: string) => {
    if (!parts[k]) missing = true;
    return parts[k];
  });
  if (missing || !local || /[{}]/.test(local)) return null;
  return `${local}@${domain}`;
}

/** Split "Jane Q. Doe-Smith" into first / last for pattern filling. */
export function splitName(full: string): { first: string; last: string } | null {
  const parts = full
    .replace(/\(.*?\)|,.*$/g, "")
    .trim()
    .split(/\s+/)
    .filter((p) => !/^(dr|mr|mrs|ms|jr|sr|ii|iii|phd|mba)\.?$/i.test(p));
  if (parts.length < 2) return null;
  return { first: parts[0], last: parts[parts.length - 1] };
}
