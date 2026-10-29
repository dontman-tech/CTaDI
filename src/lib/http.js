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
 * Two backends. When `RATE_LIMIT_BACKEND=supabase` (or Upstash Redis is
 * configured) the counter lives outside the process, which is required on
 * serverless: each invocation may be a fresh instance, so an in-process map
 * would let a caller reset the window simply by getting a cold start. The
 * in-process map remains the default for local development and single-instance
 * deployments, where it is exact and free.
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

/** Upstash Redis REST rate limit. Falls back to the in-process limiter on error. */
async function upstashRateLimit(key, perHour) {
  const url = env('UPSTASH_REDIS_REST_URL');
  const token = env('UPSTASH_REDIS_REST_TOKEN');
  const windowSeconds = 3600;
  const redisKey = `ctadi:rl:${key}`;
  try {
    const res = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify([
        ['INCR', redisKey],
        ['EXPIRE', redisKey, String(windowSeconds), 'NX'],
      ]),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const count = Number(data?.[0]?.result ?? 0);
    if (!Number.isFinite(count) || count <= 0) throw new Error('unexpected counter');
    return { allowed: count <= perHour, remaining: Math.max(0, perHour - count) };
  } catch (err) {
    console.warn('[rate-limit] distributed limiter unavailable, using in-process fallback:', err.message);
    return rateLimit(key, perHour);
  }
}

/** Supabase-backed limiter, using an atomic increment RPC if one is installed. */
async function supabaseRateLimit(key, perHour) {
  const url = env('SUPABASE_URL');
  const svc = env('SUPABASE_SERVICE_ROLE_KEY');
  try {
    const res = await fetch(`${url}/rest/v1/rpc/ctadi_rate_limit`, {
      method: 'POST',
      headers: { apikey: svc, authorization: `Bearer ${svc}`, 'content-type': 'application/json' },
      body: JSON.stringify({ p_key: key, p_window_seconds: 3600 }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const count = Number(await res.json());
    if (!Number.isFinite(count)) throw new Error('unexpected counter');
    return { allowed: count <= perHour, remaining: Math.max(0, perHour - count) };
  } catch (err) {
    console.warn('[rate-limit] supabase limiter unavailable, using in-process fallback:', err.message);
    return rateLimit(key, perHour);
  }
}

/**
 * Choose the limiter. Distributed when the platform is serverless and a
 * backend is configured; in-process otherwise.
 */
export async function checkRateLimit(key, perHour = envInt('SUBMIT_RATE_LIMIT_PER_HOUR', 5)) {
  const backend = env('RATE_LIMIT_BACKEND');
  if (backend === 'upstash' || (!backend && env('UPSTASH_REDIS_REST_URL') && env('UPSTASH_REDIS_REST_TOKEN'))) {
    return upstashRateLimit(key, perHour);
  }
  if (backend === 'supabase') {
    return supabaseRateLimit(key, perHour);
  }
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
