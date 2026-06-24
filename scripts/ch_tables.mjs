#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// LIST WAREHOUSE TABLES  ·  scripts/ch_tables.mjs   (uses .env only, no cloud login)
//
// Prints every table with its column count and (free, metadata-only) row count.
// Pass a table name to print that table's columns + types.
//
//   npm run db:tables              # all tables: columns + rows
//   npm run db:tables -- cards     # the `cards` table's columns + types
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
loadEnv(join(HERE, "..", ".env"));
const URL_BASE = (process.env.CLICKHOUSE_HOST || "").replace(/\/$/, "");
const DB = process.env.CLICKHOUSE_DATABASE || "default";
const AUTH = "Basic " + Buffer.from(`${process.env.CLICKHOUSE_USER || "default"}:${process.env.CLICKHOUSE_PASSWORD || ""}`).toString("base64");

async function ch(sql) {
  const res = await fetch(`${URL_BASE}/?database=${DB}`, { method: "POST", headers: { Authorization: AUTH, "Content-Type": "text/plain" }, body: sql });
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.text();
}

const table = process.argv[2];
const sql = table
  ? `SELECT name, type FROM system.columns WHERE database='${DB}' AND table='${table.replace(/[^a-zA-Z0-9_]/g, "")}' ORDER BY position FORMAT PrettyCompact`
  : `SELECT t.name AS table, count(c.name) AS cols, formatReadableQuantity(any(t.total_rows)) AS rows
     FROM system.tables t LEFT JOIN system.columns c ON c.database=t.database AND c.table=t.name
     WHERE t.database='${DB}' AND t.engine LIKE '%MergeTree%'
     GROUP BY t.name ORDER BY any(t.total_rows) DESC FORMAT PrettyCompact`;

ch(sql).then((out) => process.stdout.write(out)).catch((e) => { console.error(e.message); process.exit(1); });

function loadEnv(path) {
  try { for (const line of readFileSync(path, "utf8").split("\n")) { const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch { /* optional */ }
}
