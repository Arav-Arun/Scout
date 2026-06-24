import { createClient, type ClickHouseClient } from "@clickhouse/client";

// ─────────────────────────────────────────────────────────────────────────────
// DATA ACCESS LAYER  ·  lib/db/clickhouse.ts
//
// Read-only by policy: the agent may only run SELECT / DESCRIBE / SHOW. We enforce
// this in `assertReadOnly` before every query so that a misbehaving prompt can
// never mutate the warehouse.
//
// ▸ CALL MAP (who calls what):
//   - lib/agent/phases.ts (the AGENT) imports describeTable/runSelect from here.
//   - lib/db/catalog.ts builds the cached warehouse map on top of runSelect.
//   - lib/db/ingest.ts (the WRITE path) imports runSelect/describeTable to dedupe uploads.
//   - lib/api.ts (db-info handler) reads only env (host/db) for the UI banner.
//
// The single ClickHouse client (getClient) is connect-once / reuse-forever: we do NOT
// reconnect on every question. The schema cache lives in lib/db/catalog.ts; the write
// transport (CREATE/INSERT) lives in lib/db/ingest.ts (chExec).
// ─────────────────────────────────────────────────────────────────────────────

let _client: ClickHouseClient | null = null;

/** The configured database name (defaults to "default"). */
export function dbName(): string {
  return process.env.CLICKHOUSE_DATABASE || "default";
}

/** The one shared ClickHouse connection. Created on first use, reused forever. */
export function getClient(): ClickHouseClient {
  if (_client) return _client;
  const url = process.env.CLICKHOUSE_HOST;
  if (!url) throw new Error("CLICKHOUSE_HOST is not set");
  _client = createClient({
    url,
    username: process.env.CLICKHOUSE_USER || "default",
    password: process.env.CLICKHOUSE_PASSWORD || "",
    database: dbName(),
    request_timeout: 120_000,
    // Keep the underlying socket warm so a power user firing many questions in a
    // row reuses one connection instead of paying TCP/TLS setup each time.
    keep_alive: { enabled: true },
    clickhouse_settings: {
      // Defense-in-depth: readonly=2 lets us read (incl. system tables) and tune
      // per-query settings, but blocks any write/DDL at the server.
      readonly: "2",
    },
  });
  return _client;
}

/**
 * Throw unless `sql` is a single read-only statement.
 *
 * Read-only is enforced by an allowlist on the *leading* statement keyword plus a
 * ban on stacked statements. A statement that begins with SELECT/WITH/DESCRIBE/
 * SHOW/EXPLAIN and contains no `;` cannot mutate data - write/DDL verbs (INSERT,
 * DROP, ALTER, …) can only run as a leading keyword, which the allowlist rejects.
 * (A blanket keyword blocklist is intentionally avoided: it false-positives on the
 * `system` database, columns named `set`, string literals, etc.)
 */
export function assertReadOnly(sql: string): void {
  const trimmed = sql.trim().replace(/;+\s*$/, "");
  if (!trimmed) throw new Error("Empty query");
  // Block stacked statements (anything after a `;`).
  if (trimmed.includes(";")) {
    throw new Error("Multiple statements are not allowed - run one query at a time");
  }
  const head = trimmed.replace(/^\(+/, "").trimStart();
  if (!/^(SELECT|WITH|DESCRIBE|DESC|SHOW|EXPLAIN)\b/i.test(head)) {
    throw new Error("Only SELECT / WITH / DESCRIBE / SHOW / EXPLAIN queries are allowed");
  }
}

export interface QueryResult {
  columns: { name: string; type: string }[];
  rows: Record<string, unknown>[];
  rowCount: number;
  elapsedMs: number;
  truncated: boolean;
}

/** Execute a validated read-only query and return rows as JSON. */
export async function runSelect(
  sql: string,
  opts?: { settings?: Record<string, string | number> },
): Promise<QueryResult> {
  assertReadOnly(sql);
  const started = Date.now();
  // Per-query settings (e.g. a max_execution_time cap for the graph-verification probes)
  // are allowed under readonly=2; they merge over the client's defaults.
  const rs = await getClient().query({ query: sql, format: "JSON", clickhouse_settings: opts?.settings });
  const json = (await rs.json()) as {
    meta?: { name: string; type: string }[];
    data?: Record<string, unknown>[];
    rows?: number;
    statistics?: { elapsed?: number };
  };
  const rows = json.data ?? [];
  return {
    columns: json.meta ?? [],
    rows,
    rowCount: typeof json.rows === "number" ? json.rows : rows.length,
    elapsedMs: json.statistics?.elapsed
      ? Math.round(json.statistics.elapsed * 1000)
      : Date.now() - started,
    truncated: false,
  };
}

export interface TableInfo {
  name: string;
  columns: { name: string; type: string }[];
}

/** Column list + types for a single table. Sanitizes table input defensively. */
export async function describeTable(table: string): Promise<TableInfo> {
  const safe = table.replace(/[^a-zA-Z0-9_]/g, "");
  const res = await runSelect(`DESCRIBE TABLE \`${safe}\``);
  return {
    name: safe,
    columns: res.rows.map((r) => ({
      name: String(r.name),
      type: String(r.type),
    })),
  };
}
