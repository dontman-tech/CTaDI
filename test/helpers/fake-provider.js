/**
 * A deterministic, offline stand-in for a real LLM provider. Tests use it so
 * the whole pipeline can be exercised without network access, keys, or cost.
 *
 * It is deliberately naive: it reads the answer text for a few signals and
 * produces a rubric-shaped response. It is NOT a scoring model and does not
 * reproduce real scoring quality — it exists to prove the plumbing works
 * (prompt -> provider -> validation -> threshold -> email -> decision).
 */

const SIGNALS = [
  /because/i, /I (have|did|built|designed|ran|wrote|maintained|repaired)/i,
  /\d+\s*(years|kW|hours)/i, /what failed/i, /next time/i, /trade-?off/i,
  /constraint/i, /repair/i, /local/i,
];

export function makeFakeProvider({ name = 'fake', model = 'fake-1', text, failWith, delayMs = 0, calls } = {}) {
  const state = { count: 0 };
  return {
    name,
    model,
    isConfigured: () => true,
    calls: state,
    async call() {
      state.count += 1;
      if (calls) calls.push({ provider: name, at: Date.now() });
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (typeof failWith === 'function') {
        const err = failWith(state.count);
        if (err) throw err;
      } else if (failWith) {
        throw failWith;
      }
      if (typeof text === 'function') return text(state.count);
      return text;
    },
  };
}

/** Build a valid evaluation JSON string from a simple score map. */
export function fakeEvaluation({ total, overrides = {} } = {}) {
  const maxes = {
    values_alignment: 30,
    relevant_skill_level: 30,
    quality_of_thinking: 20,
    evidence_of_real_work: 10,
    commitment_and_availability: 10,
  };
  const scores = { ...maxes, ...overrides };
  const criteria = Object.entries(scores).map(([name, score]) => ({
    name,
    score,
    max: maxes[name],
    justification: `Evidence for ${name}.`,
  }));
  const total_score = total ?? criteria.reduce((s, c) => s + c.score, 0);
  return JSON.stringify({
    total_score,
    criteria,
    strengths: ['Concrete evidence of real work.'],
    concerns: ['Limited availability.'],
    recommendation: total_score >= 60 ? 'shortlist' : 'reject',
  });
}

/** A simple heuristic score for offline runs, so the demo needs no API key. */
export function heuristicEvaluation(application) {
  const text = Object.values(application.answers).join('\n');
  const hits = SIGNALS.filter((re) => re.test(text)).length;
  const lengthBonus = Math.min(12, Math.floor(text.length / 700));
  const overall = Math.max(5, Math.min(95, 22 + hits * 7 + lengthBonus));
  const weights = {
    values_alignment: 30,
    relevant_skill_level: 30,
    quality_of_thinking: 20,
    evidence_of_real_work: 10,
    commitment_and_availability: 10,
  };
  const criteria = Object.entries(weights).map(([name, max]) => ({
    name,
    score: Math.round((overall / 100) * max),
    max,
    justification: `Heuristic score for ${name} (offline mode).`,
  }));
  const total_score = criteria.reduce((s, c) => s + c.score, 0);
  return {
    total_score,
    criteria,
    strengths: ['Answers contain concrete, specific detail.'],
    concerns: hits < 3 ? ['Answers are thin on evidence.'] : [],
    recommendation: total_score >= 60 ? 'shortlist' : 'reject',
  };
}

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
            .filter((a) => a.email === e && ['received', 'scored', 'parked', 'shortlisted'].includes(a.status))
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
