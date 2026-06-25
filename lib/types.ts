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
// Rendered by ChartCard (components/DashboardPanel.tsx), which delegates to components/EChart.tsx.
export interface ChartSpec {
  title: string;
  /** 1-2 sentence observation with specific numbers. */
  insight: string;
  /** A complete Apache ECharts v5 options object. */
  echarts: Record<string, unknown>;
}

/** A markdown-style detail table rendered in the dashboard. */
// Rendered by DataTable (components/DashboardPanel.tsx), which right-aligns numeric-looking cells.
export interface DataTableSpec {
  title: string;
  columns: string[];
  rows: (string | number | null)[][];
}

/** The full structured analytical answer Scout renders on the right pane. */
// The contract between LLM output and the renderer: the single structured object
// that represents a complete answer. Built by normalizeDashboard in lib/agent/phases.ts,
// emitted inside a DashboardEvent, stored as a DashboardVersion on the client, and
// rendered by DashboardPanel.tsx.
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
// The agent never returns one big response; it streams events as NDJSON (one JSON
// object per line) while it works.

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

/** A single clarifying question - the agent stops and waits for the user. */
// Emitted from the orchestrator when the planner sets needs_clarification (workflow.ts).
// It's a distinct type (not just text) so the client can treat it specially.
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

// The streaming protocol: a discriminated union keyed on `type`, which lets the
// client's handle() switch on e.type and have TypeScript narrow each case exactly
// (useScoutAgent.ts). The server side mirrors it: emit: (e: ScoutEvent) => void is
// the callback every phase uses.
export type ScoutEvent =
  | StepEvent
  | TextEvent
  | DashboardEvent
  | ClarificationEvent
  | ErrorEvent
  | DoneEvent;

/** A turn in the conversation history sent from the client. */
// Same {role, content} shape as OpenAI's messages. Consumed by runScoutWorkflow(history)
// and read by lastUser() / historyText(); the client maintains it for multi-turn follow-ups.
export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

// ── Client-side conversation model (how the chat panel renders a turn) ───────
// The server speaks ScoutEvents; the client rebuilds them into a render tree.

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
// versionIndex ties an assistant turn to the dashboard version it produced, which is
// what makes the "View dashboard v1" button work (ChatPanel.tsx).
export interface UITurn {
  role: "user" | "assistant";
  text?: string;
  blocks?: AgentBlock[];
  /** Index into the dashboard versions list, if this turn produced one. */
  versionIndex?: number;
}

// The return value of runScoutWorkflow. Separate from the streaming path: the answer
// reaches the UI via emit, while this struct is the server-side summary of what happened.
// `dashboard` is null if it clarified or failed; `clarified` records whether it stopped to ask.
export interface AgentResult {
  dashboard: Dashboard | null;
  queries: ExecutedQuery[];
  clarified: boolean;
}

// Runtime coercion of model output → a valid Dashboard lives in lib/agent/phases.ts
// (normalizeDashboard), keeping this file types-only.
