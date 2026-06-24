// ─────────────────────────────────────────────────────────────────────────────
// EDGE VERIFICATION  ·  lib/graph/verify.ts   (makes the graph REAL, not asserted)
//
// relationships.ts proposes CANDIDATE edges from a curated manifest + column-name
// matching. But a shared column name does NOT prove the two columns actually join:
// in this warehouse `account_transactions.txn_id` and `card_transactions.txn_id`
// share a name yet have ZERO overlapping values (joining them returns nothing), and
// `market_sales.customer_id` overlaps the banking `customers` table by only ~6%.
//
// This module measures each candidate edge against the LIVE data - what fraction of a
// child key's distinct values actually resolve to a parent key - then:
//   • DROPS edges with measured 0% overlap (pure phantoms),
//   • marks the rest `verified` (strong) or partial, with the measured `overlap`,
//   • penalises partial/unverified edges so traversal prefers real join keys.
// It fails OPEN: if a probe errors or times out, the edge is kept un-judged (we never
// drop a real edge just because a probe failed). Results are cached per edge so a
// catalog refresh re-verifies only edges it hasn't seen.
// ─────────────────────────────────────────────────────────────────────────────

import { runSelect } from "../db/clickhouse";
import type { SchemaGraph, GraphEdge } from "./schema-graph";

/** Distinct child key values to probe per edge (sampled, so this stays cheap on crore-row tables). */
const SAMPLE = 400;
/** ≥ this fraction of sampled child keys resolving to the parent ⇒ a real ("verified") join key. */
export const STRONG_OVERLAP = 0.5;
/** Extra traversal cost for a partial/unverified edge, so the analyst prefers verified joins. */
const WEAK_PENALTY = 3;
const CONCURRENCY = 8;
const TTL_MS = 30 * 60_000;

const _cache = new Map<string, { overlap: number; at: number }>();
const sig = (e: GraphEdge) => `${e.a}.${e.aCol}~${e.b}.${e.bCol}`;

/**
 * Measure how many of a sample of DISTINCT child keys (`a.aCol`) actually exist among
 * the parent keys (`b.bCol`). Returns the overlap fraction, or null if it can't be judged
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
    const matched = Number(row.matched ?? 0);
    if (sampled === 0) return null; // child has no values to judge by
    return matched / sampled;
  } catch {
    return null; // fail open - never drop an edge because a probe failed
  }
}

/** Cached overlap lookup: re-probe only edges we haven't measured within the TTL. */
async function overlapFor(e: GraphEdge): Promise<number | null> {
  const k = sig(e);
  const hit = _cache.get(k);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.overlap;
  const overlap = await probeOverlap(e);
  if (overlap !== null) _cache.set(k, { overlap, at: Date.now() });
  return overlap;
}

/**
 * Verify every edge of `graph` against the live data, mutating it in place:
 *   - annotate each edge with `overlap` (0..1) and `verified` (overlap ≥ STRONG_OVERLAP),
 *   - bump the weight of partial/unverified edges so verified joins are preferred,
 *   - drop edges measured at exactly 0% overlap (confirmed phantoms) and rebuild adjacency.
 * Concurrency-bounded; safe to call on every (cached) graph build.
 */
export async function verifySchemaGraph(graph: SchemaGraph): Promise<void> {
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
      if (!e.verified) e.weight += WEAK_PENALTY;
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, edges.length) }, worker));

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
