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

/**
 * The admin review email: the whole application, in full, so it can be read and
 * judged without opening anything else. There is no automated score; the two
 * buttons are the entire decision.
 */
export function adminDigest({ application, links, config }) {
  const a = application.identity;
  const org = config?.organisation?.name ?? 'CTaDI';

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

  const inner = `
<div style="background:#fff;border-radius:10px;padding:22px;box-shadow:0 1px 3px rgba(0,0,0,.06);">
  <h1 style="margin:0 0 4px;font-size:19px;">New CTaDI application</h1>
  <p style="margin:0 0 18px;color:#5a6a60;font-size:14px;">Read it below, then approve or reject. Both links act immediately.</p>

  <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:18px;">
    <tr><td style="padding:4px 12px 4px 0;color:#7a8a80;">Name</td><td style="padding:4px 0;font-weight:600;">${escapeHtml(a.full_name)}</td></tr>
    <tr><td style="padding:4px 12px 4px 0;color:#7a8a80;">Email</td><td style="padding:4px 0;">${escapeHtml(a.email)}</td></tr>
    <tr><td style="padding:4px 12px 4px 0;color:#7a8a80;">Role</td><td style="padding:4px 0;">${escapeHtml(a.role_label)}</td></tr>
    <tr><td style="padding:4px 12px 4px 0;color:#7a8a80;">Based in</td><td style="padding:4px 0;">${escapeHtml(a.country || '—')}</td></tr>
    <tr><td style="padding:4px 12px 4px 0;color:#7a8a80;">Application</td><td style="padding:4px 0;font-family:ui-monospace,monospace;font-size:12px;">${escapeHtml(application.id ?? '')}</td></tr>
  </table>

  <div style="margin:22px 0 8px;text-align:center;">
    <a href="${links.approve}" style="display:inline-block;background:#2f7d4f;color:#fff;text-decoration:none;font-weight:600;padding:13px 30px;border-radius:7px;margin:4px;">Approve &amp; send invite</a>
    <a href="${links.reject}" style="display:inline-block;background:#fff;color:#a33;border:1px solid #e0b4b4;text-decoration:none;font-weight:600;padding:13px 30px;border-radius:7px;margin:4px;">Reject</a>
  </div>
  <p style="text-align:center;font-size:12px;color:#7a8a80;margin:6px 0 0;">One click records your decision. The approve link sends the community invite to the applicant.</p>
</div>

<div style="background:#fff;border-radius:10px;padding:22px;margin-top:18px;box-shadow:0 1px 3px rgba(0,0,0,.06);">
  <h2 style="font-size:15px;margin:0 0 14px;">Application</h2>
  ${answers}
</div>`;

  const text = [
    `New ${org} application — ${a.full_name} (${a.role_label})`,
    '',
    `Name:  ${a.full_name}`,
    `Email: ${a.email}`,
    `Role:  ${a.role_label}`,
    `Based: ${a.country || '-'}`,
    '',
    'APPROVE: ' + links.approve,
    'REJECT:  ' + links.reject,
    '',
    'ANSWERS',
    ...application.questions.map((q) => `\n[${q.section}/${q.id}] ${q.label}\n${application.answers[q.id] ?? ''}`),
  ].join('\n');

  return { subject: `[${org}] New application: ${a.full_name} (${a.role_label})`, html: SHELL(inner), text };
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
