import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { env, ROOT } from '../lib/config.js';

/**
 * SQLite store using Node's built-in `node:sqlite` (no native build, no
 * dependency, no external service). Good for a single-instance deployment.
 * For multi-instance deployments use the Supabase driver instead.
 */

function dbPath() {
  const p = env('SQLITE_PATH', './data/ctadi.sqlite');
  return path.isAbsolute(p) ? p : path.join(ROOT, p);
}

let db = null;

function connect() {
  if (db) return db;
  const file = dbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS applications (
      id                TEXT PRIMARY KEY,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL,
      email             TEXT NOT NULL,
      full_name         TEXT NOT NULL,
      role              TEXT NOT NULL,
      role_label        TEXT NOT NULL,
      status            TEXT NOT NULL,
      total_score       INTEGER,
      shortlisted       INTEGER NOT NULL DEFAULT 0,
      evaluation        TEXT,
      application       TEXT NOT NULL,
      scoring_provider  TEXT,
      scoring_model     TEXT,
      scoring_error     TEXT,
      injection_flag    INTEGER NOT NULL DEFAULT 0,
      decision          TEXT,
      decided_at        TEXT,
      decided_by        TEXT,
      notified_admin_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status);
    CREATE INDEX IF NOT EXISTS idx_applications_created ON applications(created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_applications_email_active
      ON applications(email) WHERE status IN ('received','scored','parked','shortlisted');
    CREATE TABLE IF NOT EXISTS audit_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      at         TEXT NOT NULL,
      application_id TEXT,
      action     TEXT NOT NULL,
      detail     TEXT
    );
  `);
  return db;
}

function rowToRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    email: row.email,
    full_name: row.full_name,
    role: row.role,
    role_label: row.role_label,
    status: row.status,
    total_score: row.total_score === null ? null : Number(row.total_score),
    shortlisted: Boolean(row.shortlisted),
    evaluation: row.evaluation ? JSON.parse(row.evaluation) : null,
    application: JSON.parse(row.application),
    scoring_provider: row.scoring_provider,
    scoring_model: row.scoring_model,
    scoring_error: row.scoring_error,
    injection_flag: Boolean(row.injection_flag),
    decision: row.decision,
    decided_at: row.decided_at,
    decided_by: row.decided_by,
    notified_admin_at: row.notified_admin_at,
  };
}

export const sqliteStore = {
  driver: 'sqlite',

  async insert(record) {
    const d = connect();
    d.prepare(`
      INSERT INTO applications (
        id, created_at, updated_at, email, full_name, role, role_label, status,
        total_score, shortlisted, evaluation, application, scoring_provider,
        scoring_model, scoring_error, injection_flag, decision, decided_at,
        decided_by, notified_admin_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      record.id, record.created_at, record.updated_at, record.email, record.full_name,
      record.role, record.role_label, record.status,
      record.total_score ?? null, record.shortlisted ? 1 : 0,
      record.evaluation ? JSON.stringify(record.evaluation) : null,
      JSON.stringify(record.application),
      record.scoring_provider ?? null, record.scoring_model ?? null,
      record.scoring_error ?? null, record.injection_flag ? 1 : 0,
      record.decision ?? null, record.decided_at ?? null,
      record.decided_by ?? null, record.notified_admin_at ?? null,
    );
    return record;
  },

  async update(id, patch) {
    const d = connect();
    const current = await this.get(id);
    if (!current) return null;
    const next = { ...current, ...patch, updated_at: new Date().toISOString() };
    d.prepare(`
      UPDATE applications SET
        updated_at=?, status=?, total_score=?, shortlisted=?, evaluation=?,
        scoring_provider=?, scoring_model=?, scoring_error=?, injection_flag=?,
        decision=?, decided_at=?, decided_by=?, notified_admin_at=?
      WHERE id=?
    `).run(
      next.updated_at, next.status, next.total_score ?? null, next.shortlisted ? 1 : 0,
      next.evaluation ? JSON.stringify(next.evaluation) : null,
      next.scoring_provider ?? null, next.scoring_model ?? null,
      next.scoring_error ?? null, next.injection_flag ? 1 : 0,
      next.decision ?? null, next.decided_at ?? null, next.decided_by ?? null,
      next.notified_admin_at ?? null, id,
    );
    return next;
  },

  async get(id) {
    const d = connect();
    return rowToRecord(d.prepare('SELECT * FROM applications WHERE id=?').get(id));
  },

  async getByEmail(email) {
    const d = connect();
    return rowToRecord(
      d.prepare("SELECT * FROM applications WHERE email=? AND status IN ('received','scored','parked','shortlisted') ORDER BY created_at DESC LIMIT 1").get(String(email).toLowerCase()),
    );
  },

  async list({ status, limit = 100 } = {}) {
    const d = connect();
    const rows = status
      ? d.prepare('SELECT * FROM applications WHERE status=? ORDER BY created_at DESC LIMIT ?').all(status, limit)
      : d.prepare('SELECT * FROM applications ORDER BY created_at DESC LIMIT ?').all(limit);
    return rows.map(rowToRecord);
  },

  async audit(applicationId, action, detail) {
    const d = connect();
    d.prepare('INSERT INTO audit_log (at, application_id, action, detail) VALUES (?,?,?,?)').run(
      new Date().toISOString(), applicationId ?? null, action, detail ? JSON.stringify(detail) : null,
    );
  },

  async auditList(applicationId, limit = 50) {
    const d = connect();
    const rows = d.prepare('SELECT * FROM audit_log WHERE application_id=? ORDER BY id DESC LIMIT ?').all(applicationId, limit);
    return rows.map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
  },

  async close() {
    if (db) {
      db.close();
      db = null;
    }
  },
};
