// ─────────────────────────────────────────────────────────────────────────────
// RELATIONSHIP KNOWLEDGE  ·  lib/graph/relationships.ts
//
// Tables are linked only by shared key columns. This file is where Scout recovers that implicit graph:
//
//   1. A CURATED manifest of join edges (authoritative). It captures the edges a
//      column-name match alone would miss - aliased keys like
//      `collections.assigned_employee_id -> employees.employee_id`,
//      `card_transactions.merchant -> merchants.merchant_name`, and
//      `loan_book.branch -> branches.branch_id`.
//   2. AUTO-INFERENCE from the live catalog: any key-like column (`*_id`, or a known
//      join column) shared across tables becomes an edge to its parent table. This
//      demonstrates relationships can be discovered with no FK metadata at all, and
//      keeps the graph correct if new tables are uploaded.
//
// buildSchemaGraph() (schema-graph.ts) merges both, curated winning on conflict.
// ─────────────────────────────────────────────────────────────────────────────

import type { TableInfo } from "../db/clickhouse";

/** One directed join edge: `from.table.from.column` joins to `to.table.to.column`. */
export interface Relationship {
  from: { table: string; column: string };
  to: { table: string; column: string };
  /** Human label for the relationship (shown to the LLM and in the UI). */
  label: string;
  /** "curated" + "user" edges are authoritative; "inferred" come from column-name matching. */
  source?: "curated" | "inferred" | "user";
}

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

// child[table.column] -> parent.column.  Curated, authoritative edges.
const C = (table: string, column: string, toTable: string, toColumn: string, label: string): Relationship => ({
  from: { table, column }, to: { table: toTable, column: toColumn }, label, source: "curated",
});

/** Curated edges - the source of truth, including the aliased keys inference can't see. */
export const CURATED_RELATIONSHIPS: Relationship[] = [
  // ── customer_id -> customers (the central hub) ───────────────────────────────
  ...["accounts", "cards", "card_applications", "account_transactions", "loan_applications",
    "loan_repayments", "collections", "credit_bureau", "disputes", "fraud_alerts", "kyc_records",
    "aml_screenings", "rewards_ledger", "reward_redemptions", "offer_redemptions", "campaign_responses",
    "support_tickets", "app_sessions", "statements", "devices", "loan_book", "card_transactions"].map(
    (t) => C(t, "customer_id", "customers", "customer_id", "belongs to customer"),
  ),
  // ── account / card / loan / txn parents ──────────────────────────────────────
  C("cards", "account_id", "accounts", "account_id", "drawn on account"),
  C("account_transactions", "account_id", "accounts", "account_id", "on account"),
  C("statements", "account_id", "accounts", "account_id", "for account"),
  C("disputes", "card_id", "cards", "card_id", "on card"),
  C("rewards_ledger", "card_id", "cards", "card_id", "earned on card"),
  C("statements", "card_id", "cards", "card_id", "for card"),
  C("loan_repayments", "loan_id", "loan_book", "loan_id", "repays loan"),
  C("collections", "loan_id", "loan_book", "loan_id", "collects on loan"),
  C("disputes", "txn_id", "card_transactions", "txn_id", "disputes transaction"),
  C("fraud_alerts", "txn_id", "card_transactions", "txn_id", "flags transaction"),
  C("rewards_ledger", "txn_id", "card_transactions", "txn_id", "earned on transaction"),
  C("offer_redemptions", "txn_id", "card_transactions", "txn_id", "applied to transaction"),
  // ── branches / employees (note the aliased employee columns) ─────────────────
  C("employees", "branch_id", "branches", "branch_id", "works at branch"),
  C("accounts", "branch_id", "branches", "branch_id", "opened at branch"),
  C("card_applications", "branch_id", "branches", "branch_id", "applied at branch"),
  C("loan_applications", "branch_id", "branches", "branch_id", "applied at branch"),
  C("loan_book", "branch", "branches", "branch_id", "disbursed at branch"),
  C("branches", "manager_employee_id", "employees", "employee_id", "managed by"),
  C("employees", "manager_id", "employees", "employee_id", "reports to"),
  C("collections", "assigned_employee_id", "employees", "employee_id", "assigned to"),
  C("support_tickets", "assigned_employee_id", "employees", "employee_id", "handled by"),
  C("aml_screenings", "reviewer_employee_id", "employees", "employee_id", "reviewed by"),
  C("kyc_records", "verified_by_employee_id", "employees", "employee_id", "verified by"),
  // ── products / offers / campaigns ────────────────────────────────────────────
  C("cards", "card_product_id", "card_products", "card_product_id", "is product"),
  C("card_applications", "card_product_id", "card_products", "card_product_id", "applied for product"),
  C("offers", "card_product_id", "card_products", "card_product_id", "for card product"),
  C("loan_applications", "loan_product_id", "loan_products", "loan_product_id", "applied for product"),
  C("loan_book", "product", "loan_products", "product", "is product"),
  C("offer_redemptions", "offer_id", "offers", "offer_id", "redeems offer"),
  C("campaign_responses", "campaign_id", "marketing_campaigns", "campaign_id", "responds to campaign"),
  // ── merchants / categories ───────────────────────────────────────────────────
  C("card_transactions", "merchant", "merchants", "merchant_name", "at merchant"),
  C("merchants", "merchant_category", "merchant_categories", "merchant_category", "in category"),
  C("card_transactions", "merchant_category", "merchant_categories", "merchant_category", "in category"),
  C("offers", "merchant_category", "merchant_categories", "merchant_category", "targets category"),
  C("merchants", "mcc_code", "merchant_categories", "mcc_code", "MCC"),
  // ── devices ──────────────────────────────────────────────────────────────────
  C("fraud_alerts", "device_id", "devices", "device_id", "from device"),
  C("app_sessions", "device_id", "devices", "device_id", "on device"),
  // ── geography (hub on city) ──────────────────────────────────────────────────
  ...["customers", "branches", "merchants", "employees", "card_transactions"].map(
    (t) => C(t, "city", "geographies", "city", "located in"),
  ),
];

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

/** The sub-domain for a table (defaults to "Retail / other" for the legacy retail tables). */
export function tableDomain(name: string): string {
  return TABLE_DOMAIN[name] ?? "Retail / other";
}

/**
 * Recover join edges purely from the catalog, with no FK metadata: every key-like
 * column that exists both in a table and in its canonical parent table becomes an
 * edge. Used as a fallback/augmentation alongside the curated manifest.
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
