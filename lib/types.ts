// ─────────────────────────────────────────────────────────────────────────────
// Shared types for Scout - the streaming protocol between the agent and the UI,
// and the structured dashboard the agent emits as its final answer.
// ─────────────────────────────────────────────────────────────────────────────

// ================ DASHBOARD SHAPE ================

/** A single big number shown at the top of a dashboard. */
export interface HeroMetric {
  /** Uppercase caption, e.g. "TURNED DORMANT". */
  label: string;
  /** The headline value, e.g. "6" or "147.0" or "₹1.2Cr". */
  value: string;
  /** Optional emphasis sub-label, e.g. "13.3%". */
  sub?: string;
}

/** A chart + the written observation that goes with it. */
export interface ChartSpec {
  title: string;
  /** 1-2 sentence observation with specific numbers. */
  insight: string;
  /** A complete Apache ECharts v5 options object. */
  echarts: Record<string, unknown>;
}

/** A markdown-style detail table rendered in the dashboard. */
export interface DataTableSpec {
  title: string;
  columns: string[];
  rows: (string | number | null)[][];
}

/** The full structured analytical answer Scout renders on the right pane. */
export interface Dashboard {
  title: string;
  subtitle?: string;
  /** The highlighted executive-summary paragraph. */
  summary: string;
  heroMetrics: HeroMetric[];
  charts: ChartSpec[];
  tables?: DataTableSpec[];
  recommendations?: string[];
}

// ===================================================

/** A SQL query that was executed during the analysis (for "Export SQL"). */
export interface ExecutedQuery {
  purpose: string;
  sql: string;
  rowCount: number;
  elapsedMs?: number;
}

// ── Streaming events (NDJSON, one JSON object per line) ──────────────────────

export type StepKind = "discover" | "graph" | "inspect" | "query" | "think";
export type StepStatus = "running" | "done" | "error";

/** A reasoning step shown as a chip in the chat panel. */
export interface StepEvent {
  type: "step";
  id: string;
  kind: StepKind;
  status: StepStatus;
  label: string;
  detail?: string;
}

/** Streamed conversational text from the agent ("I found 53 HVCs..."). */
export interface TextEvent {
  type: "text";
  delta: string;
}

/** The final dashboard payload. */
export interface DashboardEvent {
  type: "dashboard";
  dashboard: Dashboard;
  queries: ExecutedQuery[];
}

/** A single clarifying question - the agent stops and waits for the user. */
export interface ClarificationEvent {
  type: "clarification";
  text: string;
}

export interface ErrorEvent {
  type: "error";
  message: string;
}

export interface DoneEvent {
  type: "done";
  sessionId?: string;
}

export type ScoutEvent =
  | StepEvent
  | TextEvent
  | DashboardEvent
  | ClarificationEvent
  | ErrorEvent
  | DoneEvent;

/** A turn in the conversation history sent from the client. */
export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

// ── Client-side conversation model (how the chat panel renders a turn) ───────

/** An ordered piece of an assistant turn: narration text or a reasoning step. */
export type AgentBlock =
  | { type: "text"; text: string }
  | {
      type: "step";
      id: string;
      kind: StepKind;
      status: StepStatus;
      label: string;
      detail?: string;
    };

/** A rendered conversation turn. User turns carry text; assistant turns carry blocks. */
export interface UITurn {
  role: "user" | "assistant";
  text?: string;
  blocks?: AgentBlock[];
  /** Index into the dashboard versions list, if this turn produced one. */
  versionIndex?: number;
}

export interface AgentResult {
  dashboard: Dashboard | null;
  queries: ExecutedQuery[];
  clarified: boolean;
}

// Runtime coercion of model output → a valid Dashboard lives in lib/agent/phases.ts
// (normalizeDashboard), keeping this file types-only.
