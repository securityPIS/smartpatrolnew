/*
Tujuan: Menyediakan wrapper Supabase Auth kompatibel dengan flow auth SmartPatrol lama.
Caller: AppContextRuntime, LoginPage, dan form admin yang butuh login/register/provision akun.
Dependensi: Supabase Auth dan Edge Function provision-operational-user untuk pembuatan user oleh admin.
Main Functions: Login/register email-password, provision user operasional, logout, subscribe auth state dengan guard offline + retry restore sesi awal yang gagal transien, dan normalisasi error.
Side Effects: Membuat/menghapus sesi Supabase Auth aktif, membaca/merefresh sesi lokal (retry berbackoff + listener 'online'), dan dapat memanggil Edge Function service-role terproteksi.
*/

import { ensureSupabaseClient, isSupabaseConfigured, normalizeSupabaseUser } from './app';

function getFirebaseAuthErrorMessage(error) {
  const code = String(error?.code || error?.message || '').toLowerCase();

  if (code === 'supabase-not-configured') {
    return 'Supabase belum dikonfigurasi pada aplikasi ini.';
  }
  if (code.includes('user already registered') || code.includes('already')) {
    return 'Email ini sudah terdaftar di Supabase Auth.';
  }
  if (code.includes('invalid login') || code.includes('invalid credentials')) {
    return 'Email atau password Supabase tidak cocok.';
  }
  if (code.includes('rate limit') || code.includes('rate')) {
    return 'Batas pengiriman (rate limit) Supabase terlampaui. Silakan tunggu beberapa menit sebelum mencoba lagi.';
  }
  if (code.includes('invalid email') || code.includes('email format') || code.includes('invalid_email')) {
    return 'Format email tidak valid.';
  }
  if (code.includes('email not confirmed') || code.includes('unverified') || code.includes('confirm')) {
    return 'Email belum terkonfirmasi/terverifikasi. Silakan aktivasi akun Anda terlebih dahulu.';
  }
  if (code.includes('row-level security') || code.includes('security policy')) {
    return 'Akses ditolak oleh kebijakan keamanan RLS database.';
  }
  if (code.includes('email')) {
    return 'Autentikasi gagal karena kendala pada email.';
  }
  if (code.includes('password')) {
    return 'Password minimal 8 karakter.';
  }
  if (code.includes('network') || code.includes('fetch')) {
    return 'Jaringan gagal menjangkau Supabase. Periksa koneksi internet.';
  }
  if (code.includes('permission') || code.includes('forbidden')) {
    return 'Akses Anda ditolak oleh kebijakan keamanan SmartPatrol.';
  }
  return 'Autentikasi Supabase gagal diproses.';
}

async function loginWithFirebaseEmail(email, password) {
  const supabase = ensureSupabaseClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return {
    ...data,
    user: normalizeSupabaseUser(data.user),
  };
}

async function registerWithFirebaseEmail(email, password, metadata = {}) {
  const supabase = ensureSupabaseClient();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: Object.keys(metadata || {}).length > 0
      ? { data: metadata }
      : undefined,
  });
  if (error) throw error;
  return {
    ...data,
    user: normalizeSupabaseUser(data.user),
  };
}

async function provisionFirebaseEmailUser({ email, password, displayName = '' }) {
  const supabase = ensureSupabaseClient();
  const { data, error } = await supabase.functions.invoke('provision-operational-user', {
    body: {
      email,
      password,
      displayName,
    },
  });
  if (error) throw error;
  return {
    ...data,
    user: normalizeSupabaseUser(data?.user),
  };
}

// Ditandai true hanya selama logout yang DISENGAJA pengguna (lewat fungsi ini).
// Dipakai listener untuk membedakan SIGNED_OUT eksplisit dari auth-null involunter
// (mis. refresh token gagal saat internet hilang) yang tidak boleh memutus sesi.
let explicitFirebaseLogout = false;

async function logoutFirebaseUser() {
  if (!isSupabaseConfigured) return;
  const supabase = ensureSupabaseClient();
  explicitFirebaseLogout = true;
  try {
    // signOut menunggu notifikasi subscriber selesai sebelum resolve, jadi event
    // SIGNED_OUT yang menyusul masih membaca flag true sebelum direset di finally.
    await supabase.auth.signOut();
  } finally {
    explicitFirebaseLogout = false;
  }
}

function isBrowserOffline() {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

// Definitif hanya bila server menolak sesi (4xx: refresh token dicabut/kedaluwarsa/
// sudah dipakai, sesi hilang). Gangguan jaringan, 5xx, timeout lock antar-tab, dan
// error tak dikenal dianggap transien agar petugas tidak ketendang saat restore sesi.
function isTransientAuthError(error) {
  if (isBrowserOffline()) return true;
  if (!error) return false;
  if (error.name === 'AuthSessionMissingError') return false;
  const status = Number(error.status || 0);
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) return false;
  return true;
}

const RESTORE_RETRY_BASE_MS = 2000;
const RESTORE_RETRY_MAX_MS = 30000;

function subscribeToFirebaseAuthChanges(callback) {
  if (!isSupabaseConfigured) return () => {};
  const supabase = ensureSupabaseClient();
  let disposed = false;
  let restorePending = false;
  let restoreTimer = null;
  let restoreAttempt = 0;

  const clearRestoreTimer = () => {
    if (restoreTimer) {
      clearTimeout(restoreTimer);
      restoreTimer = null;
    }
  };

  // Retry restore sesi awal yang gagal transien. Saat offline tidak menjadwalkan timer
  // (hemat baterai); event 'online' yang memicu percobaan berikutnya.
  const scheduleRestoreRetry = () => {
    if (disposed || restoreTimer || isBrowserOffline()) return;
    const delay = Math.min(RESTORE_RETRY_BASE_MS * 2 ** restoreAttempt, RESTORE_RETRY_MAX_MS);
    restoreAttempt += 1;
    restoreTimer = setTimeout(() => {
      restoreTimer = null;
      restoreInitialSession();
    }, delay);
  };

  const emitRestoreError = (error) => {
    const isTransient = isTransientAuthError(error);
    restorePending = isTransient;
    callback(null, { event: 'INITIAL_SESSION_ERROR', isTransient, error });
    if (isTransient) scheduleRestoreRetry();
  };

  function restoreInitialSession() {
    supabase.auth.getSession()
      .then(({ data, error }) => {
        if (disposed) return;
        if (error) {
          emitRestoreError(error);
          return;
        }
        const normalizedUser = normalizeSupabaseUser(data?.session?.user);
        const isTransient = !normalizedUser && isBrowserOffline();
        restorePending = isTransient;
        if (!restorePending) restoreAttempt = 0;
        callback(normalizedUser, { event: 'INITIAL_SESSION', isTransient });
        if (isTransient) scheduleRestoreRetry();
      })
      .catch((error) => {
        if (!disposed) emitRestoreError(error);
      });
  }

  const handleOnline = () => {
    if (!restorePending || disposed) return;
    clearRestoreTimer();
    restoreInitialSession();
  };
  if (typeof window !== 'undefined') window.addEventListener('online', handleOnline);

  restoreInitialSession();

  const { data } = supabase.auth.onAuthStateChange((event, session) => {
    if (disposed) return;
    // INITIAL_SESSION sudah ditangani restoreInitialSession (yang membawa info error).
    // supabase-js mengirim INITIAL_SESSION null bila getSession gagal karena jaringan/
    // timeout lock, sehingga event ini tidak boleh dianggap logout definitif.
    if (event === 'INITIAL_SESSION') return;
    const normalizedUser = normalizeSupabaseUser(session?.user);
    if (normalizedUser && restorePending) {
      // Auto-refresh supabase-js berhasil memulihkan sesi; hentikan retry manual.
      restorePending = false;
      restoreAttempt = 0;
      clearRestoreTimer();
    }
    const isExplicitLogout = event === 'SIGNED_OUT' && explicitFirebaseLogout;
    callback(normalizedUser, {
      event,
      explicit: isExplicitLogout,
      // Auth-null involunter (SIGNED_OUT non-eksplisit dari refresh gagal, atau
      // browser offline) ditandai transien agar sesi patroli tidak diputus di
      // tengah submit. Hanya logout eksplisit pengguna yang membersihkan sesi.
      isTransient: !normalizedUser
        && !isExplicitLogout
        && (isBrowserOffline() || event === 'SIGNED_OUT'),
    });
  });

  return () => {
    disposed = true;
    clearRestoreTimer();
    if (typeof window !== 'undefined') window.removeEventListener('online', handleOnline);
    data?.subscription?.unsubscribe?.();
  };
}

export {
  getFirebaseAuthErrorMessage,
  isSupabaseConfigured as isFirebaseAuthEnabled,
  loginWithFirebaseEmail,
  logoutFirebaseUser,
  provisionFirebaseEmailUser,
  registerWithFirebaseEmail,
  subscribeToFirebaseAuthChanges,
};
