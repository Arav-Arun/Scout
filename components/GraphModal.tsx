// ─────────────────────────────────────────────────────────────────────────────
// GRAPH VIEW  ·  components/GraphModal.tsx
//
// Full-screen in-app viewer for the schema knowledge graph the Graph RAG layer recovers
// (the same data the agent's RELATE phase walks). Fetches /api/graph and draws tables as
// nodes, join keys as edges, grouped + coloured by sub-domain. Hover a table to trace
// exactly which tables it joins to. Pure SVG, deterministic layout - no graph library.
//
// Renders as a solid full-screen overlay (white in light mode, neutral grey in dark) with
// a "Back" control top-left. It is a sibling overlay portaled to <body>, so the chat
// transcript and any generated dashboards stay mounted underneath and are untouched - the
// view returns to exactly where it left off when closed.
// ─────────────────────────────────────────────────────────────────────────────
"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeftIcon } from "./icons";

interface GNode { id: string; rowCount: number; cols: number; domain: string }
interface GEdge { a: string; b: string; aCol: string; bCol: string; label: string; source: "curated" | "inferred"; overlap?: number; verified?: boolean }
interface GraphData { nodes: GNode[]; edges: GEdge[] }

const DOMAIN_COLORS: Record<string, string> = {
  "Customer": "#2f6bff", "Accounts & cards": "#06b6d4", "Payments & rewards": "#22c55e",
  "Lending": "#f59e0b", "Risk & compliance": "#ef4444", "Merchants": "#8b5cf6",
  "Engagement": "#ec4899", "Branch & staff": "#14b8a6", "Retail / other": "#64748b",
};
const DOMAIN_ORDER = ["Customer", "Accounts & cards", "Payments & rewards", "Lending", "Risk & compliance", "Merchants", "Engagement", "Branch & staff", "Retail / other"];

const W = 920, H = 660, CX = 460, CY = 322, R = 212;
const HUB = new Set(["customer_id", "city"]); // de-emphasised so the hub doesn't hairball

export default function GraphModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [data, setData] = useState<GraphData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  // Portal to <body>: the chat panel's backdrop-filter ancestor would otherwise become
  // the containing block for position:fixed and trap this overlay inside the left panel.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open || data) return;
    fetch("/api/graph").then((r) => r.json()).then((d) => (d.error ? setErr(d.error) : setData(d))).catch((e) => setErr(String(e)));
  }, [open, data]);

  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);

  // Deterministic grouped-radial layout: one cluster per sub-domain around the canvas,
  // the customers hub pinned at the centre.
  const pos = useMemo(() => {
    if (!data) return null;
    const m = new Map<string, { x: number; y: number }>();
    const domains = DOMAIN_ORDER.filter((d) => data.nodes.some((n) => n.domain === d));
    domains.forEach((dom, di) => {
      const ang = -Math.PI / 2 + (2 * Math.PI * di) / domains.length;
      const cc = { x: CX + R * Math.cos(ang), y: CY + R * Math.sin(ang) };
      const ns = data.nodes.filter((n) => n.domain === dom && n.id !== "customers");
      const k = ns.length;
      ns.forEach((n, j) => {
        if (k === 1) { m.set(n.id, cc); return; }
        const rk = Math.min(66, 16 + 9 * k);
        const a2 = ang + (2 * Math.PI * j) / k;
        m.set(n.id, { x: cc.x + rk * Math.cos(a2), y: cc.y + rk * Math.sin(a2) });
      });
    });
    m.set("customers", { x: CX, y: CY });
    return m;
  }, [data]);

  if (!open || !mounted) return null;

  const neighbors = new Set<string>();
  if (hover && data) for (const e of data.edges) { if (e.a === hover) neighbors.add(e.b); if (e.b === hover) neighbors.add(e.a); }

  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col bg-white dark:bg-[#222224] animate-fade-up">
      {/* header — back-to-home control top-left */}
      <div className="flex items-center gap-4 px-4 md:px-6 py-3.5 border-b border-line/60 shrink-0">
        <button
          onClick={onClose}
          title="Back to Scout"
          className="group flex items-center gap-2 rounded-xl px-2.5 py-1.5 text-[13px] font-semibold text-ink-soft transition-colors hover:bg-black/5 dark:hover:bg-white/10 hover:text-ink"
        >
          <ArrowLeftIcon className="h-4 w-4 transition-transform group-hover:-translate-x-0.5" />
          Back
        </button>
        <div className="h-6 w-px bg-line/70" />
        <div className="min-w-0">
          <div className="text-[15px] font-bold text-ink leading-tight">Schema Knowledge Graph</div>
          <div className="text-[11.5px] text-ink-faint mt-0.5 truncate">
            {data
              ? `${data.nodes.length} tables · ${data.edges.length} relationships (${data.edges.filter((e) => e.verified).length} verified against live data)`
              : "Loading…"}
          </div>
        </div>
      </div>

      {/* body — graph on the left, legend panel on the right */}
      <div className="flex-1 min-h-0 flex">
        {/* graph — fills the remaining space */}
        <div className="relative flex-1 min-h-0 flex items-center justify-center px-2 md:px-6 py-2">
        {err && <div className="p-10 text-center text-[13px] text-red-500">Couldn’t load the graph: {err}</div>}
        {!err && !data && <div className="p-16 text-center text-[13px] text-ink-faint">Building the graph…</div>}
        {data && pos && (
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" className="h-full w-full">
              {data.edges.map((e, i) => {
                const pa = pos.get(e.a), pb = pos.get(e.b);
                if (!pa || !pb) return null;
                const hub = HUB.has(e.aCol) || HUB.has(e.bCol);
                const inc = hover && (e.a === hover || e.b === hover);
                const partial = e.verified === false; // measured against live data, but low overlap
                let stroke = "rgba(148,163,184,0.28)", w = 1, op = 1;
                let dash: string | undefined = e.source === "inferred" ? "3 3" : undefined;
                if (hub) { stroke = "rgba(148,163,184,0.12)"; w = 0.6; }
                else if (partial) { stroke = "rgba(245,158,11,0.6)"; w = 1; dash = "4 3"; }   // amber = lossy join
                else if (e.verified) { stroke = "rgba(47,107,255,0.5)"; w = 1.25; dash = undefined; } // verified join key
                else if (e.source === "curated") { stroke = "rgba(47,107,255,0.4)"; w = 1.1; }
                if (hover) { if (inc) { stroke = partial ? "#f59e0b" : "#2f6bff"; w = 1.8; dash = partial ? "4 3" : undefined; } else { op = 0.06; } }
                const pct = e.overlap !== undefined ? ` · ${Math.round(e.overlap * 100)}% overlap` : "";
                return (
                  <line key={i} x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y} stroke={stroke} strokeWidth={w} strokeDasharray={dash} opacity={op}>
                    <title>{`${e.a}.${e.aCol} = ${e.b}.${e.bCol}${pct}`}</title>
                  </line>
                );
              })}
              {data.nodes.map((n) => {
                const p = pos.get(n.id);
                if (!p) return null;
                const color = DOMAIN_COLORS[n.domain] || "#64748b";
                const r = 5 + Math.min(11, Math.log10(n.rowCount + 10) * 2.6);
                const dim = hover && hover !== n.id && !neighbors.has(n.id);
                const showLabel = !hover || hover === n.id || neighbors.has(n.id) || n.rowCount > 500000;
                return (
                  <g key={n.id} opacity={dim ? 0.22 : 1} onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)} style={{ cursor: "pointer" }}>
                    <circle cx={p.x} cy={p.y} r={r} fill={color} stroke={hover === n.id ? "#fff" : "rgba(255,255,255,0.55)"} strokeWidth={hover === n.id ? 2 : 1} />
                    {showLabel && (
                      <text x={p.x} y={p.y + r + 9} textAnchor="middle" fontSize={hover === n.id ? 9.5 : 7.5} fontWeight={hover === n.id ? 700 : 500} fill="currentColor" className="text-ink-soft" style={{ pointerEvents: "none" }}>{n.id}</text>
                    )}
                  </g>
                );
              })}
            </svg>
          )}
        </div>

        {data && (
          <aside className="w-56 md:w-64 shrink-0 overflow-y-auto border-l border-line/60 bg-black/[0.015] px-5 py-5 flex flex-col gap-5 dark:bg-white/[0.02]">
            <div>
              <div className="mb-3 text-[11px] font-bold uppercase tracking-wider text-ink-faint">Sub-domains</div>
              <div className="flex flex-col gap-2.5">
                {DOMAIN_ORDER.filter((d) => data.nodes.some((n) => n.domain === d)).map((d) => (
                  <span key={d} className="flex items-center gap-2.5 text-[12.5px] font-medium text-ink-soft">
                    <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: DOMAIN_COLORS[d] }} />
                    {d}
                  </span>
                ))}
              </div>
            </div>

            <div className="border-t border-line/50 pt-4">
              <div className="mb-3 text-[11px] font-bold uppercase tracking-wider text-ink-faint">Relationships</div>
              <div className="flex flex-col gap-2.5 text-[12.5px] font-medium text-ink-soft">
                <span className="flex items-center gap-2.5"><span className="inline-block w-6 border-t-2" style={{ borderColor: "rgba(47,107,255,0.7)" }} />verified join</span>
                <span className="flex items-center gap-2.5"><span className="inline-block w-6 border-t-2 border-dashed" style={{ borderColor: "rgba(245,158,11,0.85)" }} />partial overlap</span>
              </div>
            </div>

            <div className="mt-auto rounded-xl border border-line/40 bg-black/[0.03] px-3 py-2.5 text-[11.5px] leading-relaxed text-ink-faint dark:bg-white/[0.04]">
              Hover a table to trace its joins; hover an edge for its live key overlap. Join keys are verified against the current data, and phantom edges (no real overlap) are dropped.
            </div>
          </aside>
        )}
      </div>
    </div>,
    document.body,
  );
}
