import { cleanText, isEmail } from './util.js';
import { loadConfig } from './config.js';

/**
 * Flatten the form definition into the ordered list of answerable questions
 * for a given role. Section A and availability apply to everyone; Section B
 * depends on the selected role.
 */
export function questionsForRole(role) {
  const { form } = loadConfig();
  const qs = [];
  for (const q of form.section_a.questions) qs.push({ ...q, section: 'A' });
  const roleBlock = form.section_b.roles[role];
  if (!roleBlock) throw new Error(`unknown role: ${role}`);
  for (const q of roleBlock.questions) qs.push({ ...q, section: 'B' });
  for (const q of form.availability.questions) qs.push({ ...q, section: 'C' });
  return qs;
}

export function roleLabel(role) {
  const { form } = loadConfig();
  return form.section_b.roles[role]?.label ?? role;
}

export function roleOptions() {
  const { form } = loadConfig();
  return Object.entries(form.section_b.roles).map(([value, r]) => ({ value, label: r.label }));
}

/**
 * Validate and normalise a raw submission payload.
 * Returns { ok, errors, application }.
 */
export function validateSubmission(raw) {
  const cfg = loadConfig();
  const maxChars = Number(process.env.MAX_ANSWER_CHARS || 6000);
  const errors = [];

  if (!raw || typeof raw !== 'object') {
    return { ok: false, errors: ['request body must be a JSON object'], application: null };
  }

  const identity = raw.identity ?? {};
  const fullName = cleanText(identity.full_name, 120);
  const email = cleanText(identity.email, 200).toLowerCase();
  const country = cleanText(identity.country, 120);
  const role = cleanText(identity.role, 40);

  if (!fullName) errors.push('identity.full_name is required');
  if (!isEmail(email)) errors.push('identity.email must be a valid email address');
  if (!cfg.form.section_b.roles[role]) errors.push(`identity.role must be one of: ${Object.keys(cfg.form.section_b.roles).join(', ')}`);
  if (raw.consent !== true) errors.push('consent must be accepted');

  const answers = {};
  const allQuestions = cfg.form.section_b.roles[role] ? questionsForRole(role) : [];
  const questionById = new Map(allQuestions.map((q) => [q.id, q]));

  for (const [id, value] of Object.entries(raw.answers ?? {})) {
    if (!questionById.has(id)) continue;
    answers[id] = cleanText(value, maxChars);
  }

  for (const q of allQuestions) {
    if (q.required && !answers[q.id]) {
      errors.push(`answers.${q.id} is required`);
    }
  }

  if (errors.length) {
    return { ok: false, errors, application: null };
  }

  const application = {
    identity: { full_name: fullName, email, country, role, role_label: roleLabel(role) },
    answers,
    questions: allQuestions.map((q) => ({
      id: q.id,
      label: q.label,
      section: q.section,
      type: q.type ?? 'text',
    })),
    raw_meta: {
      user_agent: cleanText(raw.meta?.user_agent, 300),
      received_at: new Date().toISOString(),
    },
  };
  return { ok: true, errors: [], application };
}
