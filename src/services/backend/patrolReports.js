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
// oleh re-upsert idempotent dari device lain (lihat migration 202605300007/202605300008).
//
// Dua-kunci & SELALU-tombstone: trigger DB memblokir penulisan ulang baik via
// client_event_id maupun natural key (shift_key+ship_id+checkpoint_id). Karena
// checkpoint hasil hydrate cloudState TIDAK membawa firestoreId, dan client_event_id
// re-upsert bisa berbeda dari yang tersimpan, kita SELALU menulis tombstone berbasis
// natural key dari kriteria — walau baris tidak ditemukan di SELECT — sehingga
// re-upsert dari device manapun tetap diblokir.
async function performPatrolReportDelete({ firestoreId, checkpointId, shiftKey, shipId, shipName } = {}) {
  const supabase = ensureSupabaseClient();
  const hasNaturalKey = Boolean(shipId && checkpointId);

  if (!firestoreId && !hasNaturalKey) return; // kriteria tidak cukup

  // SELECT via natural key jika tersedia — menangkap semua baris yang cocok termasuk
  // baris yang disisipkan ulang oleh device lain setelah SELECT pertama (race condition).
  // Jika natural key tidak tersedia, fallback ke firestoreId.
  let query = supabase
    .from(PATROL_REPORTS_TABLE)
    .select('id, client_event_id, shift_key, ship_id, checkpoint_id, ship_name, photo_url');

  if (hasNaturalKey) {
    query = query.eq('ship_id', shipId).eq('checkpoint_id', checkpointId);
    if (shiftKey) query = query.eq('shift_key', shiftKey);
  } else {
    query = query.eq('id', firestoreId);
  }

  const { data: rows, error: selectError } = await query;
  if (selectError) throw selectError;

  // ship_name WAJIB terisi di tombstone agar petugas (RLS can_access_ship_name) bisa
  // membaca tombstone dan mereset checkpoint lokal. Ambil dari kriteria, atau dari baris
  // yang ditemukan bila kriteria tidak membawanya.
  const resolvedShipName = shipName || (rows || []).find((row) => row.ship_name)?.ship_name || null;

  // Tombstone dari natural key kriteria — SELALU dibuat (anti-resurrection walau
  // SELECT meleset). client_event_id dibentuk identik dengan createClientEventId
  // agar cocok dengan nilai yang dipakai re-upsert.
  const tombstoneMap = new Map();
  if (hasNaturalKey) {
    const naturalEventId = createClientEventId({ shiftKey, shipId, checkpointId });
    tombstoneMap.set(naturalEventId, {
      client_event_id: naturalEventId,
      shift_key: shiftKey || null,
      ship_id: shipId,
      checkpoint_id: checkpointId,
      ship_name: resolvedShipName,
    });
  }
  // Tombstone dari setiap baris yang benar-benar ada (client_event_id aslinya).
  (rows || []).forEach((row) => {
    if (!row.client_event_id) return;
    tombstoneMap.set(row.client_event_id, {
      client_event_id: row.client_event_id,
      shift_key: row.shift_key || null,
      ship_id: row.ship_id || null,
      checkpoint_id: row.checkpoint_id || null,
      ship_name: row.ship_name || resolvedShipName,
    });
  });

  if (tombstoneMap.size > 0) {
    const { error: tombstoneError } = await supabase
      .from(PATROL_REPORT_TOMBSTONES_TABLE)
      .upsert(Array.from(tombstoneMap.values()), { onConflict: 'client_event_id' });
    if (tombstoneError) throw tombstoneError;
  }

  // Hapus foto baris yang ditemukan di SELECT.
  for (const row of (rows || [])) {
    if (row.photo_url) await deleteStorageAsset(row.photo_url);
  }

  // Hapus via natural key jika tersedia — menangkap baris baru yang disisipkan ulang
  // setelah SELECT di atas (race condition lintas-device). Jika natural key tidak ada,
  // hapus by UUID.
  if (hasNaturalKey) {
    let deleteQuery = supabase
      .from(PATROL_REPORTS_TABLE)
      .delete()
      .eq('ship_id', shipId)
      .eq('checkpoint_id', checkpointId);
    if (shiftKey) deleteQuery = deleteQuery.eq('shift_key', shiftKey);
    const { error: deleteError } = await deleteQuery;
    if (deleteError) throw deleteError;
  } else if (rows && rows.length > 0) {
    const { error: deleteError } = await supabase
      .from(PATROL_REPORTS_TABLE)
      .delete()
      .in('id', rows.map((row) => row.id));
    if (deleteError) throw deleteError;
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
      .select('client_event_id, shift_key, ship_id, checkpoint_id, ship_name')
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

  return () => {
    disposed = true;
    supabase.removeChannel(channel);
  };
}

export { PATROL_REPORTS_SCHEMA_VERSION };
