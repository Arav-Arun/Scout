"use client";

// ─────────────────────────────────────────────────────────────────────────────
// GRAPH RAG LAB  ·  app/graph/page.tsx
//
// A regular in-app page for inspecting and testing the Graph RAG layer directly,
// outside an agent run. Three surfaces:
//   • Inspect  — every recovered edge with its source, live value-overlap and verdict
//                (verified / partial / dropped phantom), plus the dropped phantoms.
//   • Test     — pick seed tables and see the exact subgraph + "JOIN GRAPH" prompt the
//                agent's RELATE phase would build; or probe any two columns for overlap.
//   • Edges    — declare a relationship that ISN'T a foreign key (two related columns the
//                automatic inference misses). It is verified, persisted, and merged back
//                into the graph immediately.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useState } from "react";

type Source = "curated" | "inferred" | "user";
type Status = "verified" | "partial" | "dropped" | "unjudged";

interface GNode { id: string; rowCount: number; cols: number; columns: string[]; domain: string }
interface GEdge {
  a: string; b: string; aCol: string; bCol: string; label: string;
  source: Source; overlap?: number; verified?: boolean; status: Status;
}
interface GraphData { nodes: GNode[]; edges: GEdge[]; dropped: GEdge[] }

const STATUS_STYLE: Record<Status, { label: string; cls: string }> = {
  verified: { label: "verified", cls: "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400" },
  partial: { label: "partial", cls: "bg-amber-500/12 text-amber-600 dark:text-amber-400" },
  dropped: { label: "dropped", cls: "bg-red-500/12 text-red-600 dark:text-red-400" },
  unjudged: { label: "unjudged", cls: "bg-slate-500/12 text-ink-faint" },
};
const SOURCE_STYLE: Record<Source, string> = {
  curated: "bg-brand/12 text-brand",
  inferred: "bg-slate-500/12 text-ink-faint",
  user: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
};

const pct = (o?: number) => (o === undefined || o === null ? "—" : `${Math.round(o * 100)}%`);

export default function GraphLabPage() {
  const [data, setData] = useState<GraphData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<"inspect" | "test" | "edges">("inspect");

  const load = useCallback(() => {
    fetch("/api/graph")
      .then((r) => r.json())
      .then((d) => (d.error ? setErr(d.error) : (setData(d), setErr(null))))
      .catch((e) => setErr(String(e)));
  }, []);
  useEffect(() => load(), [load]);

  const stats = useMemo(() => {
    if (!data) return null;
    const c = (s: Status) => data.edges.filter((e) => e.status === s).length;
    return {
      tables: data.nodes.length,
      verified: c("verified"),
      partial: c("partial"),
      recovered: data.edges.filter((e) => e.aCol !== e.bCol && e.status !== "dropped").length,
      user: data.edges.filter((e) => e.source === "user").length,
      dropped: data.dropped.length,
    };
  }, [data]);

  return (
    <main className="min-h-[100dvh] bg-canvas text-ink">
      <div className="mx-auto max-w-6xl px-5 py-6 md:px-8 md:py-8">
        {/* header */}
        <div className="flex items-center gap-4">
          <a href="/" className="rounded-xl px-2.5 py-1.5 text-[13px] font-semibold text-ink-soft transition-colors hover:bg-black/5 hover:text-ink dark:hover:bg-white/10">
            ← Back to Scout
          </a>
          <div className="h-5 w-px bg-line" />
          <div>
            <h1 className="text-[19px] font-extrabold leading-tight">Graph RAG Lab</h1>
            <p className="text-[12.5px] text-ink-faint">
              Inspect and test the schema knowledge graph the agent uses to recover and verify joins.
            </p>
          </div>
        </div>

        {err && <div className="mt-6 rounded-xl border border-red-500/30 bg-red-500/5 p-4 text-[13px] text-red-500">Couldn’t load the graph: {err}</div>}
        {!err && !data && <div className="mt-10 text-center text-[13px] text-ink-faint">Building the graph…</div>}

        {data && stats && (
          <>
            {/* summary */}
            <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <Stat label="Tables" value={stats.tables} />
              <Stat label="Verified keys" value={stats.verified} tone="emerald" />
              <Stat label="Renamed recovered" value={stats.recovered} tone="brand" />
              <Stat label="Partial (lossy)" value={stats.partial} tone="amber" />
              <Stat label="Phantoms dropped" value={stats.dropped} tone="red" />
              <Stat label="User-added" value={stats.user} tone="violet" />
            </div>

            {/* tabs */}
            <div className="mt-7 flex gap-1 border-b border-line">
              {(["inspect", "test", "edges"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`-mb-px border-b-2 px-4 py-2.5 text-[13.5px] font-semibold capitalize transition-colors ${
                    tab === t ? "border-brand text-brand" : "border-transparent text-ink-faint hover:text-ink-soft"
                  }`}
                >
                  {t === "edges" ? "Add edge" : t}
                </button>
              ))}
            </div>

            <div className="mt-5">
              {tab === "inspect" && <InspectTab data={data} />}
              {tab === "test" && <TestTab data={data} />}
              {tab === "edges" && <EdgesTab data={data} onChanged={load} />}
            </div>
          </>
        )}
      </div>
    </main>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  const color =
    tone === "emerald" ? "text-emerald-600 dark:text-emerald-400"
    : tone === "amber" ? "text-amber-600 dark:text-amber-400"
    : tone === "red" ? "text-red-600 dark:text-red-400"
    : tone === "violet" ? "text-violet-600 dark:text-violet-400"
    : tone === "brand" ? "text-brand"
    : "text-ink";
  return (
    <div className="rounded-xl border border-line bg-black/[0.015] px-3.5 py-3 dark:bg-white/[0.02]">
      <div className={`text-[22px] font-extrabold leading-none ${color}`}>{value}</div>
      <div className="mt-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-faint">{label}</div>
    </div>
  );
}

// ── Inspect ───────────────────────────────────────────────────────────────────
function InspectTab({ data }: { data: GraphData }) {
  const [q, setQ] = useState("");
  const [src, setSrc] = useState<"all" | Source>("all");
  const [showDropped, setShowDropped] = useState(false);

  const rows = useMemo(() => {
    const all = showDropped ? [...data.edges, ...data.dropped] : data.edges;
    const needle = q.trim().toLowerCase();
    return all
      .filter((e) => src === "all" || e.source === src)
      .filter((e) =>
        !needle ||
        `${e.a}.${e.aCol} ${e.b}.${e.bCol} ${e.label}`.toLowerCase().includes(needle))
      .sort((x, y) => (y.overlap ?? -1) - (x.overlap ?? -1));
  }, [data, q, src, showDropped]);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2.5">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter by table, column or label…"
          className="h-9 flex-1 min-w-[200px] rounded-lg border border-line bg-transparent px-3 text-[13px] outline-none focus:border-brand"
        />
        <select value={src} onChange={(e) => setSrc(e.target.value as typeof src)}
          className="h-9 rounded-lg border border-line bg-transparent px-2.5 text-[13px] outline-none focus:border-brand">
          <option value="all">all sources</option>
          <option value="curated">curated</option>
          <option value="inferred">inferred</option>
          <option value="user">user</option>
        </select>
        <label className="flex items-center gap-1.5 text-[12.5px] text-ink-soft">
          <input type="checkbox" checked={showDropped} onChange={(e) => setShowDropped(e.target.checked)} />
          show dropped phantoms
        </label>
      </div>

      <div className="mt-4 overflow-x-auto rounded-xl border border-line">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="border-b border-line bg-black/[0.02] text-left text-ink-faint dark:bg-white/[0.03]">
              <th className="px-3 py-2.5 font-semibold">Join key</th>
              <th className="px-3 py-2.5 font-semibold">Relationship</th>
              <th className="px-3 py-2.5 font-semibold">Source</th>
              <th className="px-3 py-2.5 font-semibold text-right">Overlap</th>
              <th className="px-3 py-2.5 font-semibold">Verdict</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e, i) => (
              <tr key={i} className="border-b border-line/60 last:border-0">
                <td className="px-3 py-2 font-mono text-[11.5px] text-ink">
                  {e.a}.<b>{e.aCol}</b> = {e.b}.<b>{e.bCol}</b>
                </td>
                <td className="px-3 py-2 text-ink-soft">{e.label}</td>
                <td className="px-3 py-2"><span className={`rounded px-1.5 py-0.5 text-[10.5px] font-semibold ${SOURCE_STYLE[e.source]}`}>{e.source}</span></td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-ink-soft">{pct(e.overlap)}</td>
                <td className="px-3 py-2"><span className={`rounded px-1.5 py-0.5 text-[10.5px] font-semibold ${STATUS_STYLE[e.status].cls}`}>{STATUS_STYLE[e.status].label}</span></td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={5} className="px-3 py-8 text-center text-ink-faint">No edges match.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="mt-2.5 text-[11.5px] text-ink-faint">
        Overlap is the live value-overlap probe (sampled). “verified” ≥ 50% · “partial” = lossy join · “dropped” = phantom (0% real overlap, never traversed).
      </p>
    </div>
  );
}

// ── Test ──────────────────────────────────────────────────────────────────────
function TestTab({ data }: { data: GraphData }) {
  const tableNames = useMemo(() => data.nodes.map((n) => n.id).sort(), [data]);
  const colsOf = useCallback((t: string) => data.nodes.find((n) => n.id === t)?.columns ?? [], [data]);

  // retrieval
  const [seeds, setSeeds] = useState<string[]>([]);
  const [retrieval, setRetrieval] = useState<{ tables: string[]; edges: GEdge[]; prompt: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const toggleSeed = (t: string) => setSeeds((s) => (s.includes(t) ? s.filter((x) => x !== t) : [...s, t]));
  const runRetrieve = async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/graph/retrieve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ seeds }) }).then((x) => x.json());
      setRetrieval(r);
    } finally { setBusy(false); }
  };

  // probe
  const [pa, setPa] = useState(tableNames[0] ?? "");
  const [pac, setPac] = useState("");
  const [pb, setPb] = useState(tableNames[1] ?? "");
  const [pbc, setPbc] = useState("");
  const [probe, setProbe] = useState<number | null | "loading" | undefined>(undefined);
  const runProbe = async () => {
    setProbe("loading");
    const r = await fetch("/api/graph/probe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ a: pa, aCol: pac, b: pb, bCol: pbc }) }).then((x) => x.json());
    setProbe(r.overlap);
  };

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {/* retrieval */}
      <section className="rounded-xl border border-line p-4">
        <h2 className="text-[14px] font-bold">Retrieve a subgraph</h2>
        <p className="mt-1 text-[12px] text-ink-faint">Pick the tables a question touches. This runs the same retrieval the agent’s RELATE phase uses and shows the exact JOIN GRAPH it would feed the analyst.</p>
        <div className="mt-3 flex max-h-40 flex-wrap gap-1.5 overflow-y-auto rounded-lg border border-line/70 p-2">
          {tableNames.map((t) => (
            <button key={t} onClick={() => toggleSeed(t)}
              className={`rounded-full px-2.5 py-1 text-[11.5px] font-medium transition-colors ${seeds.includes(t) ? "bg-brand text-white" : "bg-black/5 text-ink-soft hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/15"}`}>
              {t}
            </button>
          ))}
        </div>
        <button onClick={runRetrieve} disabled={busy || seeds.length === 0}
          className="mt-3 rounded-lg bg-brand px-3.5 py-1.5 text-[13px] font-semibold text-white disabled:opacity-40">
          {busy ? "Retrieving…" : `Retrieve (${seeds.length})`}
        </button>
        {retrieval && (
          <div className="mt-4">
            <div className="text-[12px] text-ink-soft"><b>Tables pulled in:</b> {retrieval.tables.join(", ")}</div>
            <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-black/[0.04] p-3 font-mono text-[11px] leading-relaxed text-ink-soft dark:bg-white/[0.04]">{retrieval.prompt}</pre>
          </div>
        )}
      </section>

      {/* probe */}
      <section className="rounded-xl border border-line p-4">
        <h2 className="text-[14px] font-bold">Probe a join</h2>
        <p className="mt-1 text-[12px] text-ink-faint">Measure the real value overlap between any two columns — the verification the graph runs before trusting a join.</p>
        <div className="mt-3 space-y-2.5">
          <ColPicker label="Left" table={pa} col={pac} tables={tableNames} cols={colsOf(pa)} onTable={(t) => { setPa(t); setPac(""); }} onCol={setPac} />
          <ColPicker label="Right" table={pb} col={pbc} tables={tableNames} cols={colsOf(pb)} onTable={(t) => { setPb(t); setPbc(""); }} onCol={setPbc} />
        </div>
        <button onClick={runProbe} disabled={!pa || !pac || !pb || !pbc || probe === "loading"}
          className="mt-3 rounded-lg bg-brand px-3.5 py-1.5 text-[13px] font-semibold text-white disabled:opacity-40">
          {probe === "loading" ? "Measuring…" : "Measure overlap"}
        </button>
        {probe !== undefined && probe !== "loading" && (
          <div className="mt-3 text-[13px]">
            {probe === null
              ? <span className="text-ink-faint">No values to measure (empty column).</span>
              : <>Value overlap: <b className={probe >= 0.5 ? "text-emerald-600 dark:text-emerald-400" : probe > 0 ? "text-amber-600 dark:text-amber-400" : "text-red-600 dark:text-red-400"}>{Math.round(probe * 100)}%</b>
                  <span className="ml-2 text-ink-faint">{probe >= 0.5 ? "real join key" : probe > 0 ? "lossy / partial" : "phantom — no shared values"}</span></>}
          </div>
        )}
      </section>
    </div>
  );
}

function ColPicker({ label, table, col, tables, cols, onTable, onCol }: {
  label: string; table: string; col: string; tables: string[]; cols: string[];
  onTable: (t: string) => void; onCol: (c: string) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-10 shrink-0 text-[11.5px] font-semibold text-ink-faint">{label}</span>
      <select value={table} onChange={(e) => onTable(e.target.value)}
        className="h-8 flex-1 rounded-lg border border-line bg-transparent px-2 text-[12.5px] outline-none focus:border-brand">
        {tables.map((t) => <option key={t} value={t}>{t}</option>)}
      </select>
      <select value={col} onChange={(e) => onCol(e.target.value)}
        className="h-8 flex-1 rounded-lg border border-line bg-transparent px-2 text-[12.5px] outline-none focus:border-brand">
        <option value="">column…</option>
        {cols.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
    </div>
  );
}

// ── Add edge ────────────────────────────────────────────────────────────────--
function EdgesTab({ data, onChanged }: { data: GraphData; onChanged: () => void }) {
  const tableNames = useMemo(() => data.nodes.map((n) => n.id).sort(), [data]);
  const colsOf = useCallback((t: string) => data.nodes.find((n) => n.id === t)?.columns ?? [], [data]);
  const userEdges = useMemo(() => data.edges.filter((e) => e.source === "user"), [data]);

  const [a, setA] = useState(tableNames[0] ?? "");
  const [aCol, setACol] = useState("");
  const [b, setB] = useState(tableNames[1] ?? "");
  const [bCol, setBCol] = useState("");
  const [label, setLabel] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/graph/edge", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ a, aCol, b, bCol, label }) }).then((x) => x.json());
      if (r.error) { setMsg({ ok: false, text: r.error }); return; }
      const ov = r.overlap === null || r.overlap === undefined ? "not measurable" : `${Math.round(r.overlap * 100)}% live overlap`;
      setMsg({ ok: true, text: `Edge added and verified (${ov}). It’s now part of the graph.` });
      setLabel("");
      onChanged();
    } catch (e) { setMsg({ ok: false, text: String(e) }); }
    finally { setBusy(false); }
  };

  const remove = async (e: GEdge) => {
    await fetch("/api/graph/edge", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ a: e.a, aCol: e.aCol, b: e.b, bCol: e.bCol, remove: true }) });
    onChanged();
  };

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <section className="rounded-xl border border-line p-4">
        <h2 className="text-[14px] font-bold">Declare a relationship</h2>
        <p className="mt-1 text-[12px] text-ink-faint">Not every join is a foreign key. Add an edge between two related columns the automatic inference misses — it’s verified against live data, persisted, and merged into the graph right away.</p>
        <div className="mt-3 space-y-2.5">
          <ColPicker label="From" table={a} col={aCol} tables={tableNames} cols={colsOf(a)} onTable={(t) => { setA(t); setACol(""); }} onCol={setACol} />
          <ColPicker label="To" table={b} col={bCol} tables={tableNames} cols={colsOf(b)} onTable={(t) => { setB(t); setBCol(""); }} onCol={setBCol} />
          <div className="flex items-center gap-2">
            <span className="w-10 shrink-0 text-[11.5px] font-semibold text-ink-faint">Label</span>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="optional, e.g. “relates to”"
              className="h-8 flex-1 rounded-lg border border-line bg-transparent px-2.5 text-[12.5px] outline-none focus:border-brand" />
          </div>
        </div>
        <button onClick={submit} disabled={busy || !a || !aCol || !b || !bCol}
          className="mt-3 rounded-lg bg-brand px-3.5 py-1.5 text-[13px] font-semibold text-white disabled:opacity-40">
          {busy ? "Adding…" : "Add edge"}
        </button>
        {msg && <div className={`mt-3 rounded-lg px-3 py-2 text-[12.5px] ${msg.ok ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" : "bg-red-500/10 text-red-600"}`}>{msg.text}</div>}
      </section>

      <section className="rounded-xl border border-line p-4">
        <h2 className="text-[14px] font-bold">User-added edges <span className="text-ink-faint">({userEdges.length})</span></h2>
        {userEdges.length === 0
          ? <p className="mt-2 text-[12.5px] text-ink-faint">None yet. Edges you declare appear here and in Inspect, tagged <span className="rounded px-1 py-0.5 text-[10.5px] font-semibold bg-violet-500/15 text-violet-600 dark:text-violet-400">user</span>.</p>
          : <ul className="mt-3 space-y-2">
              {userEdges.map((e, i) => (
                <li key={i} className="flex items-center justify-between gap-3 rounded-lg border border-line/70 px-3 py-2">
                  <div className="min-w-0">
                    <div className="font-mono text-[11.5px] text-ink">{e.a}.{e.aCol} = {e.b}.{e.bCol}</div>
                    <div className="text-[11px] text-ink-faint">{e.label} · {pct(e.overlap)} overlap</div>
                  </div>
                  <button onClick={() => remove(e)} className="shrink-0 rounded-md px-2 py-1 text-[11.5px] font-semibold text-red-500 hover:bg-red-500/10">Remove</button>
                </li>
              ))}
            </ul>}
      </section>
    </div>
  );
}
