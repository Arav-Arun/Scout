// Column value profiling - schema linking with cell values. The schema tells the analyst
// a column exists and the graph tells it how to join, but not what values the column holds.
// For the categorical (LowCardinality) columns of the retrieved tables, this samples the
// actual distinct values (most frequent first) so the analyst filters on real values on the
// first try instead of guessing a label and getting zero rows. A GROUP BY on a
// LowCardinality column reads its dictionary, so it stays fast on very large tables. Cached
// per column, concurrency-bounded, and fail-open. Called by the ANALYZE phase (phases.ts).

import { runSelect, type TableInfo } from "./clickhouse";

/** Distinct values sampled for one categorical column. */
export interface ColumnValues {
  column: string;
  values: string[];
  /** true if the column has more than MAX_VALUES distinct values (the list is truncated). */
  more: boolean;
}

/** The sampled categorical columns for one table. */
export interface TableProfile {
  table: string;
  columns: ColumnValues[];
}

const MAX_VALUES = 25; // distinct values shown per column
const MAX_COLS_PER_TABLE = 8; // cap categorical columns profiled per table
const CONCURRENCY = 8;
const TTL_MS = 30 * 60_000;

const _cache = new Map<string, { values: string[]; more: boolean; at: number }>();
const keyOf = (table: string, col: string) => `${table}\u0000${col}`;

/** Categorical columns are stored as LowCardinality (by both the inference and the seeder). */
function isCategorical(type: string): boolean {
  return type.includes("LowCardinality");
}

/** The categorical columns of a table that we profile (capped at MAX_COLS_PER_TABLE). */
function categoricalCols(t: TableInfo) {
  return t.columns.filter((c) => isCategorical(c.type)).slice(0, MAX_COLS_PER_TABLE);
}

/** Sample the most common distinct values of one column (cached, fail-open). */
async function probeColumn(table: string, col: string): Promise<{ values: string[]; more: boolean } | null> {
  const k = keyOf(table, col);
  const hit = _cache.get(k);
  if (hit && Date.now() - hit.at < TTL_MS) return { values: hit.values, more: hit.more };
  try {
    // GROUP BY on a LowCardinality column reads its dictionary - fast even on huge tables.
    // ORDER BY count() DESC surfaces the dominant values first; LIMIT n+1 detects truncation.
    const r = await runSelect(
      `SELECT \`${col}\` AS v, count() AS c FROM \`${table}\` WHERE \`${col}\` IS NOT NULL GROUP BY v ORDER BY c DESC LIMIT ${MAX_VALUES + 1}`,
      { settings: { max_execution_time: 8 } },
    );
    const all = r.rows.map((row) => String(row.v)).filter((v) => v !== "");
    const more = all.length > MAX_VALUES;
    const values = all.slice(0, MAX_VALUES);
    _cache.set(k, { values, more, at: Date.now() });
    return { values, more };
  } catch {
    return null; // fail open - never block analysis because a probe failed
  }
}

/**
 * Sample real distinct values for the categorical columns of the given tables.
 * Concurrency-bounded; returns columns in schema order; omits columns that fail or are empty.
 */
export async function profileColumns(tables: TableInfo[]): Promise<TableProfile[]> {
  const work: { table: string; col: string }[] = [];
  for (const t of tables) {
    const cats = categoricalCols(t);
    for (const c of cats) work.push({ table: t.name, col: c.name });
  }
  if (!work.length) return [];

  const sampled = new Map<string, { values: string[]; more: boolean }>();
  let next = 0;
  const worker = async () => {
    while (next < work.length) {
      const { table, col } = work[next++];
      const r = await probeColumn(table, col);
      if (r && r.values.length) sampled.set(keyOf(table, col), r);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, work.length) }, worker));

  // Rebuild in schema order (deterministic); drop tables with no sampled columns.
  return tables
    .map((t) => ({
      table: t.name,
      columns: categoricalCols(t)
        .map((c) => {
          const v = sampled.get(keyOf(t.name, c.name));
          return v ? { column: c.name, values: v.values, more: v.more } : null;
        })
        .filter((x): x is ColumnValues => x !== null),
    }))
    .filter((p) => p.columns.length > 0);
}

/** Render the profiles as a COLUMN VALUES block for the analyst prompt (empty string if none). */
export function formatColumnValues(profiles: TableProfile[]): string {
  if (!profiles.length) return "";
  const body = profiles
    .map((p) => {
      const cols = p.columns
        .map((c) => `  ${c.column}: ${c.values.map((v) => `'${v}'`).join(", ")}${c.more ? ", …" : ""}`)
        .join("\n");
      return `${p.table}:\n${cols}`;
    })
    .join("\n");
  return `COLUMN VALUES (actual distinct values of categorical columns, most common first - filter using EXACTLY these, do NOT invent values)\n${body}`;
}
