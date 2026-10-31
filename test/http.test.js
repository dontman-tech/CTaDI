import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * End-to-end HTTP tests. These drive the real server, real routing, and real
 * storage (a throwaway JSON file). Screening is manual, so the admin
 * dashboard API is exercised with a real admin token.
 */

const tmpDb = path.join(os.tmpdir(), `ctadi-test-${process.pid}.json`);
process.env.STORAGE_DRIVER = 'json';
process.env.JSON_DB_PATH = tmpDb;
process.env.ADMIN_API_TOKEN = 'test-admin-token';
process.env.PUBLIC_BASE_URL = 'http://127.0.0.1:0';
process.env.COMMUNITY_INVITE_URL = 'https://community.test/join';
process.env.SUBMIT_RATE_LIMIT_PER_HOUR = '1000';
process.env.NODE_ENV = 'test';

const { createServer } = await import('../src/server.js');
const { __setStore } = await import('../src/store/index.js');
const { makeMemoryStore } = await import('./helpers/doubles.js');
const { questionsForRole } = await import('../src/lib/form.js');
const { __resetRateLimit } = await import('../src/lib/http.js');

const store = makeMemoryStore();
__setStore(store);

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

async function req(method, pathname, body, headers = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
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

const admin = { 'x-admin-token': 'test-admin-token' };

function payload(role, email) {
  return {
    identity: { full_name: 'HTTP Tester', email, country: 'Testland', role },
    consent: true,
    answers: Object.fromEntries(questionsForRole(role).map((q) => [q.id, 'Because I have built things and I know the trade-offs.'])),
  };
}

test('GET /api/health reports storage and manual screening', async () => {
  const { status, json } = await req('GET', '/api/health');
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.storage, 'memory');
  assert.equal(json.screening, 'manual');
  assert.equal(json.email, undefined, 'there is no email driver any more');
  assert.equal(json.threshold, undefined, 'there is no threshold any more');
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

test('GET /admin serves the admin dashboard', async () => {
  const res = await fetch(`${base}/admin`);
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(html, /admin review/i);
  assert.match(html, /\/admin\/admin\.js/);
});

test('POST /api/submit rejects an invalid submission with field-level errors', async () => {
  const { status, json } = await req('POST', '/api/submit', { identity: { full_name: '', email: 'nope', role: 'nope' }, consent: false, answers: {} });
  assert.equal(status, 400);
  assert.equal(json.ok, false);
  assert.ok(json.errors.length >= 3);
});

test('POST /api/submit accepts a valid submission and returns a status link', async () => {
  __resetRateLimit();
  const { status, json } = await req('POST', '/api/submit', payload('design', `http-${Date.now()}@example.com`));
  assert.equal(status, 201);
  assert.equal(json.ok, true);
  assert.ok(json.application_id.startsWith('app_'));
  assert.match(json.status_url, /^\/status\?id=app_/);
});

test('GET /api/status returns a public view with no internal detail', async () => {
  const email = `status-${Date.now()}@example.com`;
  const created = await req('POST', '/api/submit', payload('research', email));
  const id = created.json.application_id;

  const { status, json } = await req('GET', `/api/status?id=${id}`);
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.status.state, 'pending');
  assert.equal(json.status.community_link, undefined, 'no invite until approved');
  assert.equal(json.status.answers, undefined, 'the public view never exposes answers');
});

test('GET /api/status 404s for an unknown id', async () => {
  const { status, json } = await req('GET', '/api/status?id=app_does_not_exist');
  assert.equal(status, 404);
  assert.equal(json.ok, false);
});

// ---- Admin dashboard ------------------------------------------------------

test('the admin dashboard rejects a request with no token', async () => {
  const { status, json } = await req('GET', '/api/admin/applications');
  assert.equal(status, 401);
  assert.equal(json.ok, false);
});

test('the admin dashboard rejects a wrong token', async () => {
  const { status } = await req('GET', '/api/admin/applications', undefined, { 'x-admin-token': 'nope' });
  assert.equal(status, 401);
});

test('the admin dashboard lists applications with the correct token', async () => {
  await req('POST', '/api/submit', payload('operations', `list-${Date.now()}@example.com`));
  const { status, json } = await req('GET', '/api/admin/applications', undefined, admin);
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.ok(Array.isArray(json.applications));
  assert.ok(json.applications.length >= 1);
  const sample = json.applications[0];
  assert.ok(sample.full_name);
  assert.ok(sample.status);
  assert.equal(sample.total_score, undefined, 'no scoring fields');
  assert.equal(sample.answers, undefined, 'the list view stays light');
});

test('the admin can filter the list by status', async () => {
  const { json } = await req('GET', '/api/admin/applications?status=approved', undefined, admin);
  assert.equal(json.ok, true);
  assert.ok(json.applications.every((a) => a.status === 'approved'));
});

test('the admin can fetch a full application, with every answer and question label', async () => {
  const email = `detail-${Date.now()}@example.com`;
  const created = await req('POST', '/api/submit', payload('hardware_energy', email));
  const id = created.json.application_id;

  const { status, json } = await req('GET', `/api/admin/application?id=${id}`, undefined, admin);
  assert.equal(status, 200);
  assert.equal(json.application.id, id);
  assert.equal(json.application.identity.email, email);
  assert.equal(json.application.status, 'pending_review');
  for (const q of questionsForRole('hardware_energy')) {
    assert.ok(q.id in json.application.answers, `answer ${q.id} is present`);
  }
  assert.ok(json.application.questions.some((q) => q.id === 'a1' && q.label), 'question labels are included');
});

test('an unknown application id 404s on the admin detail route', async () => {
  const { status } = await req('GET', '/api/admin/application?id=app_nope', undefined, admin);
  assert.equal(status, 404);
});

test('the full review flow works over HTTP: submit, list, approve, invite', async () => {
  const email = `approve-${Date.now()}@example.com`;
  const created = await req('POST', '/api/submit', payload('operations', email));
  const id = created.json.application_id;

  const decision = await req('POST', '/api/admin/decision', { id, decision: 'approve' }, admin);
  assert.equal(decision.status, 200);
  assert.equal(decision.json.ok, true);
  assert.equal(decision.json.decision, 'approved');
  assert.equal(decision.json.already_decided, false);

  const statusRes = await req('GET', `/api/status?id=${id}`);
  assert.equal(statusRes.json.status.state, 'approved');
  assert.equal(statusRes.json.status.community_link, 'https://community.test/join');
});

test('rejecting over HTTP closes the application politely', async () => {
  const created = await req('POST', '/api/submit', payload('design', `reject-${Date.now()}@example.com`));
  const id = created.json.application_id;
  const decision = await req('POST', '/api/admin/decision', { id, decision: 'reject' }, admin);
  assert.equal(decision.json.decision, 'rejected');
  const statusRes = await req('GET', `/api/status?id=${id}`);
  assert.equal(statusRes.json.status.state, 'rejected');
  assert.equal(statusRes.json.status.community_link, undefined);
});

test('a decision requires the admin token', async () => {
  const created = await req('POST', '/api/submit', payload('design', `nodecide-${Date.now()}@example.com`));
  const { status } = await req('POST', '/api/admin/decision', { id: created.json.application_id, decision: 'approve' });
  assert.equal(status, 401);
});

test('a decision rejects a bad verb', async () => {
  const created = await req('POST', '/api/submit', payload('design', `badverb-${Date.now()}@example.com`));
  const { status, json } = await req('POST', '/api/admin/decision', { id: created.json.application_id, decision: 'maybe' }, admin);
  assert.equal(status, 400);
  assert.equal(json.ok, false);
});

test('a decision on an unknown id 404s', async () => {
  const { status } = await req('POST', '/api/admin/decision', { id: 'app_nope', decision: 'approve' }, admin);
  assert.equal(status, 404);
});

test('the removed email-era endpoints are gone', async () => {
  assert.equal((await req('POST', '/api/decision', { token: 'x' })).status, 404);
  assert.equal((await req('GET', '/api/cron/rescore')).status, 404);
});

test('static serving refuses directory traversal', async () => {
  const res = await fetch(`${base}/../package.json`);
  assert.notEqual(res.status, 200);
});
