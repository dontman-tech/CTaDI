/**
 * Test doubles shared across the suite: an in-memory store that mirrors the
 * real store contract. There is no LLM and no mailer any more — screening
 * happens in the admin dashboard, so tests assert on the stored application
 * and the admin API responses.
 */

/** An in-memory store, so tests never touch the real database. */
export function makeMemoryStore() {
  const applications = new Map();
  const audit = [];
  const rateLimits = new Map();
  const clone = (r) => (r ? JSON.parse(JSON.stringify(r)) : null);
  return {
    driver: 'memory',
    async insert(record) {
      applications.set(record.id, clone(record));
      return clone(record);
    },
    async update(id, patch) {
      const cur = applications.get(id);
      if (!cur) return null;
      const next = { ...cur, ...patch, updated_at: new Date().toISOString() };
      applications.set(id, next);
      return clone(next);
    },
    async get(id) {
      return clone(applications.get(id));
    },
    async getByEmail(email) {
      const e = String(email).toLowerCase();
      return (
        clone(
          [...applications.values()]
            .filter((a) => a.email === e && ['received', 'pending_review'].includes(a.status))
            .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0],
        ) ?? null
      );
    },
    async list({ status, limit = 100 } = {}) {
      return [...applications.values()]
        .filter((a) => (status ? a.status === status : true))
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
        .slice(0, limit)
        .map(clone);
    },
    async audit(applicationId, action, detail) {
      audit.push({ at: new Date().toISOString(), application_id: applicationId ?? null, action, detail: detail ?? null });
    },
    async auditList(applicationId, limit = 50) {
      return audit.filter((a) => a.application_id === applicationId).slice(-limit).reverse();
    },
    async rateLimit(key, windowSeconds = 3600) {
      const now = Date.now();
      const entry = rateLimits.get(key);
      if (!entry || now - entry.start >= windowSeconds * 1000) {
        rateLimits.set(key, { start: now, count: 1 });
        return 1;
      }
      entry.count += 1;
      return entry.count;
    },
    async close() {},
    _all: () => [...applications.values()].map(clone),
    _audit: () => audit.slice(),
  };
}
