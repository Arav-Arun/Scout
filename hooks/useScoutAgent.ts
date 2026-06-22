// ─────────────────────────────────────────────────────────────────────────────
// AGENT HOOK  ·  hooks/useScoutAgent.ts
//
// Owns all the client-side agent interaction state: conversation turns, dashboard
// versions, streaming, and file upload. Extracted from page.tsx so the page
// component is a pure layout shell.
//
// ▸ Consumes:  POST /api/chat, POST /api/upload
// ▸ Protocol:  NDJSON stream of ScoutEvent (lib/types.ts)
// ─────────────────────────────────────────────────────────────────────────────

"use client";

import { useCallback, useRef, useState } from "react";
import type { ChatTurn, ScoutEvent, UITurn, AgentBlock } from "@/lib/types";
import type { DashboardVersion } from "@/components/DashboardPanel";

export interface ScoutAgent {
  turns: UITurn[];
  versions: DashboardVersion[];
  activeVersion: number;
  isRunning: boolean;
  setActiveVersion: (i: number) => void;
  send: (text: string) => void;
  uploadFile: (file: File) => void;
  clearChat: () => void;
}

export function useScoutAgent(): ScoutAgent {
  const [turns, setTurns] = useState<UITurn[]>([]);
  const [versions, setVersions] = useState<DashboardVersion[]>([]);
  const [activeVersion, setActiveVersion] = useState(0);
  const [isRunning, setIsRunning] = useState(false);
  const historyRef = useRef<ChatTurn[]>([]);

  const clearChat = useCallback(() => {
    setTurns([]);
    setVersions([]);
    setActiveVersion(0);
    historyRef.current = [];
  }, []);

  // ── Patch the last assistant turn's blocks ─────────────────────────────────

  const patchAssistant = useCallback(
    (fn: (blocks: AgentBlock[]) => AgentBlock[], versionIndex?: number) => {
      setTurns((t) => {
        const copy = [...t];
        const last = copy[copy.length - 1];
        if (!last || last.role !== "assistant") return t;
        copy[copy.length - 1] = {
          ...last,
          blocks: fn(last.blocks ?? []),
          versionIndex: versionIndex ?? last.versionIndex,
        };
        return copy;
      });
    },
    [],
  );

  // ── Send a question ────────────────────────────────────────────────────────

  const send = useCallback(
    async (text: string) => {
      if (isRunning) return;
      setIsRunning(true);

      setTurns((t) => [...t, { role: "user", text }, { role: "assistant", blocks: [] }]);

      const apiMessages: ChatTurn[] = [...historyRef.current, { role: "user", content: text }];

      let narration = "";
      let producedVersionIndex: number | null = null;
      let producedSummary = "";

      const handle = (e: ScoutEvent) => {
        switch (e.type) {
          case "text": {
            narration += e.delta + "\n";
            patchAssistant((blocks) => {
              const copy = [...blocks];
              const last = copy[copy.length - 1];
              if (last && last.type === "text") {
                copy[copy.length - 1] = { type: "text", text: last.text + (last.text ? "\n" : "") + e.delta };
              } else {
                copy.push({ type: "text", text: e.delta });
              }
              return copy;
            });
            break;
          }
          case "step": {
            patchAssistant((blocks) => {
              const copy = [...blocks];
              const idx = copy.findIndex((b) => b.type === "step" && b.id === e.id);
              const block: AgentBlock = {
                type: "step",
                id: e.id,
                kind: e.kind,
                status: e.status,
                label: e.label,
                detail: e.detail,
              };
              if (idx >= 0) copy[idx] = block;
              else copy.push(block);
              return copy;
            });
            break;
          }
          case "clarification": {
            narration += e.text + "\n";
            patchAssistant((blocks) => [...blocks, { type: "text", text: e.text }]);
            break;
          }
          case "dashboard": {
            producedSummary = e.dashboard.summary;
            const version: DashboardVersion = {
              dashboard: e.dashboard,
              queries: e.queries,
              question: text,
            };
            setVersions((v) => {
              const next = [...v, version];
              producedVersionIndex = next.length - 1;
              setActiveVersion(next.length - 1);
              patchAssistant((b) => b, producedVersionIndex);
              return next;
            });
            break;
          }
          case "error": {
            patchAssistant((blocks) => [...blocks, { type: "text", text: `⚠️ ${e.message}` }]);
            break;
          }
          case "done":
            break;
        }
      };

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: apiMessages }),
        });
        if (!res.body) throw new Error("No response stream");

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              handle(JSON.parse(line) as ScoutEvent);
            } catch {
              /* ignore malformed line */
            }
          }
        }
      } catch (err) {
        patchAssistant((blocks) => [
          ...blocks,
          { type: "text", text: `⚠️ ${err instanceof Error ? err.message : String(err)}` },
        ]);
      } finally {
        const assistantContent = [narration.trim(), producedSummary].filter(Boolean).join("\n\n");
        historyRef.current = [
          ...apiMessages,
          { role: "assistant", content: assistantContent || "(analysis delivered as a dashboard)" },
        ];
        setIsRunning(false);
      }
    },
    [isRunning, patchAssistant],
  );

  // ── File upload ────────────────────────────────────────────────────────────

  const uploadFile = useCallback(
    async (file: File) => {
      if (isRunning) return;
      setIsRunning(true);
      const uploadStepId = `up_${Date.now()}`;

      setTurns((t) => [
        ...t,
        { role: "user", text: `📎 ${file.name}` },
        {
          role: "assistant",
          blocks: [
            { type: "step", id: uploadStepId, kind: "discover", status: "running", label: `Ingesting ${file.name}` },
          ],
        },
      ]);

      const patchStep = (status: "done" | "error", label: string, detail: string) => {
        setTurns((t) => {
          const copy = [...t];
          const last = copy[copy.length - 1];
          if (!last || last.role !== "assistant") return t;
          const blocks = (last.blocks ?? []).map((b) =>
            b.type === "step" && b.id === uploadStepId ? { ...b, status, label, detail } : b,
          );
          copy[copy.length - 1] = { ...last, blocks };
          return copy;
        });
      };

      try {
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch("/api/upload", { method: "POST", body: fd });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Upload failed");
        if (data.alreadyExists) {
          patchStep("done", "Using existing table (skipped upload)", `${data.table} · ${Number(data.rowCount).toLocaleString()} rows`);
        } else {
          patchStep("done", "Ingested into ClickHouse", `${data.table} · ${Number(data.rowCount).toLocaleString()} rows`);
        }
        setIsRunning(false);
        send(
          `Analyse the newly uploaded table \`${data.table}\` (from the file "${file.name}", ${data.rowCount} rows). Profile it and summarise the key findings with charts.`,
        );
      } catch (e) {
        patchStep("error", "Ingestion failed", e instanceof Error ? e.message : String(e));
        setTurns((t) => {
          const copy = [...t];
          const last = copy[copy.length - 1];
          if (last?.role === "assistant") {
            copy[copy.length - 1] = {
              ...last,
              blocks: [...(last.blocks ?? []), { type: "text", text: `⚠️ ${e instanceof Error ? e.message : String(e)}` }],
            };
          }
          return copy;
        });
        setIsRunning(false);
      }
    },
    [isRunning, send],
  );

  return {
    turns,
    versions,
    activeVersion,
    isRunning,
    setActiveVersion,
    send,
    uploadFile,
    clearChat,
  };
}
