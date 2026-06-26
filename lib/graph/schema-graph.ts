// ─────────────────────────────────────────────────────────────────────────────--------
// Scout's warehouse is a graph: tables are NODES and the join keys recovered in
// relationships.ts are EDGES.
// Graph RAG retrieves a relevant subgraph. Given the tables the planner seeded, we hand the
// analyst just those tables, the bridge tables needed to join them, and the EXACT join
// keys - instead of dumping every table flat into the prompt and hoping it guesses the
// joins (this warehouse has no foreign keys).
//
// This file is the whole graph pipeline, top to bottom:
//   1. BUILD    - assemble nodes + edges from the curated/inferred relationships.
//   2. VERIFY   - probe each edge against the LIVE data; drop phantom joins.
//   3. RETRIEVE - walk from the seed tables to the relevant connected subgraph.
//   4. FORMAT   - render that subgraph as the "JOIN GRAPH" text the analyst reads.
//
// ▸ CALL MAP:
//   - lib/agent/phases.ts (the RELATE phase) calls getSchemaGraph() + retrieveSubgraph().
//   - app/api/[[...route]]/route.ts (/api/graph) reads the built graph for the in-app viewer.
//   - relationships.ts supplies the candidate edges (curated manifest + auto-inference).
// ─────────────────────────────────────────────────────────────────────────────------------

import { getCatalog, type Catalog } from "../db/catalog";
import { runSelect, type TableInfo } from "../db/clickhouse";
import {
  CURATED_RELATIONSHIPS, inferRelationships, HUB_COLUMNS, type Relationship,
} from "./relationships";

/** An undirected edge between two tables, carrying the exact join columns. */
export interface GraphEdge {
  a: string; // table (the child / referencing side)
  b: string; // table (the parent / key side)
  aCol: string;
  bCol: string;
  label: string;
  source: "curated" | "inferred";
  /** Fraction of sampled `a.aCol` values that actually resolve to `b.bCol` in the LIVE
   *  data (set by VERIFY). undefined = not yet / couldn't be measured. */
  overlap?: number;
  /** True once the edge is data-verified (overlap ≥ STRONG_OVERLAP) - a real join key,
   *  not just a column-name coincidence. */
  verified?: boolean;
}

export interface SchemaGraph {
  nodes: Map<string, { rowCount: number; columns: string[] }>;
  /** table -> edges incident to it (adjacency list). */
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

// Helpers shared across the file.
const other = (e: GraphEdge, n: string) => (e.a === n ? e.b : e.a);
/** A hub edge joins on a column that lives in many tables (customer_id, city). Routing a
 *  bridge through one would link two unrelated tables just because both carry that column. */
const isHubEdge = (e: GraphEdge) => HUB_COLUMNS.has(e.aCol) || HUB_COLUMNS.has(e.bCol);

// ── 1 · BUILD ────────────────────────────────────────────────────────────────

function edgeKey(a: string, aCol: string, b: string, bCol: string): string {
  return a < b ? `${a}.${aCol}~${b}.${bCol}` : `${b}.${bCol}~${a}.${aCol}`;
}

function hasColumn(t: TableInfo | undefined, col: string): boolean {
  return !!t && t.columns.some((c) => c.name === col);
}

/**
 * Build the schema graph from a catalog: nodes are the catalog tables, edges are the
 * curated + inferred relationships, filtered to tables/columns that actually exist and
 * de-duplicated (curated wins over inferred for the same table pair + columns).
 */
export function buildSchemaGraph(catalog: Catalog): SchemaGraph {
  const present = new Set(catalog.tables.map((t) => t.name));
  const byName = new Map(catalog.tables.map((t) => [t.name, t]));
  const all: Relationship[] = [...CURATED_RELATIONSHIPS, ...inferRelationships(catalog.tables)];

  const seen = new Map<string, GraphEdge>();
  for (const r of all) {
    if (!present.has(r.from.table) || !present.has(r.to.table) || r.from.table === r.to.table) continue;
    // Require the columns to really exist on both sides (defends against stale curation).
    if (!hasColumn(byName.get(r.from.table), r.from.column) || !hasColumn(byName.get(r.to.table), r.to.column)) continue;
    const k = edgeKey(r.from.table, r.from.column, r.to.table, r.to.column);
    if (seen.get(k)?.source === "curated") continue; // curated wins over a duplicate inferred edge
    seen.set(k, {
      a: r.from.table, b: r.to.table, aCol: r.from.column, bCol: r.to.column,
      label: r.label, source: r.source ?? "curated",
    });
  }

  const edges = [...seen.values()];
  const nodes = new Map<string, { rowCount: number; columns: string[] }>();
  const adj = new Map<string, GraphEdge[]>();
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

// ── 2 · VERIFY (makes the graph REAL, not asserted) ──────────────────────────
// A shared column name does NOT prove two columns join: here
// `account_transactions.txn_id` and `card_transactions.txn_id` share a name yet have
// ZERO overlapping values (an inner join returns nothing). So we measure each edge
// against the live data - what fraction of a child key's sampled distinct values
// actually resolve to a parent key - then drop the phantoms and mark the rest verified
// or partial. Fail-open: a probe error/timeout leaves the edge un-judged rather than
// dropping a possibly-real key.

/** Distinct child key values sampled per edge (keeps the probe cheap on crore-row tables). */
const SAMPLE = 400;
/** ≥ this fraction of sampled child keys resolving to the parent ⇒ a real ("verified") join key. */
const STRONG_OVERLAP = 0.5;
const VERIFY_CONCURRENCY = 8;
const VERIFY_TTL_MS = 30 * 60_000;

const _overlapCache = new Map<string, { overlap: number; at: number }>();
const edgeSig = (e: GraphEdge) => `${e.a}.${e.aCol}~${e.b}.${e.bCol}`;

/**
 * Measure how many of a sample of DISTINCT child keys (`a.aCol`) actually exist among the
 * parent keys (`b.bCol`). Returns the overlap fraction, or null if it can't be judged
 * (empty child, probe error/timeout). Uses an `IN (subquery)` semi-join - NOT a LEFT JOIN,
 * because ClickHouse fills unmatched LEFT-JOIN cells with type defaults (not NULL), which
 * would make every edge look like a 100% match.
 */
async function probeOverlap(e: GraphEdge): Promise<number | null> {
  const sql =
    `SELECT count() AS sampled, ` +
    `countIf(toString(k) IN (SELECT toString(\`${e.bCol}\`) FROM \`${e.b}\` WHERE \`${e.bCol}\` IS NOT NULL)) AS matched ` +
    `FROM (SELECT DISTINCT \`${e.aCol}\` AS k FROM \`${e.a}\` WHERE \`${e.aCol}\` IS NOT NULL LIMIT ${SAMPLE})`;
  try {
    const r = await runSelect(sql, { settings: { max_execution_time: 12 } });
    const row = r.rows[0] ?? {};
    const sampled = Number(row.sampled ?? 0);
    if (sampled === 0) return null; // child has no values to judge by
    return Number(row.matched ?? 0) / sampled;
  } catch {
    return null; // fail open
  }
}

/** Cached overlap lookup: re-probe only edges we haven't measured within the TTL. */
async function overlapFor(e: GraphEdge): Promise<number | null> {
  const hit = _overlapCache.get(edgeSig(e));
  if (hit && Date.now() - hit.at < VERIFY_TTL_MS) return hit.overlap;
  const overlap = await probeOverlap(e);
  if (overlap !== null) _overlapCache.set(edgeSig(e), { overlap, at: Date.now() });
  return overlap;
}

/**
 * Verify every edge against the live data, mutating the graph in place: annotate each
 * edge with `overlap` + `verified`, drop edges measured at exactly 0% overlap (confirmed
 * phantoms), and rebuild the adjacency list. Concurrency-bounded; safe to call on every
 * (cached) build.
 */
async function verifyEdges(graph: SchemaGraph): Promise<void> {
  const edges = graph.edges;
  if (!edges.length) return;

  let next = 0;
  const worker = async () => {
    while (next < edges.length) {
      const e = edges[next++];
      const overlap = await overlapFor(e);
      if (overlap === null) continue; // un-judged: leave as-is, do not drop
      e.overlap = overlap;
      e.verified = overlap >= STRONG_OVERLAP;
    }
  };
  await Promise.all(Array.from({ length: Math.min(VERIFY_CONCURRENCY, edges.length) }, worker));

  // Drop confirmed phantoms (measured exactly 0% overlap); keep partial + un-judged edges.
  const kept = edges.filter((e) => e.overlap === undefined || e.overlap > 0);
  if (kept.length !== edges.length) {
    graph.edges = kept;
    for (const list of graph.adj.values()) list.length = 0;
    for (const e of kept) {
      graph.adj.get(e.a)?.push(e);
      graph.adj.get(e.b)?.push(e);
    }
  }
}

// ── Cache (aligned with the catalog) ─────────────────────────────────────────

let _graph: SchemaGraph | null = null;
let _graphCatalogAt = 0;
let _building: Promise<SchemaGraph> | null = null;
let _buildingForAt = 0;

/**
 * The schema graph, rebuilt only when the underlying catalog changes: build the structure
 * (instant), then verify its edges against the live data. Concurrent callers for the same
 * catalog share one in-flight build.
 */
export async function getSchemaGraph(): Promise<SchemaGraph> {
  const cat = await getCatalog();
  if (_graph && _graphCatalogAt === cat.discoveredAt) return _graph;
  if (_building && _buildingForAt === cat.discoveredAt) return _building;

  _buildingForAt = cat.discoveredAt;
  _building = (async () => {
    const g = buildSchemaGraph(cat);
    try {
      await verifyEdges(g);
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

// ── 3 · RETRIEVE ──────────────────────────────────────────────────────────────

/**
 * Breadth-first shortest join path (FEWEST hops) from `from` to the nearest table in
 * `targets`; returns the edges of that path, or null if none is reachable. BFS gives the
 * shortest chain of joins, which is exactly what we want. Two knobs:
 *   - verified edges are expanded first, so a real join key wins a tie over a partial one;
 *   - `avoidHubEdges` skips hub edges (customer_id / city), so we don't bridge two unrelated
 *     tables just because both happen to carry the same hub column.
 */
function bfsPath(
  graph: SchemaGraph,
  from: string,
  targets: Set<string>,
  opts: { avoidHubEdges?: boolean } = {},
): GraphEdge[] | null {
  if (targets.has(from)) return [];
  const visited = new Set<string>([from]);
  const queue: string[] = [from];
  const prev = new Map<string, { node: string; edge: GraphEdge }>();

  while (queue.length) {
    const u = queue.shift()!;
    // Expand verified edges before unverified ones (tiebreak toward real join keys).
    const edges = [...(graph.adj.get(u) ?? [])].sort((x, y) => Number(!!y.verified) - Number(!!x.verified));
    for (const e of edges) {
      if (opts.avoidHubEdges && isHubEdge(e)) continue;
      const v = other(e, u);
      if (visited.has(v)) continue;
      visited.add(v);
      prev.set(v, { node: u, edge: e });
      if (targets.has(v)) {
        const path: GraphEdge[] = [];
        for (let cur = v; cur !== from; ) {
          const p = prev.get(cur)!;
          path.unshift(p.edge);
          cur = p.node;
        }
        return path;
      }
      queue.push(v);
    }
  }
  return null;
}

/**
 * Retrieve the relevant connected subgraph for a set of seed tables - the heart of Graph
 * RAG retrieval over schema:
 *   1. Always include the seeds.
 *   2. CONNECT them: bridge each seed to the rest via the shortest join path (BFS),
 *      preferring paths that avoid the hub - so a question spanning customers + branches
 *      pulls in `accounts` as the bridge.
 *   3. ENRICH: if room remains under `maxTables`, add the seeds' direct (non-hub) neighbours,
 *      verified ones first - typically the dimension tables.
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

  // 2 · connect the seeds through bridge tables (avoid the hub, then fall back to allowing it).
  for (let i = 1; i < seeds.length; i++) {
    const rest = new Set([...included].filter((t) => t !== seeds[i]));
    if (!rest.size) continue;
    const path = bfsPath(graph, seeds[i], rest, { avoidHubEdges: true }) ?? bfsPath(graph, seeds[i], rest);
    if (path) for (const e of path) { included.add(e.a); included.add(e.b); }
  }

  // 3 · enrich with the seeds' direct non-hub neighbours, verified ones first.
  if (included.size < maxTables) {
    const cand: { table: string; verified: boolean }[] = [];
    for (const s of seeds) {
      for (const e of graph.adj.get(s) ?? []) {
        if (isHubEdge(e)) continue;
        const n = other(e, s);
        if (included.has(n)) continue;
        const existing = cand.find((c) => c.table === n);
        if (existing) existing.verified ||= !!e.verified;
        else cand.push({ table: n, verified: !!e.verified });
      }
    }
    cand.sort((x, y) => Number(y.verified) - Number(x.verified));
    for (const c of cand) {
      if (included.size >= maxTables) break;
      included.add(c.table);
    }
  }

  const tables = [...included];
  const tableSet = new Set(tables);
  const edges = graph.edges.filter((e) => tableSet.has(e.a) && tableSet.has(e.b));
  return { seeds, tables, edges };
}

// ── 4 · FORMAT (prompt / display) ─────────────────────────────────────────────

/** The subgraph rendered as a "JOIN GRAPH" block the analyst LLM reads. */
export function formatGraphForPrompt(sub: SubGraph): string {
  if (!sub.edges.length) {
    return `JOIN GRAPH\n(the selected tables have no known relationships; query them independently)`;
  }
  const lines = sub.edges
    .map((e) => {
      // Flag a partial edge (verified against live data, but only some keys resolve) so the
      // analyst knows the join is lossy - an inner join would silently drop the unmatched rows.
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
