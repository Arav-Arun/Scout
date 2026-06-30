# Scout - AI Data Analytics Agent over ClickHouse

Scout turns a plain-English question into a structured analytical dashboard by reasoning over a large ClickHouse warehouse the way an analyst would:
map the schema, figure out which tables join and on what keys, write the SQL, run it,
and explain the result.

```
User question
   │  POST /api/chat  (streaming NDJSON)
   ▼
Scout pipeline    DISCOVER → PLAN → RELATE → INSPECT → ANALYZE↺ → SYNTHESIZE
   │                                └── Graph RAG: seed tables → connected subgraph + exact join keys
   ▼
Event stream  →  Chat panel (live reasoning chips + narrative)
              →  Dashboard panel (hero metrics, ECharts, insights, tables, Export SQL)
```

---

## Architecture & flow

**Agent architecture** — three library layers (`agent` / `graph` / `db`) behind a single streaming
API, with the UI importing only `lib/types.ts`:

```mermaid
flowchart TB
  subgraph UI["Browser — Next.js client"]
    HOOK["useScoutAgent<br/>(state + NDJSON reader)"]
    CHAT["ChatPanel<br/>(step chips + composer)"]
    DASH["DashboardPanel + EChart"]
    GLAB["/graph — Graph RAG Lab<br/>(GraphCanvas · Visualize/Inspect/Test/Manage edges)"]
  end

  subgraph API["API — app/api route"]
    CHATAPI["POST /api/chat<br/>(NDJSON stream)"]
    UPAPI["POST /api/upload"]
    GRAPHAPI["GET /api/graph<br/>+ POST graph/probe·retrieve·edge"]
  end

  subgraph AGENT["lib/agent — 6-phase orchestrator"]
    WF["workflow.ts"]
    PH["phases.ts<br/>(+ table/column guard)"]
    LLM["llm.ts + prompts.ts"]
  end

  subgraph GRAPH["lib/graph — Graph RAG"]
    REL["relationships.ts<br/>(curated seed + inference)"]
    UE["user-edges.ts<br/>(declared store: curated seed + edits)"]
    SG["schema-graph.ts<br/>(build/verify/retrieve/format)"]
    PERSIST["persist.ts<br/>(graph snapshot)"]
  end

  subgraph DB["lib/db — ClickHouse layer"]
    CH["clickhouse.ts<br/>(read-only)"]
    CAT["catalog.ts<br/>(cached map)"]
    PROF["profile.ts"]
    ING["ingest.ts + write.ts<br/>(write path)"]
  end

  OPENAI[["OpenAI API"]]
  CLICK[["ClickHouse warehouse<br/>32 tables, no FKs"]]

  CHAT --- HOOK
  DASH --- HOOK
  HOOK -->|question| CHATAPI
  CHAT -->|file| UPAPI
  CHAT -->|graph icon| GLAB
  GLAB -->|fetch| GRAPHAPI

  CHATAPI --> WF --> PH
  PH --> LLM --> OPENAI
  PH --> SG --> REL
  SG --> UE --> CH
  PH --> CAT
  PH --> PROF
  CAT --> CH
  PROF --> CH
  SG --> CH --> CLICK
  GRAPHAPI --> SG
  GRAPHAPI --> PERSIST --> CH
  UPAPI --> ING --> CLICK
  CHATAPI -.->|NDJSON events| HOOK
```

**Program flow** — the six phases and the bounded analyze loop:

```mermaid
flowchart TD
  Q["User question<br/>POST /api/chat"] --> D

  subgraph PIPE["runScoutWorkflow — lib/agent/workflow.ts"]
    D["1 · DISCOVER<br/>cached warehouse map"] --> P
    P["2 · PLAN<br/>interpret + pick seed tables"] --> CL{"needs clarification?"}
    CL -->|yes| STOP["emit clarification, stop"]
    CL -->|no| R["3 · RELATE (Graph RAG)<br/>seeds → subgraph + JOIN GRAPH<br/>(falls back to seeds if graph unavailable)"]
    R --> I["4 · INSPECT<br/>DESCRIBE ≤8 tables + sample values"]
    I --> A
    A["5 · ANALYZE loop (≤8)<br/>propose 1 SELECT → run → read ≤40 rows"]
    A -->|"column guard repairs wrong-table refs"| A
    A --> S["6 · SYNTHESIZE<br/>compose dashboard JSON"]
  end

  S --> OUT["dashboard event → UI"]
  D -.->|step + text events| OUT
```

---

## 1. The problem this solves

The warehouse is **32 interconnected tables** modelling a card-issuer / retail bank (~7.3M rows),
and by design — it has no foreign keys.Tables are linked only by *shared key columns*, and some of those keys are **aliased** (`loan_book.branch` →
`branches.branch_id`, `collections.assigned_employee_id` → `employees.employee_id`), so a column-name
match alone can't even find them.

---

## 2. The warehouse

32 tables across eight sub-domains, linked by shared (often aliased) keys — never by FKs:

| Sub-domain | Tables |
|---|---|
| Customer | `customers`, `geographies`, `devices` |
| Branch & staff | `branches`, `employees` |
| Accounts & cards | `accounts`, `cards`, `card_products`, `card_applications`, `account_transactions` |
| Payments & rewards | `card_transactions`, `statements`, `rewards_ledger`, `reward_redemptions`, `offers`, `offer_redemptions` |
| Lending | `loan_book`, `loan_products`, `loan_applications`, `loan_repayments`, `collections`, `credit_bureau` |
| Risk & compliance | `disputes`, `fraud_alerts`, `kyc_records`, `aml_screenings` |
| Merchants | `merchants`, `merchant_categories` |
| Engagement | `app_sessions`, `support_tickets`, `marketing_campaigns`, `campaign_responses` |

The data is **internally consistent**, not random filler: `rewards_ledger` and `statements` are
derived from real `card_transactions`; `disputes`/`fraud_alerts` come from transactions actually
flagged `is_fraud`; `loan_repayments` is the real EMI schedule; `collections` exists only for
delinquent loans. Every row for a customer is generated from that customer's own
`value_band`/`credit_score`/`income`, so totals reconcile across tables. `npm run db:seed-graph`
builds it (idempotent).

---

## 3. Graph RAG, in detail

Classic RAG retrieves relevant *documents*. Graph RAG retrieves a relevant *subgraph* of a
knowledge graph so the model gets the nodes and the relationships between them.
Scout's knowledge graph is the **schema graph**: tables are nodes, recovered join keys are edges.
The whole engine is [`lib/graph/schema-graph.ts`](lib/graph/schema-graph.ts) +
[`lib/graph/relationships.ts`](lib/graph/relationships.ts), in four stages:

```mermaid
flowchart LR
  subgraph STORE["Declared-edge store — user-edges.ts (scout_user_edges)"]
    CUR["CURATED_RELATIONSHIPS<br/>(seeded once)"]
    EDITS["user add / edit / delete<br/>(Graph RAG Lab)"]
  end
  CUR --> DECL["DECLARED edges<br/>(authoritative, editable)"]
  EDITS --> DECL
  INF["inferRelationships<br/>(*_id → parent, from catalog)"] --> B
  DECL --> B
  B["1 · BUILD<br/>merge edges (declared > inferred),<br/>keep only real tables + cols"] --> V
  V["2 · VERIFY<br/>probe 400 keys via IN-subquery semi-join<br/>drop 0% phantoms · mark verified / partial<br/>(declared edges measured but never dropped)"] --> RET
  SEEDS["planner seed tables"] --> RET
  RET["3 · RETRIEVE — retrieveSubgraph<br/>BFS shortest join path · avoid hubs · enrich"] --> FMT
  FMT["4 · FORMAT — formatGraphForPrompt<br/>JOIN GRAPH text → analyst LLM"]
```

### 3.1 Build — nodes and edges

- **Nodes** - every table in the live catalog (`system.columns`), carrying its column list and a
  free row-count estimate (`buildSchemaGraph`).
- **Edges** - the implicit join keys, from two sources and merged:
  - **Declared** (`user-edges.ts`, stored in `scout_user_edges`) - the authoritative, human-asserted
    edges, **all editable from the Graph RAG Lab** (add / edit / delete). The store is **seeded once**
    with the curated manifest (`CURATED_RELATIONSHIPS`), which captures the **aliased** keys a name
    match can't see (e.g. `card_transactions.merchant` → `merchants.merchant_name`); from then on the
    seed and any user edits live together as one editable set.
  - **Inferred** (`inferRelationships`) - recovered purely from the catalog with zero FK metadata: any
    key-like column (`*_id`, or a known join column in `PARENT_OF_COLUMN`) that exists both on a table
    and on its **canonical parent** becomes an edge. This keeps the graph correct when **new tables are
    uploaded**, and proves relationships are discoverable with no FK metadata.

  `buildSchemaGraph()` merges both (**declared wins over inferred**) and every edge must exist in the
  live catalog — both tables present, both join columns real — defending against stale data.

### 3.2 Verify - drop phantom joins against live data

A shared column name does **not** prove two columns join. `account_transactions.txn_id` and
`card_transactions.txn_id` share a name yet have **zero** overlapping values. So `verifyEdges()`
samples each child key (400 distinct values) and measures the fraction that actually resolves to the
parent.
Edges at 0% overlap are **dropped as phantoms**; the rest are marked `verified` (≥50%) or flagged **partial** so the
analyst is warned a join is lossy. The overlap is **auditable** — `measureOverlap` returns the exact
`matched` / `sampled` counts behind the percentage, surfaced in the Lab.
It **fails open**: a probe timeout leaves an edge un-judged rather than dropping a possibly-real key.
Declared edges are measured the same way but **never dropped** (a human asserted them); a lossy one is still flagged partial.

### 3.3 Retrieve - `retrieveSubgraph()`

The heart of it. Given the **seed tables** the planner picked from the question, it returns the
connected subgraph plus the exact join map:

1. **Keep the seeds.**
2. **Connect them** - for each remaining seed, find the shortest **join path** (fewest hops) to the
   already included set with a breadth-first search (`bfsPath`), pulling in the **bridge tables**
   along the way. (A question spanning `customers` + `branches` automatically pulls in `accounts`.)
3. **Enrich** - fill the remaining budget (default 8 tables) with the seeds' direct neighbours,
   **verified edges first** (typically the dimension tables).
   
### 3.4 Inject - and repair the analyst's SQL

- `formatGraphForPrompt()` renders the subgraph as a **`JOIN GRAPH`** block of
  `tableA.colA = tableB.colB` lines, fed to the Analyst LLM with an instruction to join **only** on
  these recovered keys (partial edges are flagged as lossy).
- The graph is also **load-bearing at query time**, not just for retrieval. Because there are no FKs,
  the analyst sometimes references a column on a table that doesn't own it. `checkColumns()`
  (pre-flight) and `enrichError()` (on a ClickHouse error) use the subgraph to tell it *which table
  owns the column and the exact join key to reach it* — so the retry is grounded instead of another
  guess. `enrichError()` also catches an **unknown-table** reference (e.g. a name the model invented,
  or an upload that never persisted): it names the real tables and the closest match, so the agent
  stops re-querying a phantom table and reports clearly instead of failing cryptically.

### 3.5 Where it runs

```
DISCOVER → PLAN → [ RELATE ] → INSPECT → ANALYZE↺ → SYNTHESIZE
                      └── walks the graph from the planner's seeds → subgraph + JOIN GRAPH
```

The **RELATE** phase ([`lib/agent/phases.ts`](lib/agent/phases.ts)) sits between PLAN and INSPECT.

### 3.6 The Graph RAG Lab (`/graph`)

The graph the agent walks is also a first-class in-app page ([`app/graph/page.tsx`](app/graph/page.tsx)) —
open it from the **graph icon** at the top of the chat panel (served as JSON at `/api/graph`). Four tabs:

- **Visualize** - the schema graph drawn as nodes (tables, coloured by sub-domain) and edges
  (verified / partial / declared), pure SVG, no graph library.
- **Inspect** - every recovered edge with its source, live value-overlap, and verdict (verified /
  partial / dropped phantom), including the dropped phantoms.
- **Test** - pick seed tables and see the exact subgraph + `JOIN GRAPH` the RELATE phase would build,
  or probe any two columns for their live overlap (with the exact matched / sampled counts).
- **Add relationship** - manage every declared edge in one place (the curated seed plus your own):
  add, edit, or delete a non-foreign-key edge between two related columns. Each change is verified
  against live data, persisted (`scout_user_edges`), and merged into the graph immediately.



## 4. The 6-phase pipeline

Instead of one unconstrained tool-calling loop, Scout decomposes analysis into six typed phases
(orchestrated in [`lib/agent/workflow.ts`](lib/agent/workflow.ts), one function each in
[`lib/agent/phases.ts`](lib/agent/phases.ts)):

1. **DISCOVER** - map the warehouse once (cached): tables, columns, free row-count estimates.
2. **PLAN** - the Planner LLM interprets the (often vague) question, fixes metric definitions, picks
   seed tables, and decides if it must ask for clarification.
3. **RELATE (Graph RAG)** - walk the schema graph from the seeds to the connected subgraph + exact
   join keys (Section 3).
4. **INSPECT** - fetch exact typed schemas (`DESCRIBE`) for the subgraph's tables (up to 8).
5. **ANALYZE** - a bounded loop (≤ 8 queries): the Analyst LLM, armed with the `JOIN GRAPH` and
   sampled categorical values, proposes one SELECT, runs it, reads ≤ 40 result rows, and iterates.
   The graph-backed column guard repairs wrong-table references here.
6. **SYNTHESIZE** - the Synthesizer LLM composes the structured JSON dashboard, using exact
   warehouse facts (table/row counts) so it never guesses structural numbers.

Every phase streams its own step chip to the UI, so the user watches the reasoning live.

## 6. Project structure

The three concerns are separated by folder. The **UI** (`app/*.tsx`, `components/`, `hooks/`) imports
only `lib/types.ts`; the **agent** lives in `lib/agent/`; the **graph** in `lib/graph/`; the
**ClickHouse data layer** in `lib/db/`.

```
app/
  page.tsx                 UI shell (state lives in hooks/useScoutAgent.ts)
  graph/page.tsx           Graph RAG Lab (Visualize / Inspect / Test / Add edge)
  api/[[...route]]/route.ts API router: /api/chat, /api/upload, /api/db-info, /api/graph (+ graph/probe·retrieve·edge)
  health/route.ts          liveness probe
components/                ChatPanel, DashboardPanel + EChart, GraphCanvas (graph viewer), icons
  components.css           all hand-written component styles (the rest is Tailwind utilities)
hooks/useScoutAgent.ts     client state: turns, dashboard versions, streaming, upload (progress + timeout)
lib/
  types.ts                 shared contract: streaming events + dashboard shape
  agent/
    workflow.ts            the 6-phase orchestrator
    phases.ts              the six phases + the graph-backed table/column guard + dashboard coercion
    context.ts             shared shapes (Plan/AnalyzeResult) + prompt formatters
    prompts.ts             all LLM system prompts
    llm.ts                 OpenAI client wrapper (llmJSON)
  graph/                   ── GRAPH RAG ──
    relationships.ts       the curated seed + key-column inference for the join graph (no FKs)
    user-edges.ts          editable declared-edge store (curated seed + user add/edit/delete)
    schema-graph.ts        build → verify → retrieveSubgraph → formatGraphForPrompt
    persist.ts             durable snapshot of the verified graph → scout_schema_graph_*
  db/                      ── CLICKHOUSE ──
    clickhouse.ts          read-only query layer (runSelect / describeTable)
    catalog.ts             cached warehouse catalog
    parsers.ts             CSV/TSV/JSON/Excel parsing + schema inference
    ingest.ts              file ingestion: CREATE TABLE + bulk INSERT
    write.ts               HTTP write transport (chExec) for ingest + graph persistence
    profile.ts             samples categorical column values for the analyst
scripts/
  seed_graph.mjs           generates the interconnected no-FK warehouse
  ch_tables.mjs / peek.sh  warehouse inspection helpers
```

---
**Scope:** the agent caps itself at ~8 queries per analysis; the graph's edge-verification probes
  are sampled (400 keys) and cached, so they stay cheap on multi-million-row tables.
