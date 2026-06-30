// File parsers — ClickHouse-agnostic utilities that turn CSV, TSV, JSON, and Excel
// files into a header + rows matrix, plus per-column ClickHouse type inference.

import * as XLSX from "xlsx";

// Delimiter-based parsing

/**
 * A minimal RFC-4180-ish delimiter parser. Handles double-quoted fields, escaped
 * quotes (""), field delimiters, and CRLF line breaks in a single-pass state machine.
 */
export function parseDelimited(text: string, delimiter: string = ",", maxRows?: number): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      if (maxRows && rows.length >= maxRows) {
        break;
      }
    } else if (c === "\r") {
      // swallow; handled by the \n
    } else {
      field += c;
    }
  }
  if (rows.length < (maxRows || Infinity) && (field.length > 0 || row.length > 0)) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0].trim() !== ""));
}

// JSON parsing

/**
 * Parse JSON input, accepting both a standard array of objects and newline-delimited
 * JSON (NDJSON). Returns a header + rows matrix.
 */
export function parseJson(buf: Buffer): string[][] {
  const text = buf.toString("utf8").trim();
  let objects: Record<string, any>[] = [];
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        objects = parsed;
      } else {
        throw new Error("JSON file must contain an array of objects");
      }
    } catch (e) {
      throw new Error(`Invalid JSON array: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    // Try parsing as NDJSON (newline-delimited JSON objects)
    const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
    try {
      objects = lines.map((line) => JSON.parse(line));
    } catch (e) {
      throw new Error(`Failed to parse as JSON Array or NDJSON: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (objects.length === 0) {
    throw new Error("No data records found in JSON");
  }

  // Extract all unique keys across all objects to form the headers.
  const headersSet = new Set<string>();
  for (const obj of objects) {
    for (const key of Object.keys(obj)) {
      headersSet.add(key);
    }
  }
  const headers = Array.from(headersSet);
  if (headers.length === 0) {
    throw new Error("No keys found in JSON records to form headers");
  }

  // Build the rows matrix.
  const rows: string[][] = [headers];
  for (const obj of objects) {
    const row = headers.map((h) => {
      const val = obj[h];
      if (val === null || val === undefined) return "";
      if (typeof val === "object") return JSON.stringify(val);
      return String(val);
    });
    rows.push(row);
  }

  return rows;
}

// Excel parsing

/** Parse the first sheet of an .xlsx/.xls workbook into a string matrix. */
export function parseXlsx(buf: Buffer): string[][] {
  const wb = XLSX.read(buf, { type: "buffer" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new Error("Workbook has no sheets");
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: "" });
  return aoa.map((r) => r.map((c) => (c == null ? "" : String(c))));
}

// Schema inference

export interface InferredColumn {
  /** Sanitised ClickHouse-safe column name. */
  name: string;
  type: string;
}

function sanitise(name: string, idx: number): string {
  const s = name.trim().replace(/[^a-zA-Z0-9_]/g, "_").replace(/^(\d)/, "_$1");
  return s || `col_${idx}`;
}

const INT_RE = /^-?\d{1,18}$/;
const FLOAT_RE = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/;

/**
 * Infer a ClickHouse type per column from sampled values.
 * Heuristics: id/code/number-ish names stay String; low-cardinality strings
 * become LowCardinality(String); dates/numbers detected from patterns.
 */
export function inferSchema(headers: string[], sampleRows: string[][]): InferredColumn[] {
  return headers.map((header, col) => {
    const name = sanitise(header, col);
    const lname = header.toLowerCase();
    const values = sampleRows
      .map((r) => (r[col] ?? "").trim())
      .filter((v) => v !== "" && v.toLowerCase() !== "null" && v !== "\\N");

    // Identifier-ish names stay String even when numeric.
    const idLike = /(^|_)(id|code|number|pin|phone|mobile|zip|pincode|account|cif)(_|$)/.test(lname);

    let type = "String";
    if (values.length === 0) {
      type = "Nullable(String)";
    } else if (!idLike && values.every((v) => INT_RE.test(v))) {
      type = "Int64";
    } else if (!idLike && values.every((v) => FLOAT_RE.test(v))) {
      type = "Decimal(18, 4)";
    } else if (values.every((v) => DATETIME_RE.test(v))) {
      type = "DateTime";
    } else if (values.every((v) => DATE_RE.test(v))) {
      type = "Date";
    } else {
      // Low-cardinality string → LowCardinality(String).
      const distinct = new Set(values).size;
      type = distinct <= 50 && distinct / values.length < 0.5
        ? "LowCardinality(String)"
        : "String";
    }
    return { name, type };
  });
}
