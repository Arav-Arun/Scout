"use client";

// GraphCanvas — pure-SVG view of the schema knowledge graph: tables are nodes,
// recovered join keys are edges, grouped and coloured by sub-domain. Hover a table
// to trace its joins. Deterministic radial layout, no graph library.

import { useMemo, useState } from "react";

interface GNode { id: string; rowCount: number; domain: string }
interface GEdge {
  a: string; b: string; aCol: string; bCol: string;
  source: "declared" | "inferred"; overlap?: number; verified?: boolean;
}

const DOMAIN_COLORS: Record<string, string> = {
  "Customer": "#2f6bff", "Accounts & cards": "#06b6d4", "Payments & rewards": "#22c55e",
  "Lending": "#f59e0b", "Risk & compliance": "#ef4444", "Merchants": "#8b5cf6",
  "Engagement": "#ec4899", "Branch & staff": "#14b8a6", "Retail / other": "#64748b",
};
const DOMAIN_ORDER = ["Customer", "Accounts & cards", "Payments & rewards", "Lending", "Risk & compliance", "Merchants", "Engagement", "Branch & staff", "Retail / other"];

const W = 920, H = 660, CX = 460, CY = 322, R = 212;
const HUB = new Set(["customer_id", "city"]); // de-emphasised so the hub doesn't dominate the layout

export default function GraphCanvas({ nodes, edges }: { nodes: GNode[]; edges: GEdge[] }) {
  const [hover, setHover] = useState<string | null>(null);

  // One cluster per sub-domain around the canvas, the customers hub pinned at the centre.
  const pos = useMemo(() => {
    const m = new Map<string, { x: number; y: number }>();
    const domains = DOMAIN_ORDER.filter((d) => nodes.some((n) => n.domain === d));
    domains.forEach((dom, di) => {
      const ang = -Math.PI / 2 + (2 * Math.PI * di) / domains.length;
      const cc = { x: CX + R * Math.cos(ang), y: CY + R * Math.sin(ang) };
      const ns = nodes.filter((n) => n.domain === dom && n.id !== "customers");
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
  }, [nodes]);

  const neighbors = new Set<string>();
  if (hover) for (const e of edges) { if (e.a === hover) neighbors.add(e.b); if (e.b === hover) neighbors.add(e.a); }

  return (
    <div className="flex min-h-0 flex-col gap-4 rounded-xl border border-line p-3 md:flex-row">
      <div className="relative flex min-h-[460px] flex-1 items-center justify-center md:h-[620px]">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" className="h-full w-full">
          {edges.map((e, i) => {
            const pa = pos.get(e.a), pb = pos.get(e.b);
            if (!pa || !pb) return null;
            const hub = HUB.has(e.aCol) || HUB.has(e.bCol);
            const inc = hover && (e.a === hover || e.b === hover);
            const partial = e.verified === false; // measured against live data, but low overlap
            const declared = e.source === "declared";
            // Colour by verdict: amber = lossy/partial, blue = verified, violet = declared-but-unjudged.
            const hi = partial ? "#f59e0b" : e.verified ? "#2f6bff" : declared ? "#8b5cf6" : "#2f6bff";
            let stroke = "rgba(148,163,184,0.28)", w = 1, op = 1;
            let dash: string | undefined = e.source === "inferred" ? "3 3" : undefined;
            if (hub) { stroke = "rgba(148,163,184,0.12)"; w = 0.6; }
            else if (partial) { stroke = "rgba(245,158,11,0.6)"; w = 1; dash = "4 3"; }
            else if (e.verified) { stroke = "rgba(47,107,255,0.5)"; w = 1.25; dash = undefined; }
            else if (declared) { stroke = "rgba(139,92,246,0.55)"; w = 1.2; dash = undefined; } // declared, unjudged
            if (hover) { if (inc) { stroke = hi; w = 1.8; dash = partial ? "4 3" : undefined; } else { op = 0.06; } }
            const pct = e.overlap !== undefined ? ` · ${Math.round(e.overlap * 100)}% overlap` : "";
            return (
              <line key={i} x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y} stroke={stroke} strokeWidth={w} strokeDasharray={dash} opacity={op}>
                <title>{`${e.a}.${e.aCol} = ${e.b}.${e.bCol}${pct}`}</title>
              </line>
            );
          })}
          {nodes.map((n) => {
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
      </div>

      <aside className="flex shrink-0 flex-col gap-5 border-line/60 md:w-56 md:border-l md:pl-5">
        <div>
          <div className="mb-3 text-[11px] font-bold uppercase tracking-wider text-ink-faint">Sub-domains</div>
          <div className="flex flex-wrap gap-x-4 gap-y-2.5 md:flex-col">
            {DOMAIN_ORDER.filter((d) => nodes.some((n) => n.domain === d)).map((d) => (
              <span key={d} className="flex items-center gap-2.5 text-[12.5px] font-medium text-ink-soft">
                <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: DOMAIN_COLORS[d] }} />
                {d}
              </span>
            ))}
          </div>
        </div>

        <div className="border-line/50 md:border-t md:pt-4">
          <div className="mb-3 text-[11px] font-bold uppercase tracking-wider text-ink-faint">Relationships</div>
          <div className="flex flex-wrap gap-x-4 gap-y-2.5 text-[12.5px] font-medium text-ink-soft md:flex-col">
            <span className="flex items-center gap-2.5"><span className="inline-block w-6 border-t-2" style={{ borderColor: "rgba(47,107,255,0.7)" }} />verified join</span>
            <span className="flex items-center gap-2.5"><span className="inline-block w-6 border-t-2 border-dashed" style={{ borderColor: "rgba(245,158,11,0.85)" }} />partial overlap</span>
            <span className="flex items-center gap-2.5"><span className="inline-block w-6 border-t-2" style={{ borderColor: "rgba(139,92,246,0.85)" }} />declared (unverified)</span>
            <span className="flex items-center gap-2.5"><span className="inline-block w-6 border-t-2 border-dashed" style={{ borderColor: "rgba(148,163,184,0.8)" }} />inferred</span>
          </div>
        </div>

        <p className="rounded-xl border border-line/40 bg-black/[0.03] px-3 py-2.5 text-[11.5px] leading-relaxed text-ink-faint dark:bg-white/[0.04]">
          Hover a table to trace its joins; hover an edge for its live key overlap. Join keys are verified against the current data, and phantom edges (no real overlap) are dropped.
        </p>
      </aside>
    </div>
  );
}
