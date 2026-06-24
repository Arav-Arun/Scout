#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// INSPECT THE SCHEMA GRAPH  ·  scripts/ch_graph.mjs   (no LLM, no app server)
//
// Recovers the warehouse's implicit relationship graph straight from ClickHouse
// `system.columns` and prints (a) the full edge list and (b) the subgraph Scout would
// retrieve for a seed set - the same Graph RAG retrieval the agent's RELATE phase runs,
// in a standalone CLI you can eyeball.
//
// This mirrors lib/graph/relationships.ts + schema-graph.ts. Edges come from auto-
// inference (a key column shared with its canonical parent table) plus the handful of
// ALIASED keys inference can't see (assigned_employee_id -> employees, branch ->
// branches, merchant -> merchants.merchant_name, loan_book.product -> loan_products).
//
// Usage:
//   npm run db:graph                       # full edge list + a couple of demo subgraphs
//   npm run db:graph -- disputes           # subgraph seeded from one table
//   npm run db:graph -- customers branches # subgraph spanning multiple seeds
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
loadEnv(join(HERE, "..", ".env"));
const URL_BASE = (process.env.CLICKHOUSE_HOST || "").replace(/\/$/, "");
const DB = process.env.CLICKHOUSE_DATABASE || "default";
const AUTH = "Basic " + Buffer.from(`${process.env.CLICKHOUSE_USER || "default"}:${process.env.CLICKHOUSE_PASSWORD || ""}`).toString("base64");

// Mirrors lib/graph/relationships.ts ------------------------------------------------
const PARENT_OF_COLUMN = {
  customer_id: "customers", account_id: "accounts", card_id: "cards", loan_id: "loan_book",
  txn_id: "card_transactions", branch_id: "branches", employee_id: "employees",
  card_product_id: "card_products", loan_product_id: "loan_products", campaign_id: "marketing_campaigns",
  offer_id: "offers", device_id: "devices", merchant_id: "merchants", mcc_code: "merchant_categories",
  merchant_category: "merchant_categories", city: "geographies",
};
const HUB_COLUMNS = new Set(["customer_id", "city"]);
// aliased child.column -> parent.column (different names; inference can't find these)
const ALIAS_EDGES = [
  ["loan_book", "branch", "branches", "branch_id", "disbursed at branch"],
  ["branches", "manager_employee_id", "employees", "employee_id", "managed by"],
  ["employees", "manager_id", "employees", "employee_id", "reports to"],
  ["collections", "assigned_employee_id", "employees", "employee_id", "assigned to"],
  ["support_tickets", "assigned_employee_id", "employees", "employee_id", "handled by"],
  ["aml_screenings", "reviewer_employee_id", "employees", "employee_id", "reviewed by"],
  ["kyc_records", "verified_by_employee_id", "employees", "employee_id", "verified by"],
  ["loan_book", "product", "loan_products", "product", "is product"],
  ["card_transactions", "merchant", "merchants", "merchant_name", "at merchant"],
];

async function chRead(sql) {
  const res = await fetch(`${URL_BASE}/?database=${DB}`, { method: "POST", headers: { Authorization: AUTH, "Content-Type": "text/plain" }, body: `${sql} FORMAT TSV` });
  if (!res.ok) throw new Error(await res.text());
  const t = await res.text();
  return t.length ? t.replace(/\n$/, "").split("\n").map((l) => l.split("\t")) : [];
}

function buildGraph(tables) {
  const present = new Set(tables.map((t) => t.name));
  const cols = new Map(tables.map((t) => [t.name, new Set(t.columns)]));
  const seen = new Map();
  const add = (a, ac, b, bc, label, source) => {
    if (!present.has(a) || !present.has(b) || a === b) return;
    if (!cols.get(a)?.has(ac) || !cols.get(b)?.has(bc)) return;
    const k = a < b ? `${a}.${ac}~${b}.${bc}` : `${b}.${bc}~${a}.${ac}`;
    if (seen.has(k) && seen.get(k).source === "curated") return;
    const hub = HUB_COLUMNS.has(ac) || HUB_COLUMNS.has(bc);
    const weight = (source === "inferred" ? 2 : 1) + (hub ? 4 : 0);
    seen.set(k, { a, ac, b, bc, label, source, weight });
  };
  for (const [a, ac, b, bc, label] of ALIAS_EDGES) add(a, ac, b, bc, label, "curated");
  for (const t of tables) for (const c of t.columns) {
    const parent = PARENT_OF_COLUMN[c];
    if (parent && parent !== t.name && present.has(parent) && cols.get(parent)?.has(c)) add(t.name, c, parent, c, "shares " + c, "inferred");
  }
  const edges = [...seen.values()];
  const adj = new Map(tables.map((t) => [t.name, []]));
  for (const e of edges) { adj.get(e.a).push(e); adj.get(e.b).push(e); }
  return { nodes: present, adj, edges };
}

const other = (e, n) => (e.a === n ? e.b : e.a);
function shortestPath(graph, from, to) {
  if (from === to) return [];
  const dist = new Map([[from, 0]]), prev = new Map(), seen = new Set();
  while (true) {
    let u = null, best = Infinity;
    for (const [n, d] of dist) if (!seen.has(n) && d < best) { best = d; u = n; }
    if (u === null || u === to) break;
    seen.add(u);
    for (const e of graph.adj.get(u) || []) { const v = other(e, u), nd = best + e.weight; if (nd < (dist.get(v) ?? Infinity)) { dist.set(v, nd); prev.set(v, { node: u, edge: e }); } }
  }
  if (!prev.has(to)) return null;
  const path = []; let cur = to;
  while (cur !== from) { const p = prev.get(cur); path.unshift(p.edge); cur = p.node; }
  return path;
}
function retrieve(graph, seeds, maxTables = 8) {
  const inc = new Set(seeds.filter((s) => graph.nodes.has(s)));
  const list = [...inc];
  for (let i = 1; i < list.length; i++) {
    let bestPath = null;
    for (const anchor of inc) { if (anchor === list[i]) { bestPath = []; break; } const p = shortestPath(graph, list[i], anchor); if (p && (!bestPath || p.length < bestPath.length)) bestPath = p; }
    if (bestPath) for (const e of bestPath) { inc.add(e.a); inc.add(e.b); }
  }
  const cands = [];
  for (const s of seeds) for (const e of graph.adj.get(s) || []) { const n = other(e, s); if (!inc.has(n)) cands.push({ n, w: e.weight }); }
  cands.sort((x, y) => x.w - y.w);
  for (const c of cands) { if (inc.size >= maxTables) break; inc.add(c.n); }
  const tableSet = new Set(inc);
  return { seeds, tables: [...inc], edges: graph.edges.filter((e) => tableSet.has(e.a) && tableSet.has(e.b)) };
}

async function main() {
  const rows = await chRead(`SELECT table, name FROM system.columns WHERE database='${DB}' ORDER BY table`);
  const byTable = new Map();
  for (const [t, c] of rows) { if (!byTable.has(t)) byTable.set(t, []); byTable.get(t).push(c); }
  const tables = [...byTable.entries()].map(([name, columns]) => ({ name, columns }));
  const graph = buildGraph(tables);

  console.log(`\nSchema graph for ${DB}: ${graph.nodes.size} tables, ${graph.edges.length} relationships (no FKs)\n`);
  const seeds = process.argv.slice(2);
  if (seeds.length) { printSub(retrieve(graph, seeds)); return; }

  console.log("All recovered edges (curated + inferred):");
  for (const e of [...graph.edges].sort((x, y) => (x.b + x.a).localeCompare(y.b + y.a))) console.log(`  ${e.a}.${e.ac} = ${e.b}.${e.bc}  · ${e.label} [${e.source}]`);
  for (const demo of [["disputes"], ["customers", "branches"], ["collections", "card_products"]]) { console.log(""); printSub(retrieve(graph, demo)); }
}
function printSub(sub) {
  console.log(`▶ retrieveSubgraph(${JSON.stringify(sub.seeds)}) → ${sub.tables.length} tables`);
  console.log(`  tables: ${sub.tables.join(", ")}`);
  console.log(`  joins:`);
  for (const e of sub.edges) console.log(`    ${e.a}.${e.ac} = ${e.b}.${e.bc}  (${e.label})`);
}
function loadEnv(path) {
  try { for (const line of readFileSync(path, "utf8").split("\n")) { const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch { /* optional */ }
}
main().catch((e) => { console.error(e); process.exit(1); });
