// LLM client (lib/agent/llm.ts) — thin wrapper over the OpenAI SDK exposing one reusable
// llmJSON() call that returns parsed JSON, with a defensive brace-extraction fallback.
//
// ROOT CAUSE of the "Premature close" synthesis failures: the OpenAI SDK (node-fetch path) pools
// keep-alive TLS sockets to api.openai.com. Synthesis is the only phase that runs *after* the
// ClickHouse query phase, so its pooled socket sits idle for seconds while queries run; the remote
// (or a proxy in a deployed container) drops that idle socket, and the large synthesis request sent
// over the now-dead socket fails with "Premature close". Plan/analyze don't hit it — no long idle
// gap, smaller bodies. The fix is `keepAlive: false`: a fresh connection per request, so no pooled
// socket can ever go stale. Streaming + a transient-drop retry remain as belt-and-suspenders.

import OpenAI from "openai";
import { Agent } from "node:https";

let _openai: OpenAI | null = null;

// A fresh TLS connection per request — never reuse a pooled socket that may have gone stale during
// the idle gap before synthesis. This is the concrete fix for the "Premature close" failures.
const httpsAgent = new Agent({ keepAlive: false });

function openai(): OpenAI {
  if (!_openai) {
    if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
    // httpAgent: fresh connection per request (see file header). maxRetries: SDK backs off on
    // connection resets / 429 / 5xx. timeout: ceiling for the full response (route maxDuration 300s).
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, httpAgent: httpsAgent, maxRetries: 3, timeout: 120_000 });
  }
  return _openai;
}

/** True for transient network failures worth another attempt (dropped socket, premature close, timeout). */
function isTransientNetworkError(e: unknown): boolean {
  const err = e as { message?: string; cause?: unknown; status?: number };
  const text = `${err?.message ?? ""} ${String(err?.cause ?? "")}`.toLowerCase();
  if (/premature close|econnreset|econnrefused|etimedout|socket hang up|fetch failed|terminated|network error|aborted|timed out|timeout/.test(text)) return true;
  // APIConnectionError from the SDK carries no HTTP status; a 5xx is also worth a retry.
  return err?.status === undefined ? /connection error/.test(text) : err.status >= 500;
}

/** Stream a JSON completion and reassemble the full text (see file header for why we stream). */
async function streamJSONText(system: string, user: string, model: string, maxTokens: number): Promise<string> {
  const stream = await openai().chat.completions.create({
    model,
    temperature: 0.1,
    max_tokens: maxTokens,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    stream: true,
  });
  let txt = "";
  for await (const chunk of stream) txt += chunk.choices[0]?.delta?.content ?? "";
  return txt;
}

/** One JSON-returning LLM call, with defensive parsing and a retry on transient network drops. */
export async function llmJSON<T = Record<string, unknown>>(
  system: string,
  user: string,
  selectedModel: string,
  maxTokens = 1600,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const txt = (await streamJSONText(system, user, selectedModel, maxTokens)) || "{}";
      try {
        return JSON.parse(txt) as T;
      } catch {
        const s = txt.indexOf("{");
        const e = txt.lastIndexOf("}");
        if (s >= 0 && e > s) return JSON.parse(txt.slice(s, e + 1)) as T;
        throw new Error("Model did not return valid JSON");
      }
    } catch (e) {
      lastErr = e;
      // Only retry transient network drops; a bad-JSON / auth / bad-request error is final.
      if (attempt < 2 && isTransientNetworkError(e)) {
        await new Promise((res) => setTimeout(res, 500 * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}
