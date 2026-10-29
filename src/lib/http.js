import { envInt } from './config.js';

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
 * Tiny in-process fixed-window rate limiter, keyed by client IP. Adequate for
 * a low-traffic onboarding form; a distributed limiter is not worth the
 * complexity here.
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

export function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress ?? 'unknown';
}

export function __resetRateLimit() {
  buckets.clear();
}
