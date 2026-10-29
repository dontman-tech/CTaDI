import { env } from '../lib/config.js';

/**
 * Supabase (hosted Postgres) store. Use this when you want a managed database,
 * a spreadsheet-like admin view, or multiple app instances. Uses the PostgREST
 * REST API with the service-role key, so no client library is needed.
 *
 * Expected table (run the SQL in README "Switching to Supabase"):
 *   create table applications (
 *     id text primary key,
 *     created_at timestamptz not null default now(),
 *     updated_at timestamptz not null default now(),
 *     email text not null, full_name text not null, role text not null,
 *     role_label text not null, status text not null, application jsonb,
 *     decision text, decided_at timestamptz,
 *     decided_by text, notified_admin_at timestamptz
 *   );
 *   create table audit_log (
 *     id bigserial primary key, at timestamptz not null default now(),
 *     application_id text, action text not null, detail jsonb
 *   );
 */

function base() {
  const url = env('SUPABASE_URL');
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for the supabase driver');
  return { url: String(url).replace(/\/+$/, ''), key };
}

async function rest(pathname, { method = 'GET', body, prefer } = {}) {
  const { url, key } = base();
  const res = await fetch(`${url}/rest/v1/${pathname}`, {
    method,
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      ...(prefer ? { prefer } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${method} ${pathname} failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

export const supabaseStore = {
  driver: 'supabase',

  async insert(record) {
    const [row] = await rest('applications', { method: 'POST', body: record, prefer: 'return=representation' });
    return row ?? record;
  },

  async update(id, patch) {
    const [row] = await rest(`applications?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: { ...patch, updated_at: new Date().toISOString() },
      prefer: 'return=representation',
    });
    return row ?? null;
  },

  async get(id) {
    const rows = await rest(`applications?id=eq.${encodeURIComponent(id)}&limit=1`);
    return rows?.[0] ?? null;
  },

  async getByEmail(email) {
    const rows = await rest(
      `applications?email=eq.${encodeURIComponent(String(email).toLowerCase())}&status=in.(received,pending_review)&order=created_at.desc&limit=1`,
    );
    return rows?.[0] ?? null;
  },

  async list({ status, limit = 100 } = {}) {
    const q = status
      ? `applications?status=eq.${encodeURIComponent(status)}&order=created_at.desc&limit=${limit}`
      : `applications?order=created_at.desc&limit=${limit}`;
    return (await rest(q)) ?? [];
  },

  async audit(applicationId, action, detail) {
    await rest('audit_log', {
      method: 'POST',
      body: { application_id: applicationId ?? null, action, detail: detail ?? null },
      prefer: 'return=minimal',
    });
  },

  async auditList(applicationId, limit = 50) {
    return (
      (await rest(`audit_log?application_id=eq.${encodeURIComponent(applicationId)}&order=id.desc&limit=${limit}`)) ?? []
    );
  },

  async close() {},
};
