// route.ts — the app's API surface (catch-all). GET: db-info, graph (the recovered graph
// for the viewer). POST: chat (streamed agent run), upload (ingest a file), and the Graph
// Lab actions graph/probe, graph/retrieve, graph/edge.

import { NextRequest } from "next/server";
import { runScoutWorkflow } from "@/lib/agent/workflow";
import { ingestFile } from "@/lib/db/ingest";
import { invalidateCatalog, getCatalog } from "@/lib/db/catalog";
import { dbName } from "@/lib/db/clickhouse";
import {
  getSchemaGraph, invalidateSchemaGraph, retrieveSubgraph, formatGraphForPrompt, measureOverlap,
} from "@/lib/graph/schema-graph";
import { persistSchemaGraph } from "@/lib/graph/persist";
import { addUserEdge, removeUserEdge, editUserEdge } from "@/lib/graph/user-edges";
import { tableDomain } from "@/lib/graph/relationships";
import type { ChatTurn, ScoutEvent } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ route?: string[] }> }
) {
  const { route } = await params;
  const path = route?.[0];

  if (path === "db-info") {
    const host = process.env.CLICKHOUSE_HOST || "";
    const database = dbName();

    // Clean host (strip username/password/protocols for display).
    let cleanHost = host;
    try {
      const url = new URL(host);
      cleanHost = url.hostname + (url.port ? `:${url.port}` : "");
    } catch {
      cleanHost = host.replace(/^https?:\/\//, "");
    }

    return Response.json({ host: cleanHost, database });
  }

  // The recovered schema knowledge graph (nodes = tables, edges = join keys), for the
  // in-app graph viewer. Built from the same getSchemaGraph() the agent's RELATE phase uses.
  if (path === "graph") {
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
      const edges = g.edges.map((e) => ({
        a: e.a, b: e.b, aCol: e.aCol, bCol: e.bCol, label: e.label, source: e.source,
        overlap: e.overlap, verified: e.verified, status: statusOf(e.overlap, e.verified),
      }));
      const dropped = (g.droppedEdges ?? []).map((e) => ({
        a: e.a, b: e.b, aCol: e.aCol, bCol: e.bCol, label: e.label, source: e.source,
        overlap: e.overlap, verified: false, status: "dropped",
      }));
      return Response.json({ nodes, edges, dropped });
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
    }
  }

  return new Response("Not Found", { status: 404 });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ route?: string[] }> }
) {
  const { route } = await params;
  const path = route?.[0];

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
        try {
          await runScoutWorkflow(history, send);
          send({ type: "done" });
        } catch (e) {
          send({ type: "error", message: e instanceof Error ? e.message : String(e) });
          send({ type: "done" });
        } finally {
          controller.close();
        }
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

  if (path === "upload") {
    try {
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        return Response.json({ error: "No file provided" }, { status: 400 });
      }

      const buf = Buffer.from(await file.arrayBuffer());
      const result = await ingestFile(file.name, buf);

      // The warehouse changed - drop the cached catalog so the next question sees it.
      invalidateCatalog();

      // Re-snapshot the schema graph so scout_schema_graph_edges/nodes reflect the new table.
      // Best-effort: a write failure here must not fail the upload itself.
      try {
        await persistSchemaGraph(await getSchemaGraph());
      } catch {
        // snapshot refresh failed; the in-memory graph is still correct for the next question.
      }

      return Response.json({
        table: result.table,
        rowCount: result.rowCount,
        columns: result.columns.map((c) => ({ name: c.name, type: c.type })),
        alreadyExists: !!result.alreadyExists,
      });
    } catch (e) {
      return Response.json(
        { error: e instanceof Error ? e.message : String(e) },
        { status: 500 },
      );
    }
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
    try {
      // Live value-overlap probe for an arbitrary column pair — the exact check the agent runs.
      if (sub === "probe") {
        const { a, aCol, b, bCol } = body as Record<string, string>;
        if (!a || !aCol || !b || !bCol) {
          return Response.json({ error: "a, aCol, b, bCol are required" }, { status: 400 });
        }
        const measure = await measureOverlap(a, aCol, b, bCol);
        return Response.json({ measure }); // {overlap, sampled, matched} or null if not measurable
      }

      // Test retrieval: what subgraph + JOIN GRAPH prompt the agent would build from these seeds.
      if (sub === "retrieve") {
        const seeds = Array.isArray(body.seeds) ? (body.seeds as string[]) : [];
        const g = await getSchemaGraph();
        const subg = retrieveSubgraph(g, seeds, { maxTables: 8 });
        return Response.json({
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
          return Response.json({ error: "a, aCol, b, bCol are required" }, { status: 400 });
        }

        if (remove) {
          await removeUserEdge(edge);
          invalidateSchemaGraph();
          // Re-snapshot so the persisted graph reflects the deletion too. Best-effort.
          try {
            await persistSchemaGraph(await getSchemaGraph());
          } catch {
            /* snapshot refresh failed; the in-memory graph already reflects the deletion */
          }
          return Response.json({ ok: true });
        }

        // Validate both columns of the (new) edge really exist before persisting.
        const cat = await getCatalog();
        const colsOf = (t: string) => cat.tables.find((x) => x.name === t)?.columns.map((c) => c.name);
        const aCols = colsOf(edge.a), bCols = colsOf(edge.b);
        if (!aCols) return Response.json({ error: `Unknown table: ${edge.a}` }, { status: 400 });
        if (!bCols) return Response.json({ error: `Unknown table: ${edge.b}` }, { status: 400 });
        if (!aCols.includes(edge.aCol)) return Response.json({ error: `${edge.a} has no column ${edge.aCol}` }, { status: 400 });
        if (!bCols.includes(edge.bCol)) return Response.json({ error: `${edge.b} has no column ${edge.bCol}` }, { status: 400 });
        if (edge.a === edge.b) return Response.json({ error: "An edge must connect two different tables" }, { status: 400 });

        const withLabel = { ...edge, label: typeof label === "string" ? label : undefined };
        // `old` present => edit (tombstone the previous endpoints, then add the new ones); else add.
        if (old && typeof old === "object") {
          const o = old as Record<string, unknown>;
          await editUserEdge({ a: String(o.a), aCol: String(o.aCol), b: String(o.b), bCol: String(o.bCol) }, withLabel);
        } else {
          await addUserEdge(withLabel);
        }
        invalidateSchemaGraph();
        const measure = await measureOverlap(edge.a, edge.aCol, edge.b, edge.bCol); // immediate feedback
        // Re-snapshot so the persisted graph reflects the change. Best-effort.
        try {
          await persistSchemaGraph(await getSchemaGraph());
        } catch {
          /* snapshot refresh failed; the in-memory graph already has the change */
        }
        return Response.json({ ok: true, measure });
      }

      return new Response("Not Found", { status: 404 });
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
    }
  }

  return new Response("Not Found", { status: 404 });
}
