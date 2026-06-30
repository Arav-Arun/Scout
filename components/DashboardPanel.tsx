"use client";

// DashboardPanel (right pane) — renders the agent's final answer: title, hero metrics,
// charts (each with its written insight), tables, recommendations, and Export SQL / Share.
// Mounted by app/page.tsx from DashboardVersion[]; delegates chart rendering to EChart.tsx.

import { useState } from "react";
import type { Dashboard, ExecutedQuery, ChartSpec, DataTableSpec } from "@/lib/types";
import EChart from "./EChart";
import { CodeIcon, ShareIcon, SparkIcon, ChartIcon, PanelLeftIcon, CheckIcon } from "./icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { PropertySearchIcon } from "@hugeicons/core-free-icons";

export interface DashboardVersion {
  dashboard: Dashboard;
  queries: ExecutedQuery[];
  question: string;
}

/** Build a portable markdown report of the analysis (used by "Share"). */
function buildReport(d: Dashboard, queries: ExecutedQuery[]): string {
  const out: string[] = [`# ${d.title}`];
  if (d.subtitle) out.push(`_${d.subtitle}_`);
  out.push("", d.summary);
  if (d.heroMetrics.length) {
    out.push("", "## Key metrics");
    for (const m of d.heroMetrics) out.push(`- **${m.label}:** ${m.value}${m.sub ? ` (${m.sub})` : ""}`);
  }
  if (d.charts.length) {
    out.push("", "## Insights");
    for (const c of d.charts) out.push(`- **${c.title}:** ${c.insight}`);
  }
  if (d.recommendations?.length) {
    out.push("", "## Recommendations");
    for (const r of d.recommendations) out.push(`- ${r}`);
  }
  if (queries.length) {
    out.push("", "## SQL", "```sql", ...queries.map((q) => `-- ${q.purpose}\n${q.sql};`), "```");
  }
  return out.join("\n");
}

export default function DashboardPanel({
  versions,
  activeVersion,
  onSelectVersion,
  isRunning,
  collapsed,
  onExpand,
  theme,
}: {
  versions: DashboardVersion[];
  activeVersion: number;
  onSelectVersion: (i: number) => void;
  isRunning: boolean;
  collapsed?: boolean;
  onExpand?: () => void;
  theme: "light" | "dark";
}) {
  const [showSql, setShowSql] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const current = versions[activeVersion];

  return (
    <div className="glass flex h-full flex-col md:rounded-3xl md:shadow-lg overflow-hidden relative">
      {/* floating controls */}
      {collapsed && onExpand && (
        <button
          onClick={onExpand}
          title="Show Scout panel"
          className="absolute left-4 top-4 z-20 glass-chrome flex h-10 w-10 cursor-pointer items-center justify-center rounded-xl border border-line shadow-md text-ink-soft hover:text-ink transition-all hover:scale-105 active:scale-95"
        >
          <PanelLeftIcon className="h-5 w-5" />
        </button>
      )}

      {versions.length > 1 && (
        <div
          className={`absolute top-4 z-20 glass-chrome flex items-center gap-0.5 rounded-xl border border-line p-1 shadow-md transition-all ${
            collapsed ? "left-[64px]" : "left-4"
          }`}
        >
          {versions.map((_, i) => (
            <button
              key={i}
              onClick={() => onSelectVersion(i)}
              className={`rounded-md cursor-pointer px-2.5 py-1 text-[11.5px] font-semibold transition-colors ${
                activeVersion === i ? "field text-ink shadow-sm" : "text-ink-faint hover:text-ink-soft"
              }`}
            >
              v{i + 1}
            </button>
          ))}
        </div>
      )}

      {current && (
        <div className="absolute right-4 top-4 z-20 flex items-center gap-2">
          <button
            onClick={() => setShowSql(true)}
            className="glass-chrome inline-flex h-10 cursor-pointer items-center gap-1.5 rounded-xl border border-line px-3 text-[12.5px] font-medium text-ink-soft shadow-md transition-all hover:text-ink hover:scale-105 active:scale-95"
          >
            <CodeIcon className="h-4 w-4" />
            Export SQL
            <span className="soft rounded px-1.5 py-0.5 text-[10.5px] text-ink-faint">{current.queries.length}</span>
          </button>
          <button
            onClick={() => setShowShare(true)}
            className="inline-flex h-10 cursor-pointer items-center gap-1.5 rounded-xl bg-brand px-3.5 text-[12.5px] font-medium text-white shadow-md transition-all hover:bg-brand-dark hover:scale-105 active:scale-95"
          >
            <ShareIcon className="h-4 w-4" />
            Share
          </button>
        </div>
      )}

      {/* body */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {!current ? (
          <DashboardEmpty isRunning={isRunning} />
        ) : (
          <div className="px-6 pb-6 pt-20">
            <div className="mx-auto max-w-4xl space-y-6">
              {/* title */}
              <div className="animate-fade-up">
                <h1 className="text-[22px] font-bold leading-tight tracking-tight text-ink">
                  {current.dashboard.title}
                </h1>
                {current.dashboard.subtitle && (
                  <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-soft">{current.dashboard.subtitle}</p>
                )}
              </div>

              {/* executive summary */}
              {current.dashboard.summary && (
                <div className="animate-fade-up rounded-2xl border border-brand-100 bg-brand-50/50 px-5 py-4">
                  <p className="text-[13.5px] leading-relaxed text-ink">{current.dashboard.summary}</p>
                </div>
              )}

              {/* hero metrics */}
              {current.dashboard.heroMetrics.length > 0 && (
                <div
                  className="hero-grid grid animate-fade-up gap-3"
                  style={{ "--hero-cols": Math.min(current.dashboard.heroMetrics.length, 4) } as React.CSSProperties}
                >
                  {current.dashboard.heroMetrics.map((m, i) => {
                    // Scale the headline down for longer values so it never wraps oddly.
                    const len = m.value.length;
                    const size = len <= 6 ? "text-[30px]" : len <= 10 ? "text-[22px]" : "text-[17px]";
                    return (
                      <div key={i} className="glass-card rounded-2xl px-4 py-3.5">
                        <div className="text-[10.5px] font-semibold uppercase leading-tight tracking-wide text-ink-faint">
                          {m.label}
                        </div>
                        <div className="mt-2 flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
                          <span className={`${size} font-bold leading-none tracking-tight text-ink`}>{m.value}</span>
                          {m.sub && <span className="text-[13px] font-semibold text-brand">{m.sub}</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* charts */}
              {current.dashboard.charts.length > 0 && (
                <div className="space-y-3">
                  <div className="flex items-center gap-2 pt-1">
                    <SparkIcon className="h-3.5 w-3.5 text-brand" />
                    <h3 className="text-[14px] font-semibold text-ink">Charts &amp; Insights</h3>
                  </div>
                  <div
                    className="chart-grid grid gap-4"
                    style={{ "--chart-cols": current.dashboard.charts.length === 1 ? "1fr" : "repeat(2, minmax(0, 1fr))" } as React.CSSProperties}
                  >
                    {current.dashboard.charts.map((c, i) => (
                      <ChartCard key={i} chart={c} theme={theme} />
                    ))}
                  </div>
                </div>
              )}

              {/* tables */}
              {current.dashboard.tables && current.dashboard.tables.length > 0 && (
                <div className="space-y-4">
                  {current.dashboard.tables.map((t, i) => (
                    <DataTable key={i} table={t} />
                  ))}
                </div>
              )}

              {/* recommendations */}
              {current.dashboard.recommendations && current.dashboard.recommendations.length > 0 && (
                <div className="glass-card rounded-2xl px-5 py-4">
                  <h3 className="mb-2 text-[13px] font-semibold text-ink">Recommendations</h3>
                  <ul className="space-y-1.5">
                    {current.dashboard.recommendations.map((r, i) => (
                      <li key={i} className="flex gap-2 text-[13px] leading-relaxed text-ink-soft">
                        <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />
                        {r}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {current && showSql && <SqlDrawer queries={current.queries} onClose={() => setShowSql(false)} />}
      {current && showShare && (
        <ShareDialog
          report={buildReport(current.dashboard, current.queries)}
          filename={`${slugify(current.dashboard.title)}.md`}
          onClose={() => setShowShare(false)}
        />
      )}
    </div>
  );
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "scout-analysis";
}

function ShareDialog({ report, filename, onClose }: { report: string; filename: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(report);
    } catch {
      // Fallback for environments without the async clipboard API.
      const ta = document.createElement("textarea");
      ta.value = report;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch { /* ignore */ }
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const download = () => {
    const blob = new Blob([report], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/60 p-6 backdrop-blur-[4px]" onClick={onClose}>
      <div
        className="glass-chrome-opaque flex max-h-[80%] w-[min(640px,100%)] flex-col overflow-hidden rounded-2xl border border-line shadow-2xl animate-fade-up"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <div className="flex items-center gap-2">
            <ShareIcon className="h-4 w-4 text-brand" />
            <span className="text-[14px] font-semibold text-ink">Share analysis</span>
          </div>
          <button onClick={onClose} className="rounded-lg cursor-pointer px-2 py-1 text-[18px] leading-none text-ink-faint hover:text-ink">
            ×
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">
          <p className="mb-2 text-[12.5px] text-ink-soft">
            A portable Markdown report of this analysis (summary, metrics, insights, and the SQL).
          </p>
          <pre className="soft max-h-72 overflow-auto rounded-xl border border-line px-3.5 py-3 text-[12px] leading-relaxed text-ink">
            <code>{report}</code>
          </pre>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">
          <button
            onClick={download}
            className="field inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] font-medium text-ink-soft hover:text-ink"
          >
            Download .md
          </button>
          <button
            onClick={copy}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-brand px-3.5 py-1.5 text-[12.5px] font-medium text-white transition-colors hover:bg-brand-dark"
          >
            {copied ? <CheckIcon className="h-3.5 w-3.5" /> : null}
            {copied ? "Copied" : "Copy to clipboard"}
          </button>
        </div>
      </div>
    </div>
  );
}

function SqlDrawer({ queries, onClose }: { queries: ExecutedQuery[]; onClose: () => void }) {
  const allSql = queries.map((q) => `-- ${q.purpose}\n${q.sql};`).join("\n\n");
  return (
    <div className="absolute inset-0 z-20 flex justify-end bg-black/60 backdrop-blur-[4px]" onClick={onClose}>
      <div
        className="glass-chrome-opaque flex h-full w-[min(620px,90%)] flex-col border-l border-line shadow-2xl animate-fade-up"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <div className="flex items-center gap-2">
            <CodeIcon className="h-4 w-4 text-brand" />
            <span className="text-[14px] font-semibold text-ink">Executed SQL ({queries.length})</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => navigator.clipboard?.writeText(allSql)}
              className="field cursor-pointer rounded-lg px-2.5 py-1 text-[12px] font-medium text-ink-soft hover:text-ink"
            >
              Copy all
            </button>
            <button onClick={onClose} className="rounded-lg cursor-pointer px-2 py-1 text-[18px] leading-none text-ink-faint hover:text-ink">
              ×
            </button>
          </div>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {queries.map((q, i) => (
            <div key={i}>
              <div className="mb-1.5 flex items-center gap-2 text-[12px] text-ink-soft">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-brand-50 text-[11px] font-semibold text-brand">
                  {i + 1}
                </span>
                <span className="font-medium">{q.purpose}</span>
                <span className="ml-auto text-[11px] text-ink-faint">
                  {q.rowCount} rows{q.elapsedMs != null ? ` · ${q.elapsedMs}ms` : ""}
                </span>
              </div>
              <pre className="soft overflow-x-auto rounded-xl border border-line px-3.5 py-3 text-[12px] leading-relaxed text-ink">
                <code>{q.sql}</code>
              </pre>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function DashboardEmpty({
  isRunning,
}: {
  isRunning: boolean;
}) {
  return (
    <div className="relative flex h-full flex-col items-center justify-center px-10 text-center">
      {/* logo with a soft halo */}
      <div className="relative flex items-center justify-center">
        <div
          aria-hidden
          className={`absolute h-32 w-32 rounded-full bg-white/10 blur-3xl dark:bg-white/5 ${isRunning ? "animate-soft-pulse" : ""}`}
        />
        <HugeiconsIcon
          icon={PropertySearchIcon}
          size={72}
          className={`relative text-brand ${isRunning ? "animate-soft-pulse" : ""}`}
        />
      </div>
      <h2 className="mt-5 text-[17px] font-semibold tracking-tight text-ink">
        {isRunning ? "Scout is analysing…" : "Your dashboard appears here"}
      </h2>
      <p className="mt-2 max-w-sm text-[13px] leading-relaxed text-ink-soft">
        {isRunning
          ? "Discovering the schema, planning queries, and synthesising insights from your data."
          : "Ask a question on the left and Scout will build hero metrics, charts and a written analysis here."}
      </p>
      {!isRunning && (
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          {[
            { label: "Hero metrics", Icon: SparkIcon },
            { label: "Charts & insights", Icon: ChartIcon },
            { label: "Exportable SQL", Icon: CodeIcon },
          ].map(({ label, Icon }) => (
            <span
              key={label}
              className="glass-card inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium text-ink-soft"
            >
              <Icon className="h-3.5 w-3.5 text-brand" />
              {label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// One "Charts & Insights" card: title, the written observation, then the chart.
function ChartCard({ chart, theme }: { chart: ChartSpec; theme: "light" | "dark" }) {
  return (
    <div className="glass-card flex flex-col rounded-2xl p-4">
      <h4 className="text-[14px] font-semibold leading-snug text-ink">{chart.title}</h4>
      {chart.insight && (
        <div className="soft mt-2 rounded-xl px-3 py-2.5">
          <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-brand">
            <SparkIcon className="h-2.5 w-2.5" />
            Insight
          </div>
          <p className="text-[12.5px] leading-relaxed text-ink-soft">{chart.insight}</p>
        </div>
      )}
      <div className="mt-3">
        <EChart spec={chart.echarts} height={240} theme={theme} />
      </div>
    </div>
  );
}

// A compact detail table for the dashboard. Numeric-looking cells are right-aligned.
function DataTable({ table }: { table: DataTableSpec }) {
  return (
    <div className="glass-card overflow-hidden rounded-xl">
      <div className="border-b border-line/70 px-4 py-2.5 text-[13px] font-semibold text-ink">
        {table.title}
      </div>
      <div className="max-h-80 overflow-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="bg-canvas/50">
              {table.columns.map((c) => (
                <th
                  key={c}
                  className="sticky top-0 z-10 whitespace-nowrap border-b border-line bg-canvas/90 backdrop-blur-md px-3 py-2 text-left font-medium text-ink-soft"
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, i) => (
              <tr key={i} className="transition-colors hover:bg-brand-50/30 dark:hover:bg-brand-100/10 even:bg-canvas/20">
                {row.map((cell, j) => {
                  const isNum = typeof cell === "number" || (cell != null && /^-?[\d,.]+%?$/.test(String(cell)));
                  return (
                    <td
                      key={j}
                      className={`whitespace-nowrap border-b border-line/60 px-3 py-1.5 text-ink ${
                        isNum ? "text-right tabular-nums" : "text-left"
                      }`}
                    >
                      {cell == null ? "-" : String(cell)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
