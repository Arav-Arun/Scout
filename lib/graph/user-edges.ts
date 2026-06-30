// ─────────────────────────────────────────────────────────────────────────────
// USER-DEFINED EDGES  ·  lib/graph/user-edges.ts
//
// The schema graph is recovered automatically (curated manifest + key-column
// inference in relationships.ts). But not every real relationship is a foreign key:
// two columns can be genuinely joinable without sharing a key-like name or being
// caught by inference. This module lets a user declare those edges by hand from the
// Graph Lab page, and persists them in ClickHouse so they survive restarts and feed
// straight back into the graph (merged in buildSchemaGraph, source = "user").
//
// Storage is a ReplacingMergeTree keyed by the edge's four endpoints: adding re-inserts
// with active=1, removing re-inserts a tombstone (active=0); the latest `updated_at`
// wins, so reads use FINAL + WHERE active = 1.
// ─────────────────────────────────────────────────────────────────────────────

import { dbName, runSelect } from "../db/clickhouse";
import { chExec } from "../db/write";
import type { Relationship } from "./relationships";

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

/** Declare a user-defined relationship between two columns. */
export function addUserEdge(e: UserEdgeInput): Promise<void> {
  return upsert(e, 1);
}

/** Tombstone a previously added user edge (latest write wins via ReplacingMergeTree). */
export function removeUserEdge(e: UserEdgeInput): Promise<void> {
  return upsert(e, 0);
}

/** The active user-defined edges as Relationships (source = "user"), or [] if none/never created. */
export async function loadUserEdges(): Promise<Relationship[]> {
  try {
    const r = await runSelect(
      `SELECT a, a_col, b, b_col, label FROM ${qualified()} FINAL WHERE active = 1`,
    );
    return r.rows.map((row) => ({
      from: { table: String(row.a), column: String(row.a_col) },
      to: { table: String(row.b), column: String(row.b_col) },
      label: String(row.label || "user-defined relationship"),
      source: "user" as const,
    }));
  } catch {
    return []; // table not created yet, or warehouse unreachable — fail open
  }
}
