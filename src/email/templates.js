import { escapeHtml } from '../lib/util.js';

const SHELL = (inner) => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f6f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1c2b23;">
<div style="max-width:640px;margin:0 auto;padding:24px 16px;">
${inner}
<p style="font-size:12px;color:#7a8a80;margin-top:28px;line-height:1.5;">
  Sent automatically by the CTaDI onboarding portal. This message contains applicant data — please handle it accordingly.
</p>
</div></body></html>`;

function scoreBar(score, max) {
  const pct = max > 0 ? Math.round((score / max) * 100) : 0;
  const colour = pct >= 70 ? '#2f7d4f' : pct >= 40 ? '#b8860b' : '#a33';
  return `<div style="background:#e6ebe7;border-radius:3px;height:8px;width:100%;overflow:hidden;">
    <div style="background:${colour};height:8px;width:${pct}%;"></div></div>`;
}

export function adminDigest({ application, evaluation, links, config, threshold }) {
  const a = application.identity;
  const criteria = evaluation.criteria
    .map(
      (c) => `<tr>
        <td style="padding:8px 12px 8px 0;vertical-align:top;font-weight:600;white-space:nowrap;">${escapeHtml(c.name.replace(/_/g, ' '))}</td>
        <td style="padding:8px 0;vertical-align:top;width:100%;">
          <div style="font-size:13px;color:#556;margin-bottom:4px;">${c.score} / ${c.max}</div>
          ${scoreBar(c.score, c.max)}
          <div style="font-size:13px;color:#334;margin-top:6px;line-height:1.5;">${escapeHtml(c.justification)}</div>
        </td>
      </tr>`,
    )
    .join('');

  const list = (items) =>
    items.length
      ? `<ul style="margin:6px 0 0;padding-left:18px;">${items.map((s) => `<li style="margin-bottom:4px;line-height:1.5;">${escapeHtml(s)}</li>`).join('')}</ul>`
      : '<p style="margin:6px 0 0;color:#778;font-size:14px;">None recorded.</p>';

  const answers = application.questions
    .map((q) => {
      const text = application.answers[q.id] ?? '';
      return `<div style="margin-bottom:16px;">
        <div style="font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#7a8a80;">Section ${escapeHtml(q.section)} · ${escapeHtml(q.id)}</div>
        <div style="font-weight:600;margin:2px 0 6px;line-height:1.45;">${escapeHtml(q.label)}</div>
        <div style="white-space:pre-wrap;background:#fff;border:1px solid #e2e7e3;border-radius:6px;padding:10px 12px;font-size:14px;line-height:1.6;">${escapeHtml(text)}</div>
      </div>`;
    })
    .join('');

  const injectionWarning = application.injection_flag
    ? `<div style="background:#fff4f4;border:1px solid #f0c6c6;border-radius:6px;padding:12px;margin-bottom:16px;">
        <strong>⚠️ Possible prompt-injection attempt detected.</strong>
        <p style="margin:6px 0 0;font-size:13px;line-height:1.5;">
        The application text contained phrasing that resembles instructions to an AI system (for example: ${escapeHtml(
          (application.injection_matches ?? []).join('; '),
        )}). The automated score ignores such text, but please read this application yourself before deciding.
        </p>
      </div>`
    : '';

  const rec = evaluation.recommendation === 'shortlist' ? 'Shortlist' : 'Reject';

  const inner = `
<div style="background:#fff;border-radius:10px;padding:22px;box-shadow:0 1px 3px rgba(0,0,0,.06);">
  <h1 style="margin:0 0 4px;font-size:19px;">New shortlisted application</h1>
  <p style="margin:0 0 18px;color:#5a6a60;font-size:14px;">Scored ${evaluation.total_score}/100 — at or above your threshold of ${threshold}.</p>

  ${injectionWarning}

  <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:18px;">
    <tr><td style="padding:4px 12px 4px 0;color:#7a8a80;">Name</td><td style="padding:4px 0;font-weight:600;">${escapeHtml(a.full_name)}</td></tr>
    <tr><td style="padding:4px 12px 4px 0;color:#7a8a80;">Email</td><td style="padding:4px 0;">${escapeHtml(a.email)}</td></tr>
    <tr><td style="padding:4px 12px 4px 0;color:#7a8a80;">Role</td><td style="padding:4px 0;">${escapeHtml(a.role_label)}</td></tr>
    <tr><td style="padding:4px 12px 4px 0;color:#7a8a80;">Based in</td><td style="padding:4px 0;">${escapeHtml(a.country || '—')}</td></tr>
    <tr><td style="padding:4px 12px 4px 0;color:#7a8a80;">Application</td><td style="padding:4px 0;font-family:ui-monospace,monospace;font-size:12px;">${escapeHtml(application.id ?? '')}</td></tr>
  </table>

  <div style="background:#eef4ef;border-radius:8px;padding:14px 16px;margin-bottom:20px;text-align:center;">
    <div style="font-size:34px;font-weight:700;color:#2f7d4f;line-height:1;">${evaluation.total_score}<span style="font-size:16px;color:#6a7a70;">/100</span></div>
    <div style="font-size:13px;color:#5a6a60;margin-top:4px;">Model recommendation: <strong>${rec}</strong></div>
  </div>

  <h2 style="font-size:15px;margin:0 0 10px;">Criterion breakdown</h2>
  <table style="width:100%;border-collapse:collapse;margin-bottom:22px;">${criteria}</table>

  <h2 style="font-size:15px;margin:0 0 6px;">Strengths</h2>
  ${list(evaluation.strengths)}

  <h2 style="font-size:15px;margin:20px 0 6px;">Concerns</h2>
  ${list(evaluation.concerns)}

  <div style="margin:26px 0 8px;text-align:center;">
    <a href="${links.approve}" style="display:inline-block;background:#2f7d4f;color:#fff;text-decoration:none;font-weight:600;padding:13px 30px;border-radius:7px;margin:4px;">Approve &amp; send invite</a>
    <a href="${links.reject}" style="display:inline-block;background:#fff;color:#a33;border:1px solid #e0b4b4;text-decoration:none;font-weight:600;padding:13px 30px;border-radius:7px;margin:4px;">Reject</a>
  </div>
  <p style="text-align:center;font-size:12px;color:#7a8a80;margin:6px 0 0;">One click records your decision. The approve link sends the community invite to the applicant.</p>
</div>

<div style="background:#fff;border-radius:10px;padding:22px;margin-top:18px;box-shadow:0 1px 3px rgba(0,0,0,.06);">
  <h2 style="font-size:15px;margin:0 0 14px;">Original answers</h2>
  ${answers}
</div>`;

  const text = [
    `New shortlisted CTaDI application — ${evaluation.total_score}/100 (threshold ${threshold})`,
    '',
    `Name:  ${a.full_name}`,
    `Email: ${a.email}`,
    `Role:  ${a.role_label}`,
    `Based: ${a.country || '-'}`,
    `Model recommendation: ${rec}`,
    application.injection_flag ? 'WARNING: possible prompt-injection attempt detected — review manually.' : '',
    '',
    'CRITERIA',
    ...evaluation.criteria.map((c) => `- ${c.name}: ${c.score}/${c.max} — ${c.justification}`),
    '',
    'STRENGTHS',
    ...(evaluation.strengths.length ? evaluation.strengths.map((s) => `- ${s}`) : ['- none recorded']),
    '',
    'CONCERNS',
    ...(evaluation.concerns.length ? evaluation.concerns.map((s) => `- ${s}`) : ['- none recorded']),
    '',
    `APPROVE: ${links.approve}`,
    `REJECT:  ${links.reject}`,
    '',
    'ORIGINAL ANSWERS',
    ...application.questions.map((q) => `\n[${q.section}/${q.id}] ${q.label}\n${application.answers[q.id] ?? ''}`),
  ]
    .filter((l) => l !== '')
    .join('\n');

  return { subject: `[CTaDI] Shortlisted: ${a.full_name} (${a.role_label}) — ${evaluation.total_score}/100`, html: SHELL(inner), text };
}

export function applicantMessage({ heading, body, link, linkLabel, footnote }) {
  const inner = `
<div style="background:#fff;border-radius:10px;padding:26px;box-shadow:0 1px 3px rgba(0,0,0,.06);">
  <h1 style="margin:0 0 12px;font-size:18px;">${escapeHtml(heading)}</h1>
  <p style="margin:0 0 16px;line-height:1.65;font-size:15px;">${escapeHtml(body)}</p>
  ${
    link
      ? `<div style="margin:22px 0;text-align:center;"><a href="${link}" style="display:inline-block;background:#2f7d4f;color:#fff;text-decoration:none;font-weight:600;padding:13px 28px;border-radius:7px;">${escapeHtml(linkLabel || 'Continue')}</a></div>
         <p style="font-size:12px;color:#7a8a80;word-break:break-all;text-align:center;">${escapeHtml(link)}</p>`
      : ''
  }
  ${footnote ? `<p style="margin:16px 0 0;font-size:13px;color:#7a8a80;line-height:1.5;">${escapeHtml(footnote)}</p>` : ''}
</div>`;
  const text = [heading, '', body, link ? `\n${linkLabel || 'Continue'}: ${link}` : '', footnote ? `\n${footnote}` : '']
    .filter(Boolean)
    .join('\n');
  return { html: SHELL(inner), text };
}
