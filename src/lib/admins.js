import { env } from '../lib/config.js';
import { safeEqual, hashToken, newAdminToken, newId, nowIso } from '../lib/util.js';

/**
 * Admin accounts.
 *
 * There are two kinds of admin:
 *
 *   - The **master** admin is the token in `ADMIN_API_TOKEN`. It always exists,
 *     cannot be edited or deleted, and is the only account that may create and
 *     delete the others. Keeping it in the environment means the owner can
 *     always get back in even if every stored row is lost.
 *   - **Ordinary** admins are created by the master and stored in the database.
 *     They can sign in, read applications, and approve or reject — but they
 *     cannot manage other admins.
 *
 * Only a token's SHA-256 hash is stored, never the token itself. The plaintext
 * is returned exactly once, when the account is created.
 */

export const MASTER = Object.freeze({
  id: 'master',
  label: 'Master admin',
  role: 'master',
  created_at: null,
  last_used_at: null,
  token_prefix: null,
});

/**
 * Resolve a presented token to an admin identity, or null.
 * `role` is 'master' or 'admin'.
 */
export async function resolveAdmin(store, token) {
  if (!token) return null;

  const expected = env('ADMIN_API_TOKEN');
  if (expected && safeEqual(token, expected)) {
    return { id: MASTER.id, label: MASTER.label, role: 'master' };
  }

  const row = await store.getAdminByHash(hashToken(token));
  if (!row) return null;
  return { id: row.id, label: row.label, role: 'admin' };
}

/** List admin accounts for the master's management screen. */
export async function listAdmins(store) {
  const rows = await store.listAdmins();
  return [MASTER, ...rows.map(toPublicAdmin)];
}

/** Create an ordinary admin. Returns { ok, admin, token } with the one-time token. */
export async function createAdmin(store, { label }) {
  const cleanLabel = String(label ?? '').trim().slice(0, 80);
  if (!cleanLabel) return { ok: false, status: 400, error: 'A name for this admin is required.' };

  const { token, hash, prefix } = newAdminToken();
  const row = {
    id: newId('adm'),
    label: cleanLabel,
    token_hash: hash,
    token_prefix: prefix,
    created_at: nowIso(),
    last_used_at: null,
  };
  await store.insertAdmin(row);
  return { ok: true, admin: toPublicAdmin(row), token };
}

/** Delete an ordinary admin. The master can never be deleted. */
export async function deleteAdmin(store, id) {
  if (id === MASTER.id) return { ok: false, status: 400, error: 'The master admin cannot be deleted.' };
  const row = await store.getAdmin(id);
  if (!row) return { ok: false, status: 404, error: 'No such admin.' };
  await store.deleteAdmin(id);
  return { ok: true, deleted: id };
}

/** Record that an admin just used their token (best-effort; never fatal). */
export async function touchAdmin(store, admin) {
  if (!admin || admin.role === 'master') return;
  try {
    await store.touchAdmin(admin.id, nowIso());
  } catch {
    /* last-used tracking is cosmetic; never break a request over it */
  }
}

function toPublicAdmin(row) {
  return {
    id: row.id,
    label: row.label,
    role: 'admin',
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    token_prefix: row.token_prefix,
  };
}
