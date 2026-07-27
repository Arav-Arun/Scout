import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { connectionKey, currentConnection, databaseName, type Connection } from "./connection";

// Read-only data access layer, scoped to the connection the visitor linked (connection.ts).
// The agent may only run SELECT / DESCRIBE / SHOW; assertReadOnly enforces this before every
// query so a misbehaving prompt can never mutate someone's warehouse. Clients are pooled per
// connection so a returning visitor reuses a warm socket. The schema cache lives in
// catalog.ts; the write transport (CREATE/INSERT) lives in write.ts (chExec).

/** The configured database name for the active connection. */
export function dbName(): string {
  return databaseName();
}

// One client per linked connection, kept warm across requests. Bounded so a busy public
// deployment can't accumulate sockets for every warehouse anyone ever tried.
const MAX_POOLED_CLIENTS = 24;
const _clients = new Map<string, ClickHouseClient>();

/** Ceiling on the setup tour's connection test (see pingConnection). */
const PING_TIMEOUT_MS = 25_000;

function buildClient(conn: Connection, requestTimeoutMs = 120_000): ClickHouseClient {
  return createClient({
    url: conn.url,
    username: conn.username || "default",
    password: conn.password || "",
    database: conn.database,
    request_timeout: requestTimeoutMs,
    // Keep the underlying socket warm so a power user firing many questions in a
    // row reuses one connection instead of paying TCP/TLS setup each time.
    keep_alive: { enabled: true },
    // Defense-in-depth: readonly=2 lets us read (incl. system tables) and tune per-query
    // settings, but blocks any write/DDL at the server. Omitted when the user is already
    // pinned read-only server-side, because such a server refuses the settings change and
    // would fail every query - and its own readonly is at least as strict anyway.
    clickhouse_settings: conn.readonlyLocked ? undefined : { readonly: "2" },
  });
}

/** The pooled ClickHouse client for the active connection. */
export function getClient(): ClickHouseClient {
  const conn = currentConnection();
  const k = connectionKey(conn);
  const hit = _clients.get(k);
  if (hit) return hit;

  // Evict the least-recently-created client once the pool is full (Map preserves insertion order).
  if (_clients.size >= MAX_POOLED_CLIENTS) {
    const oldest = _clients.keys().next().value;
    if (oldest) {
      _clients.get(oldest)?.close().catch(() => {});
      _clients.delete(oldest);
    }
  }

  const client = buildClient(conn);
  _clients.set(k, client);
  return client;
}

/** Drop the pooled client for a connection (called on disconnect). */
export function releaseClient(conn: Connection): void {
  const k = connectionKey(conn);
  _clients.get(k)?.close().catch(() => {});
  _clients.delete(k);
}

/** ClickHouse's refusal when the user is already pinned read-only and we try to set readonly=2. */
const READONLY_LOCKED = /cannot modify ['"]?readonly['"]? setting/i;

/** One trivial query on a throwaway client. Returns the server version, or throws. */
async function tryPing(conn: Connection): Promise<string> {
  // Short timeout: a typo in the host should come back in seconds, not after the analytics
  // client's two-minute ceiling. Long enough that an idle Cloud service still has time to wake.
  const client = buildClient(conn, PING_TIMEOUT_MS);
  try {
    const rs = await client.query({ query: "SELECT version() AS v", format: "JSON" });
    const json = (await rs.json()) as { data?: { v?: string }[] };
    return String(json.data?.[0]?.v ?? "unknown");
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * Test a connection's credentials before anything is remembered, so the setup tour can report
 * "connected" or the exact ClickHouse error.
 *
 * Also settles how Scout must talk to this server. A user who is already `readonly=1` - the
 * hardened setup the tour actively recommends - rejects our own `readonly=2` and would fail
 * every single query. Detect that here and hand back a Connection that stops sending it; the
 * server's own restriction is at least as strict, so nothing is loosened.
 */
export async function pingConnection(conn: Connection): Promise<{ version: string; connection: Connection }> {
  try {
    return { version: await tryPing(conn), connection: conn };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!READONLY_LOCKED.test(msg)) throw e;
    const locked = { ...conn, readonlyLocked: true };
    return { version: await tryPing(locked), connection: locked };
  }
}

/**
 * Read-only is enforced by an allowlist on the leading statement keyword plus a
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
