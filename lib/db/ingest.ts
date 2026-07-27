// ClickHouse ingestion for uploaded files - how data that isn't in the warehouse yet gets
// there. A spreadsheet the user attaches becomes a real table in their linked database, so
// the agent can query and join it exactly like everything else.
//
// The analytics client is read-only, so the CREATE TABLE + INSERT here go directly over
// ClickHouse's HTTP interface via chExec() (write.ts) - which means an upload needs a
// ClickHouse user with CREATE/INSERT rights on the linked database. File parsing lives in
// parsers.ts; this module handles the ClickHouse-specific parts: table naming, dedup, DDL,
// and bulk insert.

import { createHash } from "node:crypto";
import { runSelect, describeTable, dbName } from "./clickhouse";
import { chExec } from "./write";
import { parseDelimited, parseJson, parseXlsx, inferSchema, type InferredColumn } from "./parsers";

export type { InferredColumn };

/** Extensions the attach button accepts. Keep in sync with the file input's `accept`. */
export const SUPPORTED_EXTENSIONS = ["csv", "tsv", "xlsx", "xls", "json", "jsonl", "ndjson"] as const;

/** Upload ceiling. Whole-file parsing happens in memory, so this bounds a request's RSS. */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

// Shared helpers

/** Fully-qualified table name in the linked database. */
function qualified(table: string): string {
  return `\`${dbName()}\`.\`${table}\``;
}

/** Derive a deterministic, safe table name from filename + content hash. */
function deriveTableName(filename: string, hash: string): string {
  const base = filename.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase().slice(0, 40) || "upload";
  return `upload_${base}_${hash}`;
}

/**
 * Check if a table already exists and has data. Returns the existing result
 * if so, or null to signal that ingestion should proceed. Re-attaching the same file
 * is a no-op rather than a duplicate table, because the name carries the content hash.
 */
async function checkExisting(table: string): Promise<IngestResult | null> {
  try {
    const tableInfo = await describeTable(table);
    const countRes = await runSelect(`SELECT count() AS n FROM \`${table}\``);
    const rowCount = Number(countRes.rows[0]?.n ?? 0);
    if (rowCount > 0) {
      const columns: InferredColumn[] = tableInfo.columns.map((col) => ({
        name: col.name,
        type: col.type,
      }));
      return { table, rowCount, columns, alreadyExists: true };
    }
  } catch {
    // Table doesn't exist — proceed with ingestion.
  }
  return null;
}

/**
 * Choose a MergeTree sort key from the inferred schema. Prefer a date/datetime
 * column first, then 1-2 low-cardinality columns. Falls back to tuple().
 */
function orderByKey(columns: InferredColumn[]): string {
  const keys: string[] = [];
  const dateCol = columns.find((c) => c.type === "Date" || c.type === "DateTime");
  if (dateCol) keys.push(`\`${dateCol.name}\``);
  const lowCard = columns.filter((c) => c.type.startsWith("LowCardinality")).slice(0, 2);
  for (const c of lowCard) keys.push(`\`${c.name}\``);
  return keys.length ? `(${keys.join(", ")})` : "tuple()";
}

/** CREATE the destination table from an inferred schema (MergeTree + a sort key). */
async function createTable(table: string, columns: InferredColumn[]): Promise<void> {
  const colDefs = columns.map((c) => `\`${c.name}\` ${c.type}`).join(",\n  ");
  // IF NOT EXISTS: an ingest that created the table and then failed to insert leaves an
  // empty table behind, and the name is deterministic (filename + content hash) - so without
  // this, retrying the same upload fails forever on "table already exists".
  await chExec(`CREATE TABLE IF NOT EXISTS ${qualified(table)} (\n  ${colDefs}\n) ENGINE = MergeTree ORDER BY ${orderByKey(columns)}`);
}

/**
 * Turn a raw ClickHouse failure into something the user can act on. A missing grant is by
 * far the most common way an upload fails once a read-only user is linked, and the server's
 * own wording ("Not enough privileges") doesn't say what to change.
 */
export function explainIngestError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/not enough privileges|access_denied|accessdenied|readonly/i.test(msg)) {
    return (
      `Your ClickHouse user can read but not write, so Scout can't create the table. ` +
      `Grant CREATE TABLE and INSERT on \`${dbName()}\` (or link a user that has them) and try again.`
    );
  }
  return msg;
}

// Public API

export interface IngestResult {
  table: string;
  rowCount: number;
  columns: InferredColumn[];
  alreadyExists?: boolean;
}

/** Dispatch by extension, then ingest. Handles .csv, .tsv, .xlsx, .xls, .json, .jsonl, .ndjson. */
export async function ingestFile(filename: string, buf: Buffer): Promise<IngestResult> {
  const hash = createHash("sha256").update(buf).digest("hex").slice(0, 12);
  const ext = (filename.split(".").pop() || "").toLowerCase();

  if (!(SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new Error(`Unsupported file type ".${ext}". Attach one of: ${SUPPORTED_EXTENSIONS.join(", ")}.`);
  }

  if (ext === "csv" || ext === "tsv") {
    return ingestDelimited(filename, buf, hash, ext);
  }

  // Non-plaintext files (.xlsx, .xls, .json, etc.)
  let rows: string[][];
  if (ext === "xlsx" || ext === "xls") {
    rows = parseXlsx(buf);
  } else {
    rows = parseJson(buf);
  }
  return ingestRows(filename, rows, hash);
}

/**
 * Fast path for CSV/TSV: stream raw bytes directly to ClickHouse instead of
 * re-serialising through a matrix.
 */
async function ingestDelimited(
  filename: string,
  buf: Buffer,
  hash: string,
  ext: "csv" | "tsv",
): Promise<IngestResult> {
  const text = buf.toString("utf8");
  const delimiter = ext === "csv" ? "," : "\t";
  const format = ext === "csv" ? "CSV" : "TSV";

  // Parse only the first 501 rows for schema inference
  const sampleRows = parseDelimited(text, delimiter, 501);
  if (sampleRows.length < 2) throw new Error("File needs a header row and at least one data row");

  const headers = sampleRows[0];
  const dataSample = sampleRows.slice(1);
  const table = deriveTableName(filename, hash);

  // Dedup: skip if table already exists with data
  const existing = await checkExisting(table);
  if (existing) return existing;

  const columns = inferSchema(headers, dataSample);
  await createTable(table, columns);

  // Slice off the header row to get raw data body
  let headerEnd = text.indexOf("\n");
  if (headerEnd === -1) headerEnd = text.indexOf("\r");
  let dataStartIndex = headerEnd + 1;
  while (dataStartIndex < text.length && (text[dataStartIndex] === "\n" || text[dataStartIndex] === "\r")) {
    dataStartIndex++;
  }
  const dataBody = text.slice(dataStartIndex);

  // Bulk load raw body directly into ClickHouse
  await chExec(`INSERT INTO ${qualified(table)} FORMAT ${format}`, dataBody, {
    input_format_null_as_default: "1",
  });

  // Total row count after the load.
  const countRes = await runSelect(`SELECT count() AS n FROM \`${table}\``);
  const rowCount = Number(countRes.rows[0]?.n ?? dataSample.length);

  return { table, rowCount, columns };
}

/** Create a table from an inferred schema and bulk-load the rows (Excel/JSON path). */
async function ingestRows(filename: string, rows: string[][], contentHash?: string): Promise<IngestResult> {
  if (rows.length < 2) throw new Error("File needs a header row and at least one data row");
  const headers = rows[0];
  const dataRows = rows.slice(1);
  const sample = dataRows.slice(0, 500);

  const hash = contentHash || createHash("sha256").update(JSON.stringify(rows)).digest("hex").slice(0, 12);
  const table = deriveTableName(filename, hash);

  // Dedup: skip if table already exists with data
  const existing = await checkExisting(table);
  if (existing) return existing;

  const columns = inferSchema(headers, sample);
  await createTable(table, columns);

  // Re-emit the data as a clean CSV with sanitised headers, then bulk insert.
  const numRows = dataRows.length;
  const numCols = columns.length;
  const cleanLines = new Array(numRows + 1);
  cleanLines[0] = columns.map((c) => c.name).join(",");

  for (let i = 0; i < numRows; i++) {
    const r = dataRows[i];
    let line = "";
    for (let j = 0; j < numCols; j++) {
      const t = (r[j] ?? "").trim();
      let cell = "\\N";
      if (t !== "" && t.toLowerCase() !== "null") {
        cell = /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
      }
      line += cell;
      if (j < numCols - 1) line += ",";
    }
    cleanLines[i + 1] = line;
  }

  await chExec(`INSERT INTO ${qualified(table)} FORMAT CSVWithNames`, cleanLines.join("\n"), {
    input_format_null_as_default: "1",
  });

  return { table, rowCount: dataRows.length, columns };
}
