/**
 * Test doubles shared across the suite: an in-memory store and a recording
 * mailer. There is no LLM to fake any more — screening is manual, so tests
 * assert on the stored application and the email the admin receives.
 */

/** An in-memory store, so tests never touch the real database. */
export function makeMemoryStore() {
  const applications = new Map();
  const audit = [];
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
    async close() {},
    _all: () => [...applications.values()].map(clone),
    _audit: () => audit.slice(),
  };
}

/** A mailer that records messages instead of sending them. */
export function makeRecordingMailer() {
  const sent = [];
  return {
    name: 'recording',
    isConfigured: () => true,
    async send(msg) {
      sent.push(msg);
      return { id: `rec_${sent.length}` };
    },
    sent,
  };
}
