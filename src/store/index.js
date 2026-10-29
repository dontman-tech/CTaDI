import { env } from '../lib/config.js';
import { sqliteStore } from './sqlite.js';
import { jsonStore } from './json.js';
import { supabaseStore } from './supabase.js';

const DRIVERS = { sqlite: sqliteStore, json: jsonStore, supabase: supabaseStore };

let instance = null;

export function getStore() {
  if (instance) return instance;
  const driver = env('STORAGE_DRIVER', 'sqlite');
  const store = DRIVERS[driver];
  if (!store) throw new Error(`Unknown STORAGE_DRIVER "${driver}". Use one of: ${Object.keys(DRIVERS).join(', ')}`);
  instance = store;
  return instance;
}

/** Test helper: swap in an isolated store instance. */
export function __setStore(store) {
  instance = store;
}
