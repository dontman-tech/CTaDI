import path from 'node:path';
import fs from 'node:fs';
import { loadConfig, env, ROOT } from '../lib/config.js';
import { sendJson, sendHtml, readJsonBody, checkRateLimit, clientIp } from '../lib/http.js';
import { verifyDecisionToken } from '../lib/tokens.js';
import { escapeHtml } from '../lib/util.js';
import { getStore } from '../store/index.js';
import { submitApplication, recordDecision, publicStatus, processApplication } from '../pipeline.js';
import { roleOptions } from '../lib/form.js';
import { providerChain } from '../llm/providers.js';

/** Public form definition, with internal notes stripped. */
function publicForm() {
  const cfg = loadConfig();
  const { form } = cfg;
  const stripRole = (r) => ({
    label: r.label,
    questions: r.questions.map(({ id, label, hint, required, type }) => ({ id, label, hint, required, type: type ?? 'text' })),
  });
  return {
    intro: form.intro,
    consent: form.consent,
    identity: form.identity,
    section_a: {
      title: form.section_a.title,
      subtitle: form.section_a.subtitle,
      questions: form.section_a.questions,
    },
    section_b: {
      title: form.section_b.title,
      subtitle: form.section_b.subtitle,
      roles: Object.fromEntries(Object.entries(form.section_b.roles).map(([k, v]) => [k, stripRole(v)])),
    },
    availability: form.availability,
    organisation: cfg.organisation,
    max_answer_chars: Number(env('MAX_ANSWER_CHARS', 6000)),
  };
}

export async function handleApi(req, res, url) {
  const p = url.pathname;

  // GET /api/form — the form definition the frontend renders.
  if (req.method === 'GET' && p === '/api/form') {
    return sendJson(res, 200, publicForm());
  }

  // GET /api/health — liveness plus which providers are wired up.
  if (req.method === 'GET' && p === '/api/health') {
    const cfg = loadConfig();
    const store = await getStore();
    return sendJson(res, 200, {
      ok: true,
      storage: store.driver,
      email: env('EMAIL_DRIVER', 'console'),
      threshold: cfg.scoring.shortlist_threshold,
      providers: providerChain().map((x) => ({ name: x.name, model: x.model })),
      roles: roleOptions(),
    });
  }

  // POST /api/submit — the applicant's form submission.
  if (req.method === 'POST' && p === '/api/submit') {
    const limit = await checkRateLimit(`submit:${clientIp(req)}`);
    if (!limit.allowed) {
      return sendJson(res, 429, { ok: false, error: 'Too many submissions from this address. Please try again later.' });
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendJson(res, err.status ?? 400, { ok: false, error: err.message });
    }
    try {
      const result = await submitApplication(body);
      if (!result.ok) {
        return sendJson(res, result.status, { ok: false, errors: result.errors, statusUrl: result.statusUrl });
      }
      return sendJson(res, 201, {
        ok: true,
        application_id: result.applicationId,
        status_url: result.statusUrl,
        received: true,
      });
    } catch (err) {
      console.error('[submit] failed:', err);
      return sendJson(res, 500, { ok: false, error: 'Something went wrong while processing your application.' });
    }
  }

  // GET /api/status?id=... — the portal status page data.
  if (req.method === 'GET' && p === '/api/status') {
    const id = url.searchParams.get('id') ?? '';
    const store = await getStore();
    const record = await store.get(id);
    if (!record) return sendJson(res, 404, { ok: false, error: 'Application not found.' });
    return sendJson(res, 200, { ok: true, status: publicStatus(record) });
  }

  // POST /api/decision — the one-click approve/reject endpoint.
  if (req.method === 'POST' && p === '/api/decision') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendJson(res, err.status ?? 400, { ok: false, error: err.message });
    }
    const verified = verifyDecisionToken(body?.token);
    if (!verified.ok) {
      const cfg = loadConfig();
      const msg = verified.reason === 'expired' ? cfg.messages.link_expired : cfg.messages.link_expired;
      return sendJson(res, 400, { ok: false, error: msg, reason: verified.reason });
    }
    try {
      const result = await recordDecision(verified.applicationId, verified.decision, { decidedBy: 'email_link' });
      if (!result.ok) return sendJson(res, result.status, { ok: false, error: 'Could not record that decision.' });
      return sendJson(res, 200, {
        ok: true,
        decision: result.decision,
        already_decided: Boolean(result.alreadyDecided),
        application_id: verified.applicationId,
      });
    } catch (err) {
      console.error('[decision] failed:', err);
      return sendJson(res, 500, { ok: false, error: 'Could not record that decision.' });
    }
  }

  // GET|POST /api/cron/rescore — retry applications parked by a provider outage.
  // Vercel Cron sends a GET with `Authorization: Bearer $CRON_SECRET`.
  if ((req.method === 'GET' || req.method === 'POST') && p === '/api/cron/rescore') {
    const secret = env('CRON_SECRET');
    if (secret) {
      const auth = req.headers['authorization'] ?? '';
      const provided = auth.startsWith('Bearer ') ? auth.slice(7) : url.searchParams.get('secret');
      if (provided !== secret) return sendJson(res, 401, { ok: false, error: 'Unauthorised.' });
    }
    const store = await getStore();
    const parked = await store.list({ status: 'parked', limit: 20 });
    const results = [];
    for (const record of parked) {
      try {
        const outcome = await processApplication(record.id, { store });
        results.push({ id: record.id, ok: outcome.ok, total_score: outcome.total_score ?? null, shortlisted: outcome.shortlisted ?? null });
      } catch (err) {
        results.push({ id: record.id, ok: false, error: String(err.message ?? err) });
      }
    }
    return sendJson(res, 200, { ok: true, attempted: parked.length, results });
  }

  // GET /api/admin/applications — simple list for the admin (protect in prod).
  if (req.method === 'GET' && p === '/api/admin/applications') {
    const token = env('ADMIN_API_TOKEN');
    if (token) {
      const provided = req.headers['x-admin-token'] ?? url.searchParams.get('token');
      if (provided !== token) return sendJson(res, 401, { ok: false, error: 'Unauthorised.' });
    }
    const status = url.searchParams.get('status') ?? undefined;
    const store = await getStore();
    const records = await store.list({ status, limit: 200 });
    return sendJson(res, 200, {
      ok: true,
      count: records.length,
      applications: records.map((r) => ({
        id: r.id,
        created_at: r.created_at,
        full_name: r.full_name,
        email: r.email,
        role_label: r.role_label,
        status: r.status,
        total_score: r.total_score,
        shortlisted: r.shortlisted,
        decision: r.decision,
        injection_flag: r.injection_flag,
      })),
    });
  }

  return false;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

/** Serve files from /public. No directory traversal. */
export function serveStatic(req, res, url) {
  const publicDir = path.resolve(ROOT, 'public');
  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  let resolved = path.resolve(publicDir, `.${rel}`);

  // Guard against traversal before touching the filesystem.
  if (!resolved.startsWith(publicDir + path.sep) && resolved !== publicDir) {
    return false;
  }

  // Resolve a directory to its index.html, so /status serves public/status/index.html.
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
    resolved = path.join(resolved, 'index.html');
  }

  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return false;
  const ext = path.extname(resolved).toLowerCase();
  const body = fs.readFileSync(resolved);
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'content-length': body.length,
    'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=300',
  });
  res.end(body);
  return true;
}
