import { loadConfig } from '../lib/config.js';
import { clampScore } from '../lib/util.js';

/**
 * Extract the first balanced JSON object from a model response. Models
 * sometimes wrap JSON in prose or markdown fences despite instructions;
 * rather than failing, we recover the object.
 */
export function extractJson(text) {
  if (typeof text !== 'string') return null;
  let s = text.trim();

  // Strip markdown code fences.
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  const start = s.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i += 1) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        const candidate = s.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function asStringArray(v, limit = 5) {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x) => typeof x === 'string')
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, limit);
}

/**
 * Validate a parsed evaluation against the configured rubric and normalise it.
 * Returns { ok, evaluation, errors }.
 *
 * We accept a slightly malformed model response as long as the substance is
 * usable: missing criteria are zero-filled, over-max scores are clamped, and
 * the total is recomputed from the criteria rather than trusted.
 */
export function validateEvaluation(parsed, config = loadConfig()) {
  const errors = [];
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, evaluation: null, errors: ['response was not a JSON object'] };
  }

  const expected = config.scoring.weights;
  const byName = new Map();
  if (Array.isArray(parsed.criteria)) {
    for (const c of parsed.criteria) {
      if (!c || typeof c !== 'object') continue;
      const name = String(c.name ?? '').trim().toLowerCase().replace(/\s+/g, '_');
      if (Object.hasOwn(expected, name) && !byName.has(name)) byName.set(name, c);
    }
  }

  const criteria = [];
  for (const [name, max] of Object.entries(expected)) {
    const c = byName.get(name);
    if (!c) {
      errors.push(`missing criterion: ${name}`);
      criteria.push({ name, score: 0, max, justification: 'Not provided by the model; scored zero.' });
      continue;
    }
    const score = clampScore(c.score, max);
    criteria.push({
      name,
      score,
      max,
      justification: String(c.justification ?? '').trim().slice(0, 1200) || 'No justification provided.',
    });
  }

  const total = criteria.reduce((sum, c) => sum + c.score, 0);
  const recommendation = parsed.recommendation === 'shortlist' ? 'shortlist' : 'reject';

  const evaluation = {
    total_score: total,
    criteria,
    strengths: asStringArray(parsed.strengths),
    concerns: asStringArray(parsed.concerns),
    recommendation,
  };

  // The response is usable as long as we recovered at least one real criterion.
  const recovered = criteria.filter((c) => byName.has(c.name)).length;
  const ok = recovered > 0;
  if (!ok) errors.push('no recognisable criteria in response');

  return { ok, evaluation, errors };
}
