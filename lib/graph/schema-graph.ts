// ─────────────────────────────────────────────────────────────────────────────
// SCHEMA GRAPH + RETRIEVAL  ·  lib/graph/schema-graph.ts   (the "Graph" in Graph RAG)
//
// Scout's warehouse is a graph: tables are NODES, the implicit join keys recovered in
// relationships.ts are EDGES. Classic RAG retrieves relevant *documents*; Graph RAG
// retrieves a relevant *subgraph*. Here we apply that to schema: given the tables the
// planner seeded, we retrieve the connected subgraph (the seeds + the bridge tables
// that link them + their key dimensions) and the exact join keys, instead of dumping
// all 34 tables flat into the prompt.
//
// ▸ CALL MAP:
//   - lib/agent/phases.ts (the RELATE phase) calls getSchemaGraph() + retrieveSubgraph().
//   - Built on top of lib/db/catalog.ts (getCatalog) so it shares the one warehouse scan.
//   - relationships.ts supplies the edges (curated + inferred).
// ─────────────────────────────────────────────────────────────────────────────

import { getCatalog, type Catalog } from "../db/catalog";
import type { TableInfo } from "../db/clickhouse";
import {
  CURATED_RELATIONSHIPS, inferRelationships, HUB_COLUMNS, type Relationship,
} from "./relationships";
import { verifySchemaGraph } from "./verify";

/** An undirected edge between two tables, carrying the exact join columns. */
export interface GraphEdge {
  a: string; // table (the child / referencing side)
  b: string; // table (the parent / key side)
  aCol: string;
  bCol: string;
  label: string;
  source: "curated" | "inferred";
  /** Lower = stronger/cheaper to traverse. Hub edges (via customers/city) cost more. */
  weight: number;
  /** Fraction of sampled `a.aCol` values that actually resolve to `b.bCol` in the LIVE data
   *  (set by lib/graph/verify.ts). undefined = not yet/can't be measured. */
  overlap?: number;
  /** True once the edge is data-verified (overlap ≥ STRONG_OVERLAP) - a real join key, not just a name match. */
  verified?: boolean;
}

export interface SchemaGraph {
  nodes: Map<string, { rowCount: number; columns: string[] }>;
  /** table -> edges incident to it. */
  adj: Map<string, GraphEdge[]>;
  edges: GraphEdge[];
  builtAt: number;
}

/** A retrieved subgraph: the relevant tables + how they join. */
export interface SubGraph {
  seeds: string[];
  tables: string[];
  edges: GraphEdge[];
}

// ── Build ────────────────────────────────────────────────────────────────────

function edgeKey(a: string, aCol: string, b: string, bCol: string): string {
  return a < b ? `${a}.${aCol}~${b}.${bCol}` : `${b}.${bCol}~${a}.${aCol}`;
}

function weightOf(r: Relationship): number {
  const hub = HUB_COLUMNS.has(r.from.column) || HUB_COLUMNS.has(r.to.column);
  const base = r.source === "inferred" ? 2 : 1;
  return hub ? base + 4 : base; // strongly de-prioritise routing through hub columns
}

/**
 * Build the schema graph from a catalog: nodes are the catalog tables, edges are the
 * curated + inferred relationships, filtered to tables that actually exist and
 * de-duplicated (curated wins over inferred for the same table pair + columns).
 */
export function buildSchemaGraph(catalog: Catalog): SchemaGraph {
  const present = new Set(catalog.tables.map((t) => t.name));
  const byName = new Map(catalog.tables.map((t) => [t.name, t]));
  const all: Relationship[] = [...CURATED_RELATIONSHIPS, ...inferRelationships(catalog.tables)];

  const seen = new Map<string, GraphEdge>();
  for (const r of all) {
    if (!present.has(r.from.table) || !present.has(r.to.table) || r.from.table === r.to.table) continue;
    // require the columns to really exist on both sides (defends against stale curation)
    if (!hasColumn(byName.get(r.from.table), r.from.column) || !hasColumn(byName.get(r.to.table), r.to.column)) continue;
    const k = edgeKey(r.from.table, r.from.column, r.to.table, r.to.column);
    const existing = seen.get(k);
    if (existing && existing.source === "curated") continue; // curated wins
    seen.set(k, {
      a: r.from.table, b: r.to.table, aCol: r.from.column, bCol: r.to.column,
      label: r.label, source: r.source ?? "curated", weight: weightOf(r),
    });
  }

  const edges = [...seen.values()];
  const adj = new Map<string, GraphEdge[]>();
  const nodes = new Map<string, { rowCount: number; columns: string[] }>();
  for (const t of catalog.tables) {
    nodes.set(t.name, { rowCount: catalog.rowCounts[t.name] ?? 0, columns: t.columns.map((c) => c.name) });
    adj.set(t.name, []);
  }
  for (const e of edges) {
    adj.get(e.a)?.push(e);
    adj.get(e.b)?.push(e);
  }
  return { nodes, adj, edges, builtAt: Date.now() };
}

function hasColumn(t: TableInfo | undefined, col: string): boolean {
  return !!t && t.columns.some((c) => c.name === col);
}

// ── Cache (aligned with the catalog) ─────────────────────────────────────────

let _graph: SchemaGraph | null = null;
let _graphCatalogAt = 0;
let _building: Promise<SchemaGraph> | null = null;
let _buildingForAt = 0;

/**
 * The schema graph, rebuilt only when the underlying catalog changes. The build
 * structures the graph (instant) then verifies its edges against the live data
 * (lib/graph/verify.ts) so phantom relationships are dropped and partial ones flagged.
 * Concurrent callers for the same catalog share one in-flight build.
 */
export async function getSchemaGraph(): Promise<SchemaGraph> {
  const cat = await getCatalog();
  if (_graph && _graphCatalogAt === cat.discoveredAt) return _graph;
  if (_building && _buildingForAt === cat.discoveredAt) return _building;

  _buildingForAt = cat.discoveredAt;
  _building = (async () => {
    const g = buildSchemaGraph(cat);
    try {
      await verifySchemaGraph(g); // annotate overlap/verified + drop measured-phantom edges
    } catch {
      // Verification is best-effort: a failure leaves the structural graph intact.
    }
    _graph = g;
    _graphCatalogAt = cat.discoveredAt;
    _building = null;
    return g;
  })();
  return _building;
}

// ── Traversal ────────────────────────────────────────────────────────────────

const other = (e: GraphEdge, n: string) => (e.a === n ? e.b : e.a);

/** Dijkstra shortest path (by edge weight) between two tables; [] if disconnected. */
export function findJoinPath(graph: SchemaGraph, from: string, to: string): GraphEdge[] {
  if (from === to) return [];
  const dist = new Map<string, number>([[from, 0]]);
  const prev = new Map<string, { node: string; edge: GraphEdge }>();
  const visited = new Set<string>();
  while (visited.size < graph.nodes.size) {
    let u: string | null = null;
    let best = Infinity;
    for (const [n, d] of dist) if (!visited.has(n) && d < best) { best = d; u = n; }
    if (u === null) break;
    if (u === to) break;
    visited.add(u);
    for (const e of graph.adj.get(u) ?? []) {
      const v = other(e, u);
      const nd = best + e.weight;
      if (nd < (dist.get(v) ?? Infinity)) { dist.set(v, nd); prev.set(v, { node: u, edge: e }); }
    }
  }
  if (!prev.has(to) && from !== to) return [];
  const path: GraphEdge[] = [];
  let cur = to;
  while (cur !== from) {
    const p = prev.get(cur);
    if (!p) return [];
    path.unshift(p.edge);
    cur = p.node;
  }
  return path;
}

/**
 * Retrieve the relevant connected subgraph for a set of seed tables (the heart of
 * Graph RAG retrieval over schema):
 *   1. Always include the seeds.
 *   2. Connect them: add the bridge tables on the shortest join path between seeds
 *      (so a question spanning customers + branches pulls in `accounts`).
 *   3. If room remains (maxTables), enrich with the strongest direct neighbours of the
 *      seeds (cheapest edges first) - typically the dimension tables.
 * Returns the table set + every edge among the included tables (the join map).
 */
export function retrieveSubgraph(
  graph: SchemaGraph,
  seedTables: string[],
  opts: { maxTables?: number } = {},
): SubGraph {
  const maxTables = opts.maxTables ?? 8;
  const seeds = seedTables.filter((t) => graph.nodes.has(t));
  const included = new Set<string>(seeds);

  // 2 · connect the seeds through bridge tables
  for (let i = 1; i < seeds.length; i++) {
    // connect seed i to the nearest already-included table
    let bestPath: GraphEdge[] | null = null;
    for (const anchor of included) {
      if (anchor === seeds[i]) { bestPath = []; break; }
      const p = findJoinPath(graph, seeds[i], anchor);
      if (p.length && (!bestPath || p.length < bestPath.length)) bestPath = p;
    }
    if (bestPath) for (const e of bestPath) { included.add(e.a); included.add(e.b); }
  }

  // 3 · enrich with the strongest direct neighbours of the seeds, cheapest first
  const candidates: { table: string; weight: number }[] = [];
  for (const s of seeds) {
    for (const e of graph.adj.get(s) ?? []) {
      const n = other(e, s);
      if (!included.has(n)) candidates.push({ table: n, weight: e.weight });
    }
  }
  candidates.sort((x, y) => x.weight - y.weight);
  for (const c of candidates) {
    if (included.size >= maxTables) break;
    included.add(c.table);
  }

  const tables = [...included];
  const tableSet = new Set(tables);
  const edges = graph.edges.filter((e) => tableSet.has(e.a) && tableSet.has(e.b));
  return { seeds, tables, edges };
}

// ── Prompt / display formatting ──────────────────────────────────────────────

/** The subgraph rendered as a "JOIN GRAPH" block the analyst LLM reads. */
export function formatGraphForPrompt(sub: SubGraph): string {
  if (!sub.edges.length) {
    return `JOIN GRAPH\n(the selected tables have no known relationships; query them independently)`;
  }
  const lines = sub.edges
    .map((e) => {
      // Flag a partial edge (verified against live data, but only some keys resolve) so the
      // analyst knows the join is lossy - e.g. market_sales.customer_id only ~6% in customers.
      const partial =
        e.verified === false && e.overlap !== undefined
          ? `  [PARTIAL: only ~${Math.round(e.overlap * 100)}% of ${e.a}.${e.aCol} values match ${e.b}.${e.bCol}; an inner join drops the rest]`
          : "";
      return `- ${e.a}.${e.aCol} = ${e.b}.${e.bCol}  (${e.a} ${e.label} ${e.b})${partial}`;
    })
    .join("\n");
  return `JOIN GRAPH (tables have NO foreign keys; these join keys are RECOVERED and VERIFIED against the live data - edges with no real value overlap have been dropped)\nTables: ${sub.tables.join(", ")}\n${lines}`;
}

/** Short one-line summary for the step chip, e.g. "linked 5 tables via customer_id, card_id". */
export function summarizeSubgraph(sub: SubGraph): string {
  const cols = [...new Set(sub.edges.flatMap((e) => [e.aCol, e.bCol]))]
    .filter((c) => /_id$|^merchant$|^city$|^product$|^branch$/.test(c))
    .slice(0, 4);
  const bridges = sub.tables.filter((t) => !sub.seeds.includes(t));
  const via = cols.length ? ` via ${cols.join(", ")}` : "";
  return bridges.length
    ? `linked ${sub.tables.length} tables${via} (+${bridges.length} bridge)`
    : `${sub.tables.length} table${sub.tables.length === 1 ? "" : "s"}${via}`;
}
