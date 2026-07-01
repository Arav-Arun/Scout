// LLM client (lib/agent/llm.ts) — thin wrapper over the OpenAI SDK exposing one reusable
// llmJSON() call that returns parsed JSON, with a defensive brace-extraction fallback.
// The long synthesis call is prone to the upstream dropping the response body mid-flight
// ("Premature close"), so calls are retried on transient network failures.

import OpenAI from "openai";

let _openai: OpenAI | null = null;

function openai(): OpenAI {
  if (!_openai) {
    if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
    // maxRetries: let the SDK back off on connection resets / 429 / 5xx; timeout guards a hung socket.
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 3, timeout: 90_000 });
  }
  return _openai;
}

/** True for transient network failures worth another attempt (dropped socket, premature close, timeout). */
function isTransientNetworkError(e: unknown): boolean {
  const err = e as { message?: string; cause?: unknown; status?: number };
  const text = `${err?.message ?? ""} ${String(err?.cause ?? "")}`.toLowerCase();
  if (/premature close|econnreset|econnrefused|etimedout|socket hang up|fetch failed|terminated|network error/.test(text)) return true;
  // APIConnectionError from the SDK carries no HTTP status; a 5xx is also worth a retry.
  return err?.status === undefined ? /connection error/.test(text) : err.status >= 500;
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
      const r = await openai().chat.completions.create({
        model: selectedModel,
        temperature: 0.1,
        max_tokens: maxTokens,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      });
      const txt = r.choices[0]?.message?.content ?? "{}";
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
