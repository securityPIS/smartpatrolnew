/*
Tujuan: Adapter Supabase untuk membaca shift_history_entries yang dibuat server-side (pg_cron).
Caller: AppContextRuntime untuk merge history dari server ke state lokal.
Dependensi: Supabase Postgres/Realtime, tabel shift_history_entries.
Main Functions: subscribeToShiftHistoryEntries — fetch semua entri + subscribe realtime INSERT.
Side Effects: Membuka channel Supabase Realtime; harus di-dispose saat komponen unmount.
*/

import { ensureSupabaseClient, isSupabaseConfigured } from './app';

const SHIFT_HISTORY_TABLE = 'shift_history_entries';
const SHIFT_HISTORY_LIMIT  = 500;

/**
 * Subscribe ke tabel shift_history_entries.
 * Langsung fetch semua data lalu listen INSERT baru (dari cron job server).
 *
 * @param {function(Array)} callback - dipanggil dengan array baris DB
 * @param {function(Error)} onError  - dipanggil saat fetch/subscribe gagal
 * @returns {function} disposer — panggil untuk unsubscribe
 */
export function subscribeToShiftHistoryEntries(callback, onError) {
  // Tanpa backend (mode demo / build tanpa Supabase): tidak ada langganan realtime.
  if (!isSupabaseConfigured) return () => {};
  const supabase = ensureSupabaseClient();
  let disposed = false;

  const fetchAll = async () => {
    const { data, error } = await supabase
      .from(SHIFT_HISTORY_TABLE)
      .select('*')
      .order('date_key', { ascending: false })
      .limit(SHIFT_HISTORY_LIMIT);

    if (error) throw error;
    if (!disposed) callback(data || []);
  };

  fetchAll().catch(onError);

  // Listen hanya INSERT — cron selalu insert baru, tidak update
  const channel = supabase
    .channel('shift-history-entries-global')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: SHIFT_HISTORY_TABLE },
      () => { fetchAll().catch(onError); },
    )
    .subscribe();

  return () => {
    disposed = true;
    supabase.removeChannel(channel);
  };
}
