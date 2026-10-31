import path from 'node:path';
import fs from 'node:fs';
import { loadConfig, env, ROOT } from '../lib/config.js';
import { sendJson, sendHtml, readJsonBody, checkRateLimit, clientIp } from '../lib/http.js';
import { safeEqual } from '../lib/util.js';
import { getStore } from '../store/index.js';
import { submitApplication, recordDecision, publicStatus, adminView } from '../pipeline.js';
import { roleOptions } from '../lib/form.js';

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

/**
 * Admin authentication. The dashboard is the only route into applicant data,
 * so it is gated on a shared secret sent as `X-Admin-Token`.
 *
 * In production a token is mandatory: without one the dashboard would be open
 * to anyone who found the URL, and the whole point of the portal is that only
 * the admin reads applications. Locally, with no token set, access is allowed
 * so development needs no setup.
 */
function requireAdmin(req, url) {
  const expected = env('ADMIN_API_TOKEN');
  if (!expected) {
    if (env('NODE_ENV') === 'production' || env('VERCEL')) {
      return { ok: false, status: 503, error: 'ADMIN_API_TOKEN is not configured. Set it to use the admin dashboard.' };
    }
    return { ok: true, admin: 'dev-no-token' };
  }
  const provided = req.headers['x-admin-token'] ?? url.searchParams.get('token') ?? '';
  if (!provided || !safeEqual(String(provided), String(expected))) {
    return { ok: false, status: 401, error: 'Unauthorised.' };
  }
  return { ok: true, admin: 'token' };
}

export async function handleApi(req, res, url) {
  const p = url.pathname;

  // GET /api/form — the form definition the frontend renders.
  if (req.method === 'GET' && p === '/api/form') {
    return sendJson(res, 200, publicForm());
  }

  // GET /api/health — liveness and which drivers are wired up.
  if (req.method === 'GET' && p === '/api/health') {
    const store = await getStore();
    return sendJson(res, 200, {
      ok: true,
      storage: store.driver,
      screening: 'manual',
      review: 'admin dashboard',
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

  // ---- Admin dashboard ----------------------------------------------------

  // GET /api/admin/applications — list, newest first, optionally by status.
  if (req.method === 'GET' && p === '/api/admin/applications') {
    const auth = requireAdmin(req, url);
    if (!auth.ok) return sendJson(res, auth.status, { ok: false, error: auth.error });
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
        role: r.role,
        role_label: r.role_label,
        status: r.status,
        decision: r.decision,
        decided_at: r.decided_at,
      })),
    });
  }

  // GET /api/admin/application?id=... — the full application for review.
  if (req.method === 'GET' && p === '/api/admin/application') {
    const auth = requireAdmin(req, url);
    if (!auth.ok) return sendJson(res, auth.status, { ok: false, error: auth.error });
    const id = url.searchParams.get('id') ?? '';
    const store = await getStore();
    const record = await store.get(id);
    if (!record) return sendJson(res, 404, { ok: false, error: 'Application not found.' });
    return sendJson(res, 200, { ok: true, application: adminView(record) });
  }

  // POST /api/admin/decision — approve or reject. Body: { id, decision }.
  if (req.method === 'POST' && p === '/api/admin/decision') {
    const auth = requireAdmin(req, url);
    if (!auth.ok) return sendJson(res, auth.status, { ok: false, error: auth.error });
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendJson(res, err.status ?? 400, { ok: false, error: err.message });
    }
    const id = String(body?.id ?? '');
    const decision = String(body?.decision ?? '');
    if (!id) return sendJson(res, 400, { ok: false, error: 'An application id is required.' });
    try {
      const result = await recordDecision(id, decision, { decidedBy: 'admin_dashboard' });
      if (!result.ok) {
        const msg = result.reason === 'not_found' ? 'Application not found.' : 'That is not a valid decision.';
        return sendJson(res, result.status, { ok: false, error: msg });
      }
      return sendJson(res, 200, {
        ok: true,
        decision: result.decision,
        already_decided: Boolean(result.alreadyDecided),
        application_id: id,
      });
    } catch (err) {
      console.error('[admin/decision] failed:', err);
      return sendJson(res, 500, { ok: false, error: 'Could not record that decision.' });
    }
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

  // Resolve a directory to its index.html, so /admin serves public/admin/index.html.
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
