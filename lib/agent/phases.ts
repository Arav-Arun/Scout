// ─────────────────────────────────────────────────────────────────────────────
// AGENT PHASES  ·  lib/agent/phases.ts
//
// The five steps of the pipeline, one function each. Every phase takes the context
// it needs plus `emit`, streams its own step chips, and returns its output. The
// orchestrator (lib/workflow.ts) just calls them in order.
//
//   discover → planAnalysis → inspect → analyze → synthesize
//
// Formatting/helpers live in ./context; the data layer in ../db/clickhouse; the LLM
// client in ./llm; the prompts in ./prompts.
// ─────────────────────────────────────────────────────────────────────────────

import { describeTable, runSelect, type TableInfo } from "../db/clickhouse";
import { getCatalog, type Catalog } from "../db/catalog";
import { llmJSON } from "./llm";
import { PLANNER_SYS, ANALYST_SYS, SYNTH_SYS } from "./prompts";
import type { ChatTurn, ExecutedQuery, Dashboard } from "../types";
import {
  type Emit,
  type Plan,
  type AnalyzeResult,
  stepId,
  errMsg,
  historyText,
  compactCatalog,
  schemaBlock,
  resultsBlock,
  planBlock,
} from "./context";

const MAX_QUERIES = 8;
const MAX_TABLES = 4;

// ── PHASE 1: DISCOVER (cached) ───────────────────────────────────────────────

/** Map the warehouse (cached). Returns the catalog, or null if it's unreachable. */
export async function discover(emit: Emit): Promise<Catalog | null> {
  const id = stepId();
  emit({ type: "step", id, kind: "discover", status: "running", label: "Mapping the warehouse" });
  try {
    const cat = await getCatalog();
    const cached = Date.now() - cat.discoveredAt > 200;
    emit({ type: "step", id, kind: "discover", status: "done", label: cached ? "Loaded warehouse map" : "Mapped the warehouse", detail: `${cat.tables.length} tables` });
    return cat;
  } catch (e) {
    emit({ type: "step", id, kind: "discover", status: "error", label: "Could not reach the warehouse" });
    emit({ type: "text", delta: `I couldn't reach the database: ${errMsg(e)}` });
    return null;
  }
}

// ── PHASE 2: PLAN ────────────────────────────────────────────────────────────

/** Interpret the (often vague) question and pick the tables to inspect. */
export async function planAnalysis(question: string, history: ChatTurn[], cat: Catalog, model: string, emit: Emit): Promise<Plan> {
  const id = stepId();
  emit({ type: "step", id, kind: "think", status: "running", label: "Planning the analysis" });
  let plan: Plan;
  try {
    plan = await llmJSON<Plan>(
      PLANNER_SYS,
      `Question: ${question}\n\nRecent conversation:\n${historyText(history)}\n\nTable catalog:\n${compactCatalog(cat.tables, cat.rowCounts)}`,
      model,
    );
  } catch {
    plan = { interpretation: question, analysis_type: "investigation", response_format: "standard dashboard", tables: cat.tables.slice(0, 2).map((t) => t.name), sub_questions: [], needs_clarification: false, clarification: "" };
  }
  emit({ type: "step", id, kind: "think", status: "done", label: "Planned the analysis", detail: plan.analysis_type });
  if (plan.interpretation) emit({ type: "text", delta: plan.interpretation });
  return plan;
}

// ── PHASE 3: INSPECT ─────────────────────────────────────────────────────────

/** Fetch exact typed schemas for the chosen tables (validated against the catalog). */
export async function inspect(plan: Plan, cat: Catalog, emit: Emit): Promise<TableInfo[]> {
  const names = new Set(cat.tables.map((t) => t.name));
  let chosen = (plan.tables || []).filter((t) => names.has(t)).slice(0, MAX_TABLES);
  if (!chosen.length) chosen = cat.tables.slice(0, 2).map((t) => t.name);

  const id = stepId();
  emit({ type: "step", id, kind: "inspect", status: "running", label: "Inspecting table schemas" });
  const schemas: TableInfo[] = [];
  for (const t of chosen) {
    try {
      schemas.push(await describeTable(t));
    } catch {
      const c = cat.tables.find((x) => x.name === t);
      if (c) schemas.push(c);
    }
  }
  emit({ type: "step", id, kind: "inspect", status: "done", label: "Inspected table schemas", detail: chosen.join(", ") });
  return schemas;
}

// ── PHASE 4: ANALYZE LOOP ────────────────────────────────────────────────────

/**
 * Bounded loop (<= MAX_QUERIES): propose one SELECT, run it, feed the result back,
 * repeat until the model finishes. Returns the gathered results plus the SQL log
 * (for "Export SQL").
 */
export async function analyze(plan: Plan, schemas: TableInfo[], cat: Catalog, model: string, emit: Emit): Promise<{ results: AnalyzeResult[]; queries: ExecutedQuery[] }> {
  const results: AnalyzeResult[] = [];
  const queries: ExecutedQuery[] = [];
  const planText = planBlock(plan);
  const catalogText = `CATALOG (all tables):\n${compactCatalog(cat.tables, cat.rowCounts)}`;

  for (let i = 0; i < MAX_QUERIES; i++) {
    let decision: { done?: boolean; purpose?: string; sql?: string; finding?: string };
    try {
      decision = await llmJSON(
        ANALYST_SYS,
        `${planText}\n\nSCHEMA (chosen tables):\n${schemaBlock(schemas)}\n\n${catalogText}\n\nRESULTS SO FAR:\n${resultsBlock(results)}\n\nDecide the next query, or finish.`,
        model,
        900,
      );
    } catch {
      break;
    }

    if (decision.finding) emit({ type: "text", delta: decision.finding });
    if (decision.done || !decision.sql) break;

    const purpose = decision.purpose || "Querying";
    const id = stepId();
    emit({ type: "step", id, kind: "query", status: "running", label: "Querying ClickHouse", detail: purpose });
    try {
      const res = await runSelect(decision.sql);
      queries.push({ purpose, sql: decision.sql, rowCount: res.rowCount, elapsedMs: res.elapsedMs });
      results.push({ purpose, sql: decision.sql, columns: res.columns.map((c) => c.name), rows: res.rows.slice(0, 40), rowCount: res.rowCount });
      emit({ type: "step", id, kind: "query", status: "done", label: "Queried ClickHouse", detail: `${purpose} · ${res.rowCount} row${res.rowCount === 1 ? "" : "s"} · ${res.elapsedMs}ms` });
    } catch (e) {
      results.push({ purpose, sql: decision.sql, rows: [], rowCount: 0, error: errMsg(e) });
      emit({ type: "step", id, kind: "query", status: "error", label: "Query failed", detail: errMsg(e) });
    }
  }

  return { results, queries };
}

// ── PHASE 5: SYNTHESIZE ──────────────────────────────────────────────────────

/** Compose the final dashboard from the gathered results. Returns null on failure. */
export async function synthesize(plan: Plan, results: AnalyzeResult[], queries: ExecutedQuery[], model: string, emit: Emit): Promise<Dashboard | null> {
  const id = stepId();
  emit({ type: "step", id, kind: "think", status: "running", label: "Synthesising the dashboard" });
  const hasQueries = results.length > 0;
  const hasSuccessfulQuery = results.some((r) => !r.error && r.rowCount >= 0 && r.rows);
  if (hasQueries && !hasSuccessfulQuery) {
    emit({ type: "step", id, kind: "think", status: "error", label: "No data to synthesise" });
    emit({ type: "text", delta: "I couldn't gather enough data to answer that. Could you rephrase or narrow the question?" });
    return null;
  }
  try {
    const raw = await llmJSON<Record<string, unknown>>(
      SYNTH_SYS,
      `${planBlock(plan)}\n\nGATHERED RESULTS:\n${resultsBlock(results)}\n\nCompose the final answer now, honouring the response format: "${plan.response_format}".`,
      model,
      3500,
    );
    const dashboard = normalizeDashboard(raw);
    emit({ type: "step", id, kind: "think", status: "done", label: "Dashboard ready" });
    emit({ type: "dashboard", dashboard, queries });
    return dashboard;
  } catch (e) {
    emit({ type: "step", id, kind: "think", status: "error", label: "Synthesis failed" });
    emit({ type: "text", delta: `I gathered the data but couldn't compose the dashboard: ${errMsg(e)}` });
    return null;
  }
}

// ── Dashboard coercion ───────────────────────────────────────────────────────
// The trust boundary between untrusted synthesizer output and typed app data:
// every field is coerced/defaulted and charts without a valid `echarts` object
// are dropped.

/** Coerce model output into a valid Dashboard, guarding against missing fields. */
function normalizeDashboard(args: Record<string, unknown>): Dashboard {
  const a = args as Partial<Dashboard>;
  return {
    title: String(a.title ?? "Analysis"),
    subtitle: a.subtitle ? String(a.subtitle) : undefined,
    summary: String(a.summary ?? ""),
    heroMetrics: Array.isArray(a.heroMetrics)
      ? a.heroMetrics.map((m) => ({
          label: String(m?.label ?? ""),
          value: String(m?.value ?? ""),
          sub: m?.sub != null ? String(m.sub) : undefined,
        }))
      : [],
    charts: Array.isArray(a.charts)
      ? a.charts
          .filter((c) => c && typeof c.echarts === "object")
          .map((c) => ({
            title: String(c.title ?? ""),
            insight: String(c.insight ?? ""),
            echarts: c.echarts as Record<string, unknown>,
          }))
      : [],
    tables: Array.isArray(a.tables)
      ? a.tables.map((t) => ({
          title: String(t?.title ?? ""),
          columns: Array.isArray(t?.columns) ? t.columns.map(String) : [],
          rows: Array.isArray(t?.rows) ? t.rows : [],
        }))
      : undefined,
    recommendations: Array.isArray(a.recommendations) ? a.recommendations.map(String) : undefined,
  };
}
