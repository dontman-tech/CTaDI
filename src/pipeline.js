import { loadConfig, env, envBool, envInt } from './lib/config.js';
import { nowIso, newId } from './lib/util.js';
import { decisionLinks } from './lib/tokens.js';
import { validateSubmission } from './lib/form.js';
import { getStore } from './store/index.js';
import { getMailer } from './email/mailer.js';
import { adminDigest, applicantMessage } from './email/templates.js';
import { scoreApplication, ScoringError } from './llm/scorer.js';

/**
 * The onboarding pipeline. Each step is a small function so it can be tested
 * on its own, and the whole flow can be driven from tests without HTTP.
 *
 *   submitApplication -> store -> score -> threshold -> (admin digest | applicant note)
 *   recordDecision    -> store -> (community link | closing message)
 */

export async function submitApplication(rawPayload, { store = getStore(), mailer, scorer, config = loadConfig() } = {}) {
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
    status: 'received',
    total_score: null,
    shortlisted: false,
    evaluation: null,
    application: { ...application, id },
    scoring_provider: null,
    scoring_model: null,
    scoring_error: null,
    injection_flag: application.injection_flag,
    decision: null,
    decided_at: null,
    decided_by: null,
    notified_admin_at: null,
  };

  await store.insert(record);
  await store.audit(id, 'submitted', { email: record.email, role: record.role, injection_flag: record.injection_flag });

  const outcome = await processApplication(id, { store, mailer, scorer, config });
  return { ok: true, status: 201, applicationId: id, statusUrl: `/status?id=${id}`, outcome };
}

/**
 * Score a stored application, apply the threshold, and notify the admin if it
 * is shortlisted. Safe to re-run, which is how a parked application is rescued
 * after a provider outage.
 */
export async function processApplication(id, { store = getStore(), mailer, scorer, config = loadConfig() } = {}) {
  const record = await store.get(id);
  if (!record) return { ok: false, reason: 'not_found' };

  const doScore = scorer ?? scoreApplication;
  let scored;
  try {
    scored = await doScore(record.application, { config });
  } catch (err) {
    const attempts = err instanceof ScoringError ? err.attempts : [];
    await store.update(id, { status: 'parked', scoring_error: String(err.message ?? err) });
    await store.audit(id, 'scoring_failed', { error: String(err.message ?? err), attempts });
    return { ok: false, reason: 'scoring_failed', error: String(err.message ?? err), attempts };
  }

  const threshold = config.scoring.shortlist_threshold;
  const shortlisted = scored.evaluation.total_score >= threshold;

  await store.update(id, {
    status: shortlisted ? 'shortlisted' : 'not_shortlisted',
    total_score: scored.evaluation.total_score,
    shortlisted,
    evaluation: scored.evaluation,
    scoring_provider: scored.provider,
    scoring_model: scored.model,
    scoring_error: null,
  });
  await store.audit(id, 'scored', {
    total_score: scored.evaluation.total_score,
    threshold,
    shortlisted,
    provider: scored.provider,
    model: scored.model,
    latency_ms: scored.latency_ms,
    attempts: scored.attempts,
  });

  let notified = false;
  if (shortlisted) {
    notified = await notifyAdmin(id, { store, mailer, config });
  } else if (mailer) {
    // Neutral status message to the applicant — no score, no ranking.
    await sendApplicantStatus(await store.get(id), 'not_shortlisted', { mailer, config });
  }

  return {
    ok: true,
    applicationId: id,
    total_score: scored.evaluation.total_score,
    threshold,
    shortlisted,
    notified_admin: notified,
    evaluation: scored.evaluation,
    provider: scored.provider,
    model: scored.model,
  };
}

export async function notifyAdmin(id, { store = getStore(), mailer, config = loadConfig() } = {}) {
  const record = await store.get(id);
  if (!record?.evaluation) return false;
  const m = mailer ?? getMailer();

  const baseUrl = env('PUBLIC_BASE_URL', 'http://localhost:3000');
  const ttlHours = envInt('APPROVAL_TOKEN_TTL_HOURS', 336);
  const links = decisionLinks(baseUrl, id, ttlHours);

  const { subject, html, text } = adminDigest({
    application: record.application,
    evaluation: record.evaluation,
    links,
    config,
    threshold: config.scoring.shortlist_threshold,
  });

  await m.send({ to: env('ADMIN_EMAIL'), subject, html, text });
  await store.update(id, { notified_admin_at: nowIso() });
  await store.audit(id, 'admin_notified', { to: env('ADMIN_EMAIL') });
  return true;
}

export async function sendApplicantStatus(record, kind, { store = getStore(), mailer, config = loadConfig() } = {}) {
  const m = mailer ?? getMailer();
  const messages = config.messages;
  const a = record.application.identity;
  const org = config.organisation.name;

  if (kind === 'not_shortlisted') {
    const { html, text } = applicantMessage({
      heading: `Thank you for applying to ${org}`,
      body: messages.applicant_not_shortlisted,
      footnote: 'This is an automated message. A human reviewer reads every application that reaches review.',
    });
    await m.send({ to: a.email, subject: `${org} — your application`, html, text });
    await store.audit(record.id, 'applicant_notified_not_shortlisted', null);
    return true;
  }

  if (kind === 'approved') {
    const inviteUrl = env('COMMUNITY_INVITE_URL', config.portal.community_invite_url);
    const { html, text } = applicantMessage({
      heading: `Welcome to ${org}`,
      body: messages.applicant_approved,
      link: inviteUrl,
      linkLabel: 'Join the CTaDI community',
      footnote: 'This invitation link is personal to you. If you were not expecting it, please ignore this message.',
    });
    await m.send({ to: a.email, subject: `Welcome to ${org}`, html, text });
    await store.audit(record.id, 'applicant_notified_approved', null);
    return true;
  }

  if (kind === 'rejected') {
    const { html, text } = applicantMessage({
      heading: `Your ${org} application`,
      body: messages.applicant_rejected,
    });
    await m.send({ to: a.email, subject: `${org} — your application`, html, text });
    await store.audit(record.id, 'applicant_notified_rejected', null);
    return true;
  }

  return false;
}

/**
 * Record a human decision. This is the only place a decision is written, and
 * it is guarded so a second click cannot flip an existing decision.
 */
export async function recordDecision(id, decision, { store = getStore(), mailer, config = loadConfig(), decidedBy = 'admin_link' } = {}) {
  const record = await store.get(id);
  if (!record) return { ok: false, status: 404, reason: 'not_found' };
  if (decision !== 'approve' && decision !== 'reject') {
    return { ok: false, status: 400, reason: 'bad_decision' };
  }
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

  // On approval the applicant gets the community link: by email if configured,
  // and always on the portal status page. On rejection they get a polite close.
  try {
    if (approved && envBool('EMAIL_APPLICANT_ON_APPROVAL', config.portal.email_applicant_on_approval)) {
      await sendApplicantStatus(updated, 'approved', { store, mailer, config });
    } else if (!approved) {
      await sendApplicantStatus(updated, 'rejected', { store, mailer, config });
    }
  } catch (err) {
    await store.audit(id, 'applicant_notification_failed', { error: String(err.message ?? err) });
  }

  return { ok: true, status: 200, decision: updated.decision, record: updated };
}

/** Shape a record for the public status page — never leaks scores or evaluations. */
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
    case 'not_shortlisted':
      return { ...base, state: 'closed', heading: 'Application reviewed', message: m.applicant_not_shortlisted };
    case 'shortlisted':
      return { ...base, state: 'shortlisted', heading: 'Application shortlisted', message: m.applicant_shortlisted };
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
    case 'received':
    case 'scored':
    case 'parked':
    default:
      return { ...base, state: 'pending', heading: 'Application received', message: m.applicant_received };
  }
}
