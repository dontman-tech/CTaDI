import crypto from 'node:crypto';
import { env, envInt } from './config.js';

export function nowIso() {
  return new Date().toISOString();
}

export function newId(prefix = 'app') {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

export function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
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

/** Escape a string for safe interpolation into HTML (emails + portal). */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Detect prompt-injection-shaped content. This does NOT block submission —
 * the scoring prompt already treats answers as data. It flags the application
 * for the human reviewer and is recorded for audit.
 */
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?)/i,
  /disregard\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier)/i,
  /system\s*prompt/i,
  /(^|\n)\s*(system|assistant|developer)\s*:/i,
  /give\s+(me|this\s+applicant|them)\s+(a\s+)?(score|100|full\s+marks)/i,
  /score\s*(of|=|:)\s*100/i,
  /output\s+(only\s+)?(valid\s+)?json/i,
  /<\/?(script|iframe|img|svg)/i,
];

export function scanForInjection(text) {
  if (!text) return { flagged: false, matches: [] };
  const matches = [];
  for (const re of INJECTION_PATTERNS) {
    const m = re.exec(text);
    if (m) matches.push(m[0].slice(0, 80));
  }
  return { flagged: matches.length > 0, matches };
}

export function clampScore(n, max) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(Math.round(v), max));
}

export function shortlistThreshold() {
  return envInt('SHORTLIST_THRESHOLD', 60);
}

export function approvalSecret() {
  const secret = env('APPROVAL_TOKEN_SECRET');
  if (secret) return secret;
  if (env('NODE_ENV') === 'production') {
    throw new Error('APPROVAL_TOKEN_SECRET must be set in production');
  }
  return 'dev-only-insecure-secret-do-not-use-in-production';
}
