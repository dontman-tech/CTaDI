import crypto from 'node:crypto';

export function nowIso() {
  return new Date().toISOString();
}

export function newId(prefix = 'app') {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

/**
 * SHA-256 of a token, as hex. Admin tokens are generated with 24 random bytes
 * (192 bits) of entropy, so a fast hash is the right choice here: there is no
 * low-entropy password to brute-force, and the digest is what gets stored, so a
 * database leak does not hand over usable tokens.
 */
export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/**
 * Mint a new admin token. The plaintext is returned once, at creation, and
 * never stored — only its hash and a short prefix (for the admin list) are.
 */
export function newAdminToken() {
  const token = `ctadi_${crypto.randomBytes(24).toString('base64url')}`;
  return { token, hash: hashToken(token), prefix: token.slice(0, 12) };
}

/** Constant-time string comparison that never throws on length mismatch. */
export function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) {
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Normalise arbitrary text: strip control characters, collapse runaway
 * whitespace, trim, and cap length. Used on all applicant input.
 */
export function cleanText(value, maxChars = 6000) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  s = s.replace(/\r\n/g, '\n');
  s = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  s = s.replace(/\n{4,}/g, '\n\n\n');
  s = s.replace(/[ \t]{3,}/g, '  ');
  s = s.trim();
  if (s.length > maxChars) s = `${s.slice(0, maxChars)}\u2026[truncated]`;
  return s;
}

export function isEmail(value) {
  if (typeof value !== 'string') return false;
  const s = value.trim();
  if (s.length < 5 || s.length > 254) return false;
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(s);
}

/** Escape a string for safe interpolation into HTML. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
