// persist.ts — the single canonical, read-back store for the recovered + verified schema
// graph, in ClickHouse (scout_schema_graph_edges / _nodes). This is not an append-only audit
// log: each materialization writes the whole graph under a fresh built_at and then prunes the
// older snapshot, so the tables always hold exactly ONE graph. loadStoredGraph() reads it back
// (no re-verification) — that's what the agent's RELATE phase and the graph viewer consume, so
// the expensive build/verify runs only when the graph is materialized, not per conversation.
//
// Writes use the HTTP write transport (lib/db/write.ts), not the read-only analytics client;
// reads use the read-only client (runSelect). Each edge carries both `source`
// (declared/inferred, drives build priority) and `connection` (manual/physical, the human-vs-
// structural distinction the UI differentiates on). Phantom edges VERIFY dropped are persisted
// too (status = 'dropped') for inspection.

import { dbName, runSelect } from "../db/clickhouse";
import type { Catalog } from "../db/catalog";
import { chExec } from "../db/write";
import { connectionOf, isMetaTable, tableDomain } from "./relationships";
import type { GraphEdge, SchemaGraph } from "./schema-graph";

const EDGES_TABLE = "scout_schema_graph_edges";
const NODES_TABLE = "scout_schema_graph_nodes";
const STRONG_OVERLAP = 0.5; // mirrors schema-graph.ts: ≥ this ⇒ "verified"

/** verified | partial | dropped | unjudged — derived from the measured overlap. */
function statusOf(e: GraphEdge): string {
  if (e.overlap === undefined) return "unjudged";
  if (e.overlap === 0) return "dropped";
  return e.overlap >= STRONG_OVERLAP ? "verified" : "partial";
}

/** ClickHouse DateTime64(3) literal (UTC, millisecond precision). */
function chDateTime(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace("Z", "");
}

function qualified(table: string): string {
  return `\`${dbName()}\`.\`${table}\``;
}

async function ensureTables(): Promise<void> {
  await chExec(
    `CREATE TABLE IF NOT EXISTS ${qualified(EDGES_TABLE)} (
      built_at DateTime64(3),
      a String, a_col String, b String, b_col String,
      label String,
      source LowCardinality(String),
      connection LowCardinality(String),
      overlap Nullable(Float64),
      status LowCardinality(String),
      verified UInt8
    ) ENGINE = MergeTree ORDER BY (built_at, a, b)`,
  );
  // Migrate an edges table created before `connection` existed (idempotent no-op otherwise).
  await chExec(
    `ALTER TABLE ${qualified(EDGES_TABLE)} ADD COLUMN IF NOT EXISTS connection LowCardinality(String) AFTER source`,
  );
  await chExec(
    `CREATE TABLE IF NOT EXISTS ${qualified(NODES_TABLE)} (
      built_at DateTime64(3),
      table String,
      row_count UInt64,
      col_count UInt32,
      domain LowCardinality(String)
    ) ENGINE = MergeTree ORDER BY (built_at, table)`,
  );
}

/** Drop every snapshot older than `keepLiteral` so the tables hold only the latest graph.
 *  Best-effort: reads filter by max(built_at), so correctness never depends on this landing. */
async function pruneOlderThan(keepLiteral: string): Promise<void> {
  const cutoff = `built_at < toDateTime64('${keepLiteral}', 3)`;
  try {
    await chExec(`ALTER TABLE ${qualified(EDGES_TABLE)} DELETE WHERE ${cutoff}`);
    await chExec(`ALTER TABLE ${qualified(NODES_TABLE)} DELETE WHERE ${cutoff}`);
  } catch {
    // Pruning is housekeeping; a failure just leaves an older snapshot behind, still overridden
    // by the newer built_at on read.
  }
}

/** Bulk-insert rows as JSONEachRow (Nullable columns accept explicit JSON null). */
async function insertRows(table: string, rows: Record<string, unknown>[]): Promise<void> {
  if (!rows.length) return;
  const body = rows.map((r) => JSON.stringify(r)).join("\n");
  await chExec(`INSERT INTO ${qualified(table)} FORMAT JSONEachRow`, body);
}

/**
 * Materialize the (already built + verified) schema graph as the single canonical graph in
 * ClickHouse: write the whole graph under a fresh built_at, then prune the older snapshot so
 * only this one remains. Pass the graph from materializeSchemaGraph(); its `droppedEdges`
 * carry the phantoms.
 */
export async function persistSchemaGraph(graph: SchemaGraph): Promise<void> {
  await ensureTables();

  const builtAt = chDateTime(graph.builtAt);
  const kept = graph.edges;
  const dropped = graph.droppedEdges ?? [];

  const edgeRows = [...kept, ...dropped].map((e) => ({
    built_at: builtAt,
    a: e.a,
    a_col: e.aCol,
    b: e.b,
    b_col: e.bCol,
    label: e.label,
    source: e.source,
    connection: connectionOf(e.source),
    overlap: e.overlap ?? null,
    status: statusOf(e),
    verified: e.verified ? 1 : 0,
  }));

  const nodeRows = [...graph.nodes.entries()].map(([table, n]) => ({
    built_at: builtAt,
    table,
    row_count: n.rowCount,
    col_count: n.columns.length,
    domain: tableDomain(table),
  }));

  await insertRows(EDGES_TABLE, edgeRows);
  await insertRows(NODES_TABLE, nodeRows);
  // One graph, not a history: drop anything older than the snapshot we just wrote.
  await pruneOlderThan(builtAt);
}

/**
 * Read the single stored graph back into an in-memory SchemaGraph, with NO re-verification —
 * the edges keep the overlap/verified verdicts measured at materialization time. Nodes
 * (row counts + column lists) come from the live catalog (cheap, cached); edges come from the
 * stored snapshot. Returns null if nothing has been materialized yet (so the caller can
 * materialize once), or if the store is unreachable.
 *
 * Kept-vs-dropped mirrors verifyEdges() exactly (a confirmed phantom is an inferred edge at 0%
 * overlap; declared edges are never dropped), rather than trusting the stored `status` label.
 */
export async function loadStoredGraph(catalog: Catalog): Promise<SchemaGraph | null> {
  let rows: Record<string, unknown>[];
  let builtMs = 0;
  try {
    const res = await runSelect(
      `SELECT a, a_col, b, b_col, label, source, overlap, verified, ` +
        `toUnixTimestamp64Milli(built_at) AS built_ms ` +
        `FROM ${qualified(EDGES_TABLE)} ` +
        `WHERE built_at = (SELECT max(built_at) FROM ${qualified(EDGES_TABLE)})`,
    );
    rows = res.rows;
  } catch {
    return null; // table not created yet, or warehouse unreachable — caller materializes
  }
  if (!rows.length) return null; // never materialized

  const tables = catalog.tables.filter((t) => !isMetaTable(t.name)); // exclude Scout's own tables
  const present = new Set(tables.map((t) => t.name));
  const nodes = new Map<string, { rowCount: number; columns: string[] }>();
  const adj = new Map<string, GraphEdge[]>();
  for (const t of tables) {
    nodes.set(t.name, { rowCount: catalog.rowCounts[t.name] ?? 0, columns: t.columns.map((c) => c.name) });
    adj.set(t.name, []);
  }

  const kept: GraphEdge[] = [];
  const droppedEdges: GraphEdge[] = [];
  for (const r of rows) {
    const source = String(r.source) === "inferred" ? "inferred" : "declared";
    const overlap = r.overlap === null || r.overlap === undefined ? undefined : Number(r.overlap);
    const e: GraphEdge = {
      a: String(r.a), b: String(r.b), aCol: String(r.a_col), bCol: String(r.b_col),
      label: String(r.label), source, overlap, verified: Number(r.verified) === 1,
    };
    if (!present.has(e.a) || !present.has(e.b)) continue; // table dropped since materialization
    builtMs = Math.max(builtMs, Number(r.built_ms) || 0);
    if (e.source !== "declared" && e.overlap === 0) droppedEdges.push(e);
    else kept.push(e);
  }
  for (const e of kept) {
    adj.get(e.a)?.push(e);
    adj.get(e.b)?.push(e);
  }
  return { nodes, adj, edges: kept, droppedEdges, builtAt: builtMs || Date.now() };
}
