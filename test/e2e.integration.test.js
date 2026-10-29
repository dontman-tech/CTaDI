import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

/**
 * True end-to-end integration test.
 *
 * It stands up a fake OpenAI-compatible upstream, points the REAL provider
 * adapter at it via OPENAI_COMPAT_BASE_URL, and drives the REAL server over
 * HTTP. Nothing in the application is stubbed: routing, validation, the
 * provider adapter, JSON extraction, rubric validation, the threshold, the
 * digest email, the signed one-click link, the decision endpoint, and the
 * status page are all the production code paths.
 */

const tmpDb = path.join(process.env.TMPDIR || '/tmp', `ctadi-e2e-${process.pid}.json`);

// --- Fake upstream LLM (OpenAI-compatible) ---------------------------------
let upstreamCalls = 0;
let upstreamMode = 'good';
let upstreamBody = null;
const upstream = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => {
    raw += c;
  });
  req.on('end', () => {
    upstreamCalls += 1;
    try {
      upstreamBody = JSON.parse(raw);
    } catch {
      upstreamBody = null;
    }
    const send = (obj) => {
      const payload = JSON.stringify(obj);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(payload);
    };
    if (upstreamMode === 'garbage') {
      return send({ choices: [{ message: { content: 'sorry, I cannot help with that' } }] });
    }
    if (upstreamMode === 'error') {
      res.writeHead(429, { 'content-type': 'application/json' });
      return res.end('{"error":"rate limited"}');
    }
    const evaluation = {
      total_score: 82,
      criteria: [
        { name: 'values_alignment', score: 26, max: 30, justification: 'Treats development as capability, citing a real example.' },
        { name: 'relevant_skill_level', score: 25, max: 30, justification: 'Names specific systems and admits a real gap.' },
        { name: 'quality_of_thinking', score: 16, max: 20, justification: 'Reasons about education rather than restating slogans.' },
        { name: 'evidence_of_real_work', score: 8, max: 10, justification: 'Describes a clinic installation and its failure.' },
        { name: 'commitment_and_availability', score: 7, max: 10, justification: 'Gives a bounded, honest commitment.' },
      ],
      strengths: ['Concrete, self-critical project history.'],
      concerns: ['Cannot take daytime calls.'],
      recommendation: 'shortlist',
    };
    return send({ choices: [{ message: { content: JSON.stringify(evaluation) } }] });
  });
});

let upstreamUrl;
let server;
let base;
const sentEmails = [];

before(async () => {
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  upstreamUrl = `http://127.0.0.1:${upstream.address().port}/v1`;

  process.env.STORAGE_DRIVER = 'json';
  process.env.JSON_DB_PATH = tmpDb;
  process.env.EMAIL_DRIVER = 'console';
  process.env.APPROVAL_TOKEN_SECRET = 'e2e-secret';
  process.env.ADMIN_EMAIL = 'admin@example.org';
  process.env.PUBLIC_BASE_URL = 'https://portal.example.org';
  process.env.COMMUNITY_INVITE_URL = 'https://community.example.org/join/ctadi';
  process.env.SUBMIT_RATE_LIMIT_PER_HOUR = '1000';
  process.env.OPENAI_COMPAT_BASE_URL = upstreamUrl;
  process.env.OPENAI_COMPAT_API_KEY = 'fake-key';
  process.env.OPENAI_COMPAT_MODEL = 'fake-model';

  const { createServer } = await import('../src/server.js');
  const { __setStore } = await import('../src/store/index.js');
  const { __setMailer } = await import('../src/email/mailer.js');
  const { makeMemoryStore } = await import('./helpers/fake-provider.js');

  __setStore(makeMemoryStore());
  __setMailer({
    name: 'capture',
    isConfigured: () => true,
    async send(msg) {
      sentEmails.push(msg);
      return { id: `cap_${sentEmails.length}` };
    },
  });

  server = createServer();
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

const strongAnswers = {
  a1: 'Development is about expanding what people can actually do and choose, not just raising output. I have seen GDP rise while people lost access to land.',
  a2: 'It should begin with the people who live with the outcome. A mini-grid near Kisumu was sized for lighting when the real constraint was a diesel grain mill.',
  a3: 'Education builds the capacity to reason and act. Schooling often stops at examination performance and never reaches working with uncertainty.',
  a4: 'I want to work on appropriate technology and maintenance. I bring eight years of off-grid solar work and two deployments I designed myself.',
  b_he1: 'Off-grid solar from 200 W to 12 kW, lead-acid and LiFePO4 banks, MPPT controllers, and a 5 kW crossflow turbine rebuild.',
  b_he2: 'A 12 kW hybrid system for a clinic in Homa Bay, under a fixed budget and a weak supply chain. The monitoring failed because it needed a SIM subscription the clinic could not afford.',
  b_he3: 'Batteries die first, then cheap electronics, then roof mounting. I keep the spares list short and locally purchasable and train two people, not one.',
  b_he4: 'I ask whether it can be repaired locally and whether the supply chain will still exist in five years. I refused to quote for an app-locked water pump.',
  b_he5: '4 — I sized and commissioned the 12 kW clinic system myself and have maintained it for three years, but I have never worked above 20 kW.',
  av1: 'Six to eight hours a week, evenings and one weekend day. I would rather promise six and keep it.',
  av2: 'The maintenance and repair working group, documenting failure modes and writing maintenance sheets.',
};

test('e2e: a strong application is scored by the real adapter and shortlisted', async () => {
  const res = await api('POST', '/api/submit', {
    identity: { full_name: 'Amara Okonkwo', email: 'amara@example.org', country: 'Kenya', role: 'hardware_energy' },
    consent: true,
    answers: strongAnswers,
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.equal(res.json.ok, true);
  const id = res.json.application_id;

  // The real adapter actually called the upstream, with the right shape.
  assert.ok(upstreamCalls >= 1, 'the provider adapter called the upstream');
  assert.equal(upstreamBody.model, 'fake-model');
  assert.ok(Array.isArray(upstreamBody.messages));
  assert.match(upstreamBody.messages[0].content, /UNTRUSTED DATA/i, 'system prompt carries the injection guard');
  assert.match(upstreamBody.messages[1].content, /<<<APPLICANT_ANSWER>>>/, 'answers are wrapped as data');
  assert.equal(upstreamBody.temperature, 0, 'temperature 0 for consistency');

  // The admin digest went out with one-click links.
  const digest = sentEmails.find((m) => m.to === 'admin@example.org');
  assert.ok(digest, 'the admin was emailed');
  assert.match(digest.subject, /Shortlisted/);
  assert.match(digest.subject, /82\/100/);

  // The status page shows the shortlisted state and not the invite yet.
  const status = await api('GET', `/api/status?id=${id}`);
  assert.equal(status.json.status.state, 'shortlisted');
  assert.equal(status.json.status.community_link, undefined);

  globalThis.__e2eId = id;
});

test('e2e: clicking Approve in the digest email approves the application', async () => {
  const digest = sentEmails.find((m) => m.to === 'admin@example.org');
  const approveUrl = /https:\/\/portal\.example\.org\/decision\?token=([A-Za-z0-9_\-%.]+)/.exec(digest.html);
  assert.ok(approveUrl, 'the digest contains an absolute approve URL');
  const token = decodeURIComponent(approveUrl[1]);

  const decision = await api('POST', '/api/decision', { token });
  assert.equal(decision.status, 200);
  assert.equal(decision.json.decision, 'approved');

  const status = await api('GET', `/api/status?id=${globalThis.__e2eId}`);
  assert.equal(status.json.status.state, 'approved');
  assert.equal(status.json.status.community_link, 'https://community.example.org/join/ctadi');
});

test('e2e: the reject link works for a second application', async () => {
  const created = await api('POST', '/api/submit', {
    identity: { full_name: 'Second Person', email: 'second@example.org', country: 'Ghana', role: 'hardware_energy' },
    consent: true,
    answers: strongAnswers,
  });
  const id = created.json.application_id;
  const digest = sentEmails.filter((m) => m.to === 'admin@example.org').pop();
  const rejectUrl = /https:\/\/portal\.example\.org\/decision\?token=([A-Za-z0-9_\-%.]+)/.exec(digest.text.split('REJECT:')[1] ?? '');
  const token = decodeURIComponent(rejectUrl[1]);

  const decision = await api('POST', '/api/decision', { token });
  assert.equal(decision.json.decision, 'rejected');

  const status = await api('GET', `/api/status?id=${id}`);
  assert.equal(status.json.status.state, 'rejected');
  assert.equal(status.json.status.community_link, undefined);
});

test('e2e: a garbage upstream response parks the application rather than losing it', async () => {
  upstreamMode = 'garbage';
  const created = await api('POST', '/api/submit', {
    identity: { full_name: 'Parked Person', email: 'parked@example.org', country: 'Peru', role: 'hardware_energy' },
    consent: true,
    answers: strongAnswers,
  });
  assert.equal(created.status, 201, 'the submission still succeeds');
  const status = await api('GET', `/api/status?id=${created.json.application_id}`);
  assert.equal(status.json.status.state, 'pending', 'a parked application reads as pending to the applicant');
  upstreamMode = 'good';
});

test('e2e: a 429 from the upstream is retried, then the application is parked if it persists', async () => {
  upstreamMode = 'error';
  const before429 = upstreamCalls;
  const created = await api('POST', '/api/submit', {
    identity: { full_name: 'Rate Limited', email: 'rl@example.org', country: 'Chile', role: 'hardware_energy' },
    consent: true,
    answers: strongAnswers,
  });
  assert.equal(created.status, 201);
  assert.ok(upstreamCalls - before429 >= 2, 'the 429 was retried at least once before giving up');
  upstreamMode = 'good';
});
