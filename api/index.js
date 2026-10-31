/**
 * Vercel serverless entrypoint.
 *
 * One catch-all function handles every route. Vercel's own guidance is to keep
 * related routes in a single function rather than one function per endpoint:
 * it produces fewer cold starts and lets Fluid compute reuse a warm instance
 * across requests.
 *
 * This file adapts Vercel's Node.js request/response objects to the small
 * handler the rest of the code already speaks, so the same logic runs locally
 * (src/server.js) and on Vercel with no branching in the application code.
 *
 * Note on the admin dashboard: /admin is a static page served from the CDN,
 * but every /api/admin/* call goes through this function and is authenticated
 * with ADMIN_API_TOKEN. The static page carries no data of its own.
 *
 * Cold-start note: the store driver is imported lazily inside getStore(), so
 * an unused driver (for example node:sqlite on a Postgres deployment) can never
 * break module evaluation.
 */
import { handleApi } from '../src/routes/api.js';
import { sendJson, sendText } from '../src/lib/http.js';

export default async function handler(req, res) {
  // Vercel parses the body and exposes it on req.body; readJsonBody() reads it
  // directly. Nothing to re-stream here.
  const host = req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost';
  const proto = req.headers['x-forwarded-proto'] ?? 'https';
  const url = new URL(req.url, `${proto}://${host}`);

  try {
    if (url.pathname.startsWith('/api/')) {
      const handled = await handleApi(req, res, url);
      if (handled !== false) return;
      return sendJson(res, 404, { ok: false, error: 'Not found.' });
    }
    return sendJson(res, 404, { ok: false, error: 'Not found.' });
  } catch (err) {
    console.error('[vercel] unhandled error:', err);
    if (!res.headersSent) return sendText(res, 500, 'Internal server error');
    return res.end();
  }
}

/**
 * Vercel's Node runtime accepts a `config` export for per-function settings.
 * 60s is the ceiling on the Hobby plan, which is ample: a submission only
 * writes a record and sends one email, with no model call to wait on.
 */
export const config = {
  maxDuration: 60,
};
