"use client";

// ─────────────────────────────────────────────────────────────────────────────
// UI · CHAT PANEL (left pane)  ·  components/ChatPanel.tsx
//
// The conversation surface: composer, message list, live reasoning-step chips,
// model picker, file upload, and the DB connection banner.
//   - MOUNTED BY: app/page.tsx (which owns send()/uploadFile() and all state)
//   - CALLS:      GET /api/db-info (app/api/db-info/route.ts) for the host/db
//                 banner; onSend()/onUpload() are passed down from page.tsx.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from "react";
import type { UITurn, AgentBlock } from "@/lib/types";
import {
  SendIcon,
  SparkIcon,
  ChevronIcon,
  PanelLeftIcon,
  PaperclipIcon,
  GearIcon,
  MoonIcon,
  SunIcon,
  TrashIcon,
  DatabaseIcon,
  CheckIcon,
  SpinnerIcon,
  ChartIcon,
  CodeIcon,
} from "./icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { PropertySearchIcon } from "@hugeicons/core-free-icons";

// Render narration with inline `code` and **bold** support.
function Narration({ text }: { text: string }) {
  const html = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br/>");
  return (
    <p
      className="narration text-[13.5px] leading-relaxed text-ink-soft"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export default function ChatPanel({
  turns,
  isRunning,
  onSend,
  onUpload,
  onToggleCollapse,
  activeVersion,
  onSelectVersion,
  theme,
  onToggleTheme,
  onClearChat,
  showCollapseButton,
}: {
  turns: UITurn[];
  isRunning: boolean;
  onSend: (text: string) => void;
  onUpload: (file: File) => void;
  onToggleCollapse: () => void;
  activeVersion: number;
  onSelectVersion: (i: number) => void;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  onClearChat: () => void;
  showCollapseButton?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dbInfo, setDbInfo] = useState<{ host: string; database: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const settingsRef = useRef<HTMLDivElement>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);

  // Close Settings panel when clicking outside of it
  useEffect(() => {
    if (!settingsOpen) return;
    const handler = (e: MouseEvent) => {
      if (
        settingsRef.current &&
        !settingsRef.current.contains(e.target as Node) &&
        settingsButtonRef.current &&
        !settingsButtonRef.current.contains(e.target as Node)
      ) {
        setSettingsOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [settingsOpen]);

  useEffect(() => {
    fetch("/api/db-info")
      .then((res) => res.json())
      .then((data) => setDbInfo(data))
      .catch(() => {});
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [turns, isRunning]);

  const submit = () => {
    const t = draft.trim();
    if (!t || isRunning) return;
    setDraft("");
    onSend(t);
  };

  const pickFile = () => fileRef.current?.click();
  const empty = turns.length === 0;

  return (
    <div className="glass flex h-full flex-col md:rounded-3xl md:shadow-lg overflow-hidden">
      <input
        ref={fileRef}
        type="file"
        accept=".csv,.tsv,.xlsx,.xls,.json,.jsonl,.ndjson"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onUpload(f);
          e.target.value = "";
        }}
      />

      {/* header */}
      <div className={`p-3 md:p-3.5 pb-1 shrink-0 ${settingsOpen ? "relative z-40" : "relative z-10"}`}>
        <div className="glass-chrome flex h-14 items-center gap-2.5 rounded-2xl border border-line px-4 shadow-sm relative">
          <HugeiconsIcon icon={PropertySearchIcon} size={32} className="text-brand shrink-0" />
          <div>
            <div className="text-[15px] font-bold leading-none tracking-tight text-ink">Scout</div>
            <div className="mt-1 text-[11px] font-medium tracking-wide text-ink-faint">Ask your data anything</div>
          </div>

          <div className="ml-auto flex items-center gap-1">
            <button
              ref={settingsButtonRef}
              onClick={() => setSettingsOpen((v) => !v)}
              title="Settings"
              className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-black/5 hover:text-ink-soft dark:hover:bg-white/10"
            >
              <GearIcon className="h-5 w-5" />
            </button>
            {showCollapseButton && (
              <button
                onClick={onToggleCollapse}
                title="Collapse panel"
                className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-black/5 hover:text-ink-soft dark:hover:bg-white/10"
              >
                <PanelLeftIcon className="h-5 w-5" />
              </button>
            )}
          </div>

          {settingsOpen && (
            <div
              ref={settingsRef}
              className="absolute right-0 top-[62px] z-30 w-72 rounded-2xl bg-white dark:bg-[#16161c] p-4 shadow-xl border border-line dark:border-zinc-800/80 animate-fade-up flex flex-col gap-4"
            >
              {/* Preferences Section */}
              <div className="flex flex-col gap-3">
                <div className="text-[11px] font-bold uppercase tracking-wider text-ink-faint">Preferences</div>
                
                {/* Theme Toggle Button */}
                <button
                  onClick={onToggleTheme}
                  className="flex w-full cursor-pointer items-center justify-between rounded-xl px-3 py-2 text-[13px] text-ink transition-all hover:bg-black/5 dark:hover:bg-white/10"
                >
                  <span className="flex items-center gap-2.5">
                    {theme === "dark" ? <SunIcon className="h-4 w-4 text-ink-soft" /> : <MoonIcon className="h-4 w-4 text-ink-soft" />}
                    <span className="font-medium">Dark mode</span>
                  </span>
                  <span
                    className={`flex h-[18px] w-8 items-center rounded-full p-0.5 transition-colors ${
                      theme === "dark" ? "bg-brand" : "bg-ink-faint/40"
                    }`}
                  >
                    <span
                      className={`h-[14px] w-[14px] rounded-full bg-white shadow-sm transition-transform ${
                        theme === "dark" ? "translate-x-[14px]" : "translate-x-0"
                      }`}
                    />
                  </span>
                </button>

              </div>

              {/* Database Section */}
              <div className="flex flex-col gap-2 border-t border-line/40 pt-3">
                <div className="text-[11px] font-bold uppercase tracking-wider text-ink-faint">Warehouse Connection</div>
                <div className="flex items-start gap-2.5 rounded-xl bg-black/5 dark:bg-white/5 px-3 py-2.5 border border-line/20">
                  <DatabaseIcon className="mt-0.5 h-4 w-4 shrink-0 text-ink-soft" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[12px] font-bold text-ink-soft truncate">{dbInfo?.database || "default"}</span>
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)] shrink-0" title="Connected" />
                    </div>
                    <div className="text-[10.5px] text-ink-faint truncate font-mono mt-0.5" title={dbInfo?.host || "localhost"}>
                      {dbInfo?.host || "Connecting..."}
                    </div>
                  </div>
                </div>
              </div>

              {/* Reset Section */}
              <div className="flex flex-col border-t border-line/40 pt-3">
                <button
                  onClick={() => {
                    onClearChat();
                    setSettingsOpen(false);
                  }}
                  className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-xl bg-rose-500/10 hover:bg-rose-500/15 border border-rose-500/20 text-rose-500 dark:text-rose-400 py-2.5 text-[12.5px] font-bold transition-all hover:brightness-105 active:scale-[0.98]"
                >
                  <TrashIcon className="h-4 w-4" />
                  Reset Session
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* transcript */}
      <div ref={scrollRef} className="flex-1 space-y-5 overflow-y-auto px-5 py-5">
        {empty && <EmptyState onPick={onSend} onUploadClick={pickFile} />}

        {turns.map((turn, i) =>
          turn.role === "user" ? (
            <div key={i} className="flex justify-end animate-fade-up">
              <div className="max-w-[88%] rounded-2xl rounded-br-md bg-brand px-4 py-2.5 text-[13.5px] font-medium leading-snug text-white shadow-sm">
                {turn.text}
              </div>
            </div>
          ) : (
            <div key={i} className="space-y-2.5 animate-fade-up">
              {turn.blocks?.map((b, j) =>
                b.type === "text" ? (
                  b.text.trim() ? <Narration key={j} text={b.text} /> : null
                ) : (
                  <StepChip key={b.id} step={b} />
                ),
              )}
              {turn.versionIndex != null && (
                <button
                  onClick={() => onSelectVersion(turn.versionIndex!)}
                  className={`mt-1 inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[12px] font-medium transition-colors ${
                    activeVersion === turn.versionIndex
                      ? "border-brand-100 bg-brand-50 text-brand-dark"
                      : "border-line text-ink-soft hover:bg-black/5 dark:hover:bg-white/10"
                  }`}
                >
                  <SparkIcon className="h-3 w-3" />
                  View dashboard v{turn.versionIndex + 1}
                </button>
              )}
            </div>
          ),
        )}
      </div>

      {/* composer */}
      <div className="p-3 md:p-3.5 pt-1 shrink-0">
        <div className="glass-chrome flex items-end gap-1.5 rounded-2xl px-3 py-2 md:gap-2.5 md:px-4 md:py-2.5 transition-all focus-within:border-brand focus-within:ring-4 focus-within:ring-brand/20 dark:focus-within:ring-brand/35 shadow-sm border border-line">
          <button
            onClick={pickFile}
            disabled={isRunning}
            title="Upload a data file"
            className="flex h-9 w-9 md:h-10 md:w-10 shrink-0 cursor-pointer items-center justify-center rounded-xl bg-brand-50 text-brand hover:bg-brand-100 dark:bg-brand-950/35 dark:text-brand-light dark:hover:bg-brand-950/50 transition-colors disabled:bg-zinc-100 dark:disabled:bg-zinc-800 disabled:text-zinc-400 dark:disabled:text-zinc-600 disabled:cursor-not-allowed"
          >
            <PaperclipIcon className="h-5 w-5 md:h-[22px] md:w-[22px]" />
          </button>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={1}
            placeholder="Ask your data anything, e.g. which products are on the decline?"
            className="max-h-32 flex-1 resize-none bg-transparent py-1.5 text-[13.5px] md:py-2 md:text-[14px] text-ink outline-none placeholder:text-ink-faint disabled:opacity-50 disabled:cursor-not-allowed"
          />
          <button
            onClick={submit}
            disabled={!draft.trim() || isRunning}
            className="flex h-9 w-9 md:h-10 md:w-10 shrink-0 cursor-pointer items-center justify-center rounded-xl bg-brand text-white shadow-sm transition-all hover:brightness-105 hover:shadow-md disabled:bg-zinc-100 dark:disabled:bg-zinc-800 disabled:text-zinc-400 dark:disabled:text-zinc-600 disabled:shadow-none disabled:cursor-not-allowed"
          >
            <SendIcon className="h-4 w-4 md:h-5 md:w-5" />
          </button>
        </div>
      </div>
    </div>
  );
}

const SUGGESTIONS = [
  "Which products are on the decline, and since when?",
  "Which products are growing the fastest year over year?",
  "Break down total net revenue by category and sales channel.",
  "Compare online vs retail store sales over time.",
];

function EmptyState({ onPick, onUploadClick }: { onPick: (t: string) => void; onUploadClick: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center text-center gap-6 py-8 px-4 animate-fade-up">
      {/* Visual Badge/Icon */}
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-brand/10 text-brand shadow-sm border border-brand/15">
        <DatabaseIcon className="h-7 w-7" />
      </div>

      <div>
        <h2 className="text-[22px] font-extrabold tracking-tight text-ink">Ask your data anything</h2>
        <p className="mt-2.5 max-w-sm text-[13.5px] leading-relaxed text-ink-soft">
          You&apos;re connected to your ClickHouse warehouse. Just ask a question to start, no upload needed. Scout discovers the schema, writes the SQL, and builds a dashboard.
        </p>
      </div>

      {/* Clickable starter questions */}
      <div className="flex flex-col gap-2 w-full max-w-md">
        <span className="text-[11px] font-bold uppercase tracking-wider text-ink-faint">Try asking</span>
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            onClick={() => onPick(s)}
            className="group flex items-center gap-2.5 rounded-xl border border-line bg-black/[0.02] dark:bg-white/[0.03] px-3.5 py-2.5 text-left text-[13px] font-medium text-ink-soft transition-all hover:border-brand hover:bg-brand-50/30 hover:text-ink cursor-pointer"
          >
            <SparkIcon className="h-3.5 w-3.5 shrink-0 text-brand" />
            {s}
          </button>
        ))}
      </div>

      {/* Optional: bring in a new dataset */}
      <button
        onClick={onUploadClick}
        className="flex items-center gap-2 text-[12px] font-semibold text-ink-faint transition-colors hover:text-brand cursor-pointer"
      >
        <PaperclipIcon className="h-4 w-4" />
        or upload a new file (CSV, Excel, JSON)
      </button>
    </div>
  );
}

type Step = Extract<AgentBlock, { type: "step" }>;

const KIND_ICON: Record<"discover" | "inspect" | "query" | "think", React.ComponentType<{ className?: string }>> = {
  discover: DatabaseIcon,
  inspect: CodeIcon,
  query: ChartIcon,
  think: ChartIcon,
};

// A single reasoning-step chip in the chat transcript (mirrors the collapsible
// "Found relevant data / Queried the database" rows).
function StepChip({ step }: { step: Step }) {
  const running = step.status === "running";
  const error = step.status === "error";
  const KindIcon = KIND_ICON[step.kind] ?? DatabaseIcon;

  return (
    <div
      className={`group field flex items-center gap-2.5 rounded-xl px-3 py-2 backdrop-blur-sm transition-colors ${
        error ? "!border-red-300/60" : "hover:border-brand-100"
      }`}
    >
      <span
        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${
          error
            ? "bg-red-500/15 text-red-500"
            : running
              ? "bg-brand-50 text-brand"
              : "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
        }`}
      >
        {running ? (
          <SpinnerIcon className="h-3.5 w-3.5 animate-spin" />
        ) : error ? (
          <span className="text-[11px] font-bold">!</span>
        ) : (
          <CheckIcon className="h-3 w-3" />
        )}
      </span>

      <KindIcon className="h-3.5 w-3.5 shrink-0 text-ink-faint" />

      <span className={`text-[13px] font-medium ${running ? "text-ink-soft" : "text-ink"}`}>
        {step.label}
      </span>

      {step.detail && (
        <span className="ml-auto truncate rounded-md bg-canvas px-2 py-0.5 text-[11.5px] font-medium text-ink-faint">
          {step.detail}
        </span>
      )}
    </div>
  );
}
