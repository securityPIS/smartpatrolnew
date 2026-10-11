/*
Tujuan: Mencatat setiap logout OTOMATIS (bukan logout manual dari menu) beserta konteks state saat itu,
        agar penyebab "mental logout sendiri" bisa didiagnosis dari perangkat pengguna.
Caller: AppContextRuntime (validator sesi) dan LoginPage (menampilkan alasan logout terakhir).
Dependensi: localStorage (best-effort; gagal simpan tidak boleh mengganggu alur logout).
Main Functions: recordAutoLogout, readAutoLogoutLog, acknowledgeLatestAutoLogout.
Side Effects: Menulis ke localStorage key AUTO_LOGOUT_LOG_KEY dan console.warn.
*/

const AUTO_LOGOUT_LOG_KEY = 'smartpatrol:auto-logout-log';
const MAX_ENTRIES = 20;

export function readAutoLogoutLog() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(AUTO_LOGOUT_LOG_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAutoLogoutLog(entries) {
  try {
    window.localStorage.setItem(AUTO_LOGOUT_LOG_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
  } catch {
    // Storage penuh/diblokir: diagnostik bersifat best-effort.
  }
}

export function recordAutoLogout(code, message, context = {}) {
  const entry = {
    code,
    message,
    at: new Date().toISOString(),
    acknowledged: false,
    context: {
      online: typeof navigator !== 'undefined' ? navigator.onLine : null,
      visibility: typeof document !== 'undefined' ? document.visibilityState : null,
      ...context,
    },
  };
  console.warn('[auto-logout]', code, entry.context);
  writeAutoLogoutLog([entry, ...readAutoLogoutLog()]);
  return entry;
}

export function acknowledgeLatestAutoLogout() {
  const entries = readAutoLogoutLog();
  if (entries.length === 0 || entries[0].acknowledged) return;
  writeAutoLogoutLog([{ ...entries[0], acknowledged: true }, ...entries.slice(1)]);
}
