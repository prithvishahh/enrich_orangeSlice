/**
 * Standalone pipeline test for one domain.
 *
 *   npm run enrich -- stripe.com
 *   npm run enrich -- https://www.linear.app/about --persona "VP Marketing" --ask "Are they hiring SDRs?"
 *   npm run enrich -- ramp.com --json
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { enrichDomain } from "../lib/enrich/pipeline";
import { BUILTIN_COLUMNS, type Cell, type CustomColumn, type EnrichEvent } from "../lib/enrich/types";

function parseArgs(argv: string[]) {
  let domain: string | undefined;
  let persona = "Head of Sales";
  let json = false;
  const asks: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--persona") persona = argv[++i];
    else if (a === "--ask") asks.push(argv[++i]);
    else if (a === "--json") json = true;
    else if (!a.startsWith("--")) domain = a;
  }
  if (!domain) {
    console.error('Usage: npm run enrich -- <domain> [--persona "Head of Sales"] [--ask "question"]... [--json]');
    process.exit(1);
  }
  const customColumns: CustomColumn[] = asks.map((prompt, i) => ({ id: `custom_${i + 1}`, prompt }));
  return { domain, persona, json, customColumns };
}

async function main() {
  const { domain, persona, json, customColumns } = parseArgs(process.argv.slice(2));
  const cells: Record<string, Cell> = {};
  const events: EnrichEvent[] = [];
  const t0 = Date.now();
  const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`.padStart(7);

  await enrichDomain("row_1", domain, { persona, customColumns }, (e) => {
    events.push(e);
    if (e.type === "cell") {
      cells[e.field] = e.cell;
      const v = e.cell.value ?? "∅";
      console.log(`${ts()}  ● ${e.field.padEnd(16)} ${v}  ${e.cell.value ? `(${e.cell.confidence})` : ""}`);
    } else if (e.type === "row_status") {
      console.log(`${ts()}  ◆ status: ${e.status}${e.error ? ` — ${e.error}` : ""}`);
    } else if (e.type === "log") {
      console.log(`${ts()}  · ${e.message}`);
    }
  });

  if (json) {
    console.log(JSON.stringify({ domain, persona, cells, events }, null, 2));
    return;
  }

  console.log(`\n=== ${domain} — persona "${persona}" ===`);
  const fields = [...BUILTIN_COLUMNS.slice(1), ...customColumns.map((c) => c.id)];
  for (const f of fields) {
    const c = cells[f];
    const label = customColumns.find((x) => x.id === f)?.prompt ?? f;
    console.log(`\n${label}\n  value:      ${c?.value ?? "—"}`);
    if (c?.value) {
      console.log(`  source:     ${c.source_url}\n  confidence: ${c.confidence}`);
      if (c.evidence) console.log(`  evidence:   "${c.evidence.slice(0, 160)}"`);
    }
  }
  const cost = events.find((e) => e.type === "row_cost");
  if (cost?.type === "row_cost") {
    const u = cost.usage;
    console.log(
      `\nCost: $${u.llm_cost_usd.toFixed(4)} LLM (${u.input_tokens} in / ${u.output_tokens} out tokens, ${u.llm_calls} calls) · ` +
        `pages ${u.scrape_calls} · exa ${u.exa_calls} · hunter ${u.hunter_calls}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
