/*
Tujuan: Menginisialisasi singleton Supabase SmartPatrol SQL dan worker outbox offline.
Caller: Adapter backend auth, access, cloud state, patrol reports, incident reports, aset, dan trusted time.
Dependensi: @supabase/supabase-js, environment Vite, dan outbox IndexedDB lokal.
Main Functions: Membaca konfigurasi Supabase, membuat client browser tunggal, normalisasi user auth, dan start worker outbox.
Side Effects: Membuat sesi Supabase browser, memasang listener online untuk retry mutation offline.
*/

import { createClient } from '@supabase/supabase-js';
import { startSqlOutboxWorker } from './outbox';
import { isDemoMode } from '../demoMode';

const DEFAULT_LOCAL_SUPABASE_URL = 'http://127.0.0.1:54321';

function readEnvValue(value, fallback = '') {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || fallback;
}

const supabaseUrl = readEnvValue(import.meta.env.VITE_SUPABASE_URL, DEFAULT_LOCAL_SUPABASE_URL);
const supabaseAnonKey = readEnvValue(import.meta.env.VITE_SUPABASE_ANON_KEY);

// Mode demo: Supabase sengaja dimatikan total (tanpa client, auth, maupun sinkron cloud) agar akun
// dummy tidak bisa membaca/menulis data asli; aplikasi berjalan di jalur "tanpa backend".
const isSupabaseConfigured = !isDemoMode && Boolean(supabaseUrl && supabaseAnonKey && !supabaseAnonKey.includes('replace-with'));
const supabaseConfigSource = isDemoMode
  ? 'demo'
  : isSupabaseConfigured
    ? (import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY ? 'vite-env' : 'local-default')
    : 'missing';

const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: 'pkce',
    },
    realtime: {
      params: {
        eventsPerSecond: 8,
      },
    },
  })
  : null;

if (typeof window !== 'undefined' && !isDemoMode) {
  startSqlOutboxWorker();
}

function ensureSupabaseClient() {
  if (!supabase || !isSupabaseConfigured) {
    throw new Error('supabase-not-configured');
  }
  return supabase;
}

function normalizeSupabaseUser(user) {
  if (!user) return null;
  return {
    ...user,
    uid: user.id,
    displayName: user.user_metadata?.display_name || user.user_metadata?.name || user.email?.split('@')[0] || '',
    photoURL: user.user_metadata?.avatar_url || '',
    phoneNumber: user.phone || '',
  };
}

function unwrapSupabaseError(result, fallbackCode = 'supabase-request-failed') {
  if (result?.error) {
    const error = result.error;
    error.code = error.code || error.name || fallbackCode;
    throw error;
  }
  return result?.data ?? null;
}

export {
  ensureSupabaseClient,
  isSupabaseConfigured,
  normalizeSupabaseUser,
  supabase,
  supabaseAnonKey,
  supabaseConfigSource,
  supabaseUrl,
  unwrapSupabaseError,
};
