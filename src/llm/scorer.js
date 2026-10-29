import { loadConfig, envInt } from '../lib/config.js';
import { buildSystemPrompt, buildUserPrompt, EVALUATION_JSON_SCHEMA } from './prompt.js';
import { extractJson, validateEvaluation } from './validate.js';
import { providerChain, llmTimeoutMs } from './providers.js';

/**
 * Score one application.
 *
 * Strategy:
 *   1. Build the system + user prompt once.
 *   2. Walk the provider chain in priority order.
 *   3. For each provider, attempt (1 + maxRetriesPerProvider) calls. A call is
 *      retried when it throws a retryable error (429/5xx/timeout) OR when it
 *      returns content we cannot parse into a valid evaluation.
 *   4. The first provider that yields a valid evaluation wins.
 *   5. If every provider fails, throw a ScoringError that carries the attempts,
 *      so the caller can park the application for manual review instead of
 *      silently dropping it.
 *
 * Returns { evaluation, provider, model, attempts, latency_ms }.
 */
export async function scoreApplication(application, { config = loadConfig(), providers } = {}) {
  const chain = providers ?? providerChain();
  if (!chain.length) {
    throw new ScoringError('No LLM provider is configured. Set GEMINI_API_KEY, GROQ_API_KEY, or OPENROUTER_API_KEY.', []);
  }

  const temperature = Number(process.env.LLM_TEMPERATURE ?? config.scoring.temperature ?? 0);
  const maxRetries = envInt('LLM_MAX_RETRIES', config.scoring.max_retries_per_provider ?? 1);
  const timeoutMs = llmTimeoutMs();
  const system = buildSystemPrompt(config);
  const user = buildUserPrompt(application, config);

  const attempts = [];
  const startedAt = Date.now();

  for (const provider of chain) {
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const t0 = Date.now();
      try {
        const text = await provider.call({
          system,
          user,
          temperature,
          timeoutMs,
          jsonSchema: EVALUATION_JSON_SCHEMA,
        });
        const parsed = extractJson(text);
        if (!parsed) {
          attempts.push({ provider: provider.name, model: provider.model, attempt, ok: false, reason: 'unparseable_json', ms: Date.now() - t0 });
          continue;
        }
        const { ok, evaluation, errors } = validateEvaluation(parsed, config);
        if (!ok) {
          attempts.push({ provider: provider.name, model: provider.model, attempt, ok: false, reason: `invalid_evaluation: ${errors.join('; ')}`, ms: Date.now() - t0 });
          continue;
        }
        attempts.push({ provider: provider.name, model: provider.model, attempt, ok: true, ms: Date.now() - t0 });
        return {
          evaluation,
          provider: provider.name,
          model: provider.model,
          attempts,
          latency_ms: Date.now() - startedAt,
          partial_errors: errors,
        };
      } catch (err) {
        const retryable = err.retryable !== false;
        attempts.push({
          provider: provider.name,
          model: provider.model,
          attempt,
          ok: false,
          reason: err.name === 'AbortError' ? 'timeout' : String(err.message || err),
          ms: Date.now() - t0,
        });
        if (!retryable) break; // move to the next provider immediately
      }
    }
  }

  throw new ScoringError('All LLM providers failed to return a valid evaluation.', attempts);
}

export class ScoringError extends Error {
  constructor(message, attempts) {
    super(message);
    this.name = 'ScoringError';
    this.attempts = attempts ?? [];
  }
}
