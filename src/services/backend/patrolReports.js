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

export async function deletePatrolReport({ checkpointId, shiftKey, shipId, photoUrl } = {}) {
  if (!checkpointId || !shiftKey || !shipId) return false;
  const supabase = ensureSupabaseClient();
  try {
    if (photoUrl) await deleteStorageAsset(photoUrl);
    const { error } = await supabase
      .from(PATROL_REPORTS_TABLE)
      .delete()
      .eq('checkpoint_id', checkpointId)
      .eq('shift_key', shiftKey)
      .eq('ship_id', shipId);
    if (error) throw error;
    return true;
  } catch (error) {
    console.error('Gagal hapus patrol_report dari DB', { checkpointId, shiftKey, shipId, error });
    return false;
  }
}

export { PATROL_REPORTS_SCHEMA_VERSION };
