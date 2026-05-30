/*
Tujuan: Adapter SQL/Reatime untuk laporan checkpoint patroli.
Caller: AppContextRuntime saat submit laporan, backfill offline, dan listener lintas-device.
Dependensi: Supabase Postgres/Reatime dan outbox IndexedDB.
Main Functions: Subscribe laporan per shift/kapal dan upsert laporan idempotent per checkpoint.
Side Effects: Membaca/menulis tabel patrol_reports dan mengantre mutation saat offline.
*/

import { ensureSupabaseClient } from './app';
import { enqueueOutboxMutation, registerOutboxHandler } from './outbox';
import { deleteStorageAsset } from './assets';

const PATROL_REPORTS_TABLE = 'patrol_reports';
const PATROL_REPORTS_SCHEMA_VERSION = 1;
const PATROL_REPORTS_LISTEN_LIMIT = 120;

function createClientEventId(report = {}) {
  return [
    report.shiftKey || 'shift',
    report.shipId || 'ship',
    report.checkpointId || 'checkpoint',
  ].join('|');
}

function mapReportToRow(report = {}, options = {}) {
  const clientUpdatedAt = Number.isFinite(options.clientUpdatedAt)
    ? options.clientUpdatedAt
    : Date.now();

  return {
    client_event_id: report.clientEventId || report.client_event_id || createClientEventId(report),
    shift_key: String(report.shiftKey || ''),
    ship_id: String(report.shipId || ''),
    checkpoint_id: String(report.checkpointId || ''),
    ship_name: String(report.shipName || ''),
    checkpoint_name: String(report.checkpointName || report.name || ''),
    status: String(report.status || 'pending'),
    result_type: report.resultType || null,
    completed_by_user_id: report.completedByUserId || null,
    completed_by: report.completedBy || null,
    // Kolom *_ms bertipe bigint: paksa ke integer (performance.now() bisa hasilkan pecahan
    // sub-ms seperti 1779986567403.7 yang ditolak Postgres). Termasuk untuk laporan lama
    // yang sudah terlanjur diantrekan di outbox dengan nilai berkoma.
    occurred_at_trusted_ms: Number.isFinite(report.occurredAtTrustedMs) ? Math.round(report.occurredAtTrustedMs) : null,
    client_updated_at_ms: Math.round(clientUpdatedAt),
    media_status: report.mediaStatus || 'none',
    photo_url: report.photoUrl || null,
    payload: {
      ...report,
      schemaVersion: PATROL_REPORTS_SCHEMA_VERSION,
      clientUpdatedAt,
    },
  };
}

function mapRowToReport(row = {}) {
  return {
    ...(row.payload || {}),
    firestoreId: row.id || row.checkpoint_id || '',
    schemaVersion: row.payload?.schemaVersion || PATROL_REPORTS_SCHEMA_VERSION,
    clientUpdatedAt: row.client_updated_at_ms || row.payload?.clientUpdatedAt || null,
    serverUpdatedAt: row.server_updated_at || row.updated_at || null,
    shiftKey: row.shift_key || row.payload?.shiftKey || '',
    shipId: row.ship_id || row.payload?.shipId || '',
    checkpointId: row.checkpoint_id || row.payload?.checkpointId || '',
    shipName: row.ship_name || row.payload?.shipName || '',
    checkpointName: row.checkpoint_name || row.payload?.checkpointName || row.payload?.name || '',
    status: row.status || row.payload?.status || 'pending',
    resultType: row.result_type || row.payload?.resultType || null,
    mediaStatus: row.media_status || row.payload?.mediaStatus || 'none',
    photoUrl: row.photo_url || row.payload?.photoUrl || null,
  };
}

async function writePatrolReport(report, options = {}) {
  const supabase = ensureSupabaseClient();
  const row = mapReportToRow(report, options);
  const { error } = await supabase
    .from(PATROL_REPORTS_TABLE)
    .upsert(row, { onConflict: 'shift_key,ship_id,checkpoint_id' });
  if (error) throw error;
  return row.payload;
}

registerOutboxHandler('patrol_report.upsert', writePatrolReport);

export function subscribeToPatrolReports({ shiftKey, shipId, shipName }, callback, onError) {
  const supabase = ensureSupabaseClient();
  let disposed = false;

  const fetchRows = async () => {
    let query = supabase
      .from(PATROL_REPORTS_TABLE)
      .select('*')
      .eq('shift_key', shiftKey)
      .eq('ship_id', shipId)
      .limit(PATROL_REPORTS_LISTEN_LIMIT);

    if (shipName) query = query.eq('ship_name', shipName);
    const { data, error } = await query;
    if (error) throw error;
    if (!disposed) callback((data || []).map(mapRowToReport));
  };

  fetchRows().catch(onError);

  const channel = supabase.channel(`patrol-reports-${shiftKey}-${shipId}`)
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: PATROL_REPORTS_TABLE,
      filter: `shift_key=eq.${shiftKey}`,
    }, () => {
      fetchRows().catch(onError);
    })
    .subscribe();

  return () => {
    disposed = true;
    supabase.removeChannel(channel);
  };
}

export async function savePatrolReport(report, options = {}) {
  try {
    const saved = await writePatrolReport(report, options);
    return { ...saved, synced: true };
  } catch (error) {
    // Jangan telan diam-diam: kegagalan permanen (RLS/constraint/auth) tampak sama
    // dengan kegagalan jaringan dari sisi pemanggil. Catat error asli agar penyebab
    // laporan tidak sampai ke admin/petugas lain bisa didiagnosis, bukan hilang senyap.
    console.error('Gagal menulis laporan patroli ke patrol_reports, mengantre ke outbox', {
      code: error?.code,
      message: error?.message,
      details: error?.details,
      hint: error?.hint,
      clientEventId: report?.clientEventId || report?.client_event_id || null,
      shiftKey: report?.shiftKey || null,
      shipId: report?.shipId || null,
      checkpointId: report?.checkpointId || null,
    });
    await enqueueOutboxMutation({
      // Id deterministik per checkpoint agar submit offline berulang untuk titik yang
      // sama menimpa antrean lama, bukan menumpuk duplikat di outbox.
      id: report?.clientEventId || report?.client_event_id || createClientEventId(report),
      type: 'patrol_report.upsert',
      payload: report,
    });
    // Bedakan gagal jaringan/offline (wajar, akan di-flush outbox) dari penolakan server
    // (RLS/constraint/auth) yang harus ditampilkan ke pengguna karena laporan tak akan
    // pernah terlihat di device lain sampai akar masalahnya diperbaiki.
    const message = String(error?.message || '');
    const looksLikeNetworkError = !error?.code
      && (error?.name === 'TypeError' || /failed to fetch|network|fetch|load failed/i.test(message));
    const offline = (typeof navigator !== 'undefined' && navigator.onLine === false) || looksLikeNetworkError;
    return {
      ...report,
      schemaVersion: PATROL_REPORTS_SCHEMA_VERSION,
      clientUpdatedAt: Number.isFinite(options.clientUpdatedAt) ? options.clientUpdatedAt : Date.now(),
      pendingOfflineSync: true,
      synced: false,
      offline,
      syncError: offline ? null : {
        code: error?.code || null,
        message: error?.message || 'unknown',
        hint: error?.hint || null,
        details: error?.details || null,
      },
    };
  }
}

const PATROL_REPORT_TOMBSTONES_TABLE = 'patrol_report_tombstones';

// Hapus permanen temuan/laporan patroli + tombstone agar tidak dihidupkan kembali
// oleh re-upsert idempotent dari device lain (lihat migration 202605300007/008/012/013).
//
// PENDEKATAN: panggil RPC server-side `admin_delete_patrol_report_findings`. RPC ini
// SECURITY DEFINER dan atomic (satu transaksi): membaca shift_key & client_event_id ASLI
// dari DB, menulis tombstone yang konsisten, lalu DELETE baris. Client cukup mengirim
// (shipId, checkpointId) atau firestoreId — TIDAK perlu shiftKey (yang sering basi/salah
// dari incident object). Foto Storage dihapus terpisah karena pg function tidak punya
// akses ke Storage.
async function performPatrolReportDelete({ firestoreId, checkpointId, shipId } = {}) {
  const supabase = ensureSupabaseClient();
  const hasNaturalKey = Boolean(shipId && checkpointId);

  if (!firestoreId && !hasNaturalKey) return;

  // 1) Kumpulkan foto yang akan dihapus dari Storage (sebelum baris terhapus).
  const photoUrls = [];
  const collectPhotos = (rows) => (rows || []).forEach((r) => {
    if (r?.photo_url) photoUrls.push(r.photo_url);
  });
  if (hasNaturalKey) {
    const { data, error } = await supabase
      .from(PATROL_REPORTS_TABLE)
      .select('photo_url')
      .eq('ship_id', shipId)
      .eq('checkpoint_id', checkpointId);
    if (error) throw error;
    collectPhotos(data);
  }
  if (firestoreId) {
    const { data, error } = await supabase
      .from(PATROL_REPORTS_TABLE)
      .select('photo_url')
      .eq('id', firestoreId);
    if (error) throw error;
    collectPhotos(data);
  }

  // 2) Panggil RPC atomic: SELECT shift_key asli + tombstone + DELETE dalam satu transaksi.
  //    RPC SECURITY DEFINER bypass RLS, jadi tidak ada masalah "is_admin() false" diam-diam.
  //    Cek admin tetap dijalankan di dalam function via is_admin().
  const { data, error } = await supabase.rpc('admin_delete_patrol_report_findings', {
    p_ship_id: shipId || null,
    p_checkpoint_id: checkpointId || null,
    p_firestore_id: firestoreId || null,
  });

  if (error) {
    console.error('[hapus-temuan] RPC gagal:', error);
    throw error;
  }

  const result = Array.isArray(data) ? data[0] : data;
  console.info('[hapus-temuan] RPC result:', result);

  // 3) Hapus foto Storage (best effort). Gagal hapus foto tidak boleh membatalkan delete.
  for (const url of photoUrls) {
    try { await deleteStorageAsset(url); } catch (e) { console.warn('[hapus-temuan] gagal hapus foto', url, e); }
  }
}

registerOutboxHandler('patrol_report.delete', performPatrolReportDelete);

export async function deletePatrolReport(criteria = {}) {
  try {
    await performPatrolReportDelete(criteria);
    return true;
  } catch (error) {
    // Gagal transien (offline/jaringan/RLS): antre ke outbox agar dicoba ulang saat
    // online. Tanpa ini, hapus offline tidak pernah ditegakkan dan temuan dapat
    // dihidupkan kembali oleh hydrate/re-upsert — regresi yang justru ingin dicegah.
    // Id deterministik agar hapus berulang untuk laporan yang sama tidak menumpuk.
    console.error('Gagal hapus patrol_report dari DB, mengantre ke outbox', { ...criteria, error });
    await enqueueOutboxMutation({
      id: `patrol-delete-${criteria.firestoreId || `${criteria.shipId || 'ship'}|${criteria.shiftKey || 'shift'}|${criteria.checkpointId || 'cp'}`}`,
      type: 'patrol_report.delete',
      payload: criteria,
    });
    return false;
  }
}

// Berlangganan tombstone temuan/laporan patroli untuk PROPAGASI PENGHAPUSAN lintas-device.
//
// Akar masalah "temuan dihapus admin masih terlihat di device petugas": realtime
// patrol_reports + mergePatrolReportDocumentsIntoCheckpoints hanya MERGE/ADD baris yang
// masih ada — tidak pernah MENGHAPUS checkpoint lokal saat barisnya dihapus admin.
// Device petugas memegang checkpoint 'completed' (temuan) di state lokal selamanya.
//
// Solusi: device petugas berlangganan patrol_report_tombstones (RLS mengizinkan baca
// untuk kapal yang ditugaskan, asalkan ship_name terisi). Saat tombstone muncul, klien
// mereset checkpoint lokal yang cocok (ship_id + checkpoint_id) menjadi pending sehingga
// temuan hilang dari daftar. Trigger DB sudah mencegah re-upsert menghidupkannya lagi.
export function subscribeToPatrolReportTombstones(callback, onError) {
  const supabase = ensureSupabaseClient();
  let disposed = false;

  const fetchRows = async () => {
    const { data, error } = await supabase
      .from(PATROL_REPORT_TOMBSTONES_TABLE)
      .select('client_event_id, shift_key, ship_id, checkpoint_id, ship_name, deleted_at')
      .order('deleted_at', { ascending: false })
      .limit(500);
    if (error) throw error;
    if (!disposed) {
      callback((data || []).map((row) => ({
        clientEventId: row.client_event_id,
        shiftKey: row.shift_key || null,
        shipId: row.ship_id || null,
        checkpointId: row.checkpoint_id || null,
        shipName: row.ship_name || null,
        deletedAt: row.deleted_at || null,
      })));
    }
  };

  fetchRows().catch(onError);

  const channel = supabase.channel('patrol-report-tombstones')
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: PATROL_REPORT_TOMBSTONES_TABLE,
    }, () => {
      fetchRows().catch(onError);
    })
    .subscribe();

  // Fallback polling: realtime Supabase bisa gagal/terputus ("Realtime signal Supabase
  // gagal"). Tanpa fallback, device petugas yang SUDAH terbuka tidak pernah menerima
  // event INSERT tombstone — temuan yang dihapus admin tetap tampil sampai app di-reload.
  // Poll ulang daftar tombstone secara berkala memastikan penghapusan tetap dipropagasi
  // dalam beberapa detik walau realtime mati. fetchRows idempotent (reset checkpoint yang
  // sudah pending = no-op), jadi aman dipanggil berulang.
  const POLL_INTERVAL_MS = 15000;
  const pollTimer = setInterval(() => {
    if (disposed) return;
    fetchRows().catch(onError);
  }, POLL_INTERVAL_MS);

  return () => {
    disposed = true;
    clearInterval(pollTimer);
    supabase.removeChannel(channel);
  };
}

export { PATROL_REPORTS_SCHEMA_VERSION };
