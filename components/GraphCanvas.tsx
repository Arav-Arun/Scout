"use client";

// GraphCanvas - pure-SVG view of the schema knowledge graph: tables are nodes,
// recovered join keys are edges, grouped and coloured by sub-domain. Hover a table
// to trace its joins. Deterministic radial layout, no graph library.

import { useMemo, useState } from "react";

interface GNode { id: string; rowCount: number; domain: string }
interface GEdge {
  a: string; b: string; aCol: string; bCol: string;
  source: "declared" | "inferred"; connection?: "physical" | "manual";
  overlap?: number; verified?: boolean;
  /** True when the join column is a hub - carried by so many tables that drawing it at full
   *  weight would turn the canvas into a starburst. Derived per schema, server-side. */
  hub?: boolean;
}

// Edges are differentiated by CONNECTION KIND (colour) and VERIFICATION (line style):
//   physical = recovered from the schema/data structure (blue) · manual = human-declared (violet)
//   verified against live data = solid · partial/unverified = dashed.
const PHYSICAL = "47,107,255"; // blue
const MANUAL = "139,92,246";   // violet
const connOf = (e: GEdge) => e.connection ?? (e.source === "inferred" ? "physical" : "manual");

// Domains are derived from whatever schema the user linked, so colours are assigned by
// position rather than looked up by name. "Other" (the ungrouped tables) is always grey.
const DOMAIN_PALETTE = ["#2f6bff", "#06b6d4", "#22c55e", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6", "#eab308", "#0ea5e9"];
const OTHER_COLOR = "#64748b";

const W = 920, H = 660, CX = 460, CY = 322, R = 212;

export default function GraphCanvas({ nodes, edges }: { nodes: GNode[]; edges: GEdge[] }) {
  const [hover, setHover] = useState<string | null>(null);

  // Stable domain order (largest cluster first, "Other" last) and the colour for each.
  const domains = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of nodes) counts.set(n.domain, (counts.get(n.domain) ?? 0) + 1);
    const names = [...counts.keys()]
      .filter((d) => d !== "Other")
      .sort((a, b) => (counts.get(b)! - counts.get(a)!) || a.localeCompare(b));
    if (counts.has("Other")) names.push("Other");
    return names.map((name, i) => ({
      name,
      color: name === "Other" ? OTHER_COLOR : DOMAIN_PALETTE[i % DOMAIN_PALETTE.length],
    }));
  }, [nodes]);

  const colorOf = useMemo(
    () => new Map(domains.map((d) => [d.name, d.color])),
    [domains],
  );

  // The most-connected table anchors the centre - in any schema that's the table everything
  // else hangs off, and pinning it keeps the clusters from tangling around it.
  const centerNode = useMemo(() => {
    const degree = new Map<string, number>();
    for (const e of edges) {
      degree.set(e.a, (degree.get(e.a) ?? 0) + 1);
      degree.set(e.b, (degree.get(e.b) ?? 0) + 1);
    }
    let best: string | null = null;
    for (const n of nodes) {
      const d = degree.get(n.id) ?? 0;
      if (d >= 3 && (best === null || d > (degree.get(best) ?? 0))) best = n.id;
    }
    return best;
  }, [nodes, edges]);

  // One cluster per domain around the canvas, the hub table pinned at the centre.
  const pos = useMemo(() => {
    const m = new Map<string, { x: number; y: number }>();
    domains.forEach((dom, di) => {
      const ang = -Math.PI / 2 + (2 * Math.PI * di) / domains.length;
      const cc = { x: CX + R * Math.cos(ang), y: CY + R * Math.sin(ang) };
      const ns = nodes.filter((n) => n.domain === dom.name && n.id !== centerNode);
      const k = ns.length;
      ns.forEach((n, j) => {
        if (k === 1) { m.set(n.id, cc); return; }
        const rk = Math.min(66, 16 + 9 * k);
        const a2 = ang + (2 * Math.PI * j) / k;
        m.set(n.id, { x: cc.x + rk * Math.cos(a2), y: cc.y + rk * Math.sin(a2) });
      });
    });
    if (centerNode) m.set(centerNode, { x: CX, y: CY });
    return m;
  }, [nodes, domains, centerNode]);

  const neighbors = new Set<string>();
  if (hover) for (const e of edges) { if (e.a === hover) neighbors.add(e.b); if (e.b === hover) neighbors.add(e.a); }

  return (
    <div className="flex min-h-0 flex-col gap-4 rounded-xl border border-line p-3 md:flex-row">
      <div className="relative flex min-h-[460px] flex-1 items-center justify-center md:h-[620px]">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" className="h-full w-full">
          {edges.map((e, i) => {
            const pa = pos.get(e.a), pb = pos.get(e.b);
            if (!pa || !pb) return null;
            const hub = !!e.hub;
            const inc = hover && (e.a === hover || e.b === hover);
            const rgb = connOf(e) === "physical" ? PHYSICAL : MANUAL; // colour = connection kind
            const verified = e.verified === true;                     // line style = verification
            const hi = `rgb(${rgb})`;
            // Colour by connection (blue physical / violet manual); solid = verified, dashed = partial/unverified.
            let stroke = `rgba(${rgb},${verified ? 0.5 : 0.4})`, w = verified ? 1.25 : 1, op = 1;
            let dash: string | undefined = verified ? undefined : "4 3";
            if (hub) { stroke = "rgba(148,163,184,0.12)"; w = 0.6; } // hub edges de-emphasised
            if (hover) { if (inc) { stroke = hi; w = 1.8; } else { op = 0.06; } }
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
            const color = colorOf.get(n.domain) ?? OTHER_COLOR;
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
            {domains.map((d) => (
              <span key={d.name} className="flex items-center gap-2.5 text-[12.5px] font-medium text-ink-soft">
                <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: d.color }} />
                {d.name}
              </span>
            ))}
          </div>
        </div>

        <div className="border-line/50 md:border-t md:pt-4">
          <div className="mb-3 text-[11px] font-bold uppercase tracking-wider text-ink-faint">Connections</div>
          <div className="flex flex-wrap gap-x-4 gap-y-2.5 text-[12.5px] font-medium text-ink-soft md:flex-col">
            <span className="flex items-center gap-2.5"><span className="inline-block w-6 border-t-2" style={{ borderColor: `rgb(${PHYSICAL})` }} />physical <span className="text-ink-faint">(inferred)</span></span>
            <span className="flex items-center gap-2.5"><span className="inline-block w-6 border-t-2" style={{ borderColor: `rgb(${MANUAL})` }} />manual <span className="text-ink-faint">(declared)</span></span>
          </div>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2.5 text-[12.5px] font-medium text-ink-soft md:flex-col">
            <span className="flex items-center gap-2.5"><span className="inline-block w-6 border-t-2" style={{ borderColor: "rgba(148,163,184,0.9)" }} />verified join</span>
            <span className="flex items-center gap-2.5"><span className="inline-block w-6 border-t-2 border-dashed" style={{ borderColor: "rgba(148,163,184,0.9)" }} />partial / unverified</span>
          </div>
        </div>
      </aside>
    </div>
  );
}
