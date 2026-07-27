// ClickHouse write transport. The analytics client is pinned read-only (readonly=2), so the
// write paths - file ingestion (ingest.ts), the manual-edge store (user-edges.ts) and
// schema-graph persistence (persist.ts) - go directly over ClickHouse's HTTP interface via
// chExec() below, using the connection the visitor linked.
//
// These writes need CREATE/INSERT rights on the linked database. A read-only ClickHouse user
// is a perfectly valid way to run Scout - graph persistence degrades to in-memory and uploads
// report the server's own permission error - so callers treat failure here as recoverable.

import { currentConnection } from "./connection";

/** Base URL + Basic-auth header for direct HTTP writes (same creds as the read client). */
function chBase(): { url: string; auth: string; database: string } {
  const conn = currentConnection();
  return {
    url: conn.url.replace(/\/$/, ""),
    auth: "Basic " + Buffer.from(`${conn.username || "default"}:${conn.password || ""}`).toString("base64"),
    database: conn.database,
  };
}

/** Run a write/DDL statement against ClickHouse over HTTP. */
export async function chExec(
  query: string,
  body?: string,
  settings?: Record<string, string>,
): Promise<void> {
  const { url, auth, database } = chBase();
  const params = new URLSearchParams();
  // Without this the statement runs against `default`, not the linked database - the
  // difference only shows up on unqualified table names (ingest.ts).
  params.set("database", database);
  if (body) params.set("query", query);
  for (const [k, v] of Object.entries(settings ?? {})) params.set(k, v);
  const res = await fetch(`${url}/?${params.toString()}`, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "text/plain" },
    body: body ?? query,
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`ClickHouse error (${res.status}): ${txt.slice(0, 400)}`);
  }
}
