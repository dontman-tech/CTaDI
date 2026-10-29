#!/usr/bin/env node
/**
 * Run the three sample applicants through the real pipeline and print a
 * report. With an LLM key set this uses the real model; without one it falls
 * back to a local heuristic so the plumbing can still be demonstrated.
 *
 *   node scripts/run-samples.js            # real scoring if a key is set
 *   node scripts/run-samples.js --offline  # force the local heuristic
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadConfig } from '../src/lib/config.js';
import { validateSubmission } from '../src/lib/form.js';
import { scoreApplication } from '../src/llm/scorer.js';
import { providerChain } from '../src/llm/providers.js';
import { heuristicEvaluation } from '../test/helpers/fake-provider.js';

const offline = process.argv.includes('--offline') || !providerChain().length;
const config = loadConfig();
const samples = JSON.parse(fs.readFileSync(path.join(ROOT, 'samples', 'applicants.json'), 'utf8'));
const keys = ['strong', 'borderline', 'weak', 'injection'];

const scorer = offline
  ? async (application) => ({ evaluation: heuristicEvaluation(application), provider: 'heuristic', model: 'offline', attempts: [], latency_ms: 0 })
  : scoreApplication;

console.log(`\nCTaDI sample scoring — ${offline ? 'OFFLINE heuristic (no API key configured)' : 'LIVE via ' + providerChain().map((p) => p.name).join(' -> ')}`);
console.log(`Shortlist threshold: ${config.scoring.shortlist_threshold}\n`);

const results = [];
for (const key of keys) {
  const { ok, application, errors } = validateSubmission(samples[key]);
  if (!ok) {
    console.error(`  ${key}: INVALID SAMPLE — ${errors.join(', ')}`);
    continue;
  }
  const t0 = Date.now();
  const res = await scorer(application, { config });
  const shortlisted = res.evaluation.total_score >= config.scoring.shortlist_threshold;
  results.push({ key, score: res.evaluation.total_score, shortlisted, provider: res.provider });
  console.log(`${key.padEnd(11)} ${String(res.evaluation.total_score).padStart(3)}/100  ${shortlisted ? 'SHORTLIST ✓' : 'reject     '}  (${res.provider}, ${Date.now() - t0}ms)`);
  console.log(`            strengths: ${res.evaluation.strengths.join(' | ') || '—'}`);
  console.log(`            concerns : ${res.evaluation.concerns.join(' | ') || '—'}`);
  if (application.injection_flag) console.log(`            ⚠ injection attempt detected and flagged for manual review`);
  console.log();
}

console.log('Expected outcomes:');
console.log('  strong      -> SHORTLIST (clearly above threshold)');
console.log('  borderline  -> near the threshold, either side, decided by the human');
console.log('  weak        -> reject (clearly below threshold)');
console.log('  injection   -> reject, and flagged for manual review\n');
