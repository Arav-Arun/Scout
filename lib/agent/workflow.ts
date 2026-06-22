// ─────────────────────────────────────────────────────────────────────────────
// THE AGENT  ·  lib/agent/workflow.ts
//
// Scout's brain, as a thin orchestrator. Turns one natural-language question into a
// structured dashboard by running an explicit 5-phase pipeline in order:
//   DISCOVER → PLAN → INSPECT → ANALYZE↻ → SYNTHESIZE
//
// Each phase is its own function in lib/agent/phases.ts; the formatters/helpers they
// share live in lib/agent/context.ts. This file is just the sequence and the
// early-exit decisions between phases.
//
// ▸ CALL MAP:
//   - CALLED BY: lib/api.ts (chat handler) -> runScoutWorkflow(history, emit, opts)
//   - CALLS:     lib/agent/phases.ts (discover, planAnalysis, inspect, analyze, synthesize)
//   - EMITS:     ScoutEvent objects (lib/types.ts) streamed to the UI.
// ─────────────────────────────────────────────────────────────────────────────

import type { ChatTurn, AgentResult } from "../types";
import { lastUser, type Emit } from "./context";
import { discover, planAnalysis, inspect, analyze, synthesize } from "./phases";

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

  // 3 · INSPECT ─ exact schemas for the chosen tables.
  const schemas = await inspect(plan, cat, emit);

  // 4 · ANALYZE ─ the bounded query loop.
  const { results, queries } = await analyze(plan, schemas, cat, model, emit);

  // 5 · SYNTHESIZE ─ compose the dashboard (emits it; may be null on failure).
  const dashboard = await synthesize(plan, results, queries, model, emit);
  return { dashboard, queries, clarified: false };
}
