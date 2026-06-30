// ClickHouse write transport. The analytics client is pinned read-only (readonly=2), so
// the write paths — file ingestion (ingest.ts) and schema-graph persistence (persist.ts) —
// go directly over ClickHouse's HTTP interface via chExec() below.

/** Base URL + Basic-auth header for direct HTTP writes (same creds as the read client). */
function chBase(): { url: string; auth: string } {
  const url = process.env.CLICKHOUSE_HOST;
  if (!url) throw new Error("CLICKHOUSE_HOST is not set");
  const user = process.env.CLICKHOUSE_USER || "default";
  const pass = process.env.CLICKHOUSE_PASSWORD || "";
  return { url: url.replace(/\/$/, ""), auth: "Basic " + Buffer.from(`${user}:${pass}`).toString("base64") };
}

/** Run a write/DDL statement against ClickHouse over HTTP. */
export async function chExec(
  query: string,
  body?: string,
  settings?: Record<string, string>,
): Promise<void> {
  const { url, auth } = chBase();
  const params = new URLSearchParams();
  if (body) params.set("query", query);
  for (const [k, v] of Object.entries(settings ?? {})) params.set(k, v);
  const qs = params.toString() ? `?${params.toString()}` : "";
  const res = await fetch(url + "/" + qs, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "text/plain" },
    body: body ?? query,
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`ClickHouse error (${res.status}): ${txt.slice(0, 400)}`);
  }
}
