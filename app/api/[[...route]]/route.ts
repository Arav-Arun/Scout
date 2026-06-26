import { NextRequest } from "next/server";
import { runScoutWorkflow } from "@/lib/agent/workflow";
import { ingestFile } from "@/lib/db/ingest";
import { invalidateCatalog } from "@/lib/db/catalog";
import { dbName } from "@/lib/db/clickhouse";
import { getSchemaGraph } from "@/lib/graph/schema-graph";
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
        domain: tableDomain(id),
      }));
      const edges = g.edges.map((e) => ({
        a: e.a, b: e.b, aCol: e.aCol, bCol: e.bCol, label: e.label, source: e.source,
        overlap: e.overlap, verified: e.verified,
      }));
      return Response.json({ nodes, edges });
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

  return new Response("Not Found", { status: 404 });
}
