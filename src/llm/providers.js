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

function openAiCompatible({ name, baseUrl, apiKey, model, extraHeaders = {}, supportsJsonMode = true }) {
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
      };
      // Ask for schema-constrained output where the provider supports it, but
      // never depend on it: some free endpoints reject the field outright.
      if (supportsJsonMode) body.response_format = { type: 'json_object' };
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

/**
 * DeepSeek. Primary provider. Speaks the OpenAI chat-completions dialect, so
 * it shares the adapter above; it is only named separately so the chain reads
 * clearly and so its base URL stays configurable.
 */
function deepSeekProvider() {
  return openAiCompatible({
    name: 'deepseek',
    baseUrl: env('DEEPSEEK_API_BASE_URL', 'https://api.deepseek.com'),
    apiKey: env('DEEPSEEK_API_KEY'),
    model: env('DEEPSEEK_MODEL', 'deepseek-v4-flash'),
  });
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
 * Order: DeepSeek (primary) -> Groq (fast, reliable) -> OpenRouter free models
 * -> any custom OpenAI-compatible endpoint. Reorder by removing a key.
 */
export function providerChain() {
  return [deepSeekProvider(), groqProvider(), openRouterProvider(), customProvider()].filter((p) =>
    p.isConfigured(),
  );
}

export function llmTimeoutMs() {
  return envInt('LLM_TIMEOUT_MS', 45000);
}
