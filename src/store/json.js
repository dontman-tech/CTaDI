import fs from 'node:fs';
import path from 'node:path';
import { env, ROOT } from '../lib/config.js';

/**
 * Zero-dependency JSON-file store. Fine for a few hundred applications or for
 * local development. Not safe across multiple instances — use SQLite or
 * Postgres if you scale out. Writes are atomic (write temp, then rename).
 */

const rateLimits = new Map();

function filePath() {
  const p = env('JSON_DB_PATH', './data/ctadi.json');
  return path.isAbsolute(p) ? p : path.join(ROOT, p);
}

function read() {
  const f = filePath();
  if (!fs.existsSync(f)) return { applications: [], audit: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(f, 'utf8'));
    return { applications: parsed.applications ?? [], audit: parsed.audit ?? [] };
  } catch {
    return { applications: [], audit: [] };
  }
}

function write(data) {
  const f = filePath();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, f);
}

export const jsonStore = {
  driver: 'json',

  async insert(record) {
    const data = read();
    data.applications.push(record);
    write(data);
    return record;
  },

  async update(id, patch) {
    const data = read();
    const i = data.applications.findIndex((a) => a.id === id);
    if (i === -1) return null;
    data.applications[i] = { ...data.applications[i], ...patch, updated_at: new Date().toISOString() };
    write(data);
    return data.applications[i];
  },

  async get(id) {
    return read().applications.find((a) => a.id === id) ?? null;
  },

  async getByEmail(email) {
    const e = String(email).toLowerCase();
    return (
      read()
        .applications.filter((a) => a.email === e && ['received', 'pending_review'].includes(a.status))
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0] ?? null
    );
  },

  async list({ status, limit = 100 } = {}) {
    return read()
      .applications.filter((a) => (status ? a.status === status : true))
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      .slice(0, limit);
  },

  async audit(applicationId, action, detail) {
    const data = read();
    data.audit.push({ at: new Date().toISOString(), application_id: applicationId ?? null, action, detail: detail ?? null });
    write(data);
  },

  /**
   * In-process fixed-window counter. The JSON store is single-instance by
   * nature, so this is exact rather than a fallback.
   */
  async rateLimit(key, windowSeconds = 3600) {
    const now = Date.now();
    const windowMs = windowSeconds * 1000;
    const entry = rateLimits.get(key);
    if (!entry || now - entry.start >= windowMs) {
      rateLimits.set(key, { start: now, count: 1 });
      return 1;
    }
    entry.count += 1;
    return entry.count;
  },

  async auditList(applicationId, limit = 50) {
    return read()
      .audit.filter((a) => a.application_id === applicationId)
      .slice(-limit)
      .reverse();
  },

  async close() {},
};
