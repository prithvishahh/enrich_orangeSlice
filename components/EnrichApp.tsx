"use client";

import "ag-grid-community/styles/ag-grid.css";
import "ag-grid-community/styles/ag-theme-quartz.css";

import type { CellClickedEvent, CellValueChangedEvent, ColDef, GridApi, ICellRendererParams } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { normalizeDomain } from "@/lib/enrich/domain";
import {
  FIRMOGRAPHIC_FIELDS,
  PERSONA_FIELDS,
  type Cell,
  type CustomColumn,
  type EnrichEvent,
  type RowStatus,
  type RowUsage,
} from "@/lib/enrich/types";

// ---------------------------------------------------------------------------
// Types & helpers
// ---------------------------------------------------------------------------

type Status = RowStatus | "idle";

interface Row {
  id: string;
  domain: string;
  status: Status;
  error?: string;
  cells: Record<string, Cell>;
  cost?: RowUsage;
}

type StreamEvent = EnrichEvent | { type: "done" } | { type: "fatal"; error: string };

interface Config {
  provider: string | null;
  model: string | null;
  keys: { llm: boolean; exa: boolean; hunter: boolean; firecrawl: boolean };
}

const LABELS: Record<string, string> = {
  domain: "Domain",
  company_name: "Company",
  one_liner: "One-liner",
  industry: "Industry",
  hq_location: "HQ",
  employee_range: "Employees",
  funding_stage: "Stage",
  last_round: "Last round",
  persona_name: "Persona",
  persona_title: "Title",
  persona_email: "Email",
  email_status: "Email status",
};

const WIDTHS: Record<string, number> = {
  company_name: 150,
  one_liner: 280,
  industry: 160,
  hq_location: 170,
  employee_range: 110,
  funding_stage: 110,
  last_round: 190,
  persona_name: 150,
  persona_title: 170,
  persona_email: 220,
  email_status: 150,
};

let rowSeq = 0;
const newRow = (domain = ""): Row => ({ id: `r${++rowSeq}`, domain, status: "idle", cells: {} });
const MIN_ROWS = 12;

function padRows(rows: Row[]): Row[] {
  const trailingBlank = rows.length - 1 - rows.findLastIndex((r) => r.domain.trim());
  const need = Math.max(MIN_ROWS - rows.length, 3 - trailingBlank, 0);
  return need ? [...rows, ...Array.from({ length: need }, () => newRow())] : rows;
}

function applyEvents(rows: Row[], events: EnrichEvent[]): Row[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const e of events) {
    const r = byId.get(e.rowId);
    if (!r) continue;
    if (e.type === "cell") byId.set(r.id, { ...r, cells: { ...r.cells, [e.field]: e.cell } });
    else if (e.type === "row_status") byId.set(r.id, { ...r, status: e.status, error: e.error });
    else if (e.type === "row_cost") byId.set(r.id, { ...r, cost: e.usage });
  }
  return rows.map((r) => byId.get(r.id)!);
}

const STATUS_STYLE: Record<Status, { dot: string; label: string }> = {
  idle: { dot: "bg-neutral-200", label: "Not run" },
  queued: { dot: "bg-neutral-400", label: "Queued" },
  running: { dot: "bg-blue-500 animate-pulse", label: "Running" },
  done: { dot: "bg-emerald-500", label: "Done" },
  error: { dot: "bg-red-500", label: "Error" },
};

const EMAIL_STYLE: Record<string, string> = {
  verified: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  pattern_guessed: "bg-amber-50 text-amber-800 ring-amber-600/20",
  not_found: "bg-neutral-100 text-neutral-500 ring-neutral-400/20",
};

function EmailPill({ value }: { value: string }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${EMAIL_STYLE[value] ?? EMAIL_STYLE.not_found}`}>
      {value.replace("_", " ")}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Cell renderers
// ---------------------------------------------------------------------------

function StatusRenderer({ data }: ICellRendererParams<Row>) {
  if (!data?.domain.trim()) return null;
  const s = STATUS_STYLE[data.status];
  const tip = data.error ? `${s.label}: ${data.error}` : data.cost ? `${s.label} · $${data.cost.llm_cost_usd.toFixed(4)}` : s.label;
  return (
    <span className="flex h-full items-center justify-center" title={tip}>
      <span className={`h-2.5 w-2.5 rounded-full ${s.dot}`} />
    </span>
  );
}

function ValueRenderer({ data, column }: ICellRendererParams<Row>) {
  const field = column?.getColId() ?? "";
  const cell = data?.cells[field];
  if (!data || !cell) {
    if (data?.status === "running") return <span className="inline-block h-2 w-16 animate-pulse rounded bg-neutral-200 align-middle" />;
    return null;
  }
  if (field === "email_status" && cell.value) return <EmailPill value={cell.value} />;
  if (!cell.value) return <span className="text-neutral-300">—</span>;
  return <span className={cell.confidence < 0.5 ? "text-neutral-400 italic" : ""}>{cell.value}</span>;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export default function EnrichApp({ initialDomains = [], title }: { initialDomains?: string[]; title?: string }) {
  const [rows, setRows] = useState<Row[]>(() => padRows(initialDomains.map((d) => newRow(d))));
  const [persona, setPersona] = useState("Head of Sales");
  const [customColumns, setCustomColumns] = useState<CustomColumn[]>([]);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [running, setRunning] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ rowId: string; field: string } | null>(null);
  const [config, setConfig] = useState<Config | null>(null);

  const apiRef = useRef<GridApi<Row> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const pending = useRef<EnrichEvent[]>([]);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    fetch("/api/enrich")
      .then((r) => r.json())
      .then(setConfig)
      .catch(() => {});
  }, []);

  // Batch streamed events into one state update per animation frame.
  const enqueue = useCallback((e: EnrichEvent) => {
    pending.current.push(e);
    if (frame.current == null) {
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        const batch = pending.current;
        pending.current = [];
        setRows((prev) => applyEvents(prev, batch));
      });
    }
  }, []);

  // ---- columns ----
  const columnDefs = useMemo<ColDef<Row>[]>(() => {
    const valueCol = (field: string, headerName: string, width: number): ColDef<Row> => ({
      colId: field,
      headerName,
      width,
      valueGetter: (p) => p.data?.cells[field]?.value ?? null,
      cellRenderer: ValueRenderer,
      tooltipValueGetter: (p) => p.data?.cells[field]?.value ?? undefined,
      enableCellChangeFlash: true,
      cellClass: "cursor-pointer",
    });
    return [
      { colId: "status", headerName: "", width: 44, pinned: "left", resizable: false, sortable: false, cellRenderer: StatusRenderer },
      {
        field: "domain",
        headerName: "Domain",
        width: 180,
        pinned: "left",
        editable: true,
        cellClass: "font-medium",
      },
      ...FIRMOGRAPHIC_FIELDS.map((f) => valueCol(f, LABELS[f], WIDTHS[f])),
      ...PERSONA_FIELDS.map((f) => valueCol(f, LABELS[f], WIDTHS[f])),
      ...customColumns.map((c) => ({ ...valueCol(c.id, c.prompt, 220), headerTooltip: c.prompt })),
    ];
  }, [customColumns]);

  // ---- editing & paste ----
  const onCellValueChanged = useCallback((e: CellValueChangedEvent<Row>) => {
    if (e.colDef.field !== "domain" || !e.data) return;
    const raw = String(e.newValue ?? "").trim();
    const domain = normalizeDomain(raw) ?? raw;
    const id = e.data.id;
    setRows((prev) => padRows(prev.map((r) => (r.id === id ? { ...r, domain, status: "idle", error: undefined, cells: {}, cost: undefined } : r))));
  }, []);

  const onPaste = useCallback((e: React.ClipboardEvent) => {
    const text = e.clipboardData.getData("text/plain");
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.split("\t")[0].trim())
      .filter(Boolean);
    const api = apiRef.current;
    const focused = api?.getFocusedCell();
    const inDomainCol = !focused || focused.column.getColId() === "domain";
    // Single value while editing a cell: let the editor handle it.
    if (!lines.length || (lines.length === 1 && api?.getEditingCells().length) || (!inDomainCol && lines.length === 1)) return;
    e.preventDefault();
    e.stopPropagation();
    api?.stopEditing(true);

    const seen = new Set<string>();
    const domains = lines
      .map((l) => normalizeDomain(l) ?? l)
      .filter((d) => (seen.has(d) ? false : (seen.add(d), true)));

    setRows((prev) => {
      const next = [...prev];
      let i = focused && inDomainCol ? focused.rowIndex : next.findIndex((r) => !r.domain.trim());
      if (i < 0) i = next.length;
      for (const d of domains) {
        const base = next[i] ?? newRow();
        next[i] = { ...base, domain: d, status: "idle", error: undefined, cells: {}, cost: undefined };
        i++;
      }
      return padRows(next);
    });
  }, []);

  // ---- run / stop ----
  const run = useCallback(async () => {
    const targets = rows.filter((r) => r.domain.trim()).map((r) => ({ rowId: r.id, domain: r.domain.trim() }));
    if (!targets.length) {
      setFatal("Paste some domains into the Domain column first.");
      return;
    }
    setFatal(null);
    setRunning(true);
    const ids = new Set(targets.map((t) => t.rowId));
    setRows((prev) => prev.map((r) => (ids.has(r.id) ? { ...r, status: "queued", error: undefined } : r)));

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const res = await fetch("/api/enrich", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: targets, persona: persona.trim() || "Head of Sales", customColumns }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) throw new Error((await res.text()) || `HTTP ${res.status}`);
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of chunk.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            const ev = JSON.parse(line.slice(6)) as StreamEvent;
            if (ev.type === "fatal") setFatal(ev.error);
            else if (ev.type === "log") console.log(`[${ev.rowId}] ${ev.message}`);
            else if (ev.type !== "done") enqueue(ev);
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") setFatal((err as Error).message);
    } finally {
      abortRef.current = null;
      setRunning(false);
      // Anything still queued/running when the stream ends was cancelled.
      setRows((prev) => prev.map((r) => (r.status === "queued" || r.status === "running" ? { ...r, status: "idle" } : r)));
    }
  }, [rows, persona, customColumns, enqueue]);

  const stop = () => abortRef.current?.abort();

  // ---- columns ----
  const addColumn = () => {
    const prompt = draft.trim();
    if (!prompt) return;
    const n = customColumns.reduce((m, c) => Math.max(m, Number(c.id.split("_")[1])), 0) + 1;
    setCustomColumns((cols) => [...cols, { id: `custom_${n}`, prompt }]);
    setDraft("");
    setAdding(false);
  };

  // ---- export ----
  const exportCsv = () => {
    const fields = [...FIRMOGRAPHIC_FIELDS, ...PERSONA_FIELDS, ...customColumns.map((c) => c.id)];
    const label = (f: string) => customColumns.find((c) => c.id === f)?.prompt ?? f;
    const esc = (v: unknown) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ["domain", "status", ...fields.flatMap((f) => [label(f), `${label(f)} source`, `${label(f)} confidence`])];
    const lines = rows
      .filter((r) => r.domain.trim())
      .map((r) => [r.domain, r.status, ...fields.flatMap((f) => [r.cells[f]?.value, r.cells[f]?.source_url, r.cells[f]?.value ? r.cells[f]?.confidence : ""])]);
    const csv = [header, ...lines].map((l) => l.map(esc).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `enrich-${new Date().toISOString().slice(0, 10)}.csv` });
    a.click();
    URL.revokeObjectURL(url);
  };

  const clearAll = () => {
    setRows(padRows([]));
    setSelected(null);
  };

  // ---- derived ----
  const filled = rows.filter((r) => r.domain.trim());
  const doneCount = filled.filter((r) => r.status === "done" || r.status === "error").length;
  const quotaError = filled.find((r) => r.error?.includes("daily quota"))?.error?.split("; ")[0].replace(/^\w[\w ]*: /, "");
  const totalCost = filled.reduce((s, r) => s + (r.cost?.llm_cost_usd ?? 0), 0);
  const selRow = selected ? rows.find((r) => r.id === selected.rowId) : undefined;
  const selCell = selected && selRow ? selRow.cells[selected.field] : undefined;
  const selLabel = selected ? (customColumns.find((c) => c.id === selected.field)?.prompt ?? LABELS[selected.field] ?? selected.field) : "";

  const onCellClicked = useCallback((e: CellClickedEvent<Row>) => {
    const field = e.column.getColId();
    if (field === "domain" || field === "status" || !e.data?.domain.trim()) return;
    setSelected({ rowId: e.data.id, field });
  }, []);

  return (
    <div className="flex h-screen flex-col">
      {/* Top bar */}
      <header className="flex flex-wrap items-center gap-3 border-b border-neutral-200 px-4 py-3">
        <div className="mr-2 flex items-baseline gap-2">
          <span className="text-lg font-semibold tracking-tight">Enrich</span>
          {title && <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-500">{title}</span>}
        </div>
        <label className="flex items-center gap-2 text-sm text-neutral-500">
          Persona
          <input
            value={persona}
            onChange={(e) => setPersona(e.target.value)}
            className="w-44 rounded-md border border-neutral-300 px-2 py-1.5 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none"
          />
        </label>
        <div className="relative">
          <button onClick={() => setAdding((a) => !a)} className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50">
            + Add column
          </button>
          {adding && (
            <div className="absolute left-0 top-10 z-20 w-80 rounded-lg border border-neutral-200 bg-white p-3 shadow-lg">
              <p className="mb-2 text-xs text-neutral-500">Ask a question the agent answers for every row, with a source.</p>
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addColumn();
                  if (e.key === "Escape") setAdding(false);
                }}
                placeholder="Are they hiring SDRs?"
                className="w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm focus:border-neutral-500 focus:outline-none"
              />
              <div className="mt-2 flex justify-end gap-2">
                <button onClick={() => setAdding(false)} className="px-2 py-1 text-sm text-neutral-500">
                  Cancel
                </button>
                <button onClick={addColumn} className="rounded-md bg-neutral-900 px-3 py-1 text-sm text-white">
                  Add
                </button>
              </div>
            </div>
          )}
        </div>
        {running ? (
          <button onClick={stop} className="rounded-md bg-red-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-red-700">
            Stop
          </button>
        ) : (
          <button onClick={run} className="rounded-md bg-neutral-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-neutral-700">
            Run
          </button>
        )}
        <button onClick={exportCsv} className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50">
          Export CSV
        </button>
        <button onClick={clearAll} disabled={running} className="px-2 py-1.5 text-sm text-neutral-400 hover:text-neutral-700 disabled:opacity-40">
          Clear
        </button>

        <div className="ml-auto flex items-center gap-3 text-xs text-neutral-500">
          {filled.length > 0 && (
            <span>
              {doneCount}/{filled.length} rows
            </span>
          )}
          {totalCost > 0 && <span>${totalCost.toFixed(3)}</span>}
          {config?.provider && (
            <span className="rounded bg-neutral-100 px-1.5 py-0.5" title={config.model ?? ""}>
              {config.provider === "gemini" ? "Gemini (free)" : "Claude"}
            </span>
          )}
        </div>
      </header>

      {/* Banners */}
      {config && !config.keys.llm && (
        <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          No LLM key configured. Add <code>GEMINI_API_KEY</code> (free) or <code>ANTHROPIC_API_KEY</code> to <code>.env.local</code> and restart.
        </div>
      )}
      {config && config.keys.llm && (!config.keys.exa || !config.keys.hunter) && (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
          {!config.keys.exa && "EXA_API_KEY missing: no funding/people search. "}
          {!config.keys.hunter && "HUNTER_API_KEY missing: emails will be not_found."}
        </div>
      )}
      {quotaError && (
        <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{quotaError}</div>
      )}
      {fatal && (
        <div className="flex items-center justify-between border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          <span>{fatal}</span>
          <button onClick={() => setFatal(null)} className="text-red-400 hover:text-red-700">
            ✕
          </button>
        </div>
      )}

      {/* Grid + side panel */}
      <div className="flex min-h-0 flex-1">
        <div className="ag-theme-quartz enrich-grid min-w-0 flex-1" onPasteCapture={onPaste}>
          <AgGridReact<Row>
            rowData={rows}
            columnDefs={columnDefs}
            getRowId={(p) => p.data.id}
            defaultColDef={{ resizable: true, sortable: false, suppressMovable: true }}
            onGridReady={(e) => (apiRef.current = e.api)}
            onCellValueChanged={onCellValueChanged}
            onCellClicked={onCellClicked}
            rowHeight={36}
            headerHeight={36}
            tooltipShowDelay={500}
            singleClickEdit={false}
            stopEditingWhenCellsLoseFocus
            overlayNoRowsTemplate="Paste domains into the Domain column"
          />
        </div>

        {selected && selRow && (
          <aside className="w-96 shrink-0 overflow-y-auto border-l border-neutral-200 bg-white p-5">
            <div className="mb-4 flex items-start justify-between">
              <div>
                <p className="text-xs uppercase tracking-wide text-neutral-400">{selRow.domain}</p>
                <h2 className="mt-1 text-sm font-medium text-neutral-600">{selLabel}</h2>
              </div>
              <button onClick={() => setSelected(null)} className="text-neutral-400 hover:text-neutral-700" aria-label="Close">
                ✕
              </button>
            </div>

            {!selCell ? (
              <p className="text-sm text-neutral-400">{selRow.status === "running" ? "Working on it…" : "Not enriched yet. Press Run."}</p>
            ) : (
              <div className="space-y-5">
                <div className="text-lg leading-snug">
                  {selected.field === "email_status" && selCell.value ? (
                    <EmailPill value={selCell.value} />
                  ) : (
                    (selCell.value ?? <span className="text-neutral-400">No supported value found</span>)
                  )}
                </div>

                {selCell.value && selected.field !== "email_status" && (
                  <div>
                    <p className="mb-1 text-xs font-medium uppercase tracking-wide text-neutral-400">Confidence</p>
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 flex-1 rounded-full bg-neutral-100">
                        <div
                          className={`h-1.5 rounded-full ${selCell.confidence >= 0.75 ? "bg-emerald-500" : selCell.confidence >= 0.5 ? "bg-amber-500" : "bg-red-400"}`}
                          style={{ width: `${Math.round(selCell.confidence * 100)}%` }}
                        />
                      </div>
                      <span className="w-10 text-right text-sm tabular-nums text-neutral-600">{Math.round(selCell.confidence * 100)}%</span>
                    </div>
                  </div>
                )}

                <div>
                  <p className="mb-1 text-xs font-medium uppercase tracking-wide text-neutral-400">Source</p>
                  {selCell.source_url ? (
                    <a href={selCell.source_url} target="_blank" rel="noreferrer" className="break-all text-sm text-blue-600 hover:underline">
                      {selCell.source_url}
                    </a>
                  ) : (
                    <p className="text-sm text-neutral-400">None. The agent leaves a cell empty rather than guess.</p>
                  )}
                </div>

                {selCell.evidence && (
                  <div>
                    <p className="mb-1 text-xs font-medium uppercase tracking-wide text-neutral-400">Evidence</p>
                    <blockquote className="border-l-2 border-neutral-200 pl-3 text-sm italic text-neutral-600">{selCell.evidence}</blockquote>
                  </div>
                )}
              </div>
            )}

            {selRow.error && <p className="mt-6 rounded bg-red-50 p-2 text-xs text-red-700">Row error: {selRow.error}</p>}
            {selRow.cost && (
              <p className="mt-6 text-xs text-neutral-400">
                Row cost ${selRow.cost.llm_cost_usd.toFixed(4)} · {selRow.cost.input_tokens.toLocaleString()} in / {selRow.cost.output_tokens.toLocaleString()} out
                tokens
              </p>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
