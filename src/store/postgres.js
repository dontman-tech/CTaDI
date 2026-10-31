import { neon } from '@neondatabase/serverless';
import { env } from '../lib/config.js';

/**
 * Postgres store, talking to the database over HTTP via the Neon serverless
 * driver. This is the production driver: a Vercel function has no persistent
 * disk, so applications must live in a database. The same driver works against
 * any Postgres reachable by connection string (Neon, Supabase, RDS, a local
 * server), so switching providers is a one-line environment change.
 *
 * Over HTTP there is no connection pool to exhaust, which is what makes it
 * suitable for a serverless function that may run a hundred cold instances.
 *
 * Expected schema — run `npm run migrate`, or paste the SQL from the README:
 *   applications(id, created_at, updated_at, email, full_name, role,
 *                role_label, status, application, decision, decided_at,
 *                decided_by)
 *   audit_log(id, at, application_id, action, detail)
 *   rate_limits(key, window_start, count)
 *   admins(id, label, token_hash, token_prefix, created_at, last_used_at)
 */

let sql = null;

function connect() {
  if (sql) return sql;
  const url = env('DATABASE_URL') ?? env('POSTGRES_URL');
  if (!url) {
    throw new Error(
      'DATABASE_URL is required for the postgres driver. On Vercel, add the Postgres integration from the Marketplace — it sets this for you.',
    );
  }
  sql = neon(url);
  return sql;
}

function rowToRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
    email: row.email,
    full_name: row.full_name,
    role: row.role,
    role_label: row.role_label,
    status: row.status,
    application: typeof row.application === 'string' ? JSON.parse(row.application) : row.application,
    decision: row.decision,
    decided_at: toIso(row.decided_at),
    decided_by: row.decided_by,
  };
}

function toIso(value) {
  if (!value) return value ?? null;
  return value instanceof Date ? value.toISOString() : String(value);
}

export const postgresStore = {
  driver: 'postgres',

  async insert(record) {
    const q = connect();
    const rows = await q`
      INSERT INTO applications (
        id, created_at, updated_at, email, full_name, role, role_label, status,
        application, decision, decided_at, decided_by
      ) VALUES (
        ${record.id}, ${record.created_at}, ${record.updated_at}, ${record.email},
        ${record.full_name}, ${record.role}, ${record.role_label}, ${record.status},
        ${JSON.stringify(record.application)}, ${record.decision ?? null},
        ${record.decided_at ?? null}, ${record.decided_by ?? null}
      )
      RETURNING *
    `;
    return rowToRecord(rows[0]) ?? record;
  },

  async update(id, patch) {
    const q = connect();
    const rows = await q`
      UPDATE applications SET
        updated_at = ${new Date().toISOString()},
        status = COALESCE(${patch.status ?? null}, status),
        decision = COALESCE(${patch.decision ?? null}, decision),
        decided_at = COALESCE(${patch.decided_at ?? null}, decided_at),
        decided_by = COALESCE(${patch.decided_by ?? null}, decided_by)
      WHERE id = ${id}
      RETURNING *
    `;
    return rowToRecord(rows[0]);
  },

  async get(id) {
    const q = connect();
    const rows = await q`SELECT * FROM applications WHERE id = ${id} LIMIT 1`;
    return rowToRecord(rows[0]);
  },

  async getByEmail(email) {
    const q = connect();
    const rows = await q`
      SELECT * FROM applications
      WHERE email = ${String(email).toLowerCase()}
        AND status IN ('received', 'pending_review')
      ORDER BY created_at DESC LIMIT 1
    `;
    return rowToRecord(rows[0]);
  },

  async list({ status, limit = 100 } = {}) {
    const q = connect();
    const rows = status
      ? await q`SELECT * FROM applications WHERE status = ${status} ORDER BY created_at DESC LIMIT ${limit}`
      : await q`SELECT * FROM applications ORDER BY created_at DESC LIMIT ${limit}`;
    return rows.map(rowToRecord);
  },

  async audit(applicationId, action, detail) {
    const q = connect();
    await q`
      INSERT INTO audit_log (at, application_id, action, detail)
      VALUES (${new Date().toISOString()}, ${applicationId ?? null}, ${action}, ${detail ? JSON.stringify(detail) : null})
    `;
  },

  async auditList(applicationId, limit = 50) {
    const q = connect();
    const rows = await q`
      SELECT * FROM audit_log WHERE application_id = ${applicationId}
      ORDER BY id DESC LIMIT ${limit}
    `;
    return rows.map((r) => ({
      ...r,
      at: toIso(r.at),
      detail: typeof r.detail === 'string' ? JSON.parse(r.detail) : r.detail,
    }));
  },

  /**
   * Increment a fixed-window counter and return the new count. One atomic
   * upsert, so concurrent instances cannot both read-then-write the same
   * value. The window resets in place once it is older than `windowSeconds`.
   */
  async rateLimit(key, windowSeconds = 3600) {
    const q = connect();
    const rows = await q`
      INSERT INTO rate_limits (key, window_start, count)
      VALUES (${key}, now(), 1)
      ON CONFLICT (key) DO UPDATE SET
        count = CASE
          WHEN rate_limits.window_start < now() - make_interval(secs => ${windowSeconds})
          THEN 1 ELSE rate_limits.count + 1 END,
        window_start = CASE
          WHEN rate_limits.window_start < now() - make_interval(secs => ${windowSeconds})
          THEN now() ELSE rate_limits.window_start END
      RETURNING count
    `;
    return Number(rows[0]?.count ?? 0);
  },

  // ---- Admin accounts -----------------------------------------------------

  async insertAdmin(row) {
    const q = connect();
    const rows = await q`
      INSERT INTO admins (id, label, token_hash, token_prefix, created_at, last_used_at)
      VALUES (${row.id}, ${row.label}, ${row.token_hash}, ${row.token_prefix ?? null},
              ${row.created_at}, ${row.last_used_at ?? null})
      RETURNING id, label, token_prefix, created_at, last_used_at
    `;
    return adminRow(rows[0]);
  },

  async listAdmins() {
    const q = connect();
    const rows = await q`
      SELECT id, label, token_prefix, created_at, last_used_at
      FROM admins ORDER BY created_at ASC
    `;
    return rows.map(adminRow);
  },

  async getAdmin(id) {
    const q = connect();
    const rows = await q`SELECT * FROM admins WHERE id = ${id} LIMIT 1`;
    return rows[0] ? adminRow(rows[0]) : null;
  },

  async getAdminByHash(tokenHash) {
    const q = connect();
    const rows = await q`SELECT * FROM admins WHERE token_hash = ${tokenHash} LIMIT 1`;
    return rows[0] ? adminRow(rows[0]) : null;
  },

  async touchAdmin(id, at) {
    const q = connect();
    await q`UPDATE admins SET last_used_at = ${at} WHERE id = ${id}`;
  },

  async deleteAdmin(id) {
    const q = connect();
    const rows = await q`DELETE FROM admins WHERE id = ${id} RETURNING id`;
    return rows.length > 0;
  },

  async close() {
    sql = null;
  },
};

function adminRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    label: row.label,
    token_prefix: row.token_prefix ?? null,
    created_at: toIso(row.created_at),
    last_used_at: toIso(row.last_used_at),
  };
}
