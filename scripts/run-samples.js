#!/usr/bin/env node
/**
 * Render the sample applications through the real pipeline and print what the
 * admin dashboard would show. There is no scoring and no email: screening is
 * manual, so this is a preview of the review screen.
 *
 *   node scripts/run-samples.js            # all samples
 *   node scripts/run-samples.js strong     # one sample by name
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadConfig } from '../src/lib/config.js';
import { validateSubmission } from '../src/lib/form.js';
import { adminView, publicStatus } from '../src/pipeline.js';
import { makeMemoryStore } from '../test/helpers/doubles.js';

process.env.COMMUNITY_INVITE_URL ||= 'https://community.example.org/join/ctadi';

const config = loadConfig();
const samples = JSON.parse(fs.readFileSync(path.join(ROOT, 'samples', 'applicants.json'), 'utf8'));
const allKeys = Object.keys(samples).filter((k) => !k.startsWith('_'));
const wanted = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const keys = wanted.length ? wanted : allKeys;

const store = makeMemoryStore();

console.log(`\nCTaDI sample review — ${keys.length} of ${allKeys.length} sample(s)`);
console.log('Screening is manual: each application below waits in the admin dashboard.\n');

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

  const record = {
    id: `app_sample_${key}`,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    email: application.identity.email,
    full_name: application.identity.full_name,
    role: application.identity.role,
    role_label: application.identity.role_label,
    status: 'pending_review',
    application: { ...application, id: `app_sample_${key}` },
    decision: null,
    decided_at: null,
    decided_by: null,
  };
  await store.insert(record);

  const view = adminView(record, config);
  const status = publicStatus(record, config);

  console.log('─'.repeat(72));
  console.log(`sample    : ${key}`);
  console.log(`applicant : ${view.identity.full_name} <${view.identity.email}>`);
  console.log(`role      : ${view.identity.role_label}`);
  console.log(`status    : ${view.status}`);
  console.log(`answers   : ${Object.keys(view.answers).length} questions`);
  console.log(`applicant sees: "${status.heading}"`);
  console.log('─'.repeat(72));
  const first = view.questions.find((q) => q.id === 'a1') ?? view.questions[0];
  console.log(`  ${first.label}`);
  console.log(`  → ${view.answers[first.id]?.slice(0, 150)}…`);
  console.log();
}

console.log('What happens next in production:');
console.log('  - the admin opens /admin, reads the application in full');
console.log("  - Approve -> the applicant's status page shows the community invite");
console.log("  - Reject  -> the applicant's status page shows a polite closing message\n");
