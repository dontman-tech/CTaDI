#!/usr/bin/env node
/**
 * Render the sample applications through the real pipeline and print what the
 * admin would receive. Screening is manual, so there is no score to compute —
 * this shows the digest email and the links it would contain.
 *
 *   node scripts/run-samples.js            # all samples
 *   node scripts/run-samples.js strong     # one sample by name
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadConfig } from '../src/lib/config.js';
import { validateSubmission } from '../src/lib/form.js';
import { adminDigest } from '../src/email/templates.js';
import { decisionLinks } from '../src/lib/tokens.js';

process.env.APPROVAL_TOKEN_SECRET ||= 'sample-only-secret';
process.env.PUBLIC_BASE_URL ||= 'http://localhost:3000';

const config = loadConfig();
const samples = JSON.parse(fs.readFileSync(path.join(ROOT, 'samples', 'applicants.json'), 'utf8'));
const allKeys = Object.keys(samples).filter((k) => !k.startsWith('_'));
const wanted = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const keys = wanted.length ? wanted : allKeys;

console.log(`\nCTaDI sample review — ${keys.length} of ${allKeys.length} sample(s)`);
console.log('Screening is manual: each application below would be emailed to the admin.\n');

for (const key of keys) {
  const sample = samples[key];
  if (!sample) {
    console.error(`  ${key}: no such sample\n`);
    continue;
  }
  const { ok, application, errors } = validateSubmission(sample);
  if (!ok) {
    console.error(`  ${key}: INVALID SAMPLE — ${errors.join(', ')}\n`);
    continue;
  }

  const links = decisionLinks(process.env.PUBLIC_BASE_URL, `app_sample_${key}`, 336);
  const { subject, text } = adminDigest({ application, links, config });

  console.log('─'.repeat(72));
  console.log(`sample    : ${key}`);
  console.log(`subject   : ${subject}`);
  console.log(`applicant : ${application.identity.full_name} <${application.identity.email}>`);
  console.log(`role      : ${application.identity.role_label}`);
  console.log(`answers   : ${Object.keys(application.answers).length} questions`);
  console.log(`approve   : ${links.approve.slice(0, 88)}…`);
  console.log(`reject    : ${links.reject.slice(0, 88)}…`);
  console.log('─'.repeat(72));
  console.log(text.split('\n').slice(0, 12).join('\n'));
  console.log("  … (the full email contains every answer in the applicant's own words)\n");
}

console.log('What happens next in production:');
console.log('  - the admin reads the email and clicks Approve or Reject');
console.log("  - Approve  -> the applicant's status page shows the community invite link");
console.log("  - Reject   -> the applicant's status page shows a polite closing message\n");
