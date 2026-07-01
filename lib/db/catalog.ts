// Warehouse catalog — an in-memory map of every table's columns plus a free
// row-count estimate, discovered once and refreshed lazily after CATALOG_TTL_MS.
// Stateless data access (client, runSelect, describeTable) lives in clickhouse.ts.

import { runSelect, dbName, type TableInfo } from "./clickhouse";

/** The warehouse, mapped once: every table's columns plus a free row-count estimate. */
export interface Catalog {
  tables: TableInfo[];
  /** table name -> approximate row count (from system.tables.total_rows; no scan). */
  rowCounts: Record<string, number>;
  /** epoch ms the catalog was discovered, for TTL. */
  discoveredAt: number;
}

let _catalog: Catalog | null = null;
let _catalogInFlight: Promise<Catalog> | null = null;
const CATALOG_TTL_MS = 5 * 60_000; // re-map the warehouse at most every 5 minutes

/**
 * Return the cached warehouse catalog, discovering it on first use and refreshing lazily
 * after CATALOG_TTL_MS. Concurrent callers share a single in-flight discovery.
 */
export async function getCatalog(): Promise<Catalog> {
  const fresh = _catalog && Date.now() - _catalog.discoveredAt < CATALOG_TTL_MS;
  if (fresh) return _catalog!;
  if (_catalogInFlight) return _catalogInFlight;

  _catalogInFlight = discoverCatalog()
    .then((c) => {
      _catalog = c;
      _catalogInFlight = null;
      return c;
    })
    .catch((e) => {
      _catalogInFlight = null;
      throw e;
    });
  return _catalogInFlight;
}

/** List every table in the database with its column names + types. */
async function listTables(): Promise<TableInfo[]> {
  const db = dbName();
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
  const tables = await listTables();
  const rowCounts: Record<string, number> = {};
  try {
    // system.tables.total_rows is MergeTree metadata, not a data scan, so this stays
    // instant on very large tables.
    const db = dbName();
    const res = await runSelect(
      `SELECT name, total_rows FROM system.tables WHERE database = '${db}'`,
    );
    for (const r of res.rows) rowCounts[String(r.name)] = Number(r.total_rows ?? 0);
  } catch {
    // Row counts are best-effort context; a failure here must not block analysis.
  }
  return { tables, rowCounts, discoveredAt: Date.now() };
}
