#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// SEED THE GRAPH WAREHOUSE  ·  scripts/seed_graph.mjs
//
// Expands Scout's ClickHouse warehouse from 6 tables to 34 by generating 28 new
// interconnected fintech/card-issuer tables. There are NO foreign-key constraints
// (ClickHouse has none) - tables are linked only by shared key columns, exactly
// the implicit graph the Graph RAG layer (lib/graph/) later recovers.
//
// REALISM IS THE POINT. The new data is not random filler:
//   1. DERIVED from real facts where one already exists, so totals reconcile:
//      rewards_ledger / statements are computed from real card_transactions;
//      disputes / fraud_alerts come from transactions actually flagged is_fraud;
//      loan_repayments is the real EMI schedule; collections only on delinquent loans.
//   2. One coherent PER-CUSTOMER PROFILE (seeded from the customer's existing
//      value_band / credit_score / income / status) drives every related row, so
//      card limits track income, bureau scores track credit scores, dormant
//      customers show sparse engagement, etc.
//
// SAFETY: this script can only ever touch the 28 names in NEW_TABLES below. The 6
// existing tables (customers, loan_book, card_transactions, market_sales,
// ecommerce_orders, marketing_campaigns) are never created, written, or dropped.
//
// Usage:
//   node scripts/seed_graph.mjs            # create-if-absent, skip populated tables
//   node scripts/seed_graph.mjs --rebuild  # DROP + rebuild the 28 new tables only
//   node scripts/seed_graph.mjs --verify   # run only the reconciliation checks
//   SCALE=0.5 node scripts/seed_graph.mjs  # scale the independent fact tables
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ── Env / config ─────────────────────────────────────────────────────────────
const HERE = dirname(fileURLToPath(import.meta.url));
loadEnv(join(HERE, "..", ".env"));

const URL_BASE = (process.env.CLICKHOUSE_HOST || "").replace(/\/$/, "");
const DB = process.env.CLICKHOUSE_DATABASE || "default";
const AUTH = "Basic " + Buffer.from(`${process.env.CLICKHOUSE_USER || "default"}:${process.env.CLICKHOUSE_PASSWORD || ""}`).toString("base64");
if (!URL_BASE) throw new Error("CLICKHOUSE_HOST is not set (check .env)");

const SCALE = Number(process.env.SCALE || "1");
const REBUILD = process.argv.includes("--rebuild");
const VERIFY_ONLY = process.argv.includes("--verify");
const CHUNK = 50_000;
const NOW = new Date("2026-06-24T00:00:00Z");

// The ONLY tables this script may create / write / drop. Existing tables are absent.
const NEW_TABLES = [
  "geographies", "branches", "employees", "card_products", "loan_products",
  "merchant_categories", "merchants", "devices", "accounts", "cards",
  "card_applications", "account_transactions", "loan_applications", "loan_repayments",
  "collections", "credit_bureau", "disputes", "fraud_alerts", "kyc_records",
  "aml_screenings", "rewards_ledger", "reward_redemptions", "offers",
  "offer_redemptions", "campaign_responses", "support_tickets", "app_sessions", "statements",
];

// ── ClickHouse transport ─────────────────────────────────────────────────────
async function chRead(sql) {
  const res = await fetch(`${URL_BASE}/?database=${DB}`, {
    method: "POST", headers: { Authorization: AUTH, "Content-Type": "text/plain" },
    body: `${sql} FORMAT TSV`,
  });
  if (!res.ok) throw new Error(`read failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const text = await res.text();
  return text.length ? text.replace(/\n$/, "").split("\n").map((l) => l.split("\t")) : [];
}
async function chScalar(sql) { const r = await chRead(sql); return r.length ? r[0][0] : null; }
async function chExec(query, body, settings = {}) {
  const params = new URLSearchParams();
  if (body !== undefined) params.set("query", query);
  for (const [k, v] of Object.entries(settings)) params.set(k, v);
  const res = await fetch(`${URL_BASE}/?${params.toString()}`, {
    method: "POST", headers: { Authorization: AUTH, "Content-Type": "text/plain" },
    body: body !== undefined ? body : query,
  });
  if (!res.ok) throw new Error(`exec failed (${res.status}): ${(await res.text()).slice(0, 400)}`);
}

// ── Deterministic randomness ─────────────────────────────────────────────────
function xfnv1a(str) { let h = 2166136261 >>> 0; for (let i = 0; i < str.length; i++) { h = Math.imul(h ^ str.charCodeAt(i), 16777619); } return h >>> 0; }
function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rngOf = (seedStr) => mulberry32(xfnv1a(seedStr));
function gauss(rng, mean, sd) { const u = 1 - rng(), v = rng(); return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function lognormal(rng, median, sigma) { return median * Math.exp(sigma * gauss(rng, 0, 1)); }
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
function wpick(rng, pairs) { let t = 0; for (const [, w] of pairs) t += w; let x = rng() * t; for (const [v, w] of pairs) { if ((x -= w) <= 0) return v; } return pairs[pairs.length - 1][0]; }
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const randInt = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));

// ── Date / format helpers ────────────────────────────────────────────────────
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const ymdhms = (d) => `${ymd(d)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
const parseDate = (s) => new Date(`${s}T00:00:00Z`);
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
const addMonths = (d, n) => { const x = new Date(d); x.setUTCMonth(x.getUTCMonth() + n); return x; };
const monthsBetween = (a, b) => (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
const id = (prefix, n, width = 8) => `${prefix}${String(n).padStart(width, "0")}`;

// ── CSV inserter (chunked) ───────────────────────────────────────────────────
function cell(v) {
  if (v === null || v === undefined) return "";
  const s = typeof v === "number" ? (Number.isInteger(v) ? String(v) : String(v)) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
class Inserter {
  constructor(table, cols) { this.table = table; this.cols = cols; this.header = cols.join(","); this.buf = []; this.total = 0; }
  async push(row) { this.buf.push(this.cols.map((c) => cell(row[c])).join(",")); if (this.buf.length >= CHUNK) await this.flush(); }
  async flush() {
    if (!this.buf.length) return;
    const body = this.header + "\n" + this.buf.join("\n") + "\n";
    await chExec(`INSERT INTO \`${this.table}\` FORMAT CSVWithNames`, body, { input_format_null_as_default: "1" });
    this.total += this.buf.length; this.buf = [];
  }
}

// Build one table: define columns/types, ORDER BY, and a fill(push) generator.
async function table(name, colDefs, orderBy, fill) {
  if (!NEW_TABLES.includes(name)) throw new Error(`refusing to touch non-allowlisted table ${name}`);
  if (REBUILD) await chExec(`DROP TABLE IF EXISTS \`${name}\``);
  const exists = await chScalar(`SELECT count() FROM system.tables WHERE database='${DB}' AND name='${name}'`);
  if (Number(exists) > 0 && !REBUILD) {
    const rows = Number(await chScalar(`SELECT count() FROM \`${name}\``));
    if (rows > 0) { console.log(`  • ${name.padEnd(20)} skip (already has ${rows.toLocaleString()} rows)`); return; }
  }
  const cols = colDefs.map(([c, t]) => `\`${c}\` ${t}`).join(", ");
  await chExec(`CREATE TABLE IF NOT EXISTS \`${name}\` (${cols}) ENGINE = MergeTree ORDER BY ${orderBy}`);
  const ins = new Inserter(name, colDefs.map(([c]) => c));
  const t0 = Date.now();
  await fill((row) => ins.push(row));
  await ins.flush();
  console.log(`  ✓ ${name.padEnd(20)} ${ins.total.toLocaleString().padStart(9)} rows  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Static reference data
// ─────────────────────────────────────────────────────────────────────────────
const GEO = {
  Mumbai: ["Maharashtra", "West", 1], Delhi: ["Delhi", "North", 1], Bengaluru: ["Karnataka", "South", 1],
  Hyderabad: ["Telangana", "South", 1], Chennai: ["Tamil Nadu", "South", 1], Kolkata: ["West Bengal", "East", 1],
  Pune: ["Maharashtra", "West", 1], Ahmedabad: ["Gujarat", "West", 1], Surat: ["Gujarat", "West", 2],
  Jaipur: ["Rajasthan", "North", 2], Lucknow: ["Uttar Pradesh", "North", 2], Kanpur: ["Uttar Pradesh", "North", 2],
  Nagpur: ["Maharashtra", "West", 2], Indore: ["Madhya Pradesh", "Central", 2], Bhopal: ["Madhya Pradesh", "Central", 2],
  Patna: ["Bihar", "East", 2], Vadodara: ["Gujarat", "West", 2], Coimbatore: ["Tamil Nadu", "South", 2],
  Kochi: ["Kerala", "South", 2], Visakhapatnam: ["Andhra Pradesh", "South", 2], Chandigarh: ["Chandigarh", "North", 2],
  Guwahati: ["Assam", "Northeast", 2], Mysuru: ["Karnataka", "South", 2], Gurugram: ["Haryana", "North", 2],
  Noida: ["Uttar Pradesh", "North", 2],
};
const BRANCH_CITY = {
  "BR-KAN": "Kanpur", "BR-JAI": "Jaipur", "BR-KOL": "Kolkata", "BR-IND": "Indore", "BR-COI": "Coimbatore",
  "BR-AHM": "Ahmedabad", "BR-VAD": "Vadodara", "BR-PUN": "Pune", "BR-PAT": "Patna", "BR-NAG": "Nagpur",
  "BR-CHE": "Chennai", "BR-MUM": "Mumbai", "BR-BEN": "Bengaluru", "BR-SUR": "Surat", "BR-DEL": "Delhi",
  "BR-LUC": "Lucknow", "BR-HYD": "Hyderabad", "BR-BHO": "Bhopal",
};
const BRANCH_CODES = Object.keys(BRANCH_CITY);
// card products, ordered by the income they unlock (used to gate tier by income).
const CARD_PRODUCTS = [
  { id: "CP-STD", name: "Everyday Platinum", network: "RuPay", tier: "Standard", fee: 0, rate: 0.005, minIncome: 0 },
  { id: "CP-GLD", name: "Rewards Gold", network: "Visa", tier: "Gold", fee: 500, rate: 0.01, minIncome: 400000 },
  { id: "CP-PLT", name: "Platinum Select", network: "Mastercard", tier: "Platinum", fee: 2500, rate: 0.02, minIncome: 1200000 },
  { id: "CP-SIG", name: "Signature Privilege", network: "Visa", tier: "Signature", fee: 5000, rate: 0.03, minIncome: 3000000 },
  { id: "CP-INF", name: "Infinite Reserve", network: "Visa", tier: "Infinite", fee: 12500, rate: 0.05, minIncome: 6000000 },
];
const LOAN_PRODUCTS = [
  { id: "LP-HOME", product: "Home", category: "Secured", base: 8.5, maxTen: 240, fee: 0.5 },
  { id: "LP-AUTO", product: "Auto", category: "Secured", base: 9.5, maxTen: 84, fee: 1.0 },
  { id: "LP-GOLD", product: "Gold", category: "Secured", base: 11.0, maxTen: 36, fee: 0.75 },
  { id: "LP-EDU", product: "Education", category: "Secured", base: 10.5, maxTen: 120, fee: 0.5 },
  { id: "LP-PERS", product: "Personal", category: "Unsecured", base: 14.0, maxTen: 60, fee: 2.0 },
  { id: "LP-CC", product: "Credit Card", category: "Unsecured", base: 36.0, maxTen: 24, fee: 0 },
  { id: "LP-BNPL", product: "BNPL", category: "Unsecured", base: 22.0, maxTen: 12, fee: 1.5 },
];
const LP_BY_PRODUCT = Object.fromEntries(LOAN_PRODUCTS.map((p) => [p.product, p.id]));
const MCC = {
  Groceries: ["5411", "Retail", "Low"], Dining: ["5812", "Food & Hospitality", "Low"],
  "Food Delivery": ["5814", "Food & Hospitality", "Low"], Apparel: ["5651", "Retail", "Low"],
  Electronics: ["5732", "Retail", "Medium"], Travel: ["4722", "Travel", "Medium"],
  Fuel: ["5541", "Fuel", "Low"], Entertainment: ["7832", "Lifestyle", "Low"],
  Healthcare: ["8011", "Essential", "Low"], Education: ["8220", "Essential", "Low"],
  Utilities: ["4900", "Essential", "Low"], Transport: ["4111", "Travel", "Low"],
  Subscriptions: ["4899", "Lifestyle", "Low"], Beauty: ["5977", "Retail", "Low"],
};

// ─────────────────────────────────────────────────────────────────────────────
// Per-customer profile: derived ONCE from existing attributes, stable across runs.
// ─────────────────────────────────────────────────────────────────────────────
const BAND_RANK = { Low: 0, Medium: 1, High: 2, VIP: 3 };
function buildProfile(c) {
  const rng = rngOf("prof:" + c.customer_id);
  const bandRank = BAND_RANK[c.value_band] ?? 0;
  // Engagement: Active customers are engaged, Dormant barely, Churned not at all; lifted by value band.
  const baseEng = c.status === "Active" ? 0.55 : c.status === "Dormant" ? 0.12 : 0.02;
  const engagement = clamp(baseEng + bandRank * 0.1 + (rng() - 0.5) * 0.15, 0.01, 1);
  // Fraud propensity rises with risk band E/D and a small base rate.
  const riskBoost = { A: 0, B: 0.2, C: 0.5, D: 1.2, E: 2.2 }[c.risk_band] ?? 0.3;
  return {
    rng, bandRank, engagement,
    fraudProne: clamp(0.003 + riskBoost * 0.004, 0, 0.05),
    income: c.annual_income, credit: c.credit_score, signup: parseDate(c.signup_date),
    lastTxn: parseDate(c.last_txn_date), status: c.status, city: c.city, valueBand: c.value_band,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\nScout graph seeder → ${URL_BASE} / ${DB}  (SCALE=${SCALE}${REBUILD ? ", REBUILD" : ""})\n`);

  if (VERIFY_ONLY) { await reconcile(); return; }

  // ── Load the existing universe ─────────────────────────────────────────────
  console.log("Loading existing universe…");
  const custRows = await chRead(
    `SELECT customer_id, age, city, state, segment, value_band, credit_score, credit_limit,
            current_balance, annual_income, signup_date, last_txn_date, status, tenure_months,
            channel, kyc_status, risk_band, gender FROM customers`,
  );
  const customers = custRows.map((r) => ({
    customer_id: r[0], age: +r[1], city: r[2], state: r[3], segment: r[4], value_band: r[5],
    credit_score: +r[6], credit_limit: +r[7], current_balance: +r[8], annual_income: +r[9],
    signup_date: r[10], last_txn_date: r[11], status: r[12], tenure_months: +r[13],
    channel: r[14], kyc_status: r[15], risk_band: r[16], gender: r[17],
  }));
  const profile = new Map(customers.map((c) => [c.customer_id, buildProfile(c)]));
  console.log(`  customers: ${customers.length.toLocaleString()}`);

  const loanRows = await chRead(
    `SELECT loan_id, customer_id, product, disbursed_date, principal, outstanding, interest_rate,
            tenure_months, emi, dpd, dpd_bucket, status, branch, sanctioned_amount, collateral FROM loan_book`,
  );
  const loans = loanRows.map((r) => ({
    loan_id: r[0], customer_id: r[1], product: r[2], disbursed_date: r[3], principal: +r[4],
    outstanding: +r[5], interest_rate: +r[6], tenure_months: +r[7], emi: +r[8], dpd: +r[9],
    dpd_bucket: r[10], status: r[11], branch: r[12], sanctioned_amount: +r[13], collateral: r[14],
  }));
  console.log(`  loans: ${loans.length.toLocaleString()}`);

  const txnRows = await chRead(
    `SELECT txn_id, customer_id, txn_datetime, amount, merchant, merchant_category, city, channel, is_fraud, reward_points
     FROM card_transactions`,
  );
  const txns = txnRows.map((r) => ({
    txn_id: r[0], customer_id: r[1], ts: r[2], amount: +r[3], merchant: r[4],
    category: r[5], city: r[6], channel: r[7], is_fraud: +r[8], reward_points: +r[9],
  }));
  console.log(`  card transactions: ${txns.length.toLocaleString()}`);

  // Per-customer aggregates derived from real facts.
  const cardCustomers = new Set(txns.map((t) => t.customer_id));
  const merchantCat = new Map(); // merchant -> modal category (for the merchants dimension)
  const earnedPoints = new Map(); // customer -> total reward points (reconciles with rewards_ledger)
  for (const t of txns) {
    if (!merchantCat.has(t.merchant)) merchantCat.set(t.merchant, t.category);
    earnedPoints.set(t.customer_id, (earnedPoints.get(t.customer_id) || 0) + t.reward_points);
  }
  const loansByCustomer = new Map();
  for (const l of loans) { if (!loansByCustomer.has(l.customer_id)) loansByCustomer.set(l.customer_id, []); loansByCustomer.get(l.customer_id).push(l); }

  console.log("\nGenerating tables…");

  // ── 1. geographies ─────────────────────────────────────────────────────────
  await table("geographies",
    [["city", "String"], ["state", "LowCardinality(String)"], ["region", "LowCardinality(String)"],
     ["city_tier", "UInt8"], ["metro_flag", "UInt8"], ["zone", "LowCardinality(String)"]],
    "city",
    async (push) => { for (const [city, [state, region, tier]] of Object.entries(GEO)) await push({ city, state, region, city_tier: tier, metro_flag: tier === 1 ? 1 : 0, zone: region }); });

  // ── 2. employees (needed before branches: branch manager references one) ─────
  const empByBranch = new Map(BRANCH_CODES.map((b) => [b, []]));
  const ROLES = [["Relationship Manager", 6], ["Teller", 5], ["Collections Officer", 4], ["Support Agent", 4], ["Credit Analyst", 2], ["Compliance Officer", 1]];
  let empN = 0;
  const employees = [];
  for (const br of BRANCH_CODES) {
    const rng = rngOf("br:" + br);
    const city = BRANCH_CITY[br];
    const mgr = { employee_id: id("EMP", ++empN, 6), branch_id: br, full_name: randName(rng), role: "Branch Manager", department: "Branch Ops", hire_date: ymd(addDays(NOW, -randInt(rng, 1500, 5500))), manager_id: "", status: "Active", city };
    employees.push(mgr); empByBranch.get(br).push(mgr);
    const headcount = randInt(rng, 18, 28);
    for (let i = 0; i < headcount; i++) {
      const role = wpick(rng, ROLES);
      const e = { employee_id: id("EMP", ++empN, 6), branch_id: br, full_name: randName(rng), role, department: deptOf(role), hire_date: ymd(addDays(NOW, -randInt(rng, 60, 4500))), manager_id: mgr.employee_id, status: wpick(rng, [["Active", 92], ["On Leave", 5], ["Resigned", 3]]), city };
      employees.push(e); empByBranch.get(br).push(e);
    }
  }
  const collectorsByBranch = new Map(BRANCH_CODES.map((b) => [b, empByBranch.get(b).filter((e) => e.role === "Collections Officer")]));
  const supportAgents = employees.filter((e) => e.role === "Support Agent");
  const complianceOfficers = employees.filter((e) => e.role === "Compliance Officer");
  await table("employees",
    [["employee_id", "String"], ["branch_id", "LowCardinality(String)"], ["full_name", "String"], ["role", "LowCardinality(String)"],
     ["department", "LowCardinality(String)"], ["hire_date", "Date"], ["manager_id", "String"], ["status", "LowCardinality(String)"], ["city", "LowCardinality(String)"]],
    "(branch_id, employee_id)",
    async (push) => { for (const e of employees) await push(e); });

  // ── 3. branches ─────────────────────────────────────────────────────────────
  await table("branches",
    [["branch_id", "String"], ["branch_name", "String"], ["city", "LowCardinality(String)"], ["state", "LowCardinality(String)"],
     ["region", "LowCardinality(String)"], ["ifsc", "String"], ["branch_type", "LowCardinality(String)"], ["opened_date", "Date"],
     ["manager_employee_id", "String"], ["headcount", "UInt16"]],
    "branch_id",
    async (push) => {
      for (const br of BRANCH_CODES) {
        const rng = rngOf("brmeta:" + br); const city = BRANCH_CITY[br]; const [state, region] = GEO[city];
        await push({ branch_id: br, branch_name: `${city} Main Branch`, city, state, region,
          ifsc: `SCBL000${randInt(rng, 1000, 9999)}`, branch_type: wpick(rng, [["Urban", 6], ["Metro", 3], ["Semi-Urban", 2]]),
          opened_date: ymd(addDays(NOW, -randInt(rng, 2000, 7000))), manager_employee_id: empByBranch.get(br)[0].employee_id, headcount: empByBranch.get(br).length });
      }
    });

  // ── 4. card_products ────────────────────────────────────────────────────────
  await table("card_products",
    [["card_product_id", "String"], ["product_name", "String"], ["network", "LowCardinality(String)"], ["tier", "LowCardinality(String)"],
     ["annual_fee", "UInt32"], ["joining_fee", "UInt32"], ["reward_rate", "Decimal(5,4)"], ["forex_markup", "Decimal(4,2)"],
     ["min_income", "UInt32"], ["segment", "LowCardinality(String)"]],
    "card_product_id",
    async (push) => { for (const p of CARD_PRODUCTS) await push({ card_product_id: p.id, product_name: p.name, network: p.network, tier: p.tier, annual_fee: p.fee, joining_fee: Math.round(p.fee / 2), reward_rate: p.rate.toFixed(4), forex_markup: (p.tier === "Infinite" ? 0 : p.tier === "Signature" ? 1.5 : 3.5).toFixed(2), min_income: p.minIncome, segment: p.minIncome >= 3000000 ? "Premium" : p.minIncome >= 1200000 ? "Affluent" : "Mass" }); });

  // ── 5. loan_products ────────────────────────────────────────────────────────
  await table("loan_products",
    [["loan_product_id", "String"], ["product", "LowCardinality(String)"], ["category", "LowCardinality(String)"], ["min_amount", "UInt32"],
     ["max_amount", "UInt64"], ["base_rate", "Decimal(5,2)"], ["max_tenure_months", "UInt16"], ["processing_fee_pct", "Decimal(4,2)"]],
    "loan_product_id",
    async (push) => { for (const p of LOAN_PRODUCTS) await push({ loan_product_id: p.id, product: p.product, category: p.category, min_amount: 25000, max_amount: p.category === "Secured" ? 50000000 : 5000000, base_rate: p.base.toFixed(2), max_tenure_months: p.maxTen, processing_fee_pct: p.fee.toFixed(2) }); });

  // ── 6. merchant_categories ──────────────────────────────────────────────────
  await table("merchant_categories",
    [["mcc_code", "String"], ["merchant_category", "LowCardinality(String)"], ["category_group", "LowCardinality(String)"], ["risk_level", "LowCardinality(String)"]],
    "mcc_code",
    async (push) => { for (const [catn, [code, group, risk]] of Object.entries(MCC)) await push({ mcc_code: code, merchant_category: catn, category_group: group, risk_level: risk }); });

  // ── 7. merchants (one row per real merchant brand in card_transactions) ──────
  let merchN = 0;
  await table("merchants",
    [["merchant_id", "String"], ["merchant_name", "String"], ["merchant_category", "LowCardinality(String)"], ["mcc_code", "String"],
     ["city", "LowCardinality(String)"], ["acquirer", "LowCardinality(String)"], ["online_flag", "UInt8"], ["active_since", "Date"]],
    "merchant_id",
    async (push) => {
      for (const [name, catn] of merchantCat) {
        const rng = rngOf("merch:" + name);
        await push({ merchant_id: id("MERCH", ++merchN, 5), merchant_name: name, merchant_category: catn, mcc_code: (MCC[catn] || ["0000"])[0],
          city: pick(rng, Object.keys(GEO)), acquirer: pick(rng, ["HDFC", "ICICI", "Axis", "SBI", "Pine Labs", "Razorpay"]), online_flag: wpick(rng, [[1, 6], [0, 4]]), active_since: ymd(addDays(NOW, -randInt(rng, 400, 4000))) });
      }
    });

  // ── 8. devices (for engaged / card-holding customers) ───────────────────────
  const deviceOf = new Map(); // customer -> primary device_id
  let devN = 0;
  await table("devices",
    [["device_id", "String"], ["customer_id", "String"], ["device_type", "LowCardinality(String)"], ["os_version", "LowCardinality(String)"],
     ["model", "LowCardinality(String)"], ["first_seen_date", "Date"], ["last_seen_date", "Date"], ["is_trusted", "UInt8"], ["push_enabled", "UInt8"]],
    "(customer_id, device_id)",
    async (push) => {
      for (const c of customers) {
        const p = profile.get(c.customer_id);
        if (!cardCustomers.has(c.customer_id) && c.status !== "Active") continue; // only engaged/cardholders have a device
        const rng = p.rng;
        const nDev = c.status === "Active" && p.bandRank >= 2 ? randInt(rng, 1, 2) : 1;
        const iosSkew = p.bandRank >= 2 ? 0.55 : 0.3;
        for (let i = 0; i < nDev; i++) {
          const ios = rng() < iosSkew;
          const did = id("DEV", ++devN, 9);
          if (i === 0) deviceOf.set(c.customer_id, did);
          await push({ device_id: did, customer_id: c.customer_id, device_type: ios ? "iOS" : "Android",
            os_version: ios ? pick(rng, ["17.4", "17.2", "16.6", "18.0"]) : pick(rng, ["14", "13", "12", "15"]),
            model: ios ? pick(rng, ["iPhone 15", "iPhone 14", "iPhone 13", "iPhone SE"]) : pick(rng, ["Galaxy S23", "OnePlus 11", "Redmi Note 12", "Pixel 7", "Vivo V27"]),
            first_seen_date: ymd(p.signup), last_seen_date: ymd(c.status === "Active" ? p.lastTxn : addDays(p.lastTxn, -randInt(rng, 30, 400))),
            is_trusted: i === 0 ? 1 : 0, push_enabled: wpick(rng, [[1, 7], [0, 3]]) });
        }
      }
    });

  // ── 9. accounts (everyone has a primary account) ────────────────────────────
  const accountOf = new Map(); // customer -> primary account_id
  let accN = 0;
  await table("accounts",
    [["account_id", "String"], ["customer_id", "String"], ["account_type", "LowCardinality(String)"], ["branch_id", "LowCardinality(String)"],
     ["open_date", "Date"], ["status", "LowCardinality(String)"], ["current_balance", "Decimal(18,2)"], ["avg_monthly_balance", "Decimal(18,2)"],
     ["interest_rate", "Decimal(4,2)"], ["ifsc", "String"], ["is_primary", "UInt8"]],
    "(branch_id, customer_id)",
    async (push) => {
      for (const c of customers) {
        const p = profile.get(c.customer_id); const rng = p.rng;
        const branch = pick(rng, BRANCH_CODES);
        const accType = wpick(rng, [["Savings", 6], ["Salary", 3], ["Current", 1]]);
        const aid = id("ACC", ++accN, 11); accountOf.set(c.customer_id, aid);
        const status = c.status === "Churned" ? "Closed" : c.status === "Dormant" ? "Dormant" : "Active";
        await push({ account_id: aid, customer_id: c.customer_id, account_type: accType, branch_id: branch, open_date: c.signup_date,
          status, current_balance: c.current_balance.toFixed(2), avg_monthly_balance: (c.current_balance * (0.7 + rng() * 0.6)).toFixed(2),
          interest_rate: (accType === "Current" ? 0 : 3.5).toFixed(2), ifsc: `SCBL000${randInt(rng, 1000, 9999)}`, is_primary: 1 });
        if (accType === "Salary" && rng() < 0.25) { // a few also keep a savings account
          await push({ account_id: id("ACC", ++accN, 11), customer_id: c.customer_id, account_type: "Savings", branch_id: branch, open_date: ymd(addDays(p.signup, randInt(rng, 30, 900))), status, current_balance: (c.current_balance * rng() * 0.5).toFixed(2), avg_monthly_balance: (c.current_balance * rng() * 0.4).toFixed(2), interest_rate: "3.50", ifsc: `SCBL000${randInt(rng, 1000, 9999)}`, is_primary: 0 });
        }
      }
    });

  // ── 10. cards (cardholders = customers with card_transactions) ──────────────
  const cardOf = new Map(); // customer -> primary card_id
  const cardProductOf = new Map();
  let cardN = 0;
  await table("cards",
    [["card_id", "String"], ["customer_id", "String"], ["account_id", "String"], ["card_product_id", "LowCardinality(String)"],
     ["card_type", "LowCardinality(String)"], ["network", "LowCardinality(String)"], ["card_number_masked", "String"], ["issue_date", "Date"],
     ["expiry_date", "Date"], ["status", "LowCardinality(String)"], ["credit_limit", "UInt32"], ["current_outstanding", "Decimal(18,2)"], ["available_limit", "Decimal(18,2)"]],
    "(customer_id, card_id)",
    async (push) => {
      for (const c of customers) {
        if (!cardCustomers.has(c.customer_id)) continue;
        const p = profile.get(c.customer_id); const rng = p.rng;
        // tier gated by income: the most premium product the income unlocks (with a little spread).
        let prod = CARD_PRODUCTS[0];
        for (const cp of CARD_PRODUCTS) if (c.annual_income >= cp.minIncome) prod = cp;
        if (rng() < 0.25 && BAND_RANK[c.value_band] > 0) { const i = Math.max(0, CARD_PRODUCTS.indexOf(prod) - 1); prod = CARD_PRODUCTS[i]; }
        const cid = id("CARD", ++cardN, 10); cardOf.set(c.customer_id, cid); cardProductOf.set(c.customer_id, prod);
        const issue = addDays(p.signup, randInt(rng, 10, 400));
        const limit = Math.round(c.credit_limit / 1000) * 1000 || 50000;
        const outstanding = +(limit * rng() * (c.status === "Active" ? 0.5 : 0.15)).toFixed(2);
        await push({ card_id: cid, customer_id: c.customer_id, account_id: accountOf.get(c.customer_id), card_product_id: prod.id,
          card_type: "Credit", network: prod.network, card_number_masked: `${pick(rng, ["4", "5", "6"])}XXXXXXXXXXX${randInt(rng, 1000, 9999)}`,
          issue_date: ymd(issue), expiry_date: ymd(addMonths(issue, 48)), status: c.status === "Churned" ? "Blocked" : wpick(rng, [["Active", 90], ["Blocked", 4], ["Expired", 6]]),
          credit_limit: limit, current_outstanding: outstanding.toFixed(2), available_limit: (limit - outstanding).toFixed(2) });
      }
    });

  // ── 11. card_applications (approved → existing cards; plus rejected ones) ────
  let capN = 0;
  await table("card_applications",
    [["application_id", "String"], ["customer_id", "String"], ["card_product_id", "LowCardinality(String)"], ["applied_date", "Date"],
     ["channel", "LowCardinality(String)"], ["status", "LowCardinality(String)"], ["decision", "LowCardinality(String)"],
     ["credit_limit_approved", "UInt32"], ["branch_id", "LowCardinality(String)"], ["rejection_reason", "LowCardinality(String)"]],
    "(applied_date, customer_id)",
    async (push) => {
      for (const c of customers) {
        const p = profile.get(c.customer_id); const rng = p.rng;
        if (cardCustomers.has(c.customer_id)) { // the approved application behind their card
          const prod = cardProductOf.get(c.customer_id);
          await push({ application_id: id("CAPP", ++capN, 8), customer_id: c.customer_id, card_product_id: prod.id, applied_date: ymd(addDays(p.signup, randInt(rng, 1, 30))), channel: c.channel, status: "Approved", decision: "Approved", credit_limit_approved: Math.round(c.credit_limit / 1000) * 1000 || 50000, branch_id: pick(rng, BRANCH_CODES), rejection_reason: "" });
        } else if (rng() < 0.18) { // some non-cardholders applied and were rejected/pending
          const rejected = c.credit_score < 650 || rng() < 0.5;
          await push({ application_id: id("CAPP", ++capN, 8), customer_id: c.customer_id, card_product_id: pick(rng, CARD_PRODUCTS).id, applied_date: ymd(addDays(p.signup, randInt(rng, 30, 1500))), channel: c.channel, status: rejected ? "Rejected" : "Pending", decision: rejected ? "Declined" : "Under Review", credit_limit_approved: 0, branch_id: pick(rng, BRANCH_CODES), rejection_reason: rejected ? wpick(rng, [["Low credit score", 5], ["Insufficient income", 3], ["Existing delinquency", 2], ["Incomplete KYC", 1]]) : "" });
        }
      }
    });

  // ── 12. account_transactions (salary credits + spends, balance-consistent) ──
  let atN = 0;
  await table("account_transactions",
    [["txn_id", "String"], ["account_id", "String"], ["customer_id", "String"], ["txn_date", "Date"], ["txn_type", "LowCardinality(String)"],
     ["category", "LowCardinality(String)"], ["amount", "Decimal(18,2)"], ["mode", "LowCardinality(String)"], ["balance_after", "Decimal(18,2)"], ["narration", "String"]],
    "(account_id, txn_date)",
    async (push) => {
      for (const c of customers) {
        if (c.status === "Churned") continue;
        const p = profile.get(c.customer_id); const rng = p.rng;
        const months = clamp(Math.round(p.engagement * 8 * SCALE), 1, 12);
        let bal = c.current_balance;
        for (let m = 0; m < months; m++) {
          const d = addDays(NOW, -randInt(rng, 1, 360));
          const isCredit = rng() < 0.4;
          const amt = isCredit ? Math.round(c.annual_income / 12) : Math.round(lognormal(rng, 2500, 0.9));
          bal += isCredit ? amt : -amt;
          await push({ txn_id: id("ATXN", ++atN, 10), account_id: accountOf.get(c.customer_id), customer_id: c.customer_id, txn_date: ymd(d), txn_type: isCredit ? "Credit" : "Debit", category: isCredit ? wpick(rng, [["Salary", 6], ["Transfer", 3], ["Interest", 1]]) : wpick(rng, [["Bill Payment", 4], ["ATM", 2], ["Transfer", 3], ["Purchase", 1]]), amount: amt.toFixed(2), mode: wpick(rng, [["UPI", 5], ["NEFT", 2], ["IMPS", 2], ["ATM", 1]]), balance_after: Math.max(0, bal).toFixed(2), narration: isCredit ? "Inward credit" : "Outward debit" });
        }
      }
    });

  // ── 13. loan_applications (approved behind each loan + extra rejects) ────────
  let lapN = 0;
  await table("loan_applications",
    [["application_id", "String"], ["customer_id", "String"], ["loan_product_id", "LowCardinality(String)"], ["applied_date", "Date"],
     ["amount_requested", "UInt64"], ["tenure_requested", "UInt16"], ["status", "LowCardinality(String)"], ["decision", "LowCardinality(String)"],
     ["approved_amount", "UInt64"], ["branch_id", "LowCardinality(String)"], ["credit_score_at_apply", "UInt16"]],
    "(applied_date, customer_id)",
    async (push) => {
      for (const l of loans) {
        const rng = rngOf("lapp:" + l.loan_id);
        await push({ application_id: id("LAPP", ++lapN, 8), customer_id: l.customer_id, loan_product_id: LP_BY_PRODUCT[l.product] || "LP-PERS",
          applied_date: ymd(addDays(parseDate(l.disbursed_date), -randInt(rng, 3, 21))), amount_requested: Math.round(l.sanctioned_amount * (1 + rng() * 0.2)), tenure_requested: l.tenure_months,
          status: "Approved", decision: "Approved", approved_amount: l.sanctioned_amount, branch_id: l.branch, credit_score_at_apply: clamp(Math.round((profile.get(l.customer_id)?.credit || 650) + gauss(rng, 0, 15)), 300, 900) });
      }
      // additional rejected/pending applications (no resulting loan)
      const extra = Math.round(40000 * SCALE);
      for (let i = 0; i < extra; i++) {
        const c = customers[Math.floor(rngOf("lappx:" + i)() * customers.length)]; const rng = rngOf("lappx:" + i + c.customer_id);
        const rejected = c.credit_score < 640 || rng() < 0.55;
        await push({ application_id: id("LAPP", ++lapN, 8), customer_id: c.customer_id, loan_product_id: pick(rng, LOAN_PRODUCTS).id, applied_date: ymd(addDays(NOW, -randInt(rng, 1, 1200))), amount_requested: Math.round(lognormal(rng, 400000, 1.1)), tenure_requested: pick(rng, [12, 24, 36, 48, 60]), status: rejected ? "Rejected" : "Pending", decision: rejected ? "Declined" : "Under Review", approved_amount: 0, branch_id: pick(rng, BRANCH_CODES), credit_score_at_apply: c.credit_score });
      }
    });

  // ── 14. loan_repayments (real EMI schedule; arrears match dpd/status) ────────
  let lrN = 0;
  await table("loan_repayments",
    [["repayment_id", "String"], ["loan_id", "String"], ["customer_id", "String"], ["installment_no", "UInt16"], ["due_date", "Date"],
     ["paid_date", "Date"], ["amount_due", "Decimal(14,2)"], ["amount_paid", "Decimal(14,2)"], ["status", "LowCardinality(String)"], ["days_late", "Int32"]],
    "(loan_id, installment_no)",
    async (push) => {
      for (const l of loans) {
        const rng = rngOf("lr:" + l.loan_id);
        const disb = parseDate(l.disbursed_date);
        const elapsed = clamp(monthsBetween(disb, NOW), 0, l.tenure_months);
        const cap = Math.min(elapsed, 18); // keep recent 18 installments per loan
        const start = elapsed - cap + 1;
        const arrears = l.status === "Written-off" ? 99 : l.status === "NPA" ? Math.ceil(l.dpd / 30) + 2 : l.status === "Delinquent" ? Math.max(1, Math.round(l.dpd / 30)) : 0;
        for (let k = 0; k < cap; k++) {
          const inst = start + k; if (inst < 1) continue;
          const due = addMonths(disb, inst);
          const isArrear = (elapsed - inst) < arrears; // most recent `arrears` installments unpaid
          let status, paidDate, paid, late;
          if (isArrear) { status = (NOW - due) / 86400000 > 90 ? "Defaulted" : "Overdue"; paidDate = ""; paid = 0; late = Math.max(0, Math.round((NOW - due) / 86400000)); }
          else { late = rng() < 0.12 ? randInt(rng, 1, 25) : 0; status = late > 0 ? "Paid Late" : "Paid"; paidDate = ymd(addDays(due, late)); paid = l.emi; }
          await push({ repayment_id: id("RPMT", ++lrN, 10), loan_id: l.loan_id, customer_id: l.customer_id, installment_no: inst, due_date: ymd(due), paid_date: paidDate, amount_due: l.emi.toFixed(2), amount_paid: Number(paid).toFixed(2), status, days_late: late });
        }
      }
    });

  // ── 15. collections (ONLY delinquent/NPA/written-off loans) ─────────────────
  let colN = 0;
  await table("collections",
    [["case_id", "String"], ["loan_id", "String"], ["customer_id", "String"], ["assigned_employee_id", "String"], ["open_date", "Date"],
     ["close_date", "Date"], ["dpd", "UInt16"], ["bucket", "LowCardinality(String)"], ["status", "LowCardinality(String)"],
     ["amount_overdue", "Decimal(14,2)"], ["recovered_amount", "Decimal(14,2)"], ["priority", "LowCardinality(String)"]],
    "(open_date, loan_id)",
    async (push) => {
      for (const l of loans) {
        if (!["Delinquent", "NPA", "Written-off"].includes(l.status)) continue;
        const rng = rngOf("col:" + l.loan_id);
        const collectors = collectorsByBranch.get(l.branch) || [];
        const emp = collectors.length ? pick(rng, collectors) : id("EMP", 1, 6);
        const overdue = +(l.emi * Math.max(1, Math.round(l.dpd / 30))).toFixed(2);
        const recoveryRate = l.status === "Written-off" ? rng() * 0.15 : l.status === "NPA" ? rng() * 0.4 : 0.3 + rng() * 0.6;
        const recovered = +(overdue * recoveryRate).toFixed(2);
        const resolved = recoveryRate > 0.85 || (l.status === "Delinquent" && rng() < 0.3);
        await push({ case_id: id("COL", ++colN, 7), loan_id: l.loan_id, customer_id: l.customer_id, assigned_employee_id: typeof emp === "string" ? emp : emp.employee_id,
          open_date: ymd(addDays(NOW, -clamp(l.dpd, 30, 720))), close_date: resolved ? ymd(addDays(NOW, -randInt(rng, 1, 30))) : "",
          dpd: l.dpd, bucket: l.dpd_bucket, status: l.status === "Written-off" ? "Written-off" : resolved ? "Resolved" : wpick(rng, [["In Progress", 5], ["Legal", 2], ["Settled", 2], ["Skip Trace", 1]]),
          amount_overdue: overdue.toFixed(2), recovered_amount: recovered.toFixed(2), priority: l.dpd > 90 ? "Critical" : l.dpd > 60 ? "High" : "Medium" });
      }
    });

  // ── 16. credit_bureau (score tracks customer credit; aggregates from loans) ─
  let cbN = 0;
  await table("credit_bureau",
    [["record_id", "String"], ["customer_id", "String"], ["bureau", "LowCardinality(String)"], ["score", "UInt16"], ["band", "LowCardinality(String)"],
     ["report_date", "Date"], ["total_enquiries", "UInt16"], ["active_loans", "UInt16"], ["total_outstanding", "Decimal(18,2)"], ["dpd_max", "UInt16"], ["accounts_count", "UInt16"]],
    "(customer_id, report_date)",
    async (push) => {
      for (const c of customers) {
        const rng = rngOf("cb:" + c.customer_id);
        const myLoans = loansByCustomer.get(c.customer_id) || [];
        const active = myLoans.filter((l) => ["Current", "Delinquent", "NPA"].includes(l.status)).length;
        const outstanding = myLoans.reduce((s, l) => s + l.outstanding, 0);
        const dpdMax = myLoans.reduce((m, l) => Math.max(m, l.dpd), 0);
        const score = clamp(Math.round(c.credit_score + gauss(rng, 0, 12) - (dpdMax > 90 ? 60 : dpdMax > 30 ? 25 : 0)), 300, 900);
        await push({ record_id: id("CB", ++cbN, 8), customer_id: c.customer_id, bureau: pick(rng, ["CIBIL", "Experian", "Equifax", "CRIF"]), score, band: score >= 800 ? "Excellent" : score >= 740 ? "Good" : score >= 670 ? "Fair" : "Poor",
          report_date: ymd(addDays(NOW, -randInt(rng, 1, 90))), total_enquiries: randInt(rng, 0, 12) + (cardCustomers.has(c.customer_id) ? 1 : 0), active_loans: active, total_outstanding: outstanding.toFixed(2), dpd_max: dpdMax, accounts_count: active + (cardCustomers.has(c.customer_id) ? 1 : 0) + 1 });
      }
    });

  // ── 17. disputes (from genuinely flagged / anomalous transactions) ──────────
  let dspN = 0;
  await table("disputes",
    [["dispute_id", "String"], ["txn_id", "String"], ["customer_id", "String"], ["card_id", "String"], ["raised_date", "Date"],
     ["reason", "LowCardinality(String)"], ["status", "LowCardinality(String)"], ["disputed_amount", "Decimal(18,4)"], ["resolution", "LowCardinality(String)"], ["resolved_date", "Date"]],
    "(raised_date, txn_id)",
    async (push) => {
      for (const t of txns) {
        const cardId = cardOf.get(t.customer_id); if (!cardId) continue;
        const rng = rngOf("dsp:" + t.txn_id);
        const anomalous = t.is_fraud === 1 || t.amount > 80000;
        const raise = t.is_fraud === 1 ? rng() < 0.7 : (anomalous ? rng() < 0.05 : rng() < 0.002);
        if (!raise) continue;
        const tdate = parseDate(t.ts.slice(0, 10));
        const resolved = rng() < 0.7;
        const inFavour = t.is_fraud === 1 ? rng() < 0.8 : rng() < 0.4;
        await push({ dispute_id: id("DSP", ++dspN, 7), txn_id: t.txn_id, customer_id: t.customer_id, card_id: cardId, raised_date: ymd(addDays(tdate, randInt(rng, 1, 20))),
          reason: t.is_fraud === 1 ? wpick(rng, [["Unauthorized", 6], ["Fraud", 4]]) : wpick(rng, [["Duplicate Charge", 3], ["Service Not Received", 3], ["Quality", 2], ["Amount Mismatch", 2]]),
          status: resolved ? (inFavour ? "Resolved - Customer" : "Resolved - Merchant") : wpick(rng, [["Investigating", 6], ["Open", 4]]),
          disputed_amount: t.amount.toFixed(4), resolution: resolved ? (inFavour ? "Refunded" : "Rejected") : "Pending", resolved_date: resolved ? ymd(addDays(tdate, randInt(rng, 5, 45))) : "" });
      }
    });

  // ── 18. fraud_alerts (every confirmed fraud + rule hits on risky spend) ─────
  let frdN = 0;
  await table("fraud_alerts",
    [["alert_id", "String"], ["txn_id", "String"], ["customer_id", "String"], ["device_id", "String"], ["alert_datetime", "DateTime"],
     ["rule_name", "LowCardinality(String)"], ["risk_score", "UInt8"], ["action", "LowCardinality(String)"], ["status", "LowCardinality(String)"], ["is_confirmed_fraud", "UInt8"]],
    "(alert_datetime, txn_id)",
    async (push) => {
      for (const t of txns) {
        const rng = rngOf("frd:" + t.txn_id);
        const p = profile.get(t.customer_id);
        const hit = t.is_fraud === 1 || (t.amount > 60000 && rng() < 0.15) || (p && rng() < p.fraudProne);
        if (!hit) continue;
        const confirmed = t.is_fraud === 1 ? 1 : (rng() < 0.1 ? 1 : 0);
        await push({ alert_id: id("FRD", ++frdN, 7), txn_id: t.txn_id, customer_id: t.customer_id, device_id: deviceOf.get(t.customer_id) || "",
          alert_datetime: t.ts, rule_name: wpick(rng, [["High Amount", 4], ["Velocity Check", 3], ["Geo Mismatch", 2], ["Card Not Present", 2], ["Unusual Merchant", 1]]),
          risk_score: clamp(Math.round((confirmed ? 70 : 35) + gauss(rng, 0, 15)), 1, 100), action: confirmed ? wpick(rng, [["Blocked", 6], ["OTP Challenge", 4]]) : wpick(rng, [["Flagged", 6], ["Allowed", 4]]),
          status: confirmed ? "Confirmed Fraud" : wpick(rng, [["False Positive", 6], ["Closed", 3], ["Open", 1]]), is_confirmed_fraud: confirmed });
      }
    });

  // ── 19. kyc_records (status consistent with customers.kyc_status) ───────────
  let kycN = 0;
  await table("kyc_records",
    [["kyc_id", "String"], ["customer_id", "String"], ["doc_type", "LowCardinality(String)"], ["doc_number_masked", "String"], ["verified_date", "Date"],
     ["status", "LowCardinality(String)"], ["risk_rating", "LowCardinality(String)"], ["re_kyc_due_date", "Date"], ["verified_by_employee_id", "String"]],
    "(customer_id, verified_date)",
    async (push) => {
      for (const c of customers) {
        const rng = rngOf("kyc:" + c.customer_id);
        const verified = c.kyc_status === "Verified";
        await push({ kyc_id: id("KYC", ++kycN, 8), customer_id: c.customer_id, doc_type: wpick(rng, [["Aadhaar", 6], ["PAN", 2], ["Passport", 1], ["Voter ID", 1]]),
          doc_number_masked: `XXXX${randInt(rng, 1000, 9999)}`, verified_date: verified ? c.signup_date : "", status: c.kyc_status,
          risk_rating: { A: "Low", B: "Low", C: "Medium", D: "High", E: "High" }[c.risk_band] || "Medium", re_kyc_due_date: ymd(addDays(parseDate(c.signup_date), 365 * randInt(rng, 5, 8))),
          verified_by_employee_id: verified ? pick(rng, complianceOfficers).employee_id : "" });
      }
    });

  // ── 20. aml_screenings (periodic; hits skew to high-risk customers) ─────────
  let amlN = 0;
  await table("aml_screenings",
    [["screening_id", "String"], ["customer_id", "String"], ["screen_date", "Date"], ["screening_type", "LowCardinality(String)"], ["watchlist_hit", "UInt8"],
     ["match_score", "UInt8"], ["status", "LowCardinality(String)"], ["reviewer_employee_id", "String"]],
    "(screen_date, customer_id)",
    async (push) => {
      const target = Math.round(60000 * SCALE);
      for (let i = 0; i < target; i++) {
        const c = customers[Math.floor(rngOf("amlpick:" + i)() * customers.length)]; const rng = rngOf("aml:" + i + c.customer_id);
        const highRisk = ["D", "E"].includes(c.risk_band);
        const hit = highRisk ? rng() < 0.04 : rng() < 0.005;
        await push({ screening_id: id("AML", ++amlN, 7), customer_id: c.customer_id, screen_date: ymd(addDays(NOW, -randInt(rng, 1, 700))), screening_type: wpick(rng, [["Periodic", 5], ["Onboarding", 3], ["Transaction", 2]]),
          watchlist_hit: hit ? 1 : 0, match_score: hit ? randInt(rng, 60, 99) : randInt(rng, 0, 30), status: hit ? wpick(rng, [["Escalated", 4], ["SAR Filed", 2], ["Review", 4]]) : "Clear", reviewer_employee_id: pick(rng, complianceOfficers).employee_id });
      }
    });

  // ── 21. rewards_ledger (EARN per real txn; points reconcile with reward_points)
  let rwdN = 0;
  await table("rewards_ledger",
    [["entry_id", "String"], ["customer_id", "String"], ["card_id", "String"], ["txn_id", "String"], ["event_date", "Date"],
     ["entry_type", "LowCardinality(String)"], ["points", "Int32"], ["category", "LowCardinality(String)"]],
    "(customer_id, event_date)",
    async (push) => {
      for (const t of txns) {
        const cardId = cardOf.get(t.customer_id); if (!cardId) continue;
        await push({ entry_id: id("RWD", ++rwdN, 10), customer_id: t.customer_id, card_id: cardId, txn_id: t.txn_id, event_date: t.ts.slice(0, 10), entry_type: "Earn", points: t.reward_points, category: t.category });
      }
    });

  // ── 22. reward_redemptions (drawn against earned balance) ───────────────────
  let rdmN = 0;
  await table("reward_redemptions",
    [["redemption_id", "String"], ["customer_id", "String"], ["redeem_date", "Date"], ["points_redeemed", "UInt32"], ["reward_type", "LowCardinality(String)"],
     ["monetary_value", "Decimal(12,2)"], ["status", "LowCardinality(String)"], ["partner", "LowCardinality(String)"]],
    "(redeem_date, customer_id)",
    async (push) => {
      for (const [cust, pts] of earnedPoints) {
        if (pts < 30) continue; // need a meaningful balance to redeem
        const rng = rngOf("rdm:" + cust);
        if (rng() > 0.5) continue; // about half of eligible customers redeem
        const nRedeem = randInt(rng, 1, 3);
        let remaining = pts;
        for (let i = 0; i < nRedeem && remaining > 10; i++) {
          const used = Math.round(remaining * (0.2 + rng() * 0.5));
          remaining -= used;
          await push({ redemption_id: id("RDM", ++rdmN, 8), customer_id: cust, redeem_date: ymd(addDays(NOW, -randInt(rng, 1, 360))), points_redeemed: used, reward_type: wpick(rng, [["Cashback", 4], ["Voucher", 3], ["Statement Credit", 2], ["Air Miles", 1]]), monetary_value: (used * 0.25).toFixed(2), status: wpick(rng, [["Completed", 9], ["Pending", 1]]), partner: pick(rng, ["Amazon", "Flipkart", "MakeMyTrip", "Direct", "BookMyShow"]) });
        }
      }
    });

  // ── 23. offers ──────────────────────────────────────────────────────────────
  let ofrN = 0;
  const offers = [];
  await table("offers",
    [["offer_id", "String"], ["card_product_id", "LowCardinality(String)"], ["merchant_category", "LowCardinality(String)"], ["offer_type", "LowCardinality(String)"],
     ["discount_pct", "Decimal(5,2)"], ["max_discount", "UInt32"], ["min_txn", "UInt32"], ["valid_from", "Date"], ["valid_to", "Date"], ["channel", "LowCardinality(String)"], ["active_flag", "UInt8"]],
    "offer_id",
    async (push) => {
      const cats = Object.keys(MCC);
      for (let i = 0; i < 200; i++) {
        const rng = rngOf("ofr:" + i);
        const oid = id("OFR", ++ofrN, 5); const cat = pick(rng, cats); const cp = wpick(rng, [["ALL", 4], ...CARD_PRODUCTS.map((p) => [p.id, 1])]);
        const vf = addDays(NOW, -randInt(rng, 0, 400)); const vt = addDays(vf, randInt(rng, 30, 200));
        offers.push({ offer_id: oid, merchant_category: cat });
        await push({ offer_id: oid, card_product_id: cp, merchant_category: cat, offer_type: wpick(rng, [["Cashback", 4], ["Discount", 3], ["Reward Multiplier", 2], ["EMI", 1]]), discount_pct: (5 + rng() * 20).toFixed(2), max_discount: pick(rng, [500, 1000, 1500, 2500, 5000]), min_txn: pick(rng, [500, 1000, 2000, 5000]), valid_from: ymd(vf), valid_to: ymd(vt), channel: pick(rng, ["App", "Web", "Email", "SMS"]), active_flag: vt > NOW ? 1 : 0 });
      }
    });

  // ── 24. offer_redemptions (link a real txn in the offer's category) ─────────
  const txnsByCat = new Map();
  for (const t of txns) { if (!txnsByCat.has(t.category)) txnsByCat.set(t.category, []); txnsByCat.get(t.category).push(t); }
  let ordN = 0;
  await table("offer_redemptions",
    [["redemption_id", "String"], ["offer_id", "String"], ["customer_id", "String"], ["txn_id", "String"], ["redeemed_date", "Date"],
     ["discount_availed", "Decimal(12,2)"], ["savings", "Decimal(12,2)"]],
    "(redeemed_date, offer_id)",
    async (push) => {
      const target = Math.round(50000 * SCALE);
      for (let i = 0; i < target; i++) {
        const rng = rngOf("ord:" + i);
        const offer = pick(rng, offers); const pool = txnsByCat.get(offer.merchant_category) || [];
        if (!pool.length) continue; const t = pick(rng, pool);
        const saved = +(t.amount * (0.05 + rng() * 0.15)).toFixed(2);
        await push({ redemption_id: id("ORDM", ++ordN, 8), offer_id: offer.offer_id, customer_id: t.customer_id, txn_id: t.txn_id, redeemed_date: t.ts.slice(0, 10), discount_availed: saved.toFixed(2), savings: saved.toFixed(2) });
      }
    });

  // ── 25. campaign_responses (conversion lifts with value band) ───────────────
  const campRows = await chRead(`SELECT campaign_id, start_date, channel FROM marketing_campaigns LIMIT 4000`);
  let crN = 0;
  await table("campaign_responses",
    [["response_id", "String"], ["campaign_id", "String"], ["customer_id", "String"], ["response_date", "Date"], ["action", "LowCardinality(String)"],
     ["channel", "LowCardinality(String)"], ["converted_flag", "UInt8"], ["attributed_revenue", "Decimal(14,2)"]],
    "(campaign_id, response_date)",
    async (push) => {
      const target = Math.round(120000 * SCALE);
      for (let i = 0; i < target; i++) {
        const rng = rngOf("cr:" + i);
        const camp = campRows[Math.floor(rng() * campRows.length)]; if (!camp) continue;
        const c = customers[Math.floor(rng() * customers.length)]; const p = profile.get(c.customer_id);
        const convProb = clamp(0.02 + p.bandRank * 0.03 + p.engagement * 0.05, 0, 0.3);
        const converted = rng() < convProb;
        const action = converted ? "Converted" : wpick(rng, [["Delivered", 5], ["Opened", 3], ["Clicked", 2], ["Unsubscribed", 1]]);
        await push({ response_id: id("CRSP", ++crN, 9), campaign_id: camp[0], customer_id: c.customer_id, response_date: ymd(addDays(parseDate(camp[1]), randInt(rng, 0, 30))), action, channel: camp[2], converted_flag: converted ? 1 : 0, attributed_revenue: converted ? Math.round(lognormal(rng, 3000, 0.8)).toFixed(2) : "0.00" });
      }
    });

  // ── 26. support_tickets ─────────────────────────────────────────────────────
  let tktN = 0;
  await table("support_tickets",
    [["ticket_id", "String"], ["customer_id", "String"], ["assigned_employee_id", "String"], ["created_date", "Date"], ["resolved_date", "Date"],
     ["category", "LowCardinality(String)"], ["channel", "LowCardinality(String)"], ["priority", "LowCardinality(String)"], ["status", "LowCardinality(String)"],
     ["csat_score", "UInt8"], ["first_response_mins", "UInt16"], ["sla_breached", "UInt8"]],
    "(created_date, customer_id)",
    async (push) => {
      const target = Math.round(80000 * SCALE);
      for (let i = 0; i < target; i++) {
        const rng = rngOf("tkt:" + i);
        const c = customers[Math.floor(rng() * customers.length)]; const p = profile.get(c.customer_id);
        if (rng() > p.engagement + 0.1) continue; // engaged customers raise more tickets
        const resolved = rng() < 0.82; const frm = randInt(rng, 2, 480); const breached = frm > 240;
        await push({ ticket_id: id("TKT", ++tktN, 8), customer_id: c.customer_id, assigned_employee_id: pick(rng, supportAgents).employee_id, created_date: ymd(addDays(NOW, -randInt(rng, 1, 540))), resolved_date: resolved ? ymd(addDays(NOW, -randInt(rng, 0, 530))) : "",
          category: wpick(rng, [["Card", 4], ["App", 3], ["Account", 3], ["Loan", 2], ["Rewards", 2], ["Fraud", 1], ["General", 2]]), channel: wpick(rng, [["App", 4], ["Phone", 3], ["Email", 2], ["Web", 2], ["Branch", 1]]),
          priority: wpick(rng, [["Low", 4], ["Medium", 4], ["High", 2], ["Critical", 1]]), status: resolved ? wpick(rng, [["Resolved", 6], ["Closed", 4]]) : wpick(rng, [["Open", 5], ["In Progress", 4], ["Escalated", 1]]),
          csat_score: resolved ? (breached ? randInt(rng, 1, 3) : randInt(rng, 3, 5)) : 0, first_response_mins: frm, sla_breached: breached ? 1 : 0 });
      }
    });

  // ── 27. app_sessions (engagement-driven; sparse + old for dormant/churned) ──
  let sesN = 0;
  await table("app_sessions",
    [["session_id", "String"], ["customer_id", "String"], ["device_id", "String"], ["start_ts", "DateTime"], ["duration_sec", "UInt32"],
     ["screens_viewed", "UInt16"], ["channel", "LowCardinality(String)"], ["app_version", "LowCardinality(String)"], ["actions_taken", "UInt16"]],
    "(customer_id, start_ts)",
    async (push) => {
      for (const c of customers) {
        const dev = deviceOf.get(c.customer_id); if (!dev) continue;
        const p = profile.get(c.customer_id); const rng = p.rng;
        const nSessions = Math.round(p.engagement * 20 * SCALE);
        for (let i = 0; i < nSessions; i++) {
          const back = c.status === "Active" ? randInt(rng, 0, 180) : randInt(rng, 200, 700);
          const start = addDays(NOW, -back); start.setUTCHours(randInt(rng, 6, 23), randInt(rng, 0, 59), randInt(rng, 0, 59));
          await push({ session_id: id("SES", ++sesN, 10), customer_id: c.customer_id, device_id: dev, start_ts: ymdhms(start), duration_sec: randInt(rng, 20, 900), screens_viewed: randInt(rng, 1, 25), channel: wpick(rng, [["App", 8], ["Web", 2]]), app_version: pick(rng, ["5.12.0", "5.11.2", "5.10.0", "5.9.4"]), actions_taken: randInt(rng, 0, 12) });
        }
      }
    });

  // ── 28. statements (per card-month, aggregated from real card_transactions) ─
  const stmtAgg = new Map(); // `${customer}|${month}` -> {spent, points, count}
  for (const t of txns) {
    const month = t.ts.slice(0, 7) + "-01";
    const key = t.customer_id + "|" + month;
    const a = stmtAgg.get(key) || { spent: 0, points: 0, count: 0 };
    a.spent += t.amount; a.points += t.reward_points; a.count++; stmtAgg.set(key, a);
  }
  let stmtN = 0;
  await table("statements",
    [["statement_id", "String"], ["card_id", "String"], ["customer_id", "String"], ["account_id", "String"], ["period_month", "Date"],
     ["opening_balance", "Decimal(18,2)"], ["total_spent", "Decimal(18,2)"], ["total_paid", "Decimal(18,2)"], ["min_due", "Decimal(18,2)"],
     ["total_due", "Decimal(18,2)"], ["due_date", "Date"], ["paid_flag", "UInt8"], ["late_fee", "Decimal(10,2)"], ["interest_charged", "Decimal(12,2)"], ["points_earned", "Int32"]],
    "(customer_id, period_month)",
    async (push) => {
      for (const [key, a] of stmtAgg) {
        const [cust, month] = key.split("|");
        const cardId = cardOf.get(cust); if (!cardId) continue;
        const rng = rngOf("stmt:" + key);
        const spent = +a.spent.toFixed(2); const opening = +(spent * rng() * 0.3).toFixed(2);
        const due = +(opening + spent).toFixed(2); const paidFull = rng() < 0.62;
        const paid = paidFull ? due : +(due * (0.05 + rng() * 0.6)).toFixed(2);
        const lateFee = !paidFull && rng() < 0.25 ? pick(rng, [500, 750, 1000]) : 0;
        const interest = paidFull ? 0 : +((due - paid) * 0.035).toFixed(2);
        await push({ statement_id: id("STMT", ++stmtN, 10), card_id: cardId, customer_id: cust, account_id: accountOf.get(cust) || "", period_month: month,
          opening_balance: opening.toFixed(2), total_spent: spent.toFixed(2), total_paid: paid.toFixed(2), min_due: Math.max(0, +(due * 0.05).toFixed(2)).toFixed(2),
          total_due: due.toFixed(2), due_date: ymd(addDays(addMonths(parseDate(month), 1), 18)), paid_flag: paidFull ? 1 : 0, late_fee: Number(lateFee).toFixed(2), interest_charged: interest.toFixed(2), points_earned: a.points });
      }
    });

  console.log("\nDone generating. Running reconciliation…\n");
  await reconcile();
}

// ─────────────────────────────────────────────────────────────────────────────
// Reconciliation: proof the data is accurate (referential + semantic integrity).
// ─────────────────────────────────────────────────────────────────────────────
async function reconcile() {
  const checks = [
    ["tables present (expect >=34)", `SELECT count() FROM system.tables WHERE database='${DB}' AND engine NOT LIKE '%View%'`, (v) => +v >= 34],
    ["cards → existing customers (orphans=0)", `SELECT count() FROM cards WHERE customer_id NOT IN (SELECT customer_id FROM customers)`, (v) => +v === 0],
    ["accounts → existing customers (orphans=0)", `SELECT count() FROM accounts WHERE customer_id NOT IN (SELECT customer_id FROM customers)`, (v) => +v === 0],
    ["statements.card_id → cards (orphans=0)", `SELECT count() FROM statements WHERE card_id NOT IN (SELECT card_id FROM cards)`, (v) => +v === 0],
    ["loan_repayments.loan_id → loan_book (orphans=0)", `SELECT count() FROM loan_repayments WHERE loan_id NOT IN (SELECT loan_id FROM loan_book)`, (v) => +v === 0],
    ["disputes.txn_id → card_transactions (orphans=0)", `SELECT count() FROM disputes WHERE txn_id NOT IN (SELECT txn_id FROM card_transactions)`, (v) => +v === 0],
    ["collections ONLY on delinquent loans", `SELECT count() FROM collections WHERE loan_id NOT IN (SELECT loan_id FROM loan_book WHERE status IN ('Delinquent','NPA','Written-off'))`, (v) => +v === 0],
    ["recovered ≤ overdue in collections", `SELECT count() FROM collections WHERE recovered_amount > amount_overdue`, (v) => +v === 0],
    ["rewards_ledger earn = card_transactions points", `SELECT abs(toInt64(sum(points)) - (SELECT toInt64(sum(reward_points)) FROM card_transactions WHERE customer_id IN (SELECT customer_id FROM cards))) FROM rewards_ledger`, (v) => +v === 0],
    ["statements spent ≈ transactions spent (<0.1% gap)", `SELECT abs(toFloat64(sum(total_spent)) - (SELECT sum(amount) FROM card_transactions WHERE customer_id IN (SELECT customer_id FROM cards))) / (SELECT sum(amount) FROM card_transactions WHERE customer_id IN (SELECT customer_id FROM cards)) FROM statements`, (v) => +v < 0.001],
    ["kyc_records.status matches customers.kyc_status", `SELECT count() FROM kyc_records WHERE (customer_id, status) NOT IN (SELECT customer_id, kyc_status FROM customers)`, (v) => +v === 0],
    ["credit_bureau scores track customer credit (corr>0.6)", `SELECT corr(toFloat64(b.score), toFloat64(u.credit_score)) FROM credit_bureau b INNER JOIN customers u ON b.customer_id = u.customer_id`, (v) => +v > 0.6],
  ];
  let pass = 0;
  for (const [label, sql, ok] of checks) {
    try {
      const v = await chScalar(sql);
      const good = ok(v);
      console.log(`  ${good ? "✅" : "❌"} ${label.padEnd(48)} = ${v}`);
      if (good) pass++;
    } catch (e) { console.log(`  ⚠️  ${label.padEnd(48)} ERROR: ${String(e.message).slice(0, 80)}`); }
  }
  console.log(`\n  ${pass}/${checks.length} reconciliation checks passed.\n`);
}

// ── tiny utilities ───────────────────────────────────────────────────────────
function deptOf(role) {
  return { "Relationship Manager": "Sales", Teller: "Branch Ops", "Collections Officer": "Collections", "Support Agent": "Customer Support", "Credit Analyst": "Underwriting", "Compliance Officer": "Compliance", "Branch Manager": "Branch Ops" }[role] || "Operations";
}
const FIRST = ["Aarav", "Vivaan", "Aditya", "Vihaan", "Arjun", "Sai", "Reyansh", "Ananya", "Diya", "Saanvi", "Aadhya", "Kiara", "Riya", "Ishaan", "Kabir", "Anaya", "Myra", "Aryan", "Rohan", "Neha", "Priya", "Rahul", "Sneha", "Karan", "Pooja"];
const LAST = ["Sharma", "Verma", "Gupta", "Reddy", "Nair", "Iyer", "Patel", "Shah", "Mehta", "Rao", "Singh", "Kumar", "Das", "Bose", "Khan", "Joshi", "Pillai", "Menon", "Chopra", "Malhotra"];
function randName(rng) { return `${pick(rng, FIRST)} ${pick(rng, LAST)}`; }
function loadEnv(path) {
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch { /* .env optional if vars already in environment */ }
}

main().catch((e) => { console.error("\nSEED FAILED:", e); process.exit(1); });
