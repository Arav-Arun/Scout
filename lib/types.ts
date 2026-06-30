// Shared types for Scout: the streaming protocol between the agent and the UI,
// and the structured dashboard the agent emits as its final answer.

// ── Dashboard shape ──

/** A single big number shown at the top of a dashboard. */
export interface HeroMetric {
  /** Uppercase caption, e.g. "TURNED DORMANT". */
  label: string;
  /** The headline value, e.g. "6" or "147.0" or "₹1.2Cr". */
  value: string;
  /** Optional emphasis sub-label, e.g. "13.3%". */
  sub?: string;
}

/** A chart + the written observation that goes with it. Rendered by ChartCard
 *  (components/DashboardPanel.tsx), which delegates to components/EChart.tsx. */
export interface ChartSpec {
  title: string;
  /** 1-2 sentence observation with specific numbers. */
  insight: string;
  /** A complete Apache ECharts v5 options object. */
  echarts: Record<string, unknown>;
}

/** A detail table rendered in the dashboard by DataTable (components/DashboardPanel.tsx),
 *  which right-aligns numeric-looking cells. */
export interface DataTableSpec {
  title: string;
  columns: string[];
  rows: (string | number | null)[][];
}

/** The full structured answer Scout renders on the right pane. Built by normalizeDashboard
 *  (lib/agent/phases.ts), streamed in a DashboardEvent, and rendered by DashboardPanel.tsx. */
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

/** A SQL query that was executed during the analysis (for "Export SQL"). */
export interface ExecutedQuery {
  purpose: string;
  sql: string;
  rowCount: number;
  elapsedMs?: number;
}

// ── Streaming events ──
// The agent streams events as NDJSON (one JSON object per line) rather than one response.

/** The 5 kinds of reasoning step, each mapped to a chip in the left chat-panel UI. */
export type StepKind = "discover" | "graph" | "inspect" | "query" | "think";
/** Status of an individual chip. */
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

/** A single clarifying question; the agent stops and waits for the user. Emitted when the
 *  planner sets needs_clarification (workflow.ts). A distinct type so the client can treat
 *  it specially rather than as plain text. */
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

// The streaming protocol: a discriminated union keyed on `type`. The client narrows on
// e.type (useScoutAgent.ts); the server emits through emit: (e: ScoutEvent) => void.
export type ScoutEvent =
  | StepEvent
  | TextEvent
  | DashboardEvent
  | ClarificationEvent
  | ErrorEvent
  | DoneEvent;

/** A turn in the conversation history sent from the client (same {role, content} shape as
 *  OpenAI messages). Consumed by runScoutWorkflow(history) for multi-turn follow-ups. */
export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

// ── Client-side conversation model ──
// The server speaks ScoutEvents; the client rebuilds them into this render tree.

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

/** A rendered conversation turn. User turns carry text; assistant turns carry blocks.
 *  versionIndex ties an assistant turn to the dashboard version it produced (the
 *  "View dashboard v1" button in ChatPanel.tsx). */
export interface UITurn {
  role: "user" | "assistant";
  text?: string;
  blocks?: AgentBlock[];
  /** Index into the dashboard versions list, if this turn produced one. */
  versionIndex?: number;
}

/** The return value of runScoutWorkflow — a server-side summary (the answer itself reaches
 *  the UI via emit). `dashboard` is null if the agent clarified or failed; `clarified`
 *  records whether it stopped to ask. */
export interface AgentResult {
  dashboard: Dashboard | null;
  queries: ExecutedQuery[];
  clarified: boolean;
}

// Runtime coercion of model output → a valid Dashboard lives in lib/agent/phases.ts
// (normalizeDashboard), keeping this file types-only.
