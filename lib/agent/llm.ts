// LLM client (lib/agent/llm.ts) — thin wrapper over the OpenAI SDK exposing one reusable
// llmJSON() call that returns parsed JSON, with a defensive brace-extraction fallback.

import OpenAI from "openai";

let _openai: OpenAI | null = null;

function openai(): OpenAI {
  if (!_openai) {
    if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _openai;
}

/** One JSON-returning LLM call, with defensive parsing. */
export async function llmJSON<T = Record<string, unknown>>(
  system: string,
  user: string,
  selectedModel: string,
  maxTokens = 1600,
): Promise<T> {
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
}
