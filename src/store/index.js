import { env } from '../lib/config.js';

/**
 * Store selection.
 *
 * Drivers are loaded lazily, on first use, rather than imported eagerly. This
 * matters on serverless platforms: a static `import` of `node:sqlite` would
 * crash the whole function at module-evaluation time if the runtime does not
 * ship that module, even when the deployment uses Postgres. Loading on demand
 * means an unused driver can never break a cold start.
 *
 * Default driver: Postgres when running on Vercel (a serverless filesystem is
 * read-only apart from /tmp and does not persist between invocations), JSON
 * otherwise so local development needs no setup at all.
 */

const LOADERS = {
  postgres: () => import('./postgres.js').then((m) => m.postgresStore),
  sqlite: () => import('./sqlite.js').then((m) => m.sqliteStore),
  json: () => import('./json.js').then((m) => m.jsonStore),
};

let instance = null;

function defaultDriver() {
  // Vercel sets VERCEL=1 on every deployment.
  if (env('VERCEL')) return 'postgres';
  return 'json';
}

export async function getStore() {
  if (instance) return instance;
  const driver = env('STORAGE_DRIVER', defaultDriver());
  const load = LOADERS[driver];
  if (!load) throw new Error(`Unknown STORAGE_DRIVER "${driver}". Use one of: ${Object.keys(LOADERS).join(', ')}`);
  try {
    instance = await load();
  } catch (err) {
    throw new Error(`Could not load the "${driver}" storage driver: ${err.message}`);
  }
  return instance;
}

/** Test helper: swap in an isolated store instance. */
export function __setStore(store) {
  instance = store;
}

export function __resetStore() {
  instance = null;
}
