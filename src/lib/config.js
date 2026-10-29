import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// src/lib/config.js -> repo root is two levels up.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function readJson(rel) {
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
  const w = c.scoring?.weights ?? {};
  const total = Object.values(w).reduce((a, b) => a + b, 0);
  if (total !== 100) {
    throw new Error(`scoring.weights must sum to 100 (got ${total})`);
  }
  const t = c.scoring?.shortlist_threshold;
  if (!Number.isInteger(t) || t < 0 || t > 100) {
    throw new Error('scoring.shortlist_threshold must be an integer between 0 and 100');
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
