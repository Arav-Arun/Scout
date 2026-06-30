// user-edges.ts — the editable store of DECLARED join edges (scout_user_edges). It unifies the
// curated manifest and user-added edges into one place: on first use the curated seed
// (CURATED_RELATIONSHIPS) is loaded in, after which every edge — curated-origin or user-added —
// can be added, edited, or deleted from the Graph Lab. ("inferred" edges stay automatic.)
//
// Storage is a ReplacingMergeTree keyed by the edge's four endpoints: add re-inserts with
// active=1, delete writes a tombstone (active=0), edit = delete old + add new; the latest
// updated_at wins, so reads use FINAL WHERE active = 1.

import { dbName, runSelect } from "../db/clickhouse";
import { chExec } from "../db/write";
import { CURATED_RELATIONSHIPS, type Relationship } from "./relationships";

const TABLE = "scout_user_edges";

export interface UserEdgeInput {
  a: string;
  aCol: string;
  b: string;
  bCol: string;
  label?: string;
}

function qualified(): string {
  return `\`${dbName()}\`.\`${TABLE}\``;
}

function nowLiteral(): string {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}

async function ensureTable(): Promise<void> {
  await chExec(
    `CREATE TABLE IF NOT EXISTS ${qualified()} (
      a String, a_col String, b String, b_col String,
      label String,
      active UInt8,
      updated_at DateTime64(3)
    ) ENGINE = ReplacingMergeTree(updated_at) ORDER BY (a, a_col, b, b_col)`,
  );
}

async function upsert(e: UserEdgeInput, active: 0 | 1): Promise<void> {
  await ensureTable();
  const row = {
    a: e.a, a_col: e.aCol, b: e.b, b_col: e.bCol,
    label: e.label || `${e.a}.${e.aCol} relates to ${e.b}.${e.bCol}`,
    active, updated_at: nowLiteral(),
  };
  await chExec(`INSERT INTO ${qualified()} FORMAT JSONEachRow`, JSON.stringify(row));
}

/** Add a declared relationship between two columns. */
export function addUserEdge(e: UserEdgeInput): Promise<void> {
  return upsert(e, 1);
}

/** Delete a declared edge (writes a tombstone; latest write wins via ReplacingMergeTree). */
export function removeUserEdge(e: UserEdgeInput): Promise<void> {
  return upsert(e, 0);
}

/** Edit a declared edge: tombstone the old endpoints, then add the new ones. */
export async function editUserEdge(prev: UserEdgeInput, next: UserEdgeInput): Promise<void> {
  await upsert(prev, 0);
  await upsert(next, 1);
}

const edgeKey = (a: string, ac: string, b: string, bc: string) => `${a}.${ac}~${b}.${bc}`;

let _seedChecked = false; // once per process: skip the DB round-trip on later graph rebuilds

/**
 * Seed the curated manifest into the store once. Idempotent at the DB level too: if ANY curated
 * key already has a row (active or tombstoned), seeding is skipped — so it never duplicates and
 * never resurrects an edge the user deleted. This is the one write the unified-store model needs;
 * it runs lazily on the first graph build.
 */
export async function seedDeclaredEdges(): Promise<void> {
  if (_seedChecked) return;
  try {
    await ensureTable();
    const present = await runSelect(`SELECT DISTINCT a, a_col, b, b_col FROM ${qualified()}`);
    const have = new Set(present.rows.map((r) => edgeKey(String(r.a), String(r.a_col), String(r.b), String(r.b_col))));
    const curated = CURATED_RELATIONSHIPS.map((r) => ({ a: r.from.table, aCol: r.from.column, b: r.to.table, bCol: r.to.column, label: r.label }));
    if (!curated.some((c) => have.has(edgeKey(c.a, c.aCol, c.b, c.bCol)))) {
      const now = nowLiteral();
      const body = curated
        .map((e) => JSON.stringify({ a: e.a, a_col: e.aCol, b: e.b, b_col: e.bCol, label: e.label, active: 1, updated_at: now }))
        .join("\n");
      await chExec(`INSERT INTO ${qualified()} FORMAT JSONEachRow`, body);
    }
    _seedChecked = true; // checked (and seeded if needed) for this process
  } catch {
    // Best-effort: leave _seedChecked false so a transient failure retries on the next build.
  }
}

/** The active declared edges as Relationships (source = "declared"), or [] if none/unreachable. */
export async function loadUserEdges(): Promise<Relationship[]> {
  try {
    const r = await runSelect(
      `SELECT a, a_col, b, b_col, label FROM ${qualified()} FINAL WHERE active = 1`,
    );
    return r.rows.map((row) => ({
      from: { table: String(row.a), column: String(row.a_col) },
      to: { table: String(row.b), column: String(row.b_col) },
      label: String(row.label || "declared relationship"),
      source: "declared" as const,
    }));
  } catch {
    return []; // table not created yet, or warehouse unreachable — fail open
  }
}
