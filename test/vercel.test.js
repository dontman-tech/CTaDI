import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Vercel deployment tests.
 *
 * These simulate the platform: a fake OpenAI-compatible upstream stands in for
 * DeepSeek, and the Vercel handler is driven with the request/response objects
 * Vercel actually provides (a Node IncomingMessage with a pre-parsed req.body,
 * and a ServerResponse). This catches the serverless-specific failure modes
 * that the local server cannot: a pre-parsed body, forwarded-host URL
 * construction, and lazy store loading.
 */

const tmpDb = path.join(process.env.TMPDIR || '/tmp', `ctadi-vercel-${process.pid}.json`);

// --- Fake DeepSeek upstream -------------------------------------------------
let upstreamCalls = 0;
let lastBody = null;
let lastAuth = null;
let mode = 'good';
const upstream = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => {
    raw += c;
  });
  req.on('end', () => {
    upstreamCalls += 1;
    lastAuth = req.headers.authorization;
    try {
      lastBody = JSON.parse(raw);
    } catch {
      lastBody = null;
    }
    if (mode === 'garbage') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ choices: [{ message: { content: 'not json' } }] }));
    }
    const evaluation = {
      total_score: 78,
      criteria: [
        { name: 'values_alignment', score: 25, max: 30, justification: 'Reasons about development as capability.' },
        { name: 'relevant_skill_level', score: 24, max: 30, justification: 'Names specific systems.' },
        { name: 'quality_of_thinking', score: 15, max: 20, justification: 'Argues rather than restates.' },
        { name: 'evidence_of_real_work', score: 8, max: 10, justification: 'Describes a real deployment.' },
        { name: 'commitment_and_availability', score: 6, max: 10, justification: 'Bounded, honest commitment.' },
      ],
      strengths: ['Concrete project history.'],
      concerns: ['Limited daytime availability.'],
      recommendation: 'shortlist',
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(evaluation) } }] }));
  });
});

let upstreamUrl;
let handler;
let server;
let base;
const sentEmails = [];

before(async () => {
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;

  process.env.VERCEL = '1'; // makes the store default to supabase; we override below
  process.env.STORAGE_DRIVER = 'json';
  process.env.JSON_DB_PATH = tmpDb;
  process.env.EMAIL_DRIVER = 'console';
  process.env.APPROVAL_TOKEN_SECRET = 'vercel-test-secret';
  process.env.ADMIN_EMAIL = 'admin@example.org';
  process.env.PUBLIC_BASE_URL = 'https://ctadi.vercel.app';
  process.env.COMMUNITY_INVITE_URL = 'https://community.example.org/join';
  process.env.SUBMIT_RATE_LIMIT_PER_HOUR = '1000';
  process.env.DEEPSEEK_API_KEY = 'test-deepseek-key';
  process.env.DEEPSEEK_MODEL = 'deepseek-v4-flash';
  process.env.DEEPSEEK_API_BASE_URL = upstreamUrl;

  const mod = await import('../api/index.js');
  handler = mod.default;

  const { __setStore } = await import('../src/store/index.js');
  const { __setMailer } = await import('../src/email/mailer.js');
  const { makeMemoryStore } = await import('./helpers/fake-provider.js');
  __setStore(makeMemoryStore());
  __setMailer({
    name: 'capture',
    isConfigured: () => true,
    async send(msg) {
      sentEmails.push(msg);
      return { id: `c${sentEmails.length}` };
    },
  });

  // Wrap the Vercel handler in a plain HTTP server so we can call it over the
  // wire with the same objects Vercel uses.
  server = http.createServer((req, res) => {
    // Simulate Vercel's body parsing: attach a pre-parsed req.body.
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw) {
        try {
          req.body = JSON.parse(raw);
        } catch {
          req.body = raw;
        }
      }
      req.headers['x-forwarded-host'] = req.headers.host;
      req.headers['x-forwarded-proto'] = 'https';
      handler(req, res);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => upstream.close(resolve));
  if (fs.existsSync(tmpDb)) fs.unlinkSync(tmpDb);
});

async function api(method, pathname, body) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: (() => { try { return JSON.parse(text); } catch { return null; } })(), text };
}

const answers = {
  a1: 'Development means expanding what people can actually do and choose, because I have seen output rise while options shrank.',
  a2: 'It should begin with the people who live with the outcome; a mini-grid near Kisumu was sized for lighting when the constraint was a grain mill.',
  a3: 'Education builds the capacity to reason and act, not just to hold information.',
  a4: 'I want to work on maintenance and repair; I bring eight years of off-grid solar work.',
  b_he1: 'Off-grid solar from 200 W to 12 kW, lead-acid and LiFePO4 banks, and a 5 kW crossflow turbine rebuild.',
  b_he2: 'A 12 kW hybrid system for a clinic in Homa Bay under a fixed budget; the monitoring failed because of a SIM subscription.',
  b_he3: 'Batteries die first, then cheap electronics, then roof mounting. I keep spares locally purchasable and train two people.',
  b_he4: 'I ask whether it can be repaired locally and whether the supply chain will exist in five years.',
  b_he5: '4 — I sized and commissioned the clinic system and maintained it for three years, but never worked above 20 kW.',
  av1: 'Six to eight hours a week, evenings and one weekend day.',
  av2: 'The maintenance and repair working group, documenting failure modes.',
};

function payload(email) {
  return {
    identity: { full_name: 'Vercel Tester', email, country: 'Kenya', role: 'hardware_energy' },
    consent: true,
    answers,
  };
}

test('vercel: the DeepSeek adapter is called with the configured base URL and key', async () => {
  const res = await api('POST', '/api/submit', payload('v1@example.org'));
  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.ok(upstreamCalls >= 1, 'the DeepSeek upstream was called');
  assert.equal(lastBody.model, 'deepseek-v4-flash');
  assert.equal(lastAuth, 'Bearer test-deepseek-key', 'the bearer key was sent');
  assert.equal(lastBody.temperature, 0);
  assert.equal(lastBody.response_format.type, 'json_object');
  assert.match(lastBody.messages[0].content, /UNTRUSTED DATA/i);
  assert.match(lastBody.messages[1].content, /<<<APPLICANT_ANSWER>>>/);
});

test('vercel: a pre-parsed body is accepted (serverless platforms parse it)', async () => {
  // The wrapper attaches req.body before calling the handler; if readJsonBody
  // did not support that, this would fail with an empty body.
  const res = await api('POST', '/api/submit', payload('v2@example.org'));
  assert.equal(res.status, 201);
  assert.equal(res.json.ok, true);
});

test('vercel: an invalid submission is rejected with field errors', async () => {
  const res = await api('POST', '/api/submit', { identity: { full_name: '', email: 'bad', role: 'nope' }, consent: false, answers: {} });
  assert.equal(res.status, 400);
  assert.ok(res.json.errors.length >= 3);
});

test('vercel: approve and reject links use PUBLIC_BASE_URL', async () => {
  const digest = sentEmails.find((m) => m.to === 'admin@example.org');
  assert.ok(digest);
  assert.match(digest.html, /https:\/\/ctadi\.vercel\.app\/decision\?token=/);
});

test('vercel: the full approve flow works through the handler', async () => {
  const created = await api('POST', '/api/submit', payload('v3@example.org'));
  const id = created.json.application_id;
  const digest = sentEmails.filter((m) => m.to === 'admin@example.org').pop();
  const token = decodeURIComponent(/decision\?token=([A-Za-z0-9_\-%.]+)/.exec(digest.html)[1]);

  const decision = await api('POST', '/api/decision', { token });
  assert.equal(decision.status, 200);
  assert.equal(decision.json.decision, 'approved');

  const status = await api('GET', `/api/status?id=${id}`);
  assert.equal(status.json.status.state, 'approved');
  assert.equal(status.json.status.community_link, 'https://community.example.org/join');
});

test('vercel: the health route reports the DeepSeek provider', async () => {
  const res = await api('GET', '/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  const names = res.json.providers.map((p) => p.name);
  assert.ok(names.includes('deepseek'), `expected deepseek in ${names.join(',')}`);
});

test('vercel: an unknown /api route returns JSON 404, not HTML', async () => {
  const res = await api('GET', '/api/nope');
  assert.equal(res.status, 404);
  assert.equal(res.json.ok, false);
});

test('vercel: the cron rescore endpoint is protected by CRON_SECRET', async () => {
  process.env.CRON_SECRET = 'cron-secret-value';
  const unauth = await api('GET', '/api/cron/rescore');
  assert.equal(unauth.status, 401);

  const authed = await fetch(`${base}/api/cron/rescore`, { headers: { authorization: 'Bearer cron-secret-value' } });
  const body = await authed.json();
  assert.equal(authed.status, 200);
  assert.equal(body.ok, true);
  assert.equal(typeof body.attempted, 'number');
  delete process.env.CRON_SECRET;
});

test('vercel: a scoring failure parks the application instead of erroring', async () => {
  mode = 'garbage';
  const res = await api('POST', '/api/submit', payload('v4@example.org'));
  assert.equal(res.status, 201, 'the submission still succeeds');
  assert.equal(res.json.ok, true);
  const status = await api('GET', `/api/status?id=${res.json.application_id}`);
  assert.equal(status.json.status.state, 'pending');
  mode = 'good';
});
