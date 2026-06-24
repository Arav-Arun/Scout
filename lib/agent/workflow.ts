// ─────────────────────────────────────────────────────────────────────────────
// THE AGENT  ·  lib/agent/workflow.ts
//
// Scout's brain, as a thin orchestrator. Turns one natural-language question into a
// structured dashboard by running an explicit 6-phase pipeline in order:
//   DISCOVER → PLAN → RELATE → INSPECT → ANALYZE↻ → SYNTHESIZE
//
// RELATE is the Graph RAG step: it walks the schema graph (lib/graph/) from the
// planner's seed tables to retrieve the connected subgraph + the exact join keys, so
// the analyst can join across the 34-table warehouse that has no foreign keys.
//
// Each phase is its own function in lib/agent/phases.ts; the formatters/helpers they
// share live in lib/agent/context.ts. This file is just the sequence and the
// early-exit decisions between phases.
//
// ▸ CALL MAP:
//   - CALLED BY: lib/api.ts (chat handler) -> runScoutWorkflow(history, emit, opts)
//   - CALLS:     lib/agent/phases.ts (discover, planAnalysis, relate, inspect, analyze, synthesize)
//   - EMITS:     ScoutEvent objects (lib/types.ts) streamed to the UI.
// ─────────────────────────────────────────────────────────────────────────────

import type { ChatTurn, AgentResult } from "../types";
import { lastUser, type Emit } from "./context";
import { discover, planAnalysis, relate, inspect, analyze, synthesize } from "./phases";

/** The result for an analysis that stopped before producing a dashboard. */
const noDashboard = (clarified = false): AgentResult => ({ dashboard: null, queries: [], clarified });

export async function runScoutWorkflow(
  history: ChatTurn[],
  emit: Emit,
  options?: { model?: string },
): Promise<AgentResult> {
  const question = lastUser(history);
  const model = options?.model || process.env.OPENAI_MODEL || "gpt-4o";

  // 1 · DISCOVER (cached) ─ map the warehouse, or bail if we can't reach it.
  const cat = await discover(emit);
  if (!cat) return noDashboard();
  if (!cat.tables.length) {
    emit({ type: "text", delta: "The database has no tables yet. Upload a CSV/Excel file and I'll analyse it." });
    return noDashboard();
  }

  // 2 · PLAN ─ interpret the question; stop here if we must clarify.
  const plan = await planAnalysis(question, history, cat, model, emit);
  if (plan.needs_clarification && plan.clarification) {
    emit({ type: "clarification", text: plan.clarification });
    return noDashboard(true);
  }

  // 3 · RELATE ─ walk the schema graph to expand the seed tables with the bridge
  //     tables that join them, and recover the exact join keys (no FKs in ClickHouse).
  const sub = await relate(plan, emit);

  // 4 · INSPECT ─ exact schemas for the subgraph's tables.
  const schemas = await inspect(sub.tables, cat, emit);

  // 5 · ANALYZE ─ the bounded query loop, armed with the JOIN GRAPH + a pre-flight
  //     column check that uses it to catch wrong-table column refs before they run.
  const { results, queries } = await analyze(plan, schemas, sub, cat, model, emit);

  // 6 · SYNTHESIZE ─ compose the dashboard (emits it; may be null on failure).
  //     `cat` carries the exact warehouse facts (table count, total rows) so the
  //     synthesizer never has to guess structural numbers (cf. the "0 tables" bug).
  const dashboard = await synthesize(plan, results, queries, cat, model, emit);
  return { dashboard, queries, clarified: false };
}
