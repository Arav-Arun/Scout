# Scout - AI Data Analytics Agent over ClickHouse

Scout is an analytics agent that sits on top of **your ClickHouse warehouse** and
answers open-ended business questions in plain English. It works the way a senior analyst would:
**map the schema, work out which tables join and on what keys, write the SQL, run it, and explain
the result**, all at runtime, streamed live to a dashboard.

```text
 Question ──▶ POST /api/chat ──▶  DISCOVER → PLAN → RELATE → INSPECT → ANALYZE↺ → SYNTHESIZE
   (NL)         (NDJSON stream)                   └── Graph RAG: seeds → connected subgraph + exact join keys
                     │
                     ├──▶ Chat panel .......... live reasoning chips + narrative
                     └──▶ Dashboard panel ..... hero metrics · ECharts · insights · Export SQL
```

Scout ships with no warehouse of its own. Every visitor links **their own** ClickHouse through a
guided setup, and Scout works out that schema's conventions at runtime: it has no built-in
knowledge of any particular industry, table layout, or naming scheme. Anything not in the
warehouse yet can be attached as a CSV, Excel or JSON file and becomes a real, joinable table.

Built for anyone running an analytical warehouse - analysts, BI engineers, and teams who want
answers from very large tables without writing SQL by hand.

---

## Screenshots

<table>
  <tr>
    <td width="50%" align="center" valign="top">
      <b>Ask in plain English, get a complete dashboard</b><br/><br/>
      <img src="app/assets/img1.jpeg" alt="Ask in plain English, get a complete dashboard" width="100%"/>
    </td>
    <td width="50%" align="center" valign="top">
      <b>Multi-turn follow-ups with versioned dashboards</b><br/><br/>
      <img src="app/assets/img2.jpeg" alt="Multi-turn follow-ups with versioned dashboards" width="100%"/>
    </td>
  </tr>
  <tr>
    <td width="50%" align="center" valign="top">
      <b>Hero metrics, ECharts, and written insights</b><br/><br/>
      <img src="app/assets/img3.jpeg" alt="Hero metrics, ECharts, and written insights" width="100%"/>
    </td>
    <td width="50%" align="center" valign="top">
      <b>Export the exact SQL behind every answer</b><br/><br/>
      <img src="app/assets/img4.jpeg" alt="Export the exact SQL behind every answer" width="100%"/>
    </td>
  </tr>
  <tr>
    <td width="50%" align="center" valign="top">
      <b>Share any analysis as a portable Markdown report</b><br/><br/>
      <img src="app/assets/img5.jpeg" alt="Share any analysis as a portable Markdown report" width="100%"/>
    </td>
    <td width="50%" align="center" valign="top">
      <b>Graph RAG Lab — visualize the recovered schema graph</b><br/><br/>
      <img src="app/assets/img6.png" alt="Graph RAG Lab — visualize the recovered schema graph" width="100%"/>
    </td>
  </tr>
  <tr>
    <td width="50%" align="center" valign="top">
      <b>Inspect every join key with live overlap and verdict</b><br/><br/>
      <img src="app/assets/img7.png" alt="Inspect every join key with live overlap and verdict" width="100%"/>
    </td>
    <td width="50%" align="center" valign="top">
      <b>Test retrieval and probe any two columns</b><br/><br/>
      <img src="app/assets/img8.png" alt="Test retrieval and probe any two columns" width="100%"/>
    </td>
  </tr>
</table>

---

## Features

- **Plain-English questions, complete dashboards.** Ask "where is delinquency rising?" or "which
  card product is declining, and since when?" and get an executive summary, 3-4 hero metrics,
  ECharts visualizations with written insights, detail tables, and recommendations in one pass.
- **Transparent reasoning, live.** Every phase streams a step chip to the chat as it runs
  (mapping the warehouse, walking the schema graph, each SQL query with row counts and timing),
  so users see exactly how an answer was produced instead of trusting a black box.
- **Works on warehouses with no foreign keys.** Real analytical warehouses rarely declare FKs.
  Scout's Graph RAG engine recovers join keys from the schema and **verifies every edge against
  live data**, dropping phantom joins (same column name, zero overlapping values) and flagging
  lossy ones, so multi-table answers join on keys that actually resolve.
- **Read-only by design, safe on production data.** A statement allowlist (SELECT / DESCRIBE /
  SHOW / EXPLAIN only, no stacked statements) plus ClickHouse `readonly=2` at the session level
  mean the agent can never mutate your warehouse, no matter what the model proposes.
- **Built for scale.** All aggregation is pushed down into ClickHouse; the agent only ever reads
  small aggregated result sets. Schema discovery, the join graph, and column-value profiles are
  cached, so a question costs queries, not warehouse scans.
- **Self-correcting SQL.** A graph-backed column guard catches wrong-table column references
  before they run, and ClickHouse errors are enriched with the table that actually owns the
  column plus the exact join key to reach it, so retries are grounded rather than guesses.
- **The Graph RAG Lab.** An in-app workbench (`/graph`) to visualize the recovered schema graph,
  inspect every join key with its live overlap and verdict, test retrieval, probe any two columns,
  and declare the aliased relationships automatic inference can't see.
- **Bring your own warehouse.** A four-step in-app tour collects the connection, tests it against
  the live server, and remembers it. Credentials are sealed server-side into an httpOnly cookie
  (AES-256-GCM), so the deployment holds no connection state and two visitors never share one.
- **Attach what isn't in the warehouse.** The composer's paperclip loads a CSV, TSV, Excel or JSON
  file straight into the linked database as a typed MergeTree table, joinable with everything else.
- **Simple to operate.** One Node.js service, two environment variables, a `/health` liveness
  endpoint, and a streaming NDJSON API. Deploys anywhere Node runs.

---

## Quickstart: connect your ClickHouse and run

### 1. Prerequisites

- **Node.js 18.18+** (20+ recommended)
- An **OpenAI API key**
- A **ClickHouse** instance reachable over HTTP(S) - ClickHouse Cloud or self-hosted. You link it
  from inside the app, not from a config file, so you don't need it to hand before starting.

### 2. Install

```bash
git clone https://github.com/Arav-Arun/Scout.git
cd Scout
npm install
```

### 3. Configure the server

Scout takes no warehouse configuration: there is no `CLICKHOUSE_HOST` to set. The only
environment variables belong to the server itself.

```bash
cp .env.example .env
```

| Variable                     | What to put there                                                                                     |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`             | Powers the planner / analyst / synthesizer LLM calls                                                    |
| `SCOUT_SECRET`               | **Required in production.** Seals each visitor's saved connection into their cookie. Any long random string |
| `OPENAI_MODEL`               | Optional. Defaults to `gpt-4o`                                                                          |
| `SCOUT_ALLOW_PRIVATE_HOSTS`  | Optional. Set to `1` to allow linking a ClickHouse on `localhost` or a private network                  |

Generate a secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Without `SCOUT_SECRET`, Scout falls back to a per-process key and every restart forces visitors
to re-link their database.

### 4. Run

```bash
npm run dev        # development, http://localhost:3000
```

```bash
npm run build      # production
npm start
```

Open the app and a four-step tour walks you through linking a ClickHouse: what Scout is about to
do, where to find your connection details, the form itself (tested live against the server before
anything is saved), and a confirmation naming the database and the tables it found. From then on
the link is remembered until you disconnect from **Settings → Warehouse Connection**.

Scout discovers your schema on the first question and caches it; no schema registration, config
files, or annotations are needed.

**Note for ClickHouse Cloud:** if your instance idles, the very first request after a quiet period
can take extra time while the instance wakes. Subsequent questions are fast.

### 5. Connecting and permissions

Scout only ever runs `SELECT` against your data, enforced in code (a leading-keyword allowlist
that also rejects stacked statements) and again at the session level. **A read-only ClickHouse
user is enough** - including one already pinned `readonly=1` server-side, which Scout detects
during the connection test and adapts to.

Granting that user `CREATE TABLE` / `INSERT` on the linked database unlocks two optional things:

- **Attaching files.** The paperclip in the composer loads a CSV, TSV, Excel or JSON file into the
  database as a typed MergeTree table (named `upload_<file>_<contenthash>`, so re-attaching the
  same file is a no-op rather than a duplicate), and Scout profiles it immediately.
- **Persisting the graph.** The schema-graph snapshot and your manually declared relationships are
  stored in three small bookkeeping tables (`scout_schema_graph_edges`, `scout_schema_graph_nodes`,
  `scout_user_edges`).

With a strictly read-only user, analysis still works end to end; the graph is simply kept in
memory, manual edges can't be saved, and attaching a file reports the missing grant.

**How the link is stored.** Credentials are encrypted server-side with AES-256-GCM and handed to
the browser as an opaque, `httpOnly` cookie, so page scripts can never read them and the server
keeps no connection state of its own. Each browser is independent, which is what lets one
deployment serve many people without any of them sharing a warehouse.

**Where Scout will refuse to connect.** Because the server makes the outbound request, an
arbitrary host is a server-side request forgery vector. Scout resolves the hostname and refuses
private, loopback and link-local addresses (including cloud metadata endpoints) unless the
operator sets `SCOUT_ALLOW_PRIVATE_HOSTS=1`. Note this checks the resolved addresses rather than
pinning them, so it does not defeat a determined DNS-rebinding attacker.

### 6. Deploy

Scout is a standard Next.js app and runs on any Node host. It holds no state of its own - each
visitor's warehouse credentials live in a sealed cookie in their own browser - so there is no
database or persistent disk to provision, and it scales horizontally as long as every instance
shares the same `SCOUT_SECRET`.

**Render** (blueprint included). Dashboard -> New -> Blueprint -> pick this repo, and
[`render.yaml`](render.yaml) provisions the service. It generates `SCOUT_SECRET`, pins Node, and
points the health check at `/health`; the only thing to enter by hand is `OPENAI_API_KEY`.

**Anywhere else.** Build with `npm ci && npm run build`, start with
`npm run start -- -H 0.0.0.0`, and set `OPENAI_API_KEY` and `SCOUT_SECRET`. `GET /health` is a
liveness probe.

Two things to get right wherever you host:

- **`SCOUT_SECRET` must be set and stable**, at least 16 characters. It seals every saved
  connection. Unset, Scout falls back to a per-process key and warns on startup - links then
  break on every restart, redeploy, and scale event. Changing it later logs everyone out.
- **The host must not cut a streaming response.** An analysis streams NDJSON for up to a few
  minutes. Persistent hosts are fine as long as the proxy's idle timeout is respected, which
  the per-phase events do. On serverless the API route declares `maxDuration = 300`.

---

## Using Scout

- **Ask anything, vague is fine.** The planner interprets open-ended questions ("what's trending
  up this quarter?"), states its assumptions, and only asks a clarifying question when a wrong
  guess would genuinely mislead.
- **Follow up naturally.** "Now break that down by branch" builds on the previous answer's
  context. Each answer becomes a new dashboard version (v1, v2, ...) you can flip between.
- **Audit every answer.** "Export SQL" shows each query the agent ran, with its purpose, row
  count, and timing. "Share" produces a portable Markdown report of the analysis.
- **Teach it your joins.** Open the Graph RAG Lab (graph icon in the header) to see the join
  graph Scout recovered. If two columns relate under different names (e.g.
  `card_transactions.merchant` joins `merchants.merchant_name`), declare that edge once in the
  Lab: it is verified against your live data on the spot, persisted, and used by every question
  from then on.
- **Bring in what isn't there yet.** The paperclip in the composer takes a `.csv`, `.tsv`,
  `.xlsx`, `.xls`, `.json`, `.jsonl` or `.ndjson` file (up to 100 MB), infers a ClickHouse schema
  from a 500-row sample, creates a MergeTree table in your linked database, bulk-loads it, and
  immediately profiles it. The table name carries a content hash, so re-attaching the same file
  reuses the existing table instead of duplicating it.
- **Swap or unlink the warehouse.** **Settings → Warehouse Connection** shows what you're
  connected to, with **Change** to point Scout somewhere else and **Disconnect** to make it
  forget. Disconnecting clears the conversation too, since dashboards belong to the warehouse
  that produced them.

---

## Architecture

Three library layers - **`agent` / `graph` / `db`** - sit behind a single streaming API. The UI
imports only `lib/types.ts`; each layer talks only to the one below it.

```mermaid
flowchart TB
  subgraph UI["Browser - Next.js client"]
    HOOK["useScoutAgent<br/>state + NDJSON reader"]
    CHAT["ChatPanel<br/>composer + live step chips"]
    DASH["DashboardPanel + EChart<br/>metrics · charts · Export SQL"]
    LAB["/graph - Graph RAG Lab<br/>Visualize · Inspect · Test · Declare"]
  end

  subgraph API["API - app/api route"]
    GET["GET · db-info · graph"]
    CHATAPI["POST · chat<br/>streamed agent run"]
    EDGEAPI["POST · graph/probe · retrieve · edge"]
  end

  subgraph AGENT["lib/agent - 6-phase orchestrator"]
    WF["workflow.ts → phases.ts<br/>+ column guard"]
    LLM["llm.ts · prompts.ts · context.ts"]
  end

  subgraph GRAPH["lib/graph - Graph RAG"]
    SG["schema-graph.ts<br/>build · verify · retrieve · format"]
    REL["relationships.ts<br/>physical edges (inferred)"]
    UE["user-edges.ts<br/>manual edges (declared)"]
    PERSIST["persist.ts<br/>canonical snapshot"]
  end

  subgraph DB["lib/db - ClickHouse layer"]
    CH["clickhouse.ts · catalog.ts · profile.ts<br/>read-only query layer"]
    WRITE["write.ts<br/>HTTP write transport"]
  end

  OPENAI[["OpenAI API"]]
  WARE[("ClickHouse warehouse")]

  CHAT --- HOOK
  DASH --- HOOK
  HOOK -->|question| CHATAPI
  CHAT -. graph icon .-> LAB
  LAB --> GET
  LAB --> EDGEAPI

  CHATAPI --> WF
  WF --> LLM --> OPENAI
  WF --> SG
  GET --> SG
  EDGEAPI --> SG
  SG --> REL
  SG --> UE
  SG --> PERSIST
  WF --> CH
  SG --> CH
  UE --> WRITE
  PERSIST --> WRITE
  CH --> WARE
  WRITE --> WARE
  CHATAPI -. NDJSON events .-> HOOK
```

**Request lifecycle** - the six phases and the bounded analyze loop:

```mermaid
flowchart TD
  Q(["User question<br/>POST /api/chat"]) --> D

  subgraph PIPE["runScoutWorkflow - lib/agent"]
    D["1 · DISCOVER<br/>cached warehouse map"] --> P
    P["2 · PLAN<br/>interpret · pick seed tables"] --> CL{"needs<br/>clarification?"}
    CL -->|yes| STOP(["emit question · stop"])
    CL -->|no| R["3 · RELATE - Graph RAG<br/>seeds → subgraph + JOIN GRAPH"]
    R --> I["4 · INSPECT<br/>DESCRIBE ≤8 tables + sample values"]
    I --> A["5 · ANALYZE loop ≤8<br/>propose SELECT → run → read ≤40 rows"]
    A -->|column guard repairs wrong-table refs| A
    A --> S["6 · SYNTHESIZE<br/>compose dashboard JSON"]
  end

  S --> OUT(["dashboard event → UI"])
  D -. step + text events .-> OUT
```

---

## 1 · The problem this solves

Analytical warehouses rarely declare foreign keys, and column names lie in both directions. The
reference warehouse Scout was built and tested against models a card issuer / retail bank in
**32 interconnected tables (~7.3M rows)** with, by design, **no foreign keys**. Tables are linked
only by _shared key columns_, and some of those keys are **aliased**, so a column-name match
alone can't even find them:

| Child column                       | actually joins | Parent column             |
| ---------------------------------- | -------------- | ------------------------- |
| `loan_book.branch`                 | →              | `branches.branch_id`      |
| `collections.assigned_employee_id` | →              | `employees.employee_id`   |
| `card_transactions.merchant`       | →              | `merchants.merchant_name` |

A shared _name_, meanwhile, doesn't prove a join either: `account_transactions.txn_id` and
`card_transactions.txn_id` share a name but have **zero** overlapping values. Scout has to tell
the real relationships from the coincidental ones from the data, not the schema.

## 2 · A worked example schema

Scout ships with no warehouse and no built-in knowledge of any schema. The walkthrough below uses
one concrete example throughout - a 32-table retail-banking warehouse, linked by shared (often
aliased) keys and never by FKs - purely so the mechanics have something to bite on:

| Sub-domain         | Tables                                                                                                   |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| Customer           | `customers`, `geographies`, `devices`                                                                    |
| Branch & staff     | `branches`, `employees`                                                                                  |
| Accounts & cards   | `accounts`, `cards`, `card_products`, `card_applications`, `account_transactions`                        |
| Payments & rewards | `card_transactions`, `statements`, `rewards_ledger`, `reward_redemptions`, `offers`, `offer_redemptions` |
| Lending            | `loan_book`, `loan_products`, `loan_applications`, `loan_repayments`, `collections`, `credit_bureau`     |
| Risk & compliance  | `disputes`, `fraud_alerts`, `kyc_records`, `aml_screenings`                                              |
| Merchants          | `merchants`, `merchant_categories`                                                                       |
| Engagement         | `app_sessions`, `support_tickets`, `marketing_campaigns`, `campaign_responses`                           |

**None of this is configured anywhere.** Point Scout at any populated ClickHouse and it derives
that schema's conventions from the catalog on connect - which table owns each key, which columns
are hubs, how tables cluster into the sub-domains the graph viewer colours by - then recovers and
verifies the join graph and answers from there.

---

## 3 · Graph RAG, in detail

Classic RAG retrieves relevant _documents_. **Graph RAG retrieves a relevant _subgraph_**: the
nodes _and_ the relationships between them. Scout's knowledge graph is the **schema graph**:
tables are nodes, recovered join keys are edges. The engine is
[`lib/graph/schema-graph.ts`](lib/graph/schema-graph.ts) +
[`lib/graph/relationships.ts`](lib/graph/relationships.ts).

The expensive part, assembling every candidate edge and probing each one against the live data,
runs **once** and is stored as a single canonical graph. Every conversation and the in-app viewer
then **read** that stored graph; they never re-verify. Verification only re-runs when a human
changes the graph in the Lab.

```mermaid
flowchart LR
  subgraph WRITE["materializeSchemaGraph() - runs only on edge add / edit / delete"]
    direction TB
    INF["relationships.ts<br/>PHYSICAL edges<br/>*_id → canonical parent, from catalog"]
    MAN["user-edges.ts · scout_user_edges<br/>MANUAL edges<br/>human-declared, starts empty"]
    INF --> B
    MAN --> B
    B["1 · BUILD<br/>merge edges (manual > physical)<br/>keep only real tables + columns"] --> V
    V["2 · VERIFY<br/>probe 400 keys per edge · IN-subquery semi-join<br/>drop 0% phantoms · mark verified / partial<br/>manual edges measured but never dropped"]
  end

  V --> STORE[("scout_schema_graph_edges / _nodes<br/>ONE canonical graph")]

  subgraph READ["getSchemaGraph() - every conversation + the viewer"]
    direction TB
    LOAD["load stored graph<br/>no re-verification"] --> RET
    SEEDS["planner's seed tables"] --> RET
    RET["3 · RETRIEVE - retrieveSubgraph<br/>BFS shortest join path · avoid hubs · enrich"] --> FMT
    FMT["4 · FORMAT - formatGraphForPrompt<br/>JOIN GRAPH text → analyst LLM"]
  end

  STORE --> LOAD
```

### 3.1 Two kinds of edge

The graph has no FK metadata to start from, so every edge comes from one of two sources surfaced
in the UI as its **connection** kind:

- **Physical** _(inferred)_ - recovered purely from the catalog. A key-like column (`*_id`,
  `*_key`, `*_code`, …) belongs to the table whose name **is** that column's stem, compared
  ignoring case, separators and plurality: `customer_id → customers`,
  `merchant_category → merchant_categories`. Where that table also exposes the column, the pair
  becomes an edge. Deliberately conservative - no name match means **no edge**, because guessing a
  parent wires up joins that don't exist. Zero configuration, recomputed from the live schema, so
  it stays correct as tables change. This is the automatic backbone of the graph.

  Two more conventions come from the same pass ([`deriveHeuristics`](lib/graph/relationships.ts)):
  **hub columns** (carried by a quarter of the warehouse, so traversal penalises them and one
  question doesn't drag in the whole schema) and **sub-domains** (tables clustered on a shared
  leading token, which is what the graph viewer colours by).
- **Manual** _(declared)_ - human-asserted edges managed in the **Graph RAG Lab** and stored in
  `scout_user_edges`. The store **starts empty**; you declare the edges inference can't see -
  the **aliased** keys (`card_transactions.merchant → merchants.merchant_name`) - and they become
  first-class, editable join keys. Manual is authoritative: on conflict it **wins over** physical.

`buildSchemaGraph()` merges both and requires every edge to exist in the live catalog.

### 3.2 Verify - drop phantom joins against live data

A shared column name doesn't prove a join, so `verifyEdges()` **measures** each edge: it samples
the child key (400 distinct values) and counts the fraction that actually resolve to the parent,
using an `IN (subquery)` **semi-join** (not a `LEFT JOIN`, which ClickHouse fills with type
defaults and would make every edge look like a 100% match).

- **0% overlap → dropped** as a confirmed phantom (kept aside for inspection, never traversed).
- **≥ 50% → `verified`**; anything in between is flagged **`partial`** so the analyst is warned
  the join is lossy.
- The count is **auditable**: `measureOverlap` returns the exact `matched` / `sampled` behind the
  percentage, surfaced in the Lab.
- It **fails open**: a probe timeout leaves an edge un-judged rather than dropping a
  possibly-real key. **Manual** edges are measured the same way but **never dropped** (a human
  asserted them; a lossy one is still flagged partial).

The verified graph is persisted by [`lib/graph/persist.ts`](lib/graph/persist.ts) to
`scout_schema_graph_edges` / `_nodes` as **exactly one** snapshot (each materialization writes a
fresh `built_at` and prunes the older one). `loadStoredGraph()` reads it straight back - that's
what `getSchemaGraph()` serves, so the build/verify cost is paid once, not per question.

### 3.3 Retrieve - `retrieveSubgraph()`

Given the **seed tables** the planner picked, it returns the connected subgraph plus the exact
join map:

1. **Keep the seeds.**
2. **Connect them** - for each remaining seed, find the shortest **join path** (fewest hops) to
   the already-included set with a breadth-first search, pulling in the **bridge tables** along
   the way. (A question spanning `customers` + `branches` automatically pulls in `accounts`.)
   Hub columns (`customer_id`, `city`) are avoided first, so two unrelated tables aren't bridged
   just because both carry a hub column.
3. **Enrich** - fill the remaining budget (default 8 tables) with the seeds' direct neighbours,
   **verified edges first** (typically the dimension tables).

### 3.4 Inject - and repair the analyst's SQL

- `formatGraphForPrompt()` renders the subgraph as a **`JOIN GRAPH`** block of
  `tableA.colA = tableB.colB` lines, fed to the Analyst LLM with an instruction to join **only**
  on these recovered keys (partial edges flagged as lossy).
- The graph is **load-bearing at query time**, not just for retrieval. Because there are no FKs,
  the analyst sometimes references a column on a table that doesn't own it. `checkColumns()`
  (pre-flight) and `enrichError()` (on a ClickHouse error) use the subgraph to tell it _which
  table owns the column and the exact join key to reach it_ so the retry is grounded, not another
  guess. `enrichError()` also catches an **unknown-table** reference (a name the model invented):
  it names the real tables and the closest match, so the agent reports clearly instead of failing
  cryptically.

### 3.5 The Graph RAG Lab (`/graph`)

- **Visualize** - the schema graph as nodes (tables, coloured by sub-domain) and edges
  (verified / partial / physical / manual).
- **Inspect** - every recovered edge with its **connection** (physical / manual), live value
  overlap, and verdict (verified / partial / dropped phantom), including the dropped phantoms.
- **Test** - pick seed tables and see the exact subgraph + `JOIN GRAPH` the RELATE phase would
  build, or probe any two columns for their live overlap (with exact matched / sampled counts).
- **Declare a relationship** - add, edit, or delete a **manual** edge between two related
  columns. Each change is verified against live data, persisted to `scout_user_edges`,
  re-materializes the canonical graph, and shows up in the next question immediately.

---

## 4 · The 6-phase pipeline

Instead of one unconstrained tool-calling loop, Scout decomposes analysis into six typed phases
(orchestrated in [`lib/agent/workflow.ts`](lib/agent/workflow.ts), one function each in
[`lib/agent/phases.ts`](lib/agent/phases.ts)):

1. **DISCOVER** - map the warehouse once (cached): tables, columns, free row-count estimates.
2. **PLAN** - the Planner LLM interprets the question, fixes metric definitions, picks seed
   tables, and decides whether to ask for clarification.
3. **RELATE (Graph RAG)** - read the schema graph and walk from the seeds to the connected
   subgraph + exact join keys (Section 3). Degrades to just the seeds if the graph is
   unavailable.
4. **INSPECT** - fetch exact typed schemas (`DESCRIBE`) for the subgraph's tables (up to 8) and
   sample their categorical values.
5. **ANALYZE** - a bounded loop (≤ 8 queries): the Analyst LLM, armed with the `JOIN GRAPH` and
   the sampled values, proposes one SELECT, runs it, reads ≤ 40 result rows, and iterates. The
   graph-backed column guard repairs wrong-table references here.
6. **SYNTHESIZE** - the Synthesizer LLM composes the structured JSON dashboard, using exact
   warehouse facts (table / row counts) so it never guesses structural numbers.

Every phase streams its own step chip to the UI, so the user watches the reasoning live.

---

## 5 · Project structure

```text
app/
  page.tsx                    UI shell (state lives in hooks/useScoutAgent.ts)
  graph/page.tsx              Graph RAG Lab (Visualize / Inspect / Test / Declare)
  health/route.ts             GET /health liveness probe
  api/[[...route]]/route.ts   API router: GET db-info · graph ; POST connect · disconnect · chat ·
                              upload · graph/probe·retrieve·edge
components/                   ChatPanel · DashboardPanel + EChart · GraphCanvas (SVG graph viewer) · icons
  ConnectTour.tsx             the 4-step guided setup shown until a warehouse is linked
  components.css              hand-written component styles (the rest is Tailwind utilities)
hooks/
  useScoutAgent.ts            client state: turns, dashboard versions, NDJSON streaming, file upload
  useConnection.ts            link status + connect / disconnect (never holds the credentials)
lib/
  types.ts                    shared contract: streaming events + dashboard shape
  agent/                      ── AGENT ──
    workflow.ts               the 6-phase orchestrator
    phases.ts                 the six phases + the graph-backed column guard + dashboard coercion
    context.ts                shared shapes (Plan / AnalyzeResult) + prompt formatters
    prompts.ts                all LLM system prompts
    llm.ts                    OpenAI client wrapper (llmJSON)
  graph/                      ── GRAPH RAG ──
    relationships.ts          physical (inferred) edges + per-schema hub/parent/domain derivation
    user-edges.ts             manual (declared) edge store: scout_user_edges
    schema-graph.ts           materialize (build → verify → persist) · get (read) · retrieve · format
    persist.ts                single canonical graph snapshot → scout_schema_graph_edges/_nodes
  db/                         ── CLICKHOUSE ──
    connection.ts             the per-request connection (AsyncLocalStorage) · host normalization · SSRF guard
    session.ts                seals / opens the connection cookie (AES-256-GCM)
    clickhouse.ts             read-only query layer (runSelect / describeTable) + pooled per-connection clients
    catalog.ts                cached warehouse catalog (partitioned per connection)
    profile.ts                samples categorical column values for the analyst
    parsers.ts                CSV / TSV / Excel / JSON → rows + ClickHouse type inference
    ingest.ts                 attached file → typed MergeTree table (naming, dedup, DDL, bulk insert)
    write.ts                  HTTP write transport (chExec) for ingest, the manual store + graph snapshot
```
