// route.ts - the app's API surface (catch-all).
//   GET  db-info          the linked connection (or "not connected", which opens the setup tour)
//   GET  graph            the recovered graph, for the viewer
//   POST connect          test a user's ClickHouse and remember it in a sealed cookie
//   POST disconnect       forget it, and drop every cache held for it
//   POST upload           ingest an attached file as a new table in the linked database
//   POST chat             the streamed agent run
//   POST graph/{probe,retrieve,edge}   Graph Lab actions
//
// Every handler that touches the warehouse runs inside withConnection(), which puts the
// visitor's own credentials in scope for the whole call stack (lib/db/connection.ts). There
// is no ambient/default warehouse: no cookie means no data access.

import { NextRequest, NextResponse } from "next/server";
import { runScoutWorkflow } from "@/lib/agent/workflow";
import { getCatalog, invalidateCatalog, forgetCatalog } from "@/lib/db/catalog";
import { pingConnection, releaseClient } from "@/lib/db/clickhouse";
import {
  withConnection, normalizeUrl, displayHost, assertReachableHost, connectionKey,
  type Connection,
} from "@/lib/db/connection";
import { connectionFrom, setConnectionCookie, clearConnectionCookie } from "@/lib/db/session";
import { ingestFile, explainIngestError, MAX_UPLOAD_BYTES, SUPPORTED_EXTENSIONS } from "@/lib/db/ingest";
import { forgetProfiles } from "@/lib/db/profile";
import {
  getSchemaGraph, materializeSchemaGraph, retrieveSubgraph, formatGraphForPrompt, measureOverlap,
  forgetSchemaGraph,
} from "@/lib/graph/schema-graph";
import { addUserEdge, removeUserEdge, editUserEdge } from "@/lib/graph/user-edges";
import { tableDomain, connectionOf, isHubColumn, forgetHeuristics } from "@/lib/graph/relationships";
import type { ChatTurn, ScoutEvent } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 428: the client must link a database before this endpoint means anything. */
const notConnected = () =>
  NextResponse.json(
    { error: "No ClickHouse database is linked.", notConnected: true },
    { status: 428 },
  );

/** Everything a connection's caches hold, released together on disconnect. */
function forgetConnection(conn: Connection): void {
  const key = connectionKey(conn);
  releaseClient(conn);
  forgetCatalog(key);
  forgetSchemaGraph(key);
  forgetProfiles(key);
  forgetHeuristics(key);
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ route?: string[] }> }
) {
  const { route } = await params;
  const path = route?.[0];
  const conn = connectionFrom(_request);

  // What the UI reads on load to decide between the setup tour and the chat.
  if (path === "db-info") {
    if (!conn) return NextResponse.json({ connected: false });
    return NextResponse.json({
      connected: true,
      host: displayHost(conn.url),
      database: conn.database,
      username: conn.username,
    });
  }

  // The recovered schema knowledge graph (nodes = tables, edges = join keys), for the
  // in-app graph viewer. Built from the same getSchemaGraph() the agent's RELATE phase uses.
  if (path === "graph") {
    if (!conn) return notConnected();
    return withConnection(conn, async () => {
      try {
        const g = await getSchemaGraph();
        const nodes = [...g.nodes.entries()].map(([id, n]) => ({
          id,
          rowCount: n.rowCount,
          cols: n.columns.length,
          columns: n.columns, // exposed so the Graph Lab's add-edge form can populate column pickers
          domain: tableDomain(id),
        }));
        const statusOf = (overlap?: number, verified?: boolean) =>
          overlap === undefined ? "unjudged" : verified ? "verified" : "partial";
        // `hub` is derived per schema (relationships.ts) and travels with the edge so the
        // canvas can de-emphasise it without knowing anything about the user's column names.
        const hub = (aCol: string, bCol: string) => isHubColumn(aCol) || isHubColumn(bCol);
        const edges = g.edges.map((e) => ({
          a: e.a, b: e.b, aCol: e.aCol, bCol: e.bCol, label: e.label,
          source: e.source, connection: connectionOf(e.source), hub: hub(e.aCol, e.bCol),
          overlap: e.overlap, verified: e.verified, status: statusOf(e.overlap, e.verified),
        }));
        const dropped = (g.droppedEdges ?? []).map((e) => ({
          a: e.a, b: e.b, aCol: e.aCol, bCol: e.bCol, label: e.label,
          source: e.source, connection: connectionOf(e.source), hub: hub(e.aCol, e.bCol),
          overlap: e.overlap, verified: false, status: "dropped",
        }));
        return NextResponse.json({ nodes, edges, dropped });
      } catch (e) {
        return NextResponse.json({ error: errMsg(e) }, { status: 500 });
      }
    });
  }

  return new Response("Not Found", { status: 404 });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ route?: string[] }> }
) {
  const { route } = await params;
  const path = route?.[0];

  // ── Link a warehouse ───────────────────────────────────────────────────────
  // The last step of the setup tour: validate the details, prove they work against the
  // real server, then seal them into the cookie that makes the link stick.
  if (path === "connect") {
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Bad request" }, { status: 400 });
    }

    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    let conn: Connection;
    try {
      conn = {
        url: normalizeUrl(str(body.host)),
        username: str(body.username) || "default",
        password: typeof body.password === "string" ? body.password : "",
        database: str(body.database) || "default",
      };
      await assertReachableHost(conn.url);
    } catch (e) {
      return NextResponse.json({ error: errMsg(e) }, { status: 400 });
    }

    // Prove the credentials before remembering them, and report back what's in there so the
    // tour's final screen can say something true about the user's own warehouse. The ping may
    // hand back an adjusted connection (see pingConnection) - that's the one we must keep.
    let version: string;
    try {
      const ping = await pingConnection(conn);
      version = ping.version;
      conn = ping.connection;
    } catch (e) {
      return NextResponse.json({ error: friendlyConnectError(e, conn) }, { status: 502 });
    }

    let tables: number;
    try {
      const cat = await withConnection(conn, () => getCatalog());
      tables = cat.tables.length;
    } catch (e) {
      return NextResponse.json({ error: friendlyConnectError(e, conn) }, { status: 502 });
    }

    const response = NextResponse.json({
      connected: true,
      host: displayHost(conn.url),
      database: conn.database,
      username: conn.username,
      version,
      tables,
    });
    setConnectionCookie(response, conn);
    return response;
  }

  // ── Unlink ─────────────────────────────────────────────────────────────────
  if (path === "disconnect") {
    const conn = connectionFrom(request);
    if (conn) forgetConnection(conn);
    const response = NextResponse.json({ connected: false });
    clearConnectionCookie(response);
    return response;
  }

  const conn = connectionFrom(request);
  if (!conn) return notConnected();

  if (path === "chat") {
    let body: { messages?: ChatTurn[] };
    try {
      body = await request.json();
    } catch {
      return new Response("Bad request", { status: 400 });
    }

    const history = Array.isArray(body.messages) ? body.messages : [];

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (e: ScoutEvent) => {
          controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
        };
        // The whole agent run - every phase, every query - executes against this visitor's
        // connection and nothing else.
        await withConnection(conn, async () => {
          try {
            await runScoutWorkflow(history, send);
            send({ type: "done" });
          } catch (e) {
            send({ type: "error", message: errMsg(e) });
            send({ type: "done" });
          } finally {
            controller.close();
          }
        });
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  }

  // ── Attach a file ──────────────────────────────────────────────────────────
  // Data that isn't in the warehouse yet: parsed, typed, and created as a real table in the
  // linked database so the agent can query and join it like anything else.
  if (path === "upload") {
    return withConnection(conn, async () => {
      try {
        const form = await request.formData();
        const file = form.get("file");
        if (!(file instanceof File)) {
          return NextResponse.json({ error: "No file provided" }, { status: 400 });
        }
        if (file.size > MAX_UPLOAD_BYTES) {
          return NextResponse.json(
            { error: `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.` },
            { status: 413 },
          );
        }
        const ext = (file.name.split(".").pop() || "").toLowerCase();
        if (!(SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)) {
          return NextResponse.json(
            { error: `Scout can read ${SUPPORTED_EXTENSIONS.join(", ")} files - "${file.name}" isn't one of those.` },
            { status: 415 },
          );
        }

        const buf = Buffer.from(await file.arrayBuffer());
        const result = await ingestFile(file.name, buf);

        // The warehouse changed - drop the cached catalog so the next question sees it.
        invalidateCatalog();

        // Rebuild the schema graph over the new table (it may join the existing ones) and
        // store it. Best-effort: a read-only user can't write the snapshot, and a failure
        // here must not fail the upload itself.
        try {
          await materializeSchemaGraph();
        } catch {
          // snapshot refresh failed; the in-memory graph is still correct for the next question.
        }

        return NextResponse.json({
          table: result.table,
          rowCount: result.rowCount,
          columns: result.columns.map((c) => ({ name: c.name, type: c.type })),
          alreadyExists: !!result.alreadyExists,
        });
      } catch (e) {
        return NextResponse.json({ error: explainIngestError(e) }, { status: 500 });
      }
    });
  }

  // Graph Lab actions (inspect/test page). Dispatch on the second path segment.
  if (path === "graph") {
    const sub = route?.[1];
    let body: Record<string, unknown> = {};
    try {
      body = await request.json();
    } catch {
      /* probe/retrieve may post an empty body; treat as {} */
    }
    return withConnection(conn, async () => {
      try {
        // Live value-overlap probe for an arbitrary column pair - the exact check the agent runs.
        if (sub === "probe") {
          const { a, aCol, b, bCol } = body as Record<string, string>;
          if (!a || !aCol || !b || !bCol) {
            return NextResponse.json({ error: "a, aCol, b, bCol are required" }, { status: 400 });
          }
          // Validate the identifiers against the catalog before they reach SQL (same as edge below).
          const cat = await getCatalog();
          const has = (t: string, c: string) => cat.tables.find((x) => x.name === t)?.columns.some((x) => x.name === c);
          if (!has(a, aCol) || !has(b, bCol)) {
            return NextResponse.json({ error: "Unknown table or column" }, { status: 400 });
          }
          const measure = await measureOverlap(a, aCol, b, bCol);
          return NextResponse.json({ measure }); // {overlap, sampled, matched} or null if not measurable
        }

        // Test retrieval: what subgraph + JOIN GRAPH prompt the agent would build from these seeds.
        if (sub === "retrieve") {
          const seeds = Array.isArray(body.seeds) ? (body.seeds as string[]) : [];
          const g = await getSchemaGraph();
          const subg = retrieveSubgraph(g, seeds, { maxTables: 8 });
          return NextResponse.json({
            seeds: subg.seeds,
            tables: subg.tables,
            edges: subg.edges.map((e) => ({
              a: e.a, b: e.b, aCol: e.aCol, bCol: e.bCol, label: e.label,
              source: e.source, overlap: e.overlap, verified: e.verified,
            })),
            prompt: formatGraphForPrompt(subg),
          });
        }

        // Add / edit / delete a declared edge. ("inferred" edges are automatic, not editable.)
        if (sub === "edge") {
          const { a, aCol, b, bCol, label, remove, old } = body as Record<string, unknown>;
          const edge = { a: String(a ?? ""), aCol: String(aCol ?? ""), b: String(b ?? ""), bCol: String(bCol ?? "") };
          if (!edge.a || !edge.aCol || !edge.b || !edge.bCol) {
            return NextResponse.json({ error: "a, aCol, b, bCol are required" }, { status: 400 });
          }

          if (remove) {
            await removeUserEdge(edge);
            // Re-materialize the canonical graph so it reflects the deletion. Best-effort.
            try {
              await materializeSchemaGraph();
            } catch {
              /* re-materialization failed; the stored graph still has the old edge until next trigger */
            }
            return NextResponse.json({ ok: true });
          }

          // Validate both columns of the (new) edge really exist before persisting.
          const cat = await getCatalog();
          const colsOf = (t: string) => cat.tables.find((x) => x.name === t)?.columns.map((c) => c.name);
          const aCols = colsOf(edge.a), bCols = colsOf(edge.b);
          if (!aCols) return NextResponse.json({ error: `Unknown table: ${edge.a}` }, { status: 400 });
          if (!bCols) return NextResponse.json({ error: `Unknown table: ${edge.b}` }, { status: 400 });
          if (!aCols.includes(edge.aCol)) return NextResponse.json({ error: `${edge.a} has no column ${edge.aCol}` }, { status: 400 });
          if (!bCols.includes(edge.bCol)) return NextResponse.json({ error: `${edge.b} has no column ${edge.bCol}` }, { status: 400 });
          if (edge.a === edge.b) return NextResponse.json({ error: "An edge must connect two different tables" }, { status: 400 });

          const withLabel = { ...edge, label: typeof label === "string" ? label : undefined };
          // `old` present => edit (tombstone the previous endpoints, then add the new ones); else add.
          if (old && typeof old === "object") {
            const o = old as Record<string, unknown>;
            await editUserEdge({ a: String(o.a), aCol: String(o.aCol), b: String(o.b), bCol: String(o.bCol) }, withLabel);
          } else {
            await addUserEdge(withLabel);
          }
          const measure = await measureOverlap(edge.a, edge.aCol, edge.b, edge.bCol); // immediate feedback
          // Re-materialize the canonical graph so it reflects the add/edit. Best-effort.
          try {
            await materializeSchemaGraph();
          } catch {
            /* re-materialization failed; the change is in scout_user_edges and lands on next trigger */
          }
          return NextResponse.json({ ok: true, measure });
        }

        return new Response("Not Found", { status: 404 });
      } catch (e) {
        return NextResponse.json({ error: errMsg(e) }, { status: 500 });
      }
    });
  }

  return new Response("Not Found", { status: 404 });
}

/**
 * ClickHouse's connection failures are terse and often network-level. Map the handful the
 * setup tour actually hits onto something a first-time user can act on, and pass anything
 * else through unchanged rather than guessing.
 */
function friendlyConnectError(e: unknown, conn: Connection): string {
  const msg = errMsg(e);
  if (/authentication failed|password is incorrect|wrong password|access denied for user/i.test(msg)) {
    return `ClickHouse rejected the username or password for "${conn.username}". Check both and try again.`;
  }
  if (/unknown database|database .* (does ?n[o']t|doesn't) exist/i.test(msg)) {
    return `The database "${conn.database}" doesn't exist on that server. Check the name (it's case-sensitive).`;
  }
  if (/enotfound|eai_again|getaddrinfo/i.test(msg)) {
    return `Couldn't resolve ${displayHost(conn.url)}. Check the host address.`;
  }
  if (/econnrefused|ehostunreach|enetunreach/i.test(msg)) {
    return `Nothing answered at ${displayHost(conn.url)}. Check the port - ClickHouse Cloud uses 8443 for HTTPS.`;
  }
  if (/timeout|etimedout|timed out/i.test(msg)) {
    return `${displayHost(conn.url)} didn't respond in time. If the service was idle it may still be waking up - try again in a moment.`;
  }
  if (/certificate|self.signed|ssl|tls/i.test(msg)) {
    return `The TLS handshake with ${displayHost(conn.url)} failed: ${msg}`;
  }
  return `Couldn't reach ${displayHost(conn.url)}: ${msg}`;
}
