import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// src/lib/config.js -> repo root is two levels up.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Read a JSON config file.
 *
 * `require` is used first because it is a *static* call with a literal path, so
 * bundlers and Vercel's file tracer can see exactly which files to ship with the
 * function. A dynamic `fs.readFileSync(path.join(root, rel))` is invisible to
 * the tracer and the file is left out of the deployment, which fails at runtime
 * with ENOENT. The fs path is kept as a fallback for unusual layouts.
 */
const require = createRequire(import.meta.url);
const JSON_FILES = { 'ctadi.config.json': true, 'form.json': true };

function readJson(rel) {
  if (JSON_FILES[rel]) {
    try {
      return require(`../../${rel}`);
    } catch {
      /* fall through to the filesystem */
    }
  }
  return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
}

let cached = null;

export function loadConfig() {
  if (cached) return cached;
  const config = readJson('ctadi.config.json');
  const form = readJson('form.json');
  validateConfig(config);
  cached = { ...config, form, root };
  return cached;
}

function validateConfig(c) {
  if (!c.organisation?.name) {
    throw new Error('organisation.name is required in ctadi.config.json');
  }
  if (!c.messages?.applicant_received) {
    throw new Error('messages.applicant_received is required in ctadi.config.json');
  }
  if (!c.portal?.community_invite_url) {
    throw new Error('portal.community_invite_url is required in ctadi.config.json');
  }
}

export function env(name, fallback = undefined) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

export function envBool(name, fallback = false) {
  const v = env(name);
  if (v === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

export function envInt(name, fallback) {
  const v = env(name);
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export const ROOT = root;
