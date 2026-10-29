import { env, envInt } from '../lib/config.js';

/**
 * Provider adapters. Every adapter exposes the same interface:
 *   { name, model, isConfigured(), call({ system, user, temperature, timeoutMs, jsonSchema }) }
 * and returns the raw text of the model's reply.
 *
 * All four speak a different dialect of the same "chat completion" idea, so the
 * differences are isolated here and the rest of the codebase never branches on
 * provider.
 */

const JSON_INSTRUCTION =
  '\n\nRespond with a single valid JSON object only. No markdown, no commentary.';

async function postJson(url, headers, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
      err.status = res.status;
      // 429 and 5xx are worth retrying or failing over; 4xx usually is not.
      err.retryable = res.status === 429 || res.status >= 500;
      throw err;
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

function geminiProvider() {
  const apiKey = env('GEMINI_API_KEY');
  const model = env('GEMINI_MODEL', 'gemini-2.5-flash');
  return {
    name: 'gemini',
    model,
    isConfigured: () => Boolean(apiKey),
    async call({ system, user, temperature, timeoutMs, jsonSchema }) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      const generationConfig = {
        temperature,
        responseMimeType: 'application/json',
        ...(jsonSchema ? { responseSchema: toGeminiSchema(jsonSchema) } : {}),
      };
      const data = await postJson(
        url,
        { 'x-goog-api-key': apiKey },
        {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user + JSON_INSTRUCTION }] }],
          generationConfig,
        },
        timeoutMs,
      );
      const parts = data?.candidates?.[0]?.content?.parts ?? [];
      const text = parts.map((p) => p.text ?? '').join('');
      if (!text) {
        const err = new Error(`empty response from gemini (finishReason=${data?.candidates?.[0]?.finishReason})`);
        err.retryable = true;
        throw err;
      }
      return text;
    },
  };
}

/** Convert a subset of JSON Schema to Gemini's responseSchema dialect. */
function toGeminiSchema(schema) {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'additionalProperties' || k === '$schema' || k === 'minLength') continue;
    if (k === 'type' && typeof v === 'string') {
      out.type = v.toUpperCase();
      continue;
    }
    if (k === 'enum' || k === 'required') {
      out[k] = v;
      continue;
    }
    out[k] = toGeminiSchema(v);
  }
  return out;
}

function openAiCompatible({ name, baseUrl, apiKey, model, extraHeaders = {} }) {
  return {
    name,
    model,
    isConfigured: () => Boolean(apiKey && baseUrl),
    async call({ system, user, temperature, timeoutMs, jsonSchema }) {
      const body = {
        model,
        temperature,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user + JSON_INSTRUCTION },
        ],
        response_format: { type: 'json_object' },
      };
      // Ask for schema-constrained output where the provider supports it, but
      // never depend on it: some free endpoints reject the field outright.
      if (jsonSchema) body.response_format = { type: 'json_object' };
      const data = await postJson(
        `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`,
        { authorization: `Bearer ${apiKey}`, ...extraHeaders },
        body,
        timeoutMs,
      );
      const text = data?.choices?.[0]?.message?.content ?? '';
      if (!text) {
        const err = new Error(`empty response from ${name}`);
        err.retryable = true;
        throw err;
      }
      return text;
    },
  };
}

function groqProvider() {
  return openAiCompatible({
    name: 'groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKey: env('GROQ_API_KEY'),
    model: env('GROQ_MODEL', 'openai/gpt-oss-120b'),
  });
}

function openRouterProvider() {
  return openAiCompatible({
    name: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: env('OPENROUTER_API_KEY'),
    model: env('OPENROUTER_MODEL', 'google/gemma-4-31b-it:free'),
    extraHeaders: { 'x-title': 'CTaDI Onboarding' },
  });
}

function customProvider() {
  return openAiCompatible({
    name: 'openai-compatible',
    baseUrl: env('OPENAI_COMPAT_BASE_URL'),
    apiKey: env('OPENAI_COMPAT_API_KEY'),
    model: env('OPENAI_COMPAT_MODEL', 'default'),
  });
}

/**
 * The failover chain, in priority order. Only configured providers are used.
 * Order: Gemini free tier (best quality/limits) -> Groq (fast, reliable) ->
 * OpenRouter free models -> any custom OpenAI-compatible endpoint.
 */
export function providerChain() {
  return [geminiProvider(), groqProvider(), openRouterProvider(), customProvider()].filter((p) =>
    p.isConfigured(),
  );
}

export function llmTimeoutMs() {
  return envInt('LLM_TIMEOUT_MS', 45000);
}
