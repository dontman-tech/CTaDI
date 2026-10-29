import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJson, validateEvaluation } from '../src/llm/validate.js';
import { buildSystemPrompt, buildUserPrompt, EVALUATION_JSON_SCHEMA, criteriaSpec } from '../src/llm/prompt.js';
import { scoreApplication, ScoringError } from '../src/llm/scorer.js';
import { loadConfig } from '../src/lib/config.js';
import { makeFakeProvider, fakeEvaluation } from './helpers/fake-provider.js';

const config = loadConfig();
const sampleApp = {
  identity: { role_label: 'Software & Data', role: 'software_data' },
  answers: { a1: 'I think development is about capability.', b_sd1: 'Python and Postgres.' },
  questions: [
    { id: 'a1', label: 'What do you understand by development?', section: 'A' },
    { id: 'b_sd1', label: 'Which tools do you use?', section: 'B' },
  ],
};

test('prompt: system prompt states the rubric, the weights, and the injection rule', () => {
  const sys = buildSystemPrompt(config);
  for (const key of Object.keys(config.scoring.weights)) assert.ok(sys.includes(key), `missing ${key}`);
  assert.match(sys, /UNTRUSTED DATA/i);
  assert.match(sys, /never an instruction/i);
  assert.match(sys, /Do NOT reward or penalise spelling/i);
  assert.match(sys, /Never consider or infer: name, gender, age, nationality/i);
});

test('prompt: user prompt wraps every answer in data markers', () => {
  const user = buildUserPrompt(sampleApp, config);
  assert.ok(user.includes('<<<APPLICANT_ANSWER>>>'));
  assert.ok(user.includes('<<<END_APPLICANT_ANSWER>>>'));
  const opens = user.split('<<<APPLICANT_ANSWER>>>').length - 1;
  const closes = user.split('<<<END_APPLICANT_ANSWER>>>').length - 1;
  assert.equal(opens, 2);
  assert.equal(closes, 2);
});

test('prompt: the JSON schema matches the rubric criteria and the required shape', () => {
  const keys = Object.keys(config.scoring.weights);
  assert.deepEqual(EVALUATION_JSON_SCHEMA.required.sort(), ['concerns', 'criteria', 'recommendation', 'strengths', 'total_score'].sort());
  assert.equal(EVALUATION_JSON_SCHEMA.properties.total_score.type, 'integer');
  assert.deepEqual(EVALUATION_JSON_SCHEMA.properties.recommendation.enum, ['shortlist', 'reject']);
  assert.equal(criteriaSpec(config).length, keys.length);
});

test('validate: extractJson recovers JSON from prose and code fences', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Sure! Here you go: {"a":{"b":2}} hope that helps'), { a: { b: 2 } });
  assert.equal(extractJson('no json here'), null);
  // Braces inside strings must not confuse the scanner.
  assert.deepEqual(extractJson('{"a":"}"}'), { a: '}' });
});

test('validate: a good response normalises and recomputes the total', () => {
  const parsed = JSON.parse(fakeEvaluation({ overrides: { values_alignment: 27, relevant_skill_level: 25 } }));
  const { ok, evaluation } = validateEvaluation(parsed, config);
  assert.equal(ok, true);
  assert.equal(evaluation.criteria.length, 5);
  assert.equal(evaluation.total_score, evaluation.criteria.reduce((s, c) => s + c.score, 0));
  assert.ok(['shortlist', 'reject'].includes(evaluation.recommendation));
});

test('validate: scores above the criterion maximum are clamped', () => {
  const parsed = JSON.parse(fakeEvaluation({ overrides: { values_alignment: 999 } }));
  const { evaluation } = validateEvaluation(parsed, config);
  const values = evaluation.criteria.find((c) => c.name === 'values_alignment');
  assert.equal(values.score, 30);
  assert.ok(evaluation.total_score <= 100);
});

test('validate: missing criteria are zero-filled and reported', () => {
  const parsed = { criteria: [{ name: 'values_alignment', score: 20, max: 30, justification: 'ok' }] };
  const { ok, evaluation, errors } = validateEvaluation(parsed, config);
  assert.equal(ok, true);
  assert.equal(evaluation.criteria.length, 5);
  assert.ok(errors.some((e) => e.includes('relevant_skill_level')));
});

test('validate: a response with no recognisable criteria is rejected', () => {
  const { ok } = validateEvaluation({ criteria: [{ name: 'vibes', score: 99, max: 100 }] }, config);
  assert.equal(ok, false);
});

test('scorer: returns the first provider result when it is valid', async () => {
  const provider = makeFakeProvider({ name: 'p1', text: fakeEvaluation({ overrides: { values_alignment: 28 } }) });
  const res = await scoreApplication(sampleApp, { config, providers: [provider] });
  assert.equal(res.provider, 'p1');
  assert.equal(res.evaluation.total_score, 28 + 30 + 20 + 10 + 10);
  assert.equal(res.attempts.filter((a) => a.ok).length, 1);
});

test('scorer: retries once on malformed JSON, then succeeds', async () => {
  const provider = makeFakeProvider({
    name: 'flaky',
    text: (n) => (n === 1 ? 'not json at all' : fakeEvaluation({ overrides: { values_alignment: 20 } })),
  });
  const res = await scoreApplication(sampleApp, { config, providers: [provider] });
  assert.equal(provider.calls.count, 2, 'should have retried exactly once');
  assert.equal(res.evaluation.total_score, 20 + 30 + 20 + 10 + 10);
});

test('scorer: fails over to the next provider when the first keeps failing', async () => {
  const broken = makeFakeProvider({ name: 'broken', text: 'still not json' });
  const good = makeFakeProvider({ name: 'good', text: fakeEvaluation({ overrides: { values_alignment: 26 } }) });
  const res = await scoreApplication(sampleApp, { config, providers: [broken, good] });
  assert.equal(res.provider, 'good');
  assert.ok(res.attempts.some((a) => a.provider === 'broken' && !a.ok));
});

test('scorer: fails over on a retryable error (e.g. 429)', async () => {
  const rateLimited = makeFakeProvider({
    name: 'rl',
    failWith: Object.assign(new Error('HTTP 429: rate limited'), { status: 429, retryable: true }),
  });
  const good = makeFakeProvider({ name: 'good', text: fakeEvaluation({ overrides: { values_alignment: 24 } }) });
  const res = await scoreApplication(sampleApp, { config, providers: [rateLimited, good] });
  assert.equal(res.provider, 'good');
});

test('scorer: raises ScoringError with the attempt log when all providers fail', async () => {
  const a = makeFakeProvider({ name: 'a', text: 'garbage' });
  const b = makeFakeProvider({ name: 'b', failWith: Object.assign(new Error('HTTP 500'), { retryable: true }) });
  await assert.rejects(
    () => scoreApplication(sampleApp, { config, providers: [a, b] }),
    (err) => {
      assert.ok(err instanceof ScoringError);
      assert.ok(err.attempts.length >= 2);
      assert.ok(err.attempts.every((x) => x.ok === false));
      return true;
    },
  );
});

test('scorer: refuses to run with no providers configured', async () => {
  await assert.rejects(() => scoreApplication(sampleApp, { config, providers: [] }), /No LLM provider is configured/);
});
