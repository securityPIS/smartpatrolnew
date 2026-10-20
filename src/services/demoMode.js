/*
Tujuan: Mode demo — masuk dengan akun dummy (petugas/admin) tanpa Supabase. Data demo hanya di memori:
        tidak dibaca dari / ditulis ke penyimpanan lokal maupun cloud, sehingga data asli di perangkat
        dan server tidak tersentuh.
Caller: LoginPage (masuk demo), App (banner), services/backend/app.js (matikan Supabase),
        AppContextRuntime (dataset & sesi demo), imageStore/outbox (tanpa IndexedDB).
Dependensi: window.location (parameter URL `?demo=<akun>`).
Main Functions: isDemoMode, demoAccountKey, enterDemoMode, exitDemoMode.
Side Effects: enterDemoMode/exitDemoMode memuat ulang halaman.
*/

export const DEMO_QUERY_PARAM = 'demo';

export const DEMO_ACCOUNTS = Object.freeze({
  petugas: { key: 'petugas', userId: 'demo-petugas', label: 'Petugas (Demo)', description: 'Patroli kapal KM Demo Nusantara' },
  admin: { key: 'admin', userId: 'demo-admin', label: 'Admin (Demo)', description: 'Kelola armada, user, dan laporan' },
});

function readDemoAccountKey() {
  if (typeof window === 'undefined') return null;
  try {
    const value = new URLSearchParams(window.location.search).get(DEMO_QUERY_PARAM) || '';
    return Object.prototype.hasOwnProperty.call(DEMO_ACCOUNTS, value) ? value : null;
  } catch {
    return null;
  }
}

// Dibaca sekali saat modul dimuat: semua konfigurasi backend memakai nilai yang sama selama sesi.
export const demoAccountKey = readDemoAccountKey();
export const isDemoMode = Boolean(demoAccountKey);
export const demoAccount = demoAccountKey ? DEMO_ACCOUNTS[demoAccountKey] : null;

function navigateWithDemoParam(accountKey) {
  const url = new URL(window.location.href);
  if (accountKey) url.searchParams.set(DEMO_QUERY_PARAM, accountKey);
  else url.searchParams.delete(DEMO_QUERY_PARAM);
  url.hash = '';
  window.location.replace(url.toString());
}

// Muat ulang aplikasi dalam mode demo agar Supabase & penyimpanan lokal tidak pernah aktif.
export function enterDemoMode(accountKey) {
  if (!DEMO_ACCOUNTS[accountKey]) return;
  navigateWithDemoParam(accountKey);
}

export function exitDemoMode() {
  navigateWithDemoParam(null);
}
