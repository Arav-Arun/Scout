// Warehouse catalog - an in-memory map of every table's columns plus a free
// row-count estimate, discovered once and refreshed lazily after CATALOG_TTL_MS.
// Stateless data access (client, runSelect, describeTable) lives in clickhouse.ts.
//
// Everything here is partitioned by connection: two visitors with two different ClickHouse
// databases share this process but never share a catalog.

import { runSelect, dbName, type TableInfo } from "./clickhouse";
import { connectionKey } from "./connection";
import { deriveHeuristics, isMetaTable } from "../graph/relationships";

/** The warehouse, mapped once: every table's columns plus a free row-count estimate. */
export interface Catalog {
  tables: TableInfo[];
  /** table name -> approximate row count (from system.tables.total_rows; no scan). */
  rowCounts: Record<string, number>;
  /** epoch ms the catalog was discovered, for TTL. */
  discoveredAt: number;
}

const _catalogs = new Map<string, Catalog>();
const _inFlight = new Map<string, Promise<Catalog>>();
const CATALOG_TTL_MS = 5 * 60_000; // re-map the warehouse at most every 5 minutes

/**
 * Return the cached warehouse catalog for the active connection, discovering it on first use
 * and refreshing lazily after CATALOG_TTL_MS. Concurrent callers share a single in-flight
 * discovery.
 */
export async function getCatalog(): Promise<Catalog> {
  const key = connectionKey();
  const cached = _catalogs.get(key);
  if (cached && Date.now() - cached.discoveredAt < CATALOG_TTL_MS) return cached;

  const pending = _inFlight.get(key);
  if (pending) return pending;

  const discovery = discoverCatalog()
    .then((c) => {
      _catalogs.set(key, c);
      _inFlight.delete(key);
      return c;
    })
    .catch((e) => {
      _inFlight.delete(key);
      throw e;
    });
  _inFlight.set(key, discovery);
  return discovery;
}

/** Drop the cached catalog for the active connection - call after the warehouse changes
 *  (a file upload adds a table), so the next question sees it. */
export function invalidateCatalog(): void {
  const key = connectionKey();
  _catalogs.delete(key);
  // Also drop any discovery already in flight: it started before the warehouse changed, so
  // it would resolve without the new table and then re-cache that stale answer as fresh.
  _inFlight.delete(key);
}

/** Drop every cached artefact for a connection (called on disconnect). */
export function forgetCatalog(key: string): void {
  _catalogs.delete(key);
  _inFlight.delete(key);
}

/** List every table in the database with its column names + types. */
async function listTables(): Promise<TableInfo[]> {
  const db = dbName().replace(/'/g, "''");
  const res = await runSelect(
    `SELECT table, name, type
     FROM system.columns
     WHERE database = '${db}'
     ORDER BY table, position`,
  );
  const byTable = new Map<string, { name: string; type: string }[]>();
  for (const r of res.rows) {
    const t = String(r.table);
    if (!byTable.has(t)) byTable.set(t, []);
    byTable.get(t)!.push({ name: String(r.name), type: String(r.type) });
  }
  return [...byTable.entries()].map(([name, columns]) => ({ name, columns }));
}

/** One-shot warehouse scan: all tables + columns, plus free row-count estimates. */
async function discoverCatalog(): Promise<Catalog> {
  // Scout's own bookkeeping tables (scout_*) are not analytics tables: keep them out of
  // the catalog so the planner never seeds them and the WAREHOUSE facts count only real data.
  const tables = (await listTables()).filter((t) => !isMetaTable(t.name));
  const rowCounts: Record<string, number> = {};
  try {
    // system.tables.total_rows is MergeTree metadata, not a data scan, so this stays
    // instant on very large tables.
    const db = dbName().replace(/'/g, "''");
    const res = await runSelect(
      `SELECT name, total_rows FROM system.tables WHERE database = '${db}'`,
    );
    for (const r of res.rows) rowCounts[String(r.name)] = Number(r.total_rows ?? 0);
  } catch {
    // Row counts are best-effort context; a failure here must not block analysis.
  }
  // Re-derive this schema's naming conventions (key ownership, hub columns, domains) - the
  // graph layer reads them synchronously from here on.
  deriveHeuristics(tables, rowCounts);
  return { tables, rowCounts, discoveredAt: Date.now() };
}
