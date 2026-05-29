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
// oleh re-upsert idempotent dari device lain (lihat migration 202605300007).
//
// Strategi pencocokan dibuat lunak: utamakan id baris (firestoreId) yang pasti; bila
// tidak ada, cocokkan via ship_id + checkpoint_id (+ shift_key bila tersedia). Setiap
// baris yang cocok di-tombstone via client_event_id-nya SENDIRI (dibaca dari DB), foto
// di Storage dihapus, lalu barisnya dihapus. Melempar error agar bisa diantre ulang.
async function performPatrolReportDelete({ firestoreId, checkpointId, shiftKey, shipId } = {}) {
  const supabase = ensureSupabaseClient();
  let query = supabase
    .from(PATROL_REPORTS_TABLE)
    .select('id, client_event_id, shift_key, ship_id, checkpoint_id, ship_name, photo_url');

  if (firestoreId) {
    query = query.eq('id', firestoreId);
  } else if (shipId && checkpointId) {
    query = query.eq('ship_id', shipId).eq('checkpoint_id', checkpointId);
    if (shiftKey) query = query.eq('shift_key', shiftKey);
  } else {
    return; // kriteria tidak cukup, tidak ada yang bisa dihapus
  }

  const { data: rows, error: selectError } = await query;
  if (selectError) throw selectError;
  if (!rows || rows.length === 0) return; // tidak ada baris = sudah bersih

  const tombstones = rows
    .filter((row) => row.client_event_id)
    .map((row) => ({
      client_event_id: row.client_event_id,
      shift_key: row.shift_key || null,
      ship_id: row.ship_id || null,
      checkpoint_id: row.checkpoint_id || null,
      ship_name: row.ship_name || null,
    }));
  if (tombstones.length > 0) {
    const { error: tombstoneError } = await supabase
      .from(PATROL_REPORT_TOMBSTONES_TABLE)
      .upsert(tombstones, { onConflict: 'client_event_id' });
    if (tombstoneError) throw tombstoneError;
  }

  for (const row of rows) {
    if (row.photo_url) await deleteStorageAsset(row.photo_url);
  }

  const { error: deleteError } = await supabase
    .from(PATROL_REPORTS_TABLE)
    .delete()
    .in('id', rows.map((row) => row.id));
  if (deleteError) throw deleteError;
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

export { PATROL_REPORTS_SCHEMA_VERSION };
