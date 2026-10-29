import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { providerChain } from '../src/llm/providers.js';
import { scoreApplication, ScoringError } from '../src/llm/scorer.js';
import { loadConfig } from '../src/lib/config.js';
import { checkRateLimit, rateLimit, clientIp, __resetRateLimit } from '../src/lib/http.js';
import { getStore, __resetStore } from '../src/store/index.js';
import { makeFakeProvider } from './helpers/fake-provider.js';

const config = loadConfig();

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// --- DeepSeek provider ------------------------------------------------------

test('providers: DeepSeek is the primary provider when its key is set', () => {
  withEnv(
    { DEEPSEEK_API_KEY: 'k', DEEPSEEK_MODEL: 'deepseek-v4-flash', GROQ_API_KEY: undefined, OPENROUTER_API_KEY: undefined, OPENAI_COMPAT_API_KEY: undefined },
    () => {
      const chain = providerChain();
      assert.equal(chain.length, 1);
      assert.equal(chain[0].name, 'deepseek');
      assert.equal(chain[0].model, 'deepseek-v4-flash');
      assert.equal(chain[0].isConfigured(), true);
    },
  );
});

test('providers: the chain order is deepseek -> groq -> openrouter -> custom', () => {
  withEnv(
    {
      DEEPSEEK_API_KEY: 'd',
      GROQ_API_KEY: 'g',
      OPENROUTER_API_KEY: 'o',
      OPENAI_COMPAT_API_KEY: 'c',
      OPENAI_COMPAT_BASE_URL: 'https://example.org/v1',
    },
    () => {
      assert.deepEqual(providerChain().map((p) => p.name), ['deepseek', 'groq', 'openrouter', 'openai-compatible']);
    },
  );
});

test('providers: an unconfigured DeepSeek is dropped from the chain', () => {
  withEnv({ DEEPSEEK_API_KEY: undefined, GROQ_API_KEY: 'g' }, () => {
    const names = providerChain().map((p) => p.name);
    assert.ok(!names.includes('deepseek'));
    assert.ok(names.includes('groq'));
  });
});

test('providers: the DeepSeek base URL honours the env override and tolerates a trailing slash', async () => {
  let seenUrl = null;
  const server = http.createServer((req, res) => {
    seenUrl = req.url;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '{}' } }] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    await withEnvAsync(
      { DEEPSEEK_API_KEY: 'k', DEEPSEEK_API_BASE_URL: `http://127.0.0.1:${port}/v1/` },
      async () => {
        const provider = providerChain()[0];
        await provider.call({ system: 's', user: 'u', temperature: 0, timeoutMs: 5000 });
        assert.equal(seenUrl, '/v1/chat/completions', 'trailing slash must not double up');
      },
    );
  } finally {
    await new Promise((r) => server.close(r));
  }
});

async function withEnvAsync(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// --- Scoring time budget ----------------------------------------------------

test('scorer: stops with a time-budget error rather than running past the deadline', async () => {
  // A provider that never returns within the budget.
  const slow = makeFakeProvider({ name: 'slow', delayMs: 5000, text: '{}' });
  const application = {
    identity: { role: 'research', role_label: 'Research' },
    answers: { a1: 'Development is about capability.' },
    questions: [{ id: 'a1', label: 'What is development?', section: 'A' }],
  };
  await withEnvAsync({ LLM_TOTAL_BUDGET_MS: '1200' }, async () => {
    const started = Date.now();
    await assert.rejects(
      () => scoreApplication(application, { config, providers: [slow] }),
      (err) => {
        assert.ok(err instanceof ScoringError, `expected ScoringError, got ${err.name}: ${err.message}`);
        assert.ok(err.attempts.some((a) => a.reason === 'time_budget_exhausted' || a.reason === 'timeout'));
        return true;
      },
    );
    assert.ok(Date.now() - started < 4000, 'should have stopped near the budget, not waited for the slow provider');
  });
});

// --- Failover ---------------------------------------------------------------

test('scorer: a 401 from the primary provider fails over to the next one', async () => {
  // Two fake OpenAI-compatible upstreams: the primary rejects the key, the
  // fallback returns a valid evaluation.
  const unauthorised = http.createServer((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Authentication Fails', code: 'invalid_request_error' } }));
  });
  const good = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                total_score: 71,
                criteria: [
                  { name: 'values_alignment', score: 22, max: 30, justification: 'ok' },
                  { name: 'relevant_skill_level', score: 22, max: 30, justification: 'ok' },
                  { name: 'quality_of_thinking', score: 14, max: 20, justification: 'ok' },
                  { name: 'evidence_of_real_work', score: 8, max: 10, justification: 'ok' },
                  { name: 'commitment_and_availability', score: 5, max: 10, justification: 'ok' },
                ],
                strengths: ['s'],
                concerns: ['c'],
                recommendation: 'shortlist',
              }),
            },
          },
        ],
      }),
    );
  });
  await new Promise((r) => unauthorised.listen(0, '127.0.0.1', r));
  await new Promise((r) => good.listen(0, '127.0.0.1', r));

  try {
    await withEnvAsync(
      {
        DEEPSEEK_API_KEY: 'bad-key',
        DEEPSEEK_API_BASE_URL: `http://127.0.0.1:${unauthorised.address().port}`,
        GROQ_API_KEY: undefined,
        OPENROUTER_API_KEY: undefined,
        OPENAI_COMPAT_BASE_URL: `http://127.0.0.1:${good.address().port}`,
        OPENAI_COMPAT_API_KEY: 'good-key',
        OPENAI_COMPAT_MODEL: 'fallback-model',
      },
      async () => {
        const chain = providerChain();
        assert.deepEqual(chain.map((p) => p.name), ['deepseek', 'openai-compatible']);

        const application = {
          identity: { role: 'research', role_label: 'Research' },
          answers: { a1: 'Development is about capability.' },
          questions: [{ id: 'a1', label: 'What is development?', section: 'A' }],
        };
        const result = await scoreApplication(application, { config, providers: chain });

        assert.equal(result.provider, 'openai-compatible', 'the fallback provider must serve the result');
        assert.equal(result.evaluation.total_score, 71);
        assert.equal(result.attempts[0].provider, 'deepseek');
        assert.equal(result.attempts[0].ok, false);
        assert.match(result.attempts[0].reason, /401|Authentication/i);
      },
    );
  } finally {
    await new Promise((r) => unauthorised.close(r));
    await new Promise((r) => good.close(r));
  }
});

// --- Rate limiter -----------------------------------------------------------

test('rate limiter: the in-process limiter counts within the window', () => {
  __resetRateLimit();
  const key = `test:${Math.random()}`;
  for (let i = 0; i < 3; i += 1) {
    const r = rateLimit(key, 3);
    assert.equal(r.allowed, true, `request ${i + 1} should be allowed`);
  }
  const blocked = rateLimit(key, 3);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.remaining, 0);
});

test('rate limiter: keys are independent', () => {
  __resetRateLimit();
  rateLimit('a:1', 1);
  assert.equal(rateLimit('a:1', 1).allowed, false);
  assert.equal(rateLimit('b:1', 1).allowed, true);
});

test('rate limiter: checkRateLimit uses the in-process backend by default', async () => {
  __resetRateLimit();
  await withEnvAsync({ RATE_LIMIT_BACKEND: undefined, UPSTASH_REDIS_REST_URL: undefined, UPSTASH_REDIS_REST_TOKEN: undefined }, async () => {
    const key = `d:${Math.random()}`;
    assert.equal((await checkRateLimit(key, 2)).allowed, true);
    assert.equal((await checkRateLimit(key, 2)).allowed, true);
    assert.equal((await checkRateLimit(key, 2)).allowed, false);
  });
});

test('rate limiter: the Upstash backend is used and enforces the limit', async () => {
  let counter = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      counter += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{ result: counter }, { result: 1 }]));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    await withEnvAsync(
      { RATE_LIMIT_BACKEND: 'upstash', UPSTASH_REDIS_REST_URL: `http://127.0.0.1:${server.address().port}`, UPSTASH_REDIS_REST_TOKEN: 't' },
      async () => {
        const key = `u:${Math.random()}`;
        assert.equal((await checkRateLimit(key, 2)).allowed, true);
        assert.equal((await checkRateLimit(key, 2)).allowed, true);
        const third = await checkRateLimit(key, 2);
        assert.equal(third.allowed, false, 'the distributed counter must be shared across calls');
      },
    );
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('rate limiter: falls back to in-process when the distributed backend errors', async () => {
  // Point at a port with nothing listening.
  await withEnvAsync(
    { RATE_LIMIT_BACKEND: 'upstash', UPSTASH_REDIS_REST_URL: 'http://127.0.0.1:1', UPSTASH_REDIS_REST_TOKEN: 't' },
    async () => {
      const r = await checkRateLimit(`fallback:${Math.random()}`, 5);
      assert.equal(r.allowed, true, 'a broken limiter must fail open, not block applicants');
    },
  );
});

test('rate limiter: clientIp reads x-forwarded-for, arrays, and x-real-ip', () => {
  assert.equal(clientIp({ headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' } }), '1.2.3.4');
  assert.equal(clientIp({ headers: { 'x-forwarded-for': ['9.9.9.9'] } }), '9.9.9.9');
  assert.equal(clientIp({ headers: { 'x-real-ip': '7.7.7.7' } }), '7.7.7.7');
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: '::1' } }), '::1');
});

// --- Store selection --------------------------------------------------------

test('store: defaults to json locally and supabase on Vercel', async () => {
  await withEnvAsync({ STORAGE_DRIVER: undefined, VERCEL: undefined, JSON_DB_PATH: '/tmp/ctadi-store-test.json' }, async () => {
    __resetStore();
    const s = await getStore();
    assert.equal(s.driver, 'json');
  });
  await withEnvAsync({ STORAGE_DRIVER: undefined, VERCEL: '1' }, async () => {
    __resetStore();
    // Supabase driver loads, but has no credentials configured, so any query
    // fails — that is fine; we only assert the driver was selected.
    const s = await getStore();
    assert.equal(s.driver, 'supabase');
  });
  __resetStore();
});

test('store: an unknown driver produces a helpful error', async () => {
  await withEnvAsync({ STORAGE_DRIVER: 'mongo' }, async () => {
    __resetStore();
    await assert.rejects(() => getStore(), /Unknown STORAGE_DRIVER "mongo"/);
  });
  __resetStore();
});

test('store: getStore is memoised across calls', async () => {
  await withEnvAsync({ STORAGE_DRIVER: 'json', JSON_DB_PATH: '/tmp/ctadi-store-test2.json' }, async () => {
    __resetStore();
    const a = await getStore();
    const b = await getStore();
    assert.equal(a, b, 'the same instance should be reused');
  });
  __resetStore();
});
