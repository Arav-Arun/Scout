// LLM client (lib/agent/llm.ts) — thin wrapper over the OpenAI SDK exposing one reusable
// llmJSON() call that returns parsed JSON, with a defensive brace-extraction fallback.
//
// Requests are STREAMED (stream: true) and reassembled here. This is deliberate: a non-streaming
// completion sends no bytes until the whole answer is generated, so the socket sits idle for the
// entire generation. Any proxy in the path (Railway's edge, a load balancer) closes an idle
// connection, which undici surfaces as "Premature close" when we finally read the body. The large
// synthesis call (max_tokens 3500) is slow enough to hit this on every attempt, so retrying a
// non-streamed call can't help. Streaming keeps tokens flowing, so the connection never goes idle.
// A transient-drop retry still wraps the whole read as a backstop for genuine mid-stream failures.

import OpenAI from "openai";

let _openai: OpenAI | null = null;

function openai(): OpenAI {
  if (!_openai) {
    if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
    // maxRetries: SDK backs off on connection resets / 429 / 5xx while opening the stream.
    // timeout: generous ceiling for the full streamed response (route maxDuration is 300s).
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 3, timeout: 120_000 });
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
