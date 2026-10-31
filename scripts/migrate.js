#!/usr/bin/env node
/**
 * Apply schema.sql to the database in DATABASE_URL.
 *
 *   npm run migrate
 *
 * Safe to run repeatedly: every statement is CREATE ... IF NOT EXISTS.
 */
import fs from 'node:fs';
import path from 'node:path';
import { neon } from '@neondatabase/serverless';
import { ROOT, env } from '../src/lib/config.js';

const url = env('DATABASE_URL') ?? env('POSTGRES_URL');
if (!url) {
  console.error('DATABASE_URL is not set. Put it in .env, or add the Postgres integration in Vercel.');
  process.exit(1);
}

const sqlText = fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8');
const sql = neon(url);

// The HTTP driver runs one statement per call, so split on semicolons that end
// a statement (ignoring the ones inside comments and the file's blank lines).
const statements = sqlText
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n')
  .split(';')
  .map((s) => s.trim())
  .filter(Boolean);

console.log(`Applying ${statements.length} statements…`);
for (const statement of statements) {
  await sql.query(statement);
}
console.log('Schema is up to date.');
