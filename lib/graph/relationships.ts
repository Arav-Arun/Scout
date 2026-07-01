// relationships.ts — the join edges for the schema graph, recovered without any foreign-key
// metadata. Two kinds:
//   1. INFERRED (physical) — any key-like column (*_id or a known join column) shared between
//      a table and its canonical parent becomes an edge; recomputed from the live catalog.
//   2. MANUAL — human-declared edges managed in the Graph Lab (stored in scout_user_edges),
//      including aliased keys inference can't see (e.g. collections.assigned_employee_id →
//      employees.employee_id). Add/edit/delete from the UI.
// buildSchemaGraph() (schema-graph.ts) merges both, the manual (declared) edge winning on conflict.

import type { TableInfo } from "../db/clickhouse";

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
 *  same database as the warehouse but are not analytics tables, so the schema graph excludes
 *  them from its nodes — they'd otherwise show up as isolated, meaningless dots. */
export const isMetaTable = (name: string): boolean => name.startsWith("scout_");

/**
 * Columns that act as **hubs**: they live in many tables and point at one dimension
 * (`customer_id` is in ~24 tables). Traversal penalises hub edges so a question about
 * `disputes` doesn't drag the entire warehouse in through `customers`.
 */
export const HUB_COLUMNS = new Set(["customer_id", "city"]);

/**
 * The canonical parent table for each join column (where that column is the entity's
 * own key). Auto-inference connects every other table carrying the column to this
 * parent, rather than building a clique across all of them.
 */
export const PARENT_OF_COLUMN: Record<string, string> = {
  customer_id: "customers",
  account_id: "accounts",
  card_id: "cards",
  loan_id: "loan_book",
  txn_id: "card_transactions",
  branch_id: "branches",
  employee_id: "employees",
  card_product_id: "card_products",
  loan_product_id: "loan_products",
  campaign_id: "marketing_campaigns",
  offer_id: "offers",
  device_id: "devices",
  merchant_id: "merchants",
  mcc_code: "merchant_categories",
  merchant_category: "merchant_categories",
  city: "geographies",
};

/**
 * Sub-domain ("community") each table belongs to - used to colour the knowledge-graph
 * view and to group related tables. A lightweight, declared alternative to running
 * community detection on the graph.
 */
export const TABLE_DOMAIN: Record<string, string> = {
  customers: "Customer", geographies: "Customer", devices: "Customer",
  branches: "Branch & staff", employees: "Branch & staff",
  accounts: "Accounts & cards", cards: "Accounts & cards", card_products: "Accounts & cards",
  card_applications: "Accounts & cards", account_transactions: "Accounts & cards",
  card_transactions: "Payments & rewards", statements: "Payments & rewards",
  rewards_ledger: "Payments & rewards", reward_redemptions: "Payments & rewards",
  offers: "Payments & rewards", offer_redemptions: "Payments & rewards",
  loan_book: "Lending", loan_products: "Lending", loan_applications: "Lending",
  loan_repayments: "Lending", collections: "Lending", credit_bureau: "Lending",
  disputes: "Risk & compliance", fraud_alerts: "Risk & compliance",
  kyc_records: "Risk & compliance", aml_screenings: "Risk & compliance",
  merchants: "Merchants", merchant_categories: "Merchants",
  app_sessions: "Engagement", support_tickets: "Engagement",
  marketing_campaigns: "Engagement", campaign_responses: "Engagement",
};

/** The sub-domain for a table (defaults to "Other" for tables without an assigned sub-domain). */
export function tableDomain(name: string): string {
  return TABLE_DOMAIN[name] ?? "Other";
}

/**
 * Recover join edges purely from the catalog, with no FK metadata: every key-like
 * column that exists both in a table and in its canonical parent table becomes an
 * edge (the "physical" connections). Merged with the manual edges in buildSchemaGraph().
 */
export function inferRelationships(tables: TableInfo[]): Relationship[] {
  const present = new Set(tables.map((t) => t.name));
  const out: Relationship[] = [];
  for (const t of tables) {
    for (const col of t.columns) {
      const parent = PARENT_OF_COLUMN[col.name];
      if (!parent || parent === t.name || !present.has(parent)) continue;
      // the parent must actually expose that key column
      const parentTable = tables.find((x) => x.name === parent);
      if (!parentTable || !parentTable.columns.some((c) => c.name === col.name)) continue;
      out.push({ from: { table: t.name, column: col.name }, to: { table: parent, column: col.name }, label: "shares " + col.name, source: "inferred" });
    }
  }
  return out;
}
