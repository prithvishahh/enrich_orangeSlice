import { cached } from "./cache";
import { fetchJson, HttpError, withRetry } from "./http";
import type { SourceDoc } from "./types";
import type { UsageMeter } from "./usage";

/**
 * Open roles from the big applicant-tracking systems. Their public job-board
 * APIs are free and keyless, and a full role list lets the agent answer hiring
 * questions ("Are they hiring SDRs?") yes *or* no with a citable source —
 * careers pages usually just embed one of these boards via JavaScript.
 */
type Ats = "ashby" | "greenhouse" | "lever";
export interface JobBoard {
  ats: Ats;
  token: string;
}

const LINK_PATTERNS: [Ats, RegExp][] = [
  ["ashby", /jobs\.ashbyhq\.com\/([A-Za-z0-9._%-]+)/g],
  ["greenhouse", /(?:boards|job-boards)\.(?:eu\.)?greenhouse\.io\/(?:embed\/job_board(?:\/js)?\?for=)?([A-Za-z0-9_-]+)/g],
  ["greenhouse", /boards-api\.greenhouse\.io\/v1\/boards\/([A-Za-z0-9_-]+)/g],
  ["lever", /jobs\.(?:eu\.)?lever\.co\/([A-Za-z0-9._-]+)/g],
];
const IGNORED_TOKENS = new Set(["embed", "api", "v1", "jobs", "job_board"]);

/** Find ATS board links in raw HTML or markdown. */
export function findJobBoardLinks(content: string): JobBoard[] {
  const found = new Map<string, JobBoard>();
  for (const [ats, re] of LINK_PATTERNS) {
    for (const m of content.matchAll(re)) {
      const token = decodeURIComponent(m[1]).replace(/[.]+$/, "");
      if (!token || IGNORED_TOKENS.has(token.toLowerCase())) continue;
      found.set(`${ats}:${token.toLowerCase()}`, { ats, token });
    }
  }
  return [...found.values()];
}

interface Role {
  title: string;
  location?: string;
  team?: string;
}

const boardUrl = ({ ats, token }: JobBoard) =>
  ats === "ashby" ? `https://jobs.ashbyhq.com/${token}` : ats === "greenhouse" ? `https://job-boards.greenhouse.io/${token}` : `https://jobs.lever.co/${token}`;

async function fetchRoles({ ats, token }: JobBoard): Promise<Role[]> {
  const t = encodeURIComponent(token);
  if (ats === "ashby") {
    const r = await fetchJson<{ jobs?: { title: string; location?: string; department?: string; team?: string }[] }>(
      `https://api.ashbyhq.com/posting-api/job-board/${t}`,
    );
    return (r.jobs ?? []).map((j) => ({ title: j.title, location: j.location, team: j.department ?? j.team }));
  }
  if (ats === "greenhouse") {
    const r = await fetchJson<{ jobs?: { title: string; location?: { name?: string } }[] }>(`https://boards-api.greenhouse.io/v1/boards/${t}/jobs`);
    return (r.jobs ?? []).map((j) => ({ title: j.title, location: j.location?.name }));
  }
  const r = await fetchJson<{ text: string; categories?: { location?: string; team?: string } }[]>(`https://api.lever.co/v0/postings/${t}?mode=json`);
  return (Array.isArray(r) ? r : []).map((j) => ({ title: j.text, location: j.categories?.location, team: j.categories?.team }));
}

/** One board as a citable source doc, or null if it doesn't exist. Cached per board. */
function jobBoardDoc(board: JobBoard, meter: UsageMeter): Promise<SourceDoc | null> {
  return cached(`jobs:${board.ats}:${board.token.toLowerCase()}`, async () => {
    meter.count("scrape");
    try {
      const roles = await withRetry(`${board.ats} jobs ${board.token}`, () => fetchRoles(board));
      const lines = roles.slice(0, 150).map((r) => `- ${[r.title, r.team, r.location].filter(Boolean).join(" | ")}`);
      return {
        url: boardUrl(board),
        title: `Open roles (${board.ats})`,
        kind: "scrape" as const,
        text:
          `Complete list of currently open roles on this ${board.ats} job board: ${roles.length} total.` +
          (roles.length > 150 ? " (first 150 shown)" : "") +
          `\n${lines.join("\n") || "(no open roles)"}`,
      };
    } catch (err) {
      if (err instanceof HttpError && err.status >= 400 && err.status < 500) return null; // no such board
      throw err;
    }
  });
}

/**
 * Job boards linked from the scraped site, or, if none are linked, a guess
 * from the domain's first label (e.g. posthog.com -> ashby "posthog").
 */
export async function fetchJobBoards(domain: string, site: SourceDoc[], meter: UsageMeter): Promise<SourceDoc[]> {
  let boards = findJobBoardLinks(site.flatMap((d) => d.links ?? []).join("\n") + "\n" + site.map((d) => d.text).join("\n"));
  const guessed = !boards.length;
  if (guessed) {
    const slug = domain.split(".")[0];
    boards = (["ashby", "greenhouse", "lever"] as const).map((ats) => ({ ats, token: slug }));
  }
  const settled = await Promise.allSettled(boards.slice(0, 3).map((b) => jobBoardDoc(b, meter)));
  const docs = settled.flatMap((r) => (r.status === "fulfilled" && r.value ? [r.value] : []));
  // A guessed board with zero roles is more likely a wrong/empty board than a signal.
  return guessed ? docs.filter((d) => !d.text.includes(": 0 total.")) : docs;
}
