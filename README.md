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
Scout Workflow (DISCOVER → PLAN → INSPECT → ANALYZE → SYNTHESIZE)
   │   orchestration:     lib/agent/workflow.ts
   │   prompts:           lib/agent/prompts.ts
   │   LLM client:        lib/agent/llm.ts
   │   querying:           lib/db/clickhouse.ts
   ▼
Stream of events  →  Chat panel (step chips + narration)  +  Dashboard panel
                     (hero metrics, ECharts charts, insights, tables, Export SQL)
```

### 1. 5-Phase Agentic Pipeline
Instead of running a single, unconstrained loop where an LLM repeatedly calls tools Scout decomposes the data analytics process into five discrete, structured, and sequentially typed phases:
1. **DISCOVER**: A fast, low-overhead metadata listing to map out the entire warehouse and gather table/column catalogs before planning.
2. **PLAN**: The Planner LLM (`PLANNER_SYS` in `lib/agent/prompts.ts`) interprets the user's request, parses ambiguous terms, sets metric definitions, determines output format requirements, and decides if clarification is needed.
3. **INSPECT**: Fetches target schemas (column names and database types) for the chosen tables (`describeTable`) to ensure syntactic correctness in generated SQL.
4. **ANALYZE Loop**: An iterative query loop (capped at 8 queries) where the Analyst LLM (`ANALYST_SYS`) suggests a single query, executes it, and evaluates up to 40 row result previews to determine if further investigation is needed.
5. **SYNTHESIZE**: The Synthesizer LLM (`SYNTH_SYS`) aggregates the query results, references exact metrics, and compiles a structured JSON dashboard conforming to the user's formatting request.

### 2. ClickHouse Performance & Database Integration
ClickHouse is a column oriented DBMS optimized for sub-second analytical queries over billions of rows. Scout is engineered to leverage these advantages fully:
- **Server Side Aggregations**: All mathematical calculations are performed entirely by ClickHouse. The LLM only receives consolidated data previews (max 40 rows per query), keeping token consumption low and processing speed incredibly fast.
- **Dynamic Sort Ordering (`ORDER BY`)**: During file upload, `orderByKey` selects an optimal primary sorting key for the table. It prioritizes time-series date columns and low-cardinality values first to speed up indexing.
- **Low Cardinality Compression**: Text columns with repetitive values are inferred as `LowCardinality(String)`. ClickHouse compresses these using dictionary encoding, reducing disk I/O and accelerating `GROUP BY` execution.
- **High-Precision Decimal Ingestion**: Float values are automatically inferred as `Decimal(18, 4)` rather than `Float64`. This prevents binary floating-point representation rounding errors, ensuring 100% financial calculation accuracy.

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
npm run db:tables    # List all tables with row counts
npm run db:peek      # Browse table data (usage: npm run db:peek -- <table> [limit])
npm run test:chat    # End-to-end agent test against running dev server
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
    workflow.ts         ORCHESTRATION: the 5-phase pipeline
    phases.ts           the 5 phases + normalizeDashboard (model-output coercion)
    context.ts          shared shapes (Plan/AnalyzeResult) + prompt formatters
    prompts.ts          PROMPTS: all LLM system prompts
    llm.ts              LLM CLIENT: OpenAI wrapper + llmJSON()
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
