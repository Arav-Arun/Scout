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
import { getSchemaGraph, retrieveSubgraph, formatGraphForPrompt, summarizeSubgraph, type SubGraph } from "../graph/schema-graph";
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
// The planner seeds a few tables; the schema graph then expands that set with the
// bridge/dimension tables needed to join them, so INSPECT describes a wider set.
const MAX_INSPECT = 8;

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

// ── PHASE 3a: RELATE (Graph RAG retrieval over the schema) ───────────────────

/**
 * Walk the schema graph from the planner's seed tables to retrieve the connected
 * subgraph: the seeds plus the bridge/dimension tables needed to join them, plus the
 * exact join keys (the warehouse has no foreign keys). Returns the expanded table set
 * to inspect and the JOIN GRAPH text the analyst reads. Degrades to just the seeds if
 * the graph is unavailable, so the pipeline never regresses.
 */
export async function relate(plan: Plan, emit: Emit): Promise<SubGraph> {
  const id = stepId();
  emit({ type: "step", id, kind: "graph", status: "running", label: "Walking the schema graph" });
  try {
    const graph = await getSchemaGraph();
    const sub = retrieveSubgraph(graph, plan.tables || [], { maxTables: MAX_INSPECT });
    emit({ type: "step", id, kind: "graph", status: "done", label: "Mapped table relationships", detail: summarizeSubgraph(sub) });
    return sub;
  } catch {
    emit({ type: "step", id, kind: "graph", status: "error", label: "Schema graph unavailable" });
    const seeds = plan.tables || [];
    return { seeds, tables: seeds, edges: [] };
  }
}

// ── PHASE 3b: INSPECT ────────────────────────────────────────────────────────

/** Fetch exact typed schemas for the chosen tables (validated against the catalog). */
export async function inspect(tableNames: string[], cat: Catalog, emit: Emit): Promise<TableInfo[]> {
  const names = new Set(cat.tables.map((t) => t.name));
  let chosen = (tableNames || []).filter((t) => names.has(t)).slice(0, MAX_INSPECT);
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

// ── Column-resolution guard (uses the schema graph to fix wrong-table refs) ──
// The warehouse has no foreign keys, so the analyst sometimes selects a column from a
// table that doesn't have it (the column lives on a parent table reachable by a join).
// These helpers turn that into an actionable hint - which table owns the column and
// the exact join key from the retrieved subgraph - either before the query runs
// (checkColumns) or by enriching ClickHouse's own error (enrichColumnError).

interface ColumnIndex {
  /** table -> set of its column names. */
  tableCols: Map<string, Set<string>>;
  /** column name -> the in-scope tables that actually have it. */
  colOwners: Map<string, string[]>;
}

function buildColumnIndex(schemas: TableInfo[]): ColumnIndex {
  const tableCols = new Map<string, Set<string>>();
  const colOwners = new Map<string, string[]>();
  for (const t of schemas) {
    tableCols.set(t.name, new Set(t.columns.map((c) => c.name)));
    for (const c of t.columns) {
      const owners = colOwners.get(c.name) ?? [];
      owners.push(t.name);
      colOwners.set(c.name, owners);
    }
  }
  return { tableCols, colOwners };
}

/** Resolve table aliases (and bare table names) from the query's FROM / JOIN clauses. */
function aliasMap(sql: string, tableCols: Map<string, Set<string>>): Map<string, string> {
  const out = new Map<string, string>();
  const re = /\b(?:FROM|JOIN)\s+`?([A-Za-z_]\w*)`?(?:\s+(?:AS\s+)?`?([A-Za-z_]\w*)`?)?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const table = m[1];
    if (!tableCols.has(table)) continue; // not an in-scope base table (e.g. a subquery)
    out.set(table, table);
    const alias = m[2];
    if (alias && !/^(on|using|where|group|order|limit|left|right|inner|outer|join|as|prewhere|having|settings|format)$/i.test(alias)) {
      out.set(alias, table);
    }
  }
  return out;
}

/** The join key (from the retrieved subgraph) connecting `owner` to any in-scope table. */
function joinSuggestion(sub: SubGraph, owner: string, inScope: Set<string>): string {
  const e = sub.edges.find((e) => (e.a === owner && inScope.has(e.b)) || (e.b === owner && inScope.has(e.a)));
  return e ? ` Join ${e.a}.${e.aCol} = ${e.b}.${e.bCol}.` : " Join it in using the JOIN GRAPH.";
}

/**
 * Pre-flight: flag an alias-qualified reference `t.col` whose table `t` is in scope but
 * lacks `col`, when another in-scope table DOES have it. Returns a hint, or null if the
 * query looks fine. Deliberately conservative (qualified refs only) so it never rejects
 * a valid query - unqualified/ambiguous refs are left to ClickHouse + enrichColumnError.
 */
function checkColumns(sql: string, idx: ColumnIndex, sub: SubGraph): string | null {
  const aliases = aliasMap(sql, idx.tableCols);
  if (!aliases.size) return null;
  const seen = new Set<string>();
  const qref = /\b([A-Za-z_]\w*)\.([A-Za-z_]\w*)\b/g;
  let m: RegExpExecArray | null;
  while ((m = qref.exec(sql)) !== null) {
    const [, q, col] = m;
    const table = aliases.get(q);
    if (!table || col === "*") continue;
    if (idx.tableCols.get(table)?.has(col)) continue; // valid reference
    const owners = (idx.colOwners.get(col) ?? []).filter((o) => o !== table);
    if (!owners.length) continue; // unknown everywhere - could be a computed alias; let CH judge
    const key = `${table}.${col}`;
    if (seen.has(key)) continue;
    seen.add(key);
    return `Column \`${col}\` is not on table \`${table}\`; it lives on \`${owners[0]}\`.${joinSuggestion(sub, owners[0], new Set([table]))} The warehouse has no foreign keys, so you must JOIN to read it.`;
  }
  return null;
}

/** Append a graph-grounded hint to a ClickHouse "unknown column" error, if we can. */
function enrichColumnError(message: string, sql: string, idx: ColumnIndex, sub: SubGraph): string {
  const m = message.match(/(?:Unknown (?:expression )?identifier|Missing columns?:?)\s*['"`]?([A-Za-z_]\w*)['"`]?/i);
  const col = m?.[1];
  if (!col) return message;
  const owners = idx.colOwners.get(col);
  if (!owners?.length) return message;
  const inScope = new Set(aliasMap(sql, idx.tableCols).values());
  return `${message}  Hint: column \`${col}\` lives on \`${owners[0]}\`.${joinSuggestion(sub, owners[0], inScope.size ? inScope : new Set(idx.tableCols.keys()))}`;
}

// ── PHASE 4: ANALYZE LOOP ────────────────────────────────────────────────────

/**
 * Bounded loop (<= MAX_QUERIES): propose one SELECT, run it, feed the result back,
 * repeat until the model finishes. Returns the gathered results plus the SQL log
 * (for "Export SQL").
 */
export async function analyze(plan: Plan, schemas: TableInfo[], sub: SubGraph, cat: Catalog, model: string, emit: Emit): Promise<{ results: AnalyzeResult[]; queries: ExecutedQuery[] }> {
  const results: AnalyzeResult[] = [];
  const queries: ExecutedQuery[] = [];
  const planText = planBlock(plan);
  const graphText = formatGraphForPrompt(sub);
  const graphBlock = graphText ? `\n\n${graphText}` : "";
  const colIndex = buildColumnIndex(schemas);
  const catalogText = `CATALOG (all tables):\n${compactCatalog(cat.tables, cat.rowCounts)}`;

  for (let i = 0; i < MAX_QUERIES; i++) {
    let decision: { done?: boolean; purpose?: string; sql?: string; finding?: string };
    try {
      decision = await llmJSON(
        ANALYST_SYS,
        `${planText}\n\nSCHEMA (chosen tables):\n${schemaBlock(schemas)}${graphBlock}\n\n${catalogText}\n\nRESULTS SO FAR:\n${resultsBlock(results)}\n\nDecide the next query, or finish.`,
        model,
        900,
      );
    } catch {
      break;
    }

    if (decision.finding) emit({ type: "text", delta: decision.finding });
    if (decision.done || !decision.sql) break;

    const purpose = decision.purpose || "Querying";

    // Pre-flight: catch an alias-qualified column used on the wrong table (e.g.
    // `collections.branch` when `branch` lives on loan_book) BEFORE paying a query
    // round-trip. The hint carries the right table + the join key from the graph, so
    // the analyst fixes it on the next turn instead of guessing again. Conservative:
    // only fires on a confident wrong-table reference, never on a valid query.
    const preflight = checkColumns(decision.sql, colIndex, sub);
    if (preflight) {
      results.push({ purpose, sql: decision.sql, rows: [], rowCount: 0, error: preflight });
      emit({ type: "step", id: stepId(), kind: "query", status: "error", label: "Adjusting the query", detail: preflight.slice(0, 140) });
      continue;
    }

    const id = stepId();
    emit({ type: "step", id, kind: "query", status: "running", label: "Querying ClickHouse", detail: purpose });
    try {
      const res = await runSelect(decision.sql);
      queries.push({ purpose, sql: decision.sql, rowCount: res.rowCount, elapsedMs: res.elapsedMs });
      results.push({ purpose, sql: decision.sql, columns: res.columns.map((c) => c.name), rows: res.rows.slice(0, 40), rowCount: res.rowCount });
      emit({ type: "step", id, kind: "query", status: "done", label: "Queried ClickHouse", detail: `${purpose} · ${res.rowCount} row${res.rowCount === 1 ? "" : "s"} · ${res.elapsedMs}ms` });
    } catch (e) {
      // Enrich a ClickHouse "unknown column" error with the table that actually owns
      // the column + the join key, so the retry is grounded (catches the unqualified
      // case the pre-flight deliberately leaves alone).
      const msg = enrichColumnError(errMsg(e), decision.sql, colIndex, sub);
      results.push({ purpose, sql: decision.sql, rows: [], rowCount: 0, error: msg });
      emit({ type: "step", id, kind: "query", status: "error", label: "Query failed", detail: msg.slice(0, 140) });
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
