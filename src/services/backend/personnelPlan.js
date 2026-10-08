/*
Tujuan: Memicu penerapan jadwal penugasan bulanan di server (pergantian bulan & mulai tugas terjadwal).
Caller: AppContextRuntime saat admin membuka halaman Jadwal Penugasan.
Dependensi: Supabase RPC public.apply_personnel_monthly_plan (migration 20261008120000).
Main Functions: applyPersonnelMonthlyPlanOnServer — best effort, dibatasi timeout.
Side Effects: Server dapat memperbarui ships.personnel* dan profiles.status/ship_assigned.
*/

import { ensureSupabaseClient, isSupabaseConfigured } from './app';

// Pemanggilan ini berjalan di latar belakang; tetap wajib ber-timeout supaya socket basi
// di jaringan jelek tidak menggantung (lihat pola bug skeleton di CLAUDE.md).
const APPLY_PLAN_TIMEOUT_MS = 8000;

function withTimeout(promise, timeoutMs) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error('apply-personnel-plan-timeout');
      error.code = 'apply-personnel-plan-timeout';
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// Mengembalikan jumlah kapal yang berubah, atau null bila RPC belum tersedia / gagal.
export async function applyPersonnelMonthlyPlanOnServer() {
  if (!isSupabaseConfigured) return null;
  try {
    const supabase = ensureSupabaseClient();
    const { data, error } = await withTimeout(
      supabase.rpc('apply_personnel_monthly_plan'),
      APPLY_PLAN_TIMEOUT_MS,
    );
    if (error) throw error;
    return Number(data) || 0;
  } catch (error) {
    console.warn('[jadwal] apply_personnel_monthly_plan gagal / belum tersedia', error);
    return null;
  }
}
