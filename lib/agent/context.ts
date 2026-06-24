// ─────────────────────────────────────────────────────────────────────────────
// AGENT CONTEXT  ·  lib/agent/context.ts
//
// The plumbing the agent shares across phases: the data shapes it passes around
// (Plan, AnalyzeResult), small id/error helpers, and the formatters that turn
// catalog / schema / results into the prompt text the LLM reads.
//
// This is the "lower layer": it knows nothing about the phases (lib/agent/phases.ts)
// or the orchestrator (lib/agent/workflow.ts) - they import from here, never the reverse.
// ─────────────────────────────────────────────────────────────────────────────

import type { TableInfo } from "../db/clickhouse";
import type { ChatTurn, ScoutEvent } from "../types";

/** A callback that streams one event to the UI (wired up by app/api/chat/route.ts). */
export type Emit = (e: ScoutEvent) => void;

// ── Shared phase shapes ──────────────────────────────────────────────────────

/** The planner's structured output (PHASE 2). */
export interface Plan {
  interpretation: string;
  analysis_type: string;
  response_format: string;
  tables: string[];
  sub_questions: string[];
  needs_clarification: boolean;
  clarification: string;
}

/** The outcome of one analyze-loop query (PHASE 4). */
export interface AnalyzeResult {
  purpose: string;
  sql: string;
  columns?: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  error?: string;
}

// ── Small helpers ────────────────────────────────────────────────────────────

let _seq = 0;
/** Unique id for a streamed step, so the UI can update a chip in place. */
export const stepId = () => `wf_${Date.now()}_${_seq++}`;

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ── Conversation helpers ─────────────────────────────────────────────────────

export function lastUser(history: ChatTurn[]): string {
  return [...history].reverse().find((m) => m.role === "user")?.content ?? "";
}

export function historyText(history: ChatTurn[]): string {
  return history
    .slice(-6)
    .map((m) => `${m.role === "user" ? "User" : "Scout"}: ${m.content}`)
    .join("\n");
}

// ── Warehouse-level facts (deterministic, computed from the catalog) ──────────
// These are the ground truth for structural questions ("how many tables / rows?").
// The synthesizer never sees the catalog, so without this it used to GUESS the count
// (and once answered "0 tables"). We compute the facts in code and hand them to the
// model so it never has to count tables itself.

export interface WarehouseSummary {
  tableCount: number;
  totalRows: number;
  largest?: { name: string; rows: number };
  smallest?: { name: string; rows: number };
}

/** Roll the catalog up into warehouse totals: table count, total rows, largest/smallest. */
export function warehouseSummary(tables: TableInfo[], rowCounts: Record<string, number> = {}): WarehouseSummary {
  let totalRows = 0;
  let largest: { name: string; rows: number } | undefined;
  let smallest: { name: string; rows: number } | undefined;
  for (const t of tables) {
    const n = rowCounts[t.name] ?? 0;
    totalRows += n;
    if (!largest || n > largest.rows) largest = { name: t.name, rows: n };
    if (n > 0 && (!smallest || n < smallest.rows)) smallest = { name: t.name, rows: n };
  }
  return { tableCount: tables.length, totalRows, largest, smallest };
}

/** One exact, model-readable line of warehouse facts (exact integers, never rounded to 0). */
export function warehouseFacts(tables: TableInfo[], rowCounts: Record<string, number> = {}): string {
  const s = warehouseSummary(tables, rowCounts);
  const n = (x: number) => x.toLocaleString("en-US");
  const parts = [`${s.tableCount} table${s.tableCount === 1 ? "" : "s"}`, `${n(s.totalRows)} rows total`];
  if (s.largest) parts.push(`largest: ${s.largest.name} (${n(s.largest.rows)})`);
  if (s.smallest) parts.push(`smallest: ${s.smallest.name} (${n(s.smallest.rows)})`);
  return `WAREHOUSE: ${parts.join(" · ")}.`;
}

// ── Catalog / schema / results formatting ────────────────────────────────────

/** Compact one-line-per-table catalog for the planner (incl. row-count scale). */
export function compactCatalog(tables: TableInfo[], rowCounts: Record<string, number> = {}): string {
  const lines = tables
    .map((t) => {
      const cols = t.columns.slice(0, 40).map((c) => c.name).join(", ");
      const more = t.columns.length > 40 ? `, …(+${t.columns.length - 40})` : "";
      const n = rowCounts[t.name];
      const scale = n ? ` ~${fmtCount(n)} rows` : "";
      return `- ${t.name} [${t.columns.length} cols${scale}]: ${cols}${more}`;
    })
    .join("\n");
  // Header line states the exact table count up front: it is the source of truth for
  // structural facts, so the model reads it instead of guessing (cf. the "0 tables" bug).
  return `${warehouseFacts(tables, rowCounts)}\n${lines}`;
}

/** Human-readable row count (1_00_00_000 -> "10.0M") for catalog context. */
function fmtCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

/** Full typed schema block for the chosen tables. */
export function schemaBlock(infos: TableInfo[]): string {
  return infos
    .map((t) => `TABLE ${t.name}\n${t.columns.map((c) => `  ${c.name} ${c.type}`).join("\n")}`)
    .join("\n\n");
}

/**
 * Per-numeric-column sum/min/max over a result's rows, computed in code so the model never
 * has to add up rows itself (that hand-summing is how it produced a total SMALLER than one of
 * its parts). For a complete breakdown the column `sum` IS the grand total and `max` is the
 * largest part - both exact and mutually consistent.
 */
function columnAggregates(rows: Record<string, unknown>[], rowCount: number): string {
  if (!rows.length) return "";
  const parts: string[] = [];
  for (const k of Object.keys(rows[0])) {
    let sum = 0, min = Infinity, max = -Infinity, ok = true, seen = 0;
    for (const row of rows) {
      const v = row[k];
      const num =
        typeof v === "number" ? v
        : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v)
        : null;
      if (num === null) { ok = false; break; } // non-numeric column - skip
      sum += num; seen++; if (num < min) min = num; if (num > max) max = num;
    }
    if (ok && seen) parts.push(`${k}: sum=${sum}, min=${min}, max=${max}`);
  }
  if (!parts.length) return "";
  // rowCount is the true count returned; r.rows is capped at 40. Flag partial sums clearly.
  const complete = rowCount <= rows.length;
  const scope = complete
    ? `all ${rowCount} returned rows`
    : `ONLY the first ${rows.length} of ${rowCount} rows (NOT a grand total)`;
  return `\nColumn aggregates over ${scope} - use these, do NOT add rows yourself: ${parts.join("; ")}`;
}

/** Results gathered so far, trimmed for the model's context (+ exact column aggregates). */
export function resultsBlock(results: AnalyzeResult[]): string {
  if (!results.length) return "(no queries run yet)";
  return results
    .map((r, i) => {
      if (r.error) return `#${i + 1} ${r.purpose}\nSQL: ${r.sql}\nERROR: ${r.error}`;
      const sample = JSON.stringify(r.rows.slice(0, 25));
      const aggs = columnAggregates(r.rows, r.rowCount);
      return `#${i + 1} ${r.purpose} (${r.rowCount} rows)\nSQL: ${r.sql}\nRows: ${sample}${aggs}`;
    })
    .join("\n\n");
}

/** The plan rendered as prompt text (shared by the analyze loop and synthesis). */
export function planBlock(plan: Plan): string {
  return `PLAN\nInterpretation: ${plan.interpretation}\nType: ${plan.analysis_type}\nResponse format: ${plan.response_format}\nSub-questions:\n${(plan.sub_questions || []).map((q) => `- ${q}`).join("\n")}`;
}
