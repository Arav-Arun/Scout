// relationships.ts - the join edges for the schema graph, recovered without any foreign-key
// metadata. Two kinds:
//   1. INFERRED (physical) - a key-like column shared between a table and the table that owns
//      that key becomes an edge; recomputed from the live catalog.
//   2. MANUAL - human-declared edges managed in the Graph Lab (stored in scout_user_edges),
//      including aliased keys inference can't see (e.g. collections.assigned_employee_id →
//      employees.employee_id). Add/edit/delete from the UI.
// buildSchemaGraph() (schema-graph.ts) merges both, the manual (declared) edge winning on conflict.
//
// Everything here is derived from whatever schema the visitor linked - Scout ships with no
// hardcoded knowledge of any particular warehouse. Naming conventions are the only signal
// available without FKs, so inference is deliberately conservative: it claims an edge only
// when a key column's stem matches a real table name. Anything it can't see (a renamed or
// aliased key) is exactly what the Graph Lab's manual edges are for.

import type { TableInfo } from "../db/clickhouse";
import { connectionKey, tryConnection } from "../db/connection";

/** One directed join edge: `from.table.from.column` joins to `to.table.to.column`. */
export interface Relationship {
  from: { table: string; column: string };
  to: { table: string; column: string };
  /** Human label for the relationship (shown to the LLM and in the UI). */
  label: string;
  /** "declared" edges are human-asserted and authoritative (added/edited in the Graph Lab,
   *  stored in scout_user_edges); "inferred" come from column-name matching. */
  source?: "declared" | "inferred";
}

/**
 * The connection "kind" the graph surfaces to the reader: a **physical** connection is
 * recovered automatically from the schema/data structure (an inferred key), a **manual**
 * connection was declared by a human in the Graph Lab (i.e. "declared", stored in
 * scout_user_edges). This one helper is the single mapping from the internal `source` field
 * to that vocabulary, so storage, the API and the UI all agree.
 */
export type Connection = "physical" | "manual";
export function connectionOf(source: "declared" | "inferred" | undefined): Connection {
  return source === "inferred" ? "physical" : "manual";
}

/** Scout's own bookkeeping tables (the graph store + editable-edges store). They live in the
 *  same database as the user's warehouse but are not analytics tables, so the schema graph
 *  excludes them from its nodes - they'd otherwise show up as isolated, meaningless dots. */
export const isMetaTable = (name: string): boolean => name.startsWith("scout_");

// ── Name normalization ───────────────────────────────────────────────────────

/** Crude English singularization - enough to match `customers` ↔ `customer_id`. */
function singular(word: string): string {
  const w = word.toLowerCase();
  if (w.length > 3 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 4 && /(s|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 2 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

/** Compare table and column names ignoring separators, case and plurality. */
function nameKey(name: string): string {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(singular)
    .join("");
}

/** The key suffixes that mark a column as a reference to some entity's identity. */
const KEY_SUFFIX = /_(id|ids|key|code|no|num|number|uuid|guid|sk|fk)$/i;

/** `customer_id` → `customer`; a column with no key suffix is its own stem. */
function keyStem(column: string): string {
  return column.replace(KEY_SUFFIX, "");
}

// ── Derived, per-schema heuristics ───────────────────────────────────────────

export interface SchemaHeuristics {
  /** join column -> the table that owns it as its own identity (its canonical parent). */
  parentOf: Map<string, string>;
  /** Columns that live in many tables (a `customer_id` carried by half the warehouse).
   *  Traversal penalises them so a question about one table doesn't drag in the whole
   *  schema through a shared column. */
  hubColumns: Set<string>;
  /** table -> the cluster it's grouped and coloured under in the graph viewer. */
  domainOf: Map<string, string>;
}

const EMPTY: SchemaHeuristics = { parentOf: new Map(), hubColumns: new Set(), domainOf: new Map() };

// Cached per linked connection - each visitor's schema yields its own conventions.
const _heuristics = new Map<string, SchemaHeuristics>();

/**
 * Work out this schema's conventions from the catalog: which table owns each key column,
 * which columns are hubs, and how tables cluster into domains. Called by getCatalog() on
 * every (re)discovery, so the sync accessors below always read a current answer.
 */
export function deriveHeuristics(
  tables: TableInfo[],
  rowCounts: Record<string, number> = {},
): SchemaHeuristics {
  const analytics = tables.filter((t) => !isMetaTable(t.name));
  const byNameKey = new Map<string, TableInfo[]>();
  for (const t of analytics) {
    const k = nameKey(t.name);
    byNameKey.set(k, [...(byNameKey.get(k) ?? []), t]);
  }

  // How many tables carry each column (the hub signal), and which ones.
  const carriers = new Map<string, string[]>();
  for (const t of analytics) {
    for (const c of t.columns) {
      carriers.set(c.name, [...(carriers.get(c.name) ?? []), t.name]);
    }
  }

  // parentOf: a column belongs to the table whose name IS that column's stem
  // (`customer_id` → `customers`, `merchant_category` → `merchant_categories`), provided
  // that table actually exposes the column. No name match ⇒ no inferred parent: guessing
  // one would wire up joins that don't exist.
  const parentOf = new Map<string, string>();
  for (const [column, owners] of carriers) {
    const stem = keyStem(column);
    if (!stem || stem.length < 2) continue; // a bare `id` / `key` is not a cross-table join key
    const stemKey = nameKey(stem);
    if (!stemKey) continue;
    const candidates = (byNameKey.get(stemKey) ?? []).filter((t) => owners.includes(t.name));
    if (!candidates.length) continue;
    // Ties are vanishingly rare (two tables normalizing to the same name); prefer the
    // smaller one, which is the dimension side of the relationship.
    const parent = candidates.reduce((best, t) =>
      (rowCounts[t.name] ?? 0) < (rowCounts[best.name] ?? 0) ? t : best,
    );
    parentOf.set(column, parent.name);
  }

  // hubColumns: carried by a quarter of the warehouse (and at least 4 tables).
  const hubThreshold = Math.max(4, Math.ceil(analytics.length * 0.25));
  const hubColumns = new Set<string>();
  for (const [column, owners] of carriers) {
    if (owners.length >= hubThreshold) hubColumns.add(column);
  }

  // domainOf: cluster on the table name's leading token when two or more tables share it
  // (`cards`, `card_products`, `card_transactions` → "Card"); loners fall to "Other".
  // Tables are grouped on the SINGULAR token so plural and singular prefixes land together,
  // but each group is labelled with the spelling that actually occurs most (so a set of
  // `hackernews*` tables reads "Hackernews", not "Hackernew").
  const rawToken = (name: string) => (name.split(/[^a-zA-Z0-9]+/).filter(Boolean)[0] ?? "").toLowerCase();
  const spellings = new Map<string, Map<string, number>>();
  for (const t of analytics) {
    const raw = rawToken(t.name);
    if (!raw) continue;
    const group = singular(raw);
    const counts = spellings.get(group) ?? new Map<string, number>();
    counts.set(raw, (counts.get(raw) ?? 0) + 1);
    spellings.set(group, counts);
  }

  const labels = new Map<string, string>();
  for (const [group, counts] of spellings) {
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    if (total < 2) continue; // a lone table isn't a cluster
    const best = [...counts.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0][0];
    labels.set(group, best[0].toUpperCase() + best.slice(1));
  }

  const domainOf = new Map<string, string>();
  for (const t of analytics) {
    domainOf.set(t.name, labels.get(singular(rawToken(t.name))) ?? "Other");
  }

  const derived: SchemaHeuristics = { parentOf, hubColumns, domainOf };
  const conn = tryConnection();
  if (conn) _heuristics.set(connectionKey(conn), derived);
  return derived;
}

/** The derived conventions for the active connection (empty until the catalog is discovered). */
export function heuristics(): SchemaHeuristics {
  const conn = tryConnection();
  return (conn && _heuristics.get(connectionKey(conn))) || EMPTY;
}

/** Forget the derived conventions for a connection (called on disconnect). */
export function forgetHeuristics(key: string): void {
  _heuristics.delete(key);
}

/** True for a column carried by so many tables that joining through it links unrelated ones. */
export function isHubColumn(column: string): boolean {
  return heuristics().hubColumns.has(column);
}

/** The cluster a table is grouped under in the graph viewer. */
export function tableDomain(name: string): string {
  return heuristics().domainOf.get(name) ?? "Other";
}

// ── Inference ────────────────────────────────────────────────────────────────

/**
 * Recover join edges purely from the catalog, with no FK metadata: every key-like
 * column that exists both in a table and in the table that owns that key becomes an
 * edge (the "physical" connections). Merged with the manual edges in buildSchemaGraph().
 */
export function inferRelationships(tables: TableInfo[]): Relationship[] {
  const { parentOf } = heuristics();
  const present = new Set(tables.map((t) => t.name));
  const out: Relationship[] = [];
  for (const t of tables) {
    for (const col of t.columns) {
      const parent = parentOf.get(col.name);
      if (!parent || parent === t.name || !present.has(parent)) continue;
      // the parent must actually expose that key column
      const parentTable = tables.find((x) => x.name === parent);
      if (!parentTable || !parentTable.columns.some((c) => c.name === col.name)) continue;
      out.push({
        from: { table: t.name, column: col.name },
        to: { table: parent, column: col.name },
        label: "shares " + col.name,
        source: "inferred",
      });
    }
  }
  return out;
}
