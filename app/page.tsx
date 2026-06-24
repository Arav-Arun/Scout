"use client";

// ─────────────────────────────────────────────────────────────────────────────
// UI ENTRY  ·  app/page.tsx
//
// Pure layout shell. All agent interaction state lives in hooks/useScoutAgent.ts.
// This component only handles:
//   - Desktop vs mobile layout switching
//   - Theme persistence
//   - Sidebar resize
//   - Rendering ChatPanel + DashboardPanel
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState, memo } from "react";
import ChatPanel from "@/components/ChatPanel";
import DashboardPanel from "@/components/DashboardPanel";
import { useScoutAgent } from "@/hooks/useScoutAgent";

type Theme = "light" | "dark";
type MobileTab = "chat" | "dashboard";

const DEFAULT_SIDEBAR_W = 380;
const MIN_SIDEBAR_W = 320;
const MAX_SIDEBAR_W = 640;

export default function Home() {
  const agent = useScoutAgent();

  const [chatCollapsed, setChatCollapsed] = useState(false);
  const [theme, setTheme] = useState<Theme>("light");
  const [mobileTab, setMobileTab] = useState<MobileTab>("chat");
  const [mobileDashboardBadge, setMobileDashboardBadge] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_W);

  // ── Persist theme & sidebar width ──────────────────────────────────────────
  useEffect(() => {
    setTheme("light");
    const savedW = localStorage.getItem("scout-sidebar-w");
    if (savedW) setSidebarWidth(Math.min(Math.max(Number(savedW), MIN_SIDEBAR_W), MAX_SIDEBAR_W));
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("scout-theme", theme);
  }, [theme]);

  const toggleTheme = useCallback(() => setTheme((t) => (t === "dark" ? "light" : "dark")), []);

  // ── Track new dashboards for mobile badge ──────────────────────────────────
  const prevVersionCount = useRef(0);
  useEffect(() => {
    if (agent.versions.length > prevVersionCount.current) {
      setMobileDashboardBadge(true);
    }
    prevVersionCount.current = agent.versions.length;
  }, [agent.versions.length]);

  // ── Resize handle ──────────────────────────────────────────────────────────
  const sidebarRef = useRef<HTMLDivElement>(null);

  const onResizeStart = useCallback(
    (e: React.MouseEvent | React.TouchEvent) => {
      e.preventDefault();
      const startX = "touches" in e ? e.touches[0].clientX : e.clientX;
      const startW = sidebarWidth;

      const onMove = (ev: MouseEvent | TouchEvent) => {
        const clientX = "touches" in ev ? ev.touches[0].clientX : ev.clientX;
        const w = Math.min(Math.max(startW + (clientX - startX), MIN_SIDEBAR_W), MAX_SIDEBAR_W);
        setSidebarWidth(w);
      };

      const onUp = () => {
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.removeEventListener("touchmove", onMove);
        document.removeEventListener("touchend", onUp);
        const el = sidebarRef.current;
        if (el) localStorage.setItem("scout-sidebar-w", String(el.offsetWidth));
      };

      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      document.addEventListener("touchmove", onMove);
      document.addEventListener("touchend", onUp);
    },
    [sidebarWidth],
  );

  const switchMobileTab = (tab: MobileTab) => {
    setMobileTab(tab);
    if (tab === "dashboard") setMobileDashboardBadge(false);
  };

  const handleClearChat = useCallback(() => {
    agent.clearChat();
    setMobileTab("chat");
    setMobileDashboardBadge(false);
  }, [agent]);

  return (
    <main className="relative flex h-[100dvh] w-screen overflow-hidden md:p-3.5 md:gap-3.5">
      {/* ── Desktop layout (md+): resizable side-by-side ── */}
      <section
        ref={sidebarRef}
        style={{ "--sidebar-w": chatCollapsed ? "0px" : `${sidebarWidth}px` } as React.CSSProperties}
        className={`scout-sidebar relative hidden md:flex flex-col overflow-hidden transition-[width] duration-150 ease-out ${
          chatCollapsed ? "pointer-events-none min-w-0 opacity-0" : "opacity-100"
        }`}
      >
        <ChatPanel
          turns={agent.turns}
          isRunning={agent.isRunning}
          onSend={agent.send}
          onUpload={agent.uploadFile}
          onToggleCollapse={() => setChatCollapsed(true)}
          activeVersion={agent.activeVersion}
          onSelectVersion={agent.setActiveVersion}
          theme={theme}
          onToggleTheme={toggleTheme}
          onClearChat={handleClearChat}
          showCollapseButton
        />
        {/* Drag handle */}
        {!chatCollapsed && (
          <div
            className="resize-handle"
            onMouseDown={onResizeStart}
            onTouchStart={onResizeStart}
          />
        )}
      </section>

      <section className="relative hidden md:flex flex-col flex-1 min-w-0">
        <DashboardPanel
          versions={agent.versions}
          activeVersion={agent.activeVersion}
          onSelectVersion={agent.setActiveVersion}
          isRunning={agent.isRunning}
          collapsed={chatCollapsed}
          onExpand={() => setChatCollapsed(false)}
          theme={theme}
        />
      </section>

      {/* ── Mobile layout (<md): full-screen tab view ── */}
      <div className="flex md:hidden h-full w-full flex-col">
        <div className="flex-1 overflow-hidden">
          {mobileTab === "chat" ? (
            <ChatPanel
              turns={agent.turns}
              isRunning={agent.isRunning}
              onSend={agent.send}
              onUpload={agent.uploadFile}
              onToggleCollapse={() => {}}
              activeVersion={agent.activeVersion}
              onSelectVersion={(i) => {
                agent.setActiveVersion(i);
                switchMobileTab("dashboard");
              }}
              theme={theme}
              onToggleTheme={toggleTheme}
              onClearChat={handleClearChat}
            />
          ) : (
            <DashboardPanel
              versions={agent.versions}
              activeVersion={agent.activeVersion}
              onSelectVersion={agent.setActiveVersion}
              isRunning={agent.isRunning}
              theme={theme}
            />
          )}
        </div>

        {/* Bottom tab bar */}
        <MobileTabBar
          active={mobileTab}
          onSwitch={switchMobileTab}
          badge={mobileDashboardBadge}
        />
      </div>
    </main>
  );
}

/* ── Memoised mobile tab bar ────────────────────────────────────────────────── */
const MobileTabBar = memo(function MobileTabBar({
  active,
  onSwitch,
  badge,
}: {
  active: MobileTab;
  onSwitch: (tab: MobileTab) => void;
  badge: boolean;
}) {
  return (
    <nav className="glass-chrome flex shrink-0 border-t border-line safe-bottom">
      <button
        onClick={() => onSwitch("chat")}
        className={`flex flex-1 cursor-pointer flex-col items-center gap-0.5 py-2.5 text-[11px] font-semibold transition-colors ${
          active === "chat" ? "text-brand" : "text-ink-faint"
        }`}
      >
        <svg viewBox="0 0 20 20" fill="none" className="h-5 w-5" aria-hidden>
          <path d="M4 4h12a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H7l-4 3V6a2 2 0 0 1 2-2z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        </svg>
        Chat
      </button>
      <button
        onClick={() => onSwitch("dashboard")}
        className={`relative flex flex-1 cursor-pointer flex-col items-center gap-0.5 py-2.5 text-[11px] font-semibold transition-colors ${
          active === "dashboard" ? "text-brand" : "text-ink-faint"
        }`}
      >
        <svg viewBox="0 0 20 20" fill="none" className="h-5 w-5" aria-hidden>
          <rect x="2" y="3" width="7" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
          <rect x="11" y="3" width="7" height="4" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
          <rect x="2" y="11" width="7" height="4" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
          <rect x="11" y="9" width="7" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
        </svg>
        Dashboard
        {badge && active !== "dashboard" && (
          <span className="absolute right-[calc(50%-24px)] top-1.5 h-2 w-2 rounded-full bg-brand animate-pulse" />
        )}
      </button>
    </nav>
  );
});
