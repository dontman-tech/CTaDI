import { loadConfig, env } from './lib/config.js';
import { nowIso, newId } from './lib/util.js';
import { validateSubmission } from './lib/form.js';
import { getStore } from './store/index.js';

/**
 * The onboarding pipeline.
 *
 *   submitApplication -> store as pending_review -> (admin reviews in the
 *   dashboard) -> recordDecision -> the applicant's status page changes
 *
 * There is no automated screening and no email. Every submission waits in the
 * admin dashboard, where a person reads it in full and approves or rejects it.
 * The applicant's status page is how they learn the outcome.
 */

export async function submitApplication(rawPayload, { store, config = loadConfig() } = {}) {
  store = store ?? (await getStore());
  const { ok, errors, application } = validateSubmission(rawPayload);
  if (!ok) return { ok: false, status: 400, errors };

  const existing = await store.getByEmail(application.identity.email);
  if (existing) {
    return {
      ok: false,
      status: 409,
      errors: ['An application from this email address is already in progress.'],
      applicationId: existing.id,
      statusUrl: `/status?id=${existing.id}`,
    };
  }

  const id = newId('app');
  const record = {
    id,
    created_at: nowIso(),
    updated_at: nowIso(),
    email: application.identity.email,
    full_name: application.identity.full_name,
    role: application.identity.role,
    role_label: application.identity.role_label,
    status: 'pending_review',
    application: { ...application, id },
    decision: null,
    decided_at: null,
    decided_by: null,
  };

  await store.insert(record);
  await store.audit(id, 'submitted', { email: record.email, role: record.role });

  return { ok: true, status: 201, applicationId: id, statusUrl: `/status?id=${id}` };
}

/**
 * Record a human decision made in the admin dashboard. This is the only place
 * a decision is written, and it is guarded so a second click cannot flip an
 * existing decision.
 */
export async function recordDecision(id, decision, { store, config = loadConfig(), decidedBy = 'admin' } = {}) {
  store = store ?? (await getStore());
  if (decision !== 'approve' && decision !== 'reject') {
    return { ok: false, status: 400, reason: 'bad_decision' };
  }
  const record = await store.get(id);
  if (!record) return { ok: false, status: 404, reason: 'not_found' };
  if (record.decision) {
    return { ok: true, status: 200, alreadyDecided: true, decision: record.decision, record };
  }

  const approved = decision === 'approve';
  const updated = await store.update(id, {
    status: approved ? 'approved' : 'rejected',
    decision: approved ? 'approved' : 'rejected',
    decided_at: nowIso(),
    decided_by: decidedBy,
  });
  await store.audit(id, approved ? 'approved' : 'rejected', { by: decidedBy });

  return { ok: true, status: 200, decision: updated.decision, record: updated };
}

/** Shape a record for the public status page — never leaks internal notes. */
export function publicStatus(record, config = loadConfig()) {
  const m = config.messages;
  const inviteUrl = env('COMMUNITY_INVITE_URL', config.portal.community_invite_url);
  const base = {
    id: record.id,
    submitted_at: record.created_at,
    role_label: record.role_label,
    full_name: record.full_name,
  };

  switch (record.status) {
    case 'approved':
      return {
        ...base,
        state: 'approved',
        heading: 'You are in — welcome to CTaDI',
        message: m.applicant_approved,
        community_link: inviteUrl,
      };
    case 'rejected':
      return { ...base, state: 'rejected', heading: 'Application reviewed', message: m.applicant_rejected };
    case 'pending_review':
    default:
      return { ...base, state: 'pending', heading: 'Application under review', message: m.applicant_under_review };
  }
}

/**
 * Shape a record for the admin dashboard: the full application plus the
 * review state. This is the only view that exposes the applicant's answers to
 * anyone other than the applicant.
 */
export function adminView(record, config = loadConfig()) {
  const a = record.application;
  return {
    id: record.id,
    submitted_at: record.created_at,
    updated_at: record.updated_at,
    status: record.status,
    decision: record.decision,
    decided_at: record.decided_at,
    decided_by: record.decided_by,
    identity: a.identity,
    answers: a.answers,
    questions: a.questions,
    availability: a.availability,
    consent: a.consent,
    community_link: record.status === 'approved' ? env('COMMUNITY_INVITE_URL', config.portal.community_invite_url) : null,
  };
}
