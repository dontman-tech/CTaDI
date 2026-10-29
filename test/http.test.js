import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * End-to-end HTTP tests. These drive the real server, real routing, and real
 * storage (a throwaway JSON file) with a recording mailer in place of SMTP.
 * This is the closest thing to the deployed system that runs offline.
 */

const tmpDb = path.join(os.tmpdir(), `ctadi-test-${process.pid}.json`);
process.env.STORAGE_DRIVER = 'json';
process.env.JSON_DB_PATH = tmpDb;
process.env.EMAIL_DRIVER = 'console';
process.env.APPROVAL_TOKEN_SECRET = 'test-secret-please-do-not-use';
process.env.ADMIN_EMAIL = 'admin@example.org';
process.env.PUBLIC_BASE_URL = 'http://127.0.0.1:0';
process.env.COMMUNITY_INVITE_URL = 'https://community.test/join';
process.env.SUBMIT_RATE_LIMIT_PER_HOUR = '1000';

const { createServer } = await import('../src/server.js');
const { __setStore } = await import('../src/store/index.js');
const { __setMailer } = await import('../src/email/mailer.js');
const { makeMemoryStore, makeRecordingMailer } = await import('./helpers/doubles.js');
const { questionsForRole } = await import('../src/lib/form.js');
const { __resetRateLimit } = await import('../src/lib/http.js');

const store = makeMemoryStore();
const mailer = makeRecordingMailer();
__setStore(store);
__setMailer(mailer);

let server;
let base;

before(async () => {
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  if (fs.existsSync(tmpDb)) fs.unlinkSync(tmpDb);
});

async function req(method, pathname, body) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

function payload(role, email) {
  return {
    identity: { full_name: 'HTTP Tester', email, country: 'Testland', role },
    consent: true,
    answers: Object.fromEntries(questionsForRole(role).map((q) => [q.id, 'Because I have built things and I know the trade-offs.'])),
  };
}

test('GET /api/health reports storage and email, and no scoring', async () => {
  const { status, json } = await req('GET', '/api/health');
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.storage, 'memory');
  assert.equal(json.email, 'console');
  assert.equal(json.threshold, undefined, 'there is no threshold any more');
  assert.equal(json.providers, undefined, 'there are no LLM providers any more');
});

test('GET /api/form serves the form with all six roles and no internal notes', async () => {
  const { status, json } = await req('GET', '/api/form');
  assert.equal(status, 200);
  assert.equal(Object.keys(json.section_b.roles).length, 6);
  assert.equal(json.section_a.questions.length, 4);
  assert.ok(json.section_b.roles.software_data.questions.length >= 4);
  assert.ok(!('_comment' in json.section_b));
  assert.ok(!('expectation' in json.section_b.roles.software_data), 'internal notes are stripped');
});

test('GET / serves the application form', async () => {
  const res = await fetch(`${base}/`);
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(html, /Membership application/);
  assert.match(html, /\/form\.js/);
});

test('POST /api/submit rejects an invalid submission with field-level errors', async () => {
  const { status, json } = await req('POST', '/api/submit', { identity: { full_name: '', email: 'nope', role: 'nope' }, consent: false, answers: {} });
  assert.equal(status, 400);
  assert.equal(json.ok, false);
  assert.ok(json.errors.length >= 3);
});

test('POST /api/submit accepts a valid submission, emails the admin, and returns a status link', async () => {
  __resetRateLimit();
  const before = mailer.sent.length;
  const { status, json } = await req('POST', '/api/submit', payload('design', `http-${Date.now()}@example.com`));
  assert.equal(status, 201);
  assert.equal(json.ok, true);
  assert.ok(json.application_id.startsWith('app_'));
  assert.match(json.status_url, /^\/status\?id=app_/);
  assert.equal(mailer.sent.length, before + 1, 'the admin is emailed for every submission');
  assert.equal(mailer.sent.at(-1).to, 'admin@example.org');
});

test('GET /api/status returns a public view with no internal detail', async () => {
  const email = `status-${Date.now()}@example.com`;
  const created = await req('POST', '/api/submit', payload('research', email));
  const id = created.json.application_id;

  const { status, json } = await req('GET', `/api/status?id=${id}`);
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.status.state, 'pending');
  assert.equal(json.status.total_score, undefined);
  assert.equal(json.status.evaluation, undefined);
  assert.equal(json.status.community_link, undefined, 'no invite until approved');
});

test('GET /api/status 404s for an unknown id', async () => {
  const { status, json } = await req('GET', '/api/status?id=app_does_not_exist');
  assert.equal(status, 404);
  assert.equal(json.ok, false);
});

test('POST /api/decision rejects a forged token', async () => {
  const { status, json } = await req('POST', '/api/decision', { token: 'not.a.real.token' });
  assert.equal(status, 400);
  assert.equal(json.ok, false);
});

test('the full review flow works over HTTP: submit, email, approve, invite', async () => {
  const email = `approve-${Date.now()}@example.com`;
  const created = await req('POST', '/api/submit', payload('operations', email));
  const id = created.json.application_id;

  // The admin reads the digest that the submission produced — no scoring step.
  const digest = mailer.sent.filter((m) => m.to === 'admin@example.org').pop();
  assert.ok(digest, 'the admin received a digest');
  const approveToken = decodeURIComponent(/decision\?token=([A-Za-z0-9_\-%.]+)/.exec(digest.html)[1]);

  const decision = await req('POST', '/api/decision', { token: approveToken });
  assert.equal(decision.status, 200);
  assert.equal(decision.json.ok, true);
  assert.equal(decision.json.decision, 'approved');

  const statusRes = await req('GET', `/api/status?id=${id}`);
  assert.equal(statusRes.json.status.state, 'approved');
  assert.equal(statusRes.json.status.community_link, 'https://community.test/join');
});

test('GET /decision renders the confirmation page', async () => {
  const res = await fetch(`${base}/decision?token=whatever`);
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(html, /\/decision\.js/);
});

test('static serving refuses directory traversal', async () => {
  const res = await fetch(`${base}/../package.json`);
  assert.notEqual(res.status, 200);
});

test('GET /api/admin/applications lists applications without scores', async () => {
  const { status, json } = await req('GET', '/api/admin/applications');
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.ok(Array.isArray(json.applications));
  assert.ok(json.applications.length >= 1);
  const sample = json.applications[0];
  assert.equal(sample.total_score, undefined);
  assert.equal(sample.shortlisted, undefined);
  assert.equal(sample.evaluation, undefined);
});

test('GET /api/cron/rescore is gone', async () => {
  const { status } = await req('GET', '/api/cron/rescore');
  assert.equal(status, 404, 'the rescore job no longer exists');
});
