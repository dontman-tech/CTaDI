import { env, envInt } from './config.js';

export function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

export function sendHtml(res, status, html, extraHeaders = {}) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders });
  res.end(html);
}

export function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' });
  res.end(text);
}

/** Read and parse a JSON request body, with a hard size cap. */
export async function readJsonBody(req, maxBytes = 256 * 1024) {
  // Serverless platforms (Vercel, Netlify, Lambda) parse the body for us and
  // expose it on req.body. Their request object still has an .on method, but
  // the underlying stream is already drained, so checking for the parsed body
  // FIRST is essential — reading the stream would hang forever.
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') {
      if (!req.body.trim()) return {};
      try {
        return JSON.parse(req.body);
      } catch {
        throw Object.assign(new Error('invalid JSON body'), { status: 400 });
      }
    }
    if (Buffer.isBuffer(req.body)) {
      const raw = req.body.toString('utf8');
      if (!raw.trim()) return {};
      try {
        return JSON.parse(raw);
      } catch {
        throw Object.assign(new Error('invalid JSON body'), { status: 400 });
      }
    }
    if (typeof req.body === 'object') return req.body;
  }

  // Plain Node HTTP server (local development): read the stream.
  if (typeof req.on !== 'function') return {};

  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('invalid JSON body'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Fixed-window rate limiter.
 *
 * On a serverless platform each request may land on a fresh instance, so an
 * in-process counter can be reset simply by getting a cold start. When the
 * Postgres store is in use the counter is kept there instead, in a single
 * atomic upsert. The in-process map remains the fallback for local
 * development, single-instance deployments, and any moment the database is
 * unreachable — the limiter fails open rather than blocking real applicants.
 */
const buckets = new Map();

export function rateLimit(key, perHour = envInt('SUBMIT_RATE_LIMIT_PER_HOUR', 5)) {
  const now = Date.now();
  const windowMs = 3600 * 1000;
  const entry = buckets.get(key);
  if (!entry || now - entry.start >= windowMs) {
    buckets.set(key, { start: now, count: 1 });
    return { allowed: true, remaining: perHour - 1 };
  }
  entry.count += 1;
  if (entry.count > perHour) {
    return { allowed: false, retryAfterMs: windowMs - (now - entry.start), remaining: 0 };
  }
  return { allowed: true, remaining: perHour - entry.count };
}

/** Postgres-backed fixed window, via the store. Falls back on any error. */
async function postgresRateLimit(key, perHour) {
  try {
    const { postgresStore } = await import('../store/postgres.js');
    const count = await postgresStore.rateLimit(key, 3600);
    if (!Number.isFinite(count)) throw new Error('unexpected counter');
    return { allowed: count <= perHour, remaining: Math.max(0, perHour - count) };
  } catch (err) {
    console.warn('[rate-limit] postgres limiter unavailable, using in-process fallback:', err.message);
    return rateLimit(key, perHour);
  }
}

/**
 * Choose the limiter. The distributed one is used whenever the deployment is
 * backed by Postgres, which is exactly when an in-process counter is unsafe.
 */
export async function checkRateLimit(key, perHour = envInt('SUBMIT_RATE_LIMIT_PER_HOUR', 5)) {
  const driver = env('STORAGE_DRIVER') ?? (env('VERCEL') ? 'postgres' : 'json');
  if (driver === 'postgres') return postgresRateLimit(key, perHour);
  return rateLimit(key, perHour);
}

export function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  if (Array.isArray(fwd) && fwd.length) return String(fwd[0]).split(',')[0].trim();
  // Vercel also sets these.
  const real = req.headers['x-real-ip'];
  if (typeof real === 'string' && real.length) return real;
  return req.socket?.remoteAddress ?? 'unknown';
}

export function __resetRateLimit() {
  buckets.clear();
}
