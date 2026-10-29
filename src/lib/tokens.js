import crypto from 'node:crypto';
import { approvalSecret } from './util.js';

/**
 * Stateless, tamper-proof decision tokens.
 *
 * Format: base64url(payloadJson) + "." + base64url(hmacSha256(payload, secret))
 *
 * The payload is bound to a specific application id and decision, so a link
 * emailed for application X can never be replayed against application Y, and
 * an "approve" link cannot be edited into a "reject" link. The token carries
 * its own expiry so no database lookup is needed to reject stale links.
 */

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function sign(payloadB64) {
  return crypto.createHmac('sha256', approvalSecret()).update(payloadB64).digest('base64url');
}

export function createDecisionToken({ applicationId, decision, ttlHours = 336 }) {
  const payload = {
    a: applicationId,
    d: decision,
    exp: Date.now() + ttlHours * 3600 * 1000,
    n: crypto.randomBytes(6).toString('hex'),
  };
  const body = b64url(JSON.stringify(payload));
  return `${body}.${sign(body)}`;
}

export function verifyDecisionToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) {
    return { ok: false, reason: 'malformed' };
  }
  const [body, mac] = token.split('.');
  if (!body || !mac) return { ok: false, reason: 'malformed' };

  const expected = sign(body);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (typeof payload.exp !== 'number' || Date.now() > payload.exp) {
    return { ok: false, reason: 'expired' };
  }
  if (payload.d !== 'approve' && payload.d !== 'reject') {
    return { ok: false, reason: 'bad_decision' };
  }
  return { ok: true, applicationId: payload.a, decision: payload.d };
}

export function decisionLinks(baseUrl, applicationId, ttlHours) {
  const approve = createDecisionToken({ applicationId, decision: 'approve', ttlHours });
  const reject = createDecisionToken({ applicationId, decision: 'reject', ttlHours });
  const base = String(baseUrl).replace(/\/+$/, '');
  return {
    approve: `${base}/decision?token=${encodeURIComponent(approve)}`,
    reject: `${base}/decision?token=${encodeURIComponent(reject)}`,
  };
}
