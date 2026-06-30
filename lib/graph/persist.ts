// persist.ts — writes a durable, queryable snapshot of the recovered + verified schema
// graph into the warehouse (ClickHouse scout_schema_graph_edges / _nodes), so the graph is
// an inspectable artifact rather than only an in-memory structure.
//
// Writes use the HTTP write transport (lib/db/write.ts), not the read-only analytics client.
// Triggered on every file upload (app/api route) and on demand via `npm run graph:persist`.
// Each run appends a snapshot tagged by built_at (latest = max(built_at)). The full probed
// candidate set is persisted, including phantom edges VERIFY dropped (status = 'dropped').

import { dbName } from "../db/clickhouse";
import { chExec } from "../db/write";
import { tableDomain } from "./relationships";
import type { GraphEdge, SchemaGraph } from "./schema-graph";

const EDGES_TABLE = "scout_schema_graph_edges";
const NODES_TABLE = "scout_schema_graph_nodes";
const STRONG_OVERLAP = 0.5; // mirrors schema-graph.ts: ≥ this ⇒ "verified"

export interface PersistResult {
  builtAt: number;
  edges: number; // verified + partial + un-judged (kept in the traversable graph)
  dropped: number; // confirmed phantoms (0% overlap)
  nodes: number;
}

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
      overlap Nullable(Float64),
      status LowCardinality(String),
      verified UInt8
    ) ENGINE = MergeTree ORDER BY (built_at, a, b)`,
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

/** Bulk-insert rows as JSONEachRow (Nullable columns accept explicit JSON null). */
async function insertRows(table: string, rows: Record<string, unknown>[]): Promise<void> {
  if (!rows.length) return;
  const body = rows.map((r) => JSON.stringify(r)).join("\n");
  await chExec(`INSERT INTO ${qualified(table)} FORMAT JSONEachRow`, body);
}

/**
 * Write one snapshot of the (already built + verified) schema graph to ClickHouse.
 * Pass the graph returned by getSchemaGraph(); its `droppedEdges` carry the phantoms.
 */
export async function persistSchemaGraph(graph: SchemaGraph): Promise<PersistResult> {
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

  return { builtAt: graph.builtAt, edges: kept.length, dropped: dropped.length, nodes: nodeRows.length };
}
