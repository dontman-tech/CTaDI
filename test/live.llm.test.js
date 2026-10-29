import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/lib/config.js';
import { scoreApplication } from '../src/llm/scorer.js';
import { providerChain } from '../src/llm/providers.js';
import { loadConfig } from '../src/lib/config.js';
import { validateSubmission } from '../src/lib/form.js';

/**
 * Live tests. They hit real providers and cost real (free-tier) quota, so they
 * are skipped unless CTADI_LIVE_TESTS=1 and at least one provider key is set.
 *
 *   CTADI_LIVE_TESTS=1 npm run test:live
 *
 * These are the tests that actually check scoring QUALITY: that a strong
 * applicant outscores a weak one, and that an injection attempt does not
 * inflate a score.
 */

const enabled = process.env.CTADI_LIVE_TESTS === '1';
const chain = providerChain();

if (!enabled) {
  test('live scoring tests are skipped (set CTADI_LIVE_TESTS=1 to run them)', (t) => {
    t.skip('CTADI_LIVE_TESTS is not set to 1');
  });
} else if (!chain.length) {
  test('live scoring tests are skipped (no provider key configured)', (t) => {
    t.skip('Set DEEPSEEK_API_KEY (or GROQ_API_KEY / OPENROUTER_API_KEY)');
  });
} else {
  const config = loadConfig();
  const samples = JSON.parse(fs.readFileSync(path.join(ROOT, 'samples', 'applicants.json'), 'utf8'));

  async function scoreSample(key) {
    const raw = samples[key];
    const { ok, application, errors } = validateSubmission(raw);
    assert.equal(ok, true, `sample ${key} must be valid: ${errors.join(', ')}`);
    return scoreApplication(application, { config });
  }

  test('live: the strong applicant is shortlisted', async () => {
    const res = await scoreSample('strong');
    console.log(`  strong -> ${res.evaluation.total_score}/100 via ${res.provider}`);
    assert.ok(res.evaluation.total_score >= config.scoring.shortlist_threshold, `expected >= ${config.scoring.shortlist_threshold}, got ${res.evaluation.total_score}`);
  });

  test('live: the weak applicant is not shortlisted', async () => {
    const res = await scoreSample('weak');
    console.log(`  weak -> ${res.evaluation.total_score}/100 via ${res.provider}`);
    assert.ok(res.evaluation.total_score < config.scoring.shortlist_threshold, `expected < ${config.scoring.shortlist_threshold}, got ${res.evaluation.total_score}`);
  });

  test('live: the strong applicant outscores the weak one', async () => {
    const [strong, weak] = await Promise.all([scoreSample('strong'), scoreSample('weak')]);
    console.log(`  strong ${strong.evaluation.total_score} vs weak ${weak.evaluation.total_score}`);
    assert.ok(strong.evaluation.total_score > weak.evaluation.total_score);
  });

  test('live: an injection attempt does not inflate the score', async () => {
    const res = await scoreSample('injection');
    console.log(`  injection -> ${res.evaluation.total_score}/100 via ${res.provider}`);
    assert.ok(res.evaluation.total_score < config.scoring.shortlist_threshold, 'the embedded instruction must not push it over the threshold');
  });
}
