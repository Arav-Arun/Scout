# Scout - AI Data Analytics Agent

Scout lets a user ask open-ended questions in plain English against a large ClickHouse warehouse and get back a
structured analytical dashboard: hero metrics, charts, data tables, and a written narrative, rendered live in a chat-driven UI.

---

## How it works

```
User question
   │
   ▼
/api/chat  (streaming NDJSON)
   │
   ▼
Scout Workflow (DISCOVER → PLAN → RELATE → INSPECT → ANALYZE → SYNTHESIZE)
   │   orchestration:     lib/agent/workflow.ts
   │   prompts:           lib/agent/prompts.ts
   │   LLM client:        lib/agent/llm.ts
   │   graph (Graph RAG): lib/graph/schema-graph.ts + relationships.ts
   │   querying:           lib/db/clickhouse.ts
   ▼
Stream of events  →  Chat panel (step chips + narration)  +  Dashboard panel
                     (hero metrics, ECharts charts, insights, tables, Export SQL)
```

### 1. 6-Phase Agentic Pipeline
Instead of running a single, unconstrained loop where an LLM repeatedly calls tools Scout decomposes the data analytics process into six discrete, structured, and sequentially typed phases:
1. **DISCOVER**: A fast, low-overhead metadata listing to map out the entire warehouse and gather table/column catalogs before planning.
2. **PLAN**: The Planner LLM (`PLANNER_SYS` in `lib/agent/prompts.ts`) interprets the user's request, parses ambiguous terms, sets metric definitions, determines output format requirements, and decides if clarification is needed.
3. **RELATE (Graph RAG)**: Walks the **schema graph** (`lib/graph/`) from the planner's seed tables to retrieve the connected subgraph - the seeds plus the bridge/dimension tables needed to join them - and the exact join keys. The warehouse has 32 interconnected tables and **no foreign keys**, so this is what lets the agent join correctly across them. The exact live count is read at runtime from `warehouseFacts()`, never hardcoded.
4. **INSPECT**: Fetches target schemas (column names and database types) for the subgraph's tables (`describeTable`) to ensure syntactic correctness in generated SQL.
5. **ANALYZE Loop**: An iterative query loop (capped at 8 queries) where the Analyst LLM (`ANALYST_SYS`) - now given the `JOIN GRAPH` - suggests a single query, executes it, and evaluates up to 40 row result previews to determine if further investigation is needed.
6. **SYNTHESIZE**: The Synthesizer LLM (`SYNTH_SYS`) aggregates the query results, references exact metrics, and compiles a structured JSON dashboard conforming to the user's formatting request.

### 2. ClickHouse Performance & Database Integration
ClickHouse is a column oriented DBMS optimized for sub-second analytical queries over billions of rows. Scout is engineered to leverage these advantages fully:
- **Server Side Aggregations**: All mathematical calculations are performed entirely by ClickHouse. The LLM only receives consolidated data previews (max 40 rows per query), keeping token consumption low and processing speed incredibly fast.
- **Dynamic Sort Ordering (`ORDER BY`)**: During file upload, `orderByKey` selects an optimal primary sorting key for the table. It prioritizes time-series date columns and low-cardinality values first to speed up indexing.
- **Low Cardinality Compression**: Text columns with repetitive values are inferred as `LowCardinality(String)`. ClickHouse compresses these using dictionary encoding, reducing disk I/O and accelerating `GROUP BY` execution.
- **High-Precision Decimal Ingestion**: Float values are automatically inferred as `Decimal(18, 4)` rather than `Float64`. This prevents binary floating-point representation rounding errors, ensuring 100% financial calculation accuracy.

---

## Graph RAG, in detail

Scout's hardest retrieval problem is **which tables to join, and on what keys**. The
warehouse is 32 tables in one
card-issuer / retail-bank domain, linked only by shared key
columns — ClickHouse has **no foreign keys**, and the schema was built that way on purpose.
A flat "here are all the tables, pick some" catalog works at 6 tables; at 34, a single
business question routinely spans a join chain the planner can't see, so the model guesses
join keys and gets them wrong.

**Graph RAG** fixes this. Classic RAG retrieves relevant *documents*; Graph RAG retrieves a
relevant *subgraph* of a knowledge graph — so the model gets the nodes **and the
relationships between them**. Scout's knowledge graph is the **schema graph**: tables are
nodes, recovered join keys are edges.

### Nodes and edges

- **Nodes** — every table in the live catalog (`getCatalog()` → `system.columns`), carrying
  its column list and a free row-count estimate (`buildSchemaGraph` in
  [`lib/graph/schema-graph.ts`](lib/graph/schema-graph.ts)).
- **Edges** — the implicit join keys, recovered two ways and merged
  ([`lib/graph/relationships.ts`](lib/graph/relationships.ts)):

  **1. Curated manifest (`CURATED_RELATIONSHIPS`)** — authoritative, hand-declared edges.
  This is the source of truth and captures the **aliased** keys a name match alone can't
  see, e.g. `collections.assigned_employee_id → employees.employee_id`,
  `card_transactions.merchant → merchants.merchant_name`,
  `loan_book.branch → branches.branch_id`.

  **2. Auto-inference (`inferRelationships`)** — recovered purely from the catalog with zero
  FK metadata: any key-like column (`*_id`, or a known join column) that exists both on a
  table and on its **canonical parent** (`PARENT_OF_COLUMN`, e.g. `account_id → accounts`)
  becomes an edge. Inference links each child to the one parent table rather than building a
  clique, and it keeps the graph correct when **new tables are uploaded**.

  `buildSchemaGraph()` merges both, **curated wins on conflict**, and every edge is validated
  against the live catalog — both tables must exist and both join columns must really be
  present (defends against stale curation).

### Hub columns

`customer_id` and `city` are **hub columns** (`HUB_COLUMNS`) — `customer_id` alone lives in
~24 tables. If retrieval bridged through them, every question would drag the whole warehouse in
through `customers`. So when connecting tables, Scout **avoids hub edges first** and only falls
back to them when there's no other path — a question about `disputes` reaches `card_transactions`
directly instead of detouring through the customer hub.

### Verify against live data (drop phantom joins)

A shared column name doesn't prove two columns join. `account_transactions.txn_id` and
`card_transactions.txn_id` share a name but have **zero** overlapping values (an inner join
returns nothing). So once the graph
is built, `verifyEdges()` samples each child key and measures the fraction that actually resolves
to the parent (an `IN (subquery)` semi-join, **not** a LEFT JOIN — ClickHouse fills unmatched
LEFT-JOIN cells with type defaults, which would make every edge look like a 100% match). Edges
measured at 0% overlap are **dropped** as phantoms; the rest are marked `verified` (≥50% overlap)
or flagged **partial**, and the `JOIN GRAPH` warns the analyst when a join is lossy. It fails
open — a probe error/timeout leaves the edge un-judged rather than dropping a possibly-real key.

### Build + caching

`getSchemaGraph()` is built on top of the cached catalog and shares its one warehouse scan
(build → verify → cache). The graph is cached and **rebuilt only when the catalog changes**
(its `discoveredAt` timestamp), so repeated questions and graph-view opens reuse it. The catalog scan is
metadata-only (`system.columns` + `system.tables.total_rows` — no data scan) with a 5-minute
TTL, invalidated immediately after an upload.

### Retrieval — `retrieveSubgraph()`

This is the heart of it. Given the **seed tables** the planner picked from the question, it
returns the connected subgraph plus the exact join map:

1. **Keep the seeds.**
2. **Connect them** — for each remaining seed, find the shortest **join path** (fewest hops)
   to the already-included set with a breadth-first search (`bfsPath`), preferring paths that
   **avoid the hub**, and pull in the **bridge tables** along it. (So a question spanning
   `customers` + `branches` automatically pulls in `accounts`.)
3. **Enrich** — fill the remaining budget (`maxTables`, default 8) with the seeds' direct
   non-hub neighbours, **verified edges first** (typically the dimension tables).

The result is the table set plus every edge among those tables — the concrete join graph.

### Injecting it into the model

- `formatGraphForPrompt()` renders the subgraph as a **`JOIN GRAPH`** block of
  `tableA.colA = tableB.colB` lines, fed to the Analyst LLM with an instruction to join
  **only** on these recovered keys and to chain through bridge tables to reach far tables.
  If the subgraph has no edges, it says so (query the tables independently).
- `summarizeSubgraph()` produces the one-line **"Mapped table relationships"** step chip the
  user sees, e.g. *"linked 6 tables via customer_id, card_id, branch_id (+2 bridge)"*.

### Where it runs in the pipeline

```
DISCOVER → PLAN → RELATE → INSPECT → ANALYZE↻ → SYNTHESIZE
                  ▲ Graph RAG: seed tables → connected subgraph + join keys
```

The **RELATE** phase ([`lib/agent/phases.ts`](lib/agent/phases.ts)) sits between PLAN and
INSPECT: it walks the graph from the planner's seeds, emits the step chip, hands the expanded
table set to INSPECT (now up to 8 tables, not 4), and the `JOIN GRAPH` block to ANALYZE. The
change is **additive and safe** — if the graph is empty or the seeds are unreachable, RELATE
falls back to the seed tables and the pipeline behaves exactly as before.

### Measured impact (before / after Graph RAG)

`npm run db:eval` quantifies whether the graph helps: for each benchmark question it pulls the
ground-truth answer straight from ClickHouse, then runs the **full agent twice** - graph **OFF**
vs **ON** - and scores each run on whether it named the right answer with the right number, whether
the SQL used the required (no-FK) join, and how many wrong-table / wrong-key queries ClickHouse
rejected.

A representative run over the multi-table questions that *require* a recovered join:

| Metric | Graph OFF | Graph ON |
|---|---|---|
| Answer accuracy | 50% (2/4) | **75% (3/4)** |
| Wrong-table / wrong-key SQL errors | 3 | **0** |
| Completed with a dashboard | 4/4 | 4/4 |

With the graph on, the agent recovered the right join path more reliably and produced **zero**
wrong-table SQL errors (vs 3 without it) - e.g. *"which loan product recovered the most across
collections?"* needs a `collections -> loan_book` join on `loan_id`: graph-off answered from the
wrong basis, graph-on got it right. Numbers are computed live against the warehouse and vary run
to run, so re-run `npm run db:eval` for a fresh measurement.

### Inspect it yourself

The in-app **Schema Knowledge Graph** viewer (the graph icon at the top of the chat panel)
renders the *exact same* `getSchemaGraph()` the agent walks — nodes coloured by sub-domain
(`TABLE_DOMAIN`), curated vs inferred edges styled differently, hover a table to trace its
joins. The same graph is also served as JSON at `/api/graph` for programmatic inspection.

---

## Quick start

```bash
# 1. Install
npm install

# 2. Configure env (copy and fill in)
cp .env.example .env
#   OPENAI_API_KEY, OPENAI_MODEL
#   CLICKHOUSE_HOST / USER / PASSWORD / DATABASE

# 3. Run
npm run dev          # http://localhost:3000
```

### Dev utilities

```bash
npm run db:tables      # List all tables with row counts
npm run db:peek        # Browse table data (usage: npm run db:peek -- <table> [limit])
npm run db:seed-graph  # Generate the 28 interconnected tables (idempotent; --rebuild to reset)
npm run db:eval        # Measure Graph-RAG accuracy: agent graph OFF vs ON (needs dev server; paid)
```

### Deployment to Railway
1. **Create Project**: Link your GitHub repository in Railway.
2. **Environment Variables**: Add the following variables under the **Variables** tab in Railway:
   - `OPENAI_API_KEY`: Your OpenAI API Key.
   - `CLICKHOUSE_HOST`: Your ClickHouse host URL (e.g., `https://xxxx.clickhouse.cloud:8443`)
   - `CLICKHOUSE_USER`: Your ClickHouse database username
   - `CLICKHOUSE_PASSWORD`: Your ClickHouse database password
   - `CLICKHOUSE_DATABASE`: Your ClickHouse database name (e.g., `default` or custom database)
   - `OPENAI_MODEL`: `gpt-4o` (optional)
3. **Build & Start**: Railway will automatically detect the Next.js setup via Nixpacks, run `npm run build`, and start the server with `npm run start` listening on the correct `$PORT` with no execution timeouts or file upload caps.

---

## Features

- **Conversational analysis** with live, streamed reasoning steps (find tables,
  inspect columns, sample values, query the database).
- **Structured dashboards**: 3-4 hero metrics, ECharts charts each with a written
  insight, optional data tables and recommendations.
- **Follow-ups** that build on prior context ("now filter that for Mumbai only").
- **Export SQL**: every query the agent ran, copyable.
- **CSV / Excel / JSON upload**: drop a file (paperclip in the composer), Scout infers a
  ClickHouse schema, creates a table, loads the rows, and analyses it automatically.
  
### Example questions

- "How many high value customers turned dormant? Check for the 2026 Jan cohort."
- "Show me the customer segment distribution."
- "What's the average credit score by customer value band?"
- "What does our loan book look like? Break it down by DPD buckets."
- "Find customers with high fraud risk who are also priority customers."

---

## Project structure

The three concerns are separated by folder: the **UI** (`app/*.tsx`, `components/`,
`hooks/`) imports only `lib/types.ts`; the **agent** lives in `lib/agent/`; the
**ClickHouse data layer** lives in `lib/db/`. The dynamic catch-all route file at
`app/api/[[...route]]/route.ts` serves as the API router. (Most files also carry a
"CALL MAP" header comment describing their role and what they call.)

```
app/
  page.tsx              UI ENTRY: layout shell (state lives in hooks/useScoutAgent.ts)
  api/[[...route]]/
    route.ts            API ROUTER: catch-all endpoint (chat, upload, db-info, health)
  health/route.ts       thin liveness probe (bare /health path)
hooks/
  useScoutAgent.ts      CLIENT STATE: turns, versions, streaming, upload
components/             ChatPanel (chat UI), DashboardPanel + EChart (dashboard UI), icons
lib/
  types.ts              SHARED CONTRACT: streaming protocol + dashboard types
  agent/                ── AGENT domain ──
    workflow.ts         ORCHESTRATION: the 6-phase pipeline
    phases.ts           the 6 phases + normalizeDashboard (model-output coercion)
    context.ts          shared shapes (Plan/AnalyzeResult) + prompt formatters
    prompts.ts          PROMPTS: all LLM system prompts
    llm.ts              LLM CLIENT: OpenAI wrapper + llmJSON()
  graph/                ── GRAPH RAG domain ──
    relationships.ts    recovers the implicit join edges (curated + auto-inferred, no FKs)
    schema-graph.ts     builds + verifies the schema graph, retrieveSubgraph (Graph RAG retrieval)
  db/                   ── CLICKHOUSE domain ──
    clickhouse.ts       DATA ACCESS: read-only query layer (runSelect / describeTable)
    catalog.ts          cached warehouse catalog (getCatalog / invalidateCatalog)
    parsers.ts          FILE PARSING: CSV/TSV/JSON/Excel parsers + schema inference
    ingest.ts           WRITE PATH: table creation + bulk INSERT (chExec HTTP transport)
```
---

## Notes

- **Connect once, schema in context:** the warehouse catalog (tables, columns,
  row-count scale) is discovered a single time and cached in memory
  (`lib/db/catalog.ts → getCatalog`), so follow-up questions reuse it instead of
  re-scanning `system.columns` every turn. The cache is invalidated automatically
  after an upload.
- The agent caps itself at ~12 reasoning iterations and ~8 queries per analysis.
- Query execution and result size caps are fully removed to support analyzing massive enterprise datasets at scale.
