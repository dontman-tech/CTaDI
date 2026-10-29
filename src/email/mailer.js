import { env } from '../lib/config.js';

/**
 * Email drivers, all on free tiers. Each exposes send({ to, subject, html, text }).
 * EMAIL_DRIVER selects one; "console" prints to stdout so the whole pipeline
 * can be exercised locally without any provider account.
 */

function consoleDriver() {
  return {
    name: 'console',
    isConfigured: () => true,
    async send({ to, subject, html, text }) {
      const line = '='.repeat(72);
      console.log(`\n${line}\n[email:console] to=${to}\n[email:console] subject=${subject}\n${line}`);
      console.log(text || stripHtml(html));
      console.log(`${line}\n`);
      return { id: `console_${Date.now()}`, driver: 'console' };
    },
  };
}

function stripHtml(html = '') {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function resendDriver() {
  const key = env('RESEND_API_KEY');
  const from = env('FROM_EMAIL');
  return {
    name: 'resend',
    isConfigured: () => Boolean(key && from),
    async send({ to, subject, html, text }) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject, html, text }),
      });
      const body = await res.text();
      if (!res.ok) throw new Error(`Resend failed: HTTP ${res.status} ${body.slice(0, 300)}`);
      return { id: JSON.parse(body).id, driver: 'resend' };
    },
  };
}

function brevoDriver() {
  const key = env('BREVO_API_KEY');
  const from = env('FROM_EMAIL', 'CTaDI Onboarding <onboarding@example.org>');
  const match = /^(.*)<(.+)>$/.exec(from);
  const sender = match ? { name: match[1].trim().replace(/^"|"$/g, ''), email: match[2].trim() } : { email: from };
  return {
    name: 'brevo',
    isConfigured: () => Boolean(key),
    async send({ to, subject, html, text }) {
      const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': key, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ sender, to: [{ email: to }], subject, htmlContent: html, textContent: text }),
      });
      const body = await res.text();
      if (!res.ok) throw new Error(`Brevo failed: HTTP ${res.status} ${body.slice(0, 300)}`);
      return { id: JSON.parse(body).messageId, driver: 'brevo' };
    },
  };
}

/**
 * Gmail driver using an app password over SMTP. Implemented with raw net/tls
 * so there is still no third-party dependency. Only used when explicitly
 * selected; most people should prefer Resend or Brevo.
 */
function gmailDriver() {
  const user = env('GMAIL_USER');
  const pass = env('GMAIL_APP_PASSWORD');
  return {
    name: 'gmail',
    isConfigured: () => Boolean(user && pass),
    async send({ to, subject, html, text }) {
      const { sendSmtp } = await import('./smtp.js');
      return sendSmtp({
        host: 'smtp.gmail.com',
        port: 465,
        user,
        pass,
        from: env('FROM_EMAIL', user),
        to,
        subject,
        html,
        text,
      });
    },
  };
}

const DRIVERS = {
  console: consoleDriver,
  resend: resendDriver,
  brevo: brevoDriver,
  gmail: gmailDriver,
};

let instance = null;

export function getMailer() {
  if (instance) return instance;
  const wanted = env('EMAIL_DRIVER', 'console');
  const factory = DRIVERS[wanted];
  if (!factory) throw new Error(`Unknown EMAIL_DRIVER "${wanted}". Use one of: ${Object.keys(DRIVERS).join(', ')}`);
  const driver = factory();
  if (!driver.isConfigured()) {
    throw new Error(`EMAIL_DRIVER=${wanted} is selected but its credentials are missing. Set them in .env, or use EMAIL_DRIVER=console.`);
  }
  instance = driver;
  return instance;
}

export function __setMailer(m) {
  instance = m;
}
