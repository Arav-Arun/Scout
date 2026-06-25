"use client";

// UI · CHART RENDERER · components/EChart.tsx
// Thin wrapper around Apache ECharts v5. Receives a complete `echarts` options
// object (produced and normalized by the agent's synthesize phase in lib/agent/phases.ts; typed in lib/types.ts)
// and draws it. Used by components/DashboardPanel.tsx, one instance per ChartSpec.

import { useEffect, useRef } from "react";
import * as echarts from "echarts";

const PALETTE = [
  "#3b82f6",
  "#22c55e",
  "#f59e0b",
  "#ef4444",
  "#06b6d4",
  "#8b5cf6",
  "#ec4899",
  "#14b8a6",
];

type Theme = "light" | "dark";

const THEME_COLORS: Record<Theme, { text: string; axis: string; split: string; tooltipBg: string; tooltipText: string; pieGap: string }> = {
  light: { text: "#1e293b", axis: "#cbd5e1", split: "#f1f5f9", tooltipBg: "rgba(255,255,255,0.96)", tooltipText: "#0f1729", pieGap: "#ffffff" },
  dark: { text: "#cbd5e1", axis: "rgba(255,255,255,0.16)", split: "rgba(255,255,255,0.06)", tooltipBg: "rgba(30,31,35,0.96)", tooltipText: "#f8fafc", pieGap: "#2c2e33" },
};

// Apply themed defaults to an axis (object or array) without clobbering values
// the agent set explicitly.
function themeAxis(axis: unknown, c: (typeof THEME_COLORS)[Theme]): unknown {
  if (!axis) return axis;
  if (Array.isArray(axis)) return axis.map((a) => themeAxis(a, c));
  const a = { ...(axis as Record<string, unknown>) };
  a.axisLabel = { color: c.text, ...(a.axisLabel as object) };
  a.axisLine = { lineStyle: { color: c.axis }, ...(a.axisLine as object) };
  a.splitLine = { lineStyle: { color: c.split }, ...(a.splitLine as object) };
  a.nameTextStyle = { color: c.text, ...(a.nameTextStyle as object) };
  return a;
}

// Renders a complete ECharts v5 options object, layering theme-aware defaults
// (palette, fonts, axis/label colors) under whatever the agent emits.
export default function EChart({
  spec,
  height = 240,
  theme = "light",
}: {
  spec: Record<string, unknown>;
  height?: number;
  theme?: Theme;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const c = THEME_COLORS[theme];
    const chart = echarts.init(ref.current, undefined, { renderer: "canvas" });

    const merged: Record<string, unknown> = {
      color: PALETTE,
      textStyle: { fontFamily: "Inter, sans-serif", color: c.text, fontSize: 11 },
      grid: { containLabel: true, left: 8, right: 16, top: 24, bottom: 8 },
      ...spec,
    };

    // Tooltip defaults (so dark mode doesn't get a white box on dark).
    merged.tooltip = {
      backgroundColor: c.tooltipBg,
      borderWidth: 0,
      textStyle: { color: c.tooltipText, fontSize: 12 },
      ...(merged.tooltip as object),
    };

    // Themed legend text.
    if (merged.legend) {
      merged.legend = { textStyle: { color: c.text }, ...(merged.legend as object) };
    }

    // Themed axes.
    if (merged.xAxis) merged.xAxis = themeAxis(merged.xAxis, c);
    if (merged.yAxis) merged.yAxis = themeAxis(merged.yAxis, c);

    // Pie: enforce a clean, consistent layout regardless of what the agent emitted.
    const series = merged.series as Record<string, unknown>[] | undefined;
    if (Array.isArray(series) && series.some((s) => s?.type === "pie")) {
      // A scrollable legend pinned to the top, with clear breathing room below it.
      merged.legend = {
        type: "scroll",
        top: 0,
        left: "center",
        icon: "roundRect",
        itemWidth: 11,
        itemHeight: 11,
        itemGap: 16,
        padding: [2, 8, 14, 8],
        textStyle: { color: c.text, fontSize: 11 },
      };
      for (const s of series) {
        if (s?.type !== "pie") continue;
        // Push the donut down so it never crowds the legend.
        s.center = ["50%", "64%"];
        if (!s.radius) s.radius = ["46%", "70%"];
        // Flat slices (no rounded corners), thin theme-matched separators.
        s.itemStyle = { ...(s.itemStyle as object), borderRadius: 0, borderColor: c.pieGap, borderWidth: 1 };
        
        // Ensure labels and label lines are always highly visible and color-themed
        const existingLabel = (s.label as Record<string, unknown>) || {};
        s.label = {
          show: true,
          formatter: "{d}%",
          fontSize: 11,
          ...existingLabel,
          color: (existingLabel.color as string) || c.text,
        };

        const existingLabelLine = (s.labelLine as Record<string, unknown>) || {};
        s.labelLine = {
          length: 6,
          length2: 6,
          ...existingLabelLine,
          lineStyle: {
            color: c.text,
            ...(existingLabelLine.lineStyle as object),
          },
        };

        if (s.minShowLabelAngle === undefined) s.minShowLabelAngle = 8;
        if (s.avoidLabelOverlap === undefined) s.avoidLabelOverlap = true;
      }
    }

    try {
      chart.setOption(merged, true);
    } catch (e) {
      console.error("ECharts setOption failed", e);
    }

    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      chart.dispose();
    };
  }, [spec, theme]);

  // Sizing rules live in globals.css (.echart-canvas); only the dynamic height is injected.
  return <div ref={ref} className="echart-canvas" style={{ "--echart-h": `${height}px` } as React.CSSProperties} />;
}
