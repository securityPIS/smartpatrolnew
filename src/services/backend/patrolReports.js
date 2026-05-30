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
// AKAR MASALAH "temuan dihapus admin balik lagi": versi lama menyaring SELECT & DELETE
// dengan shift_key yang DIBAWA incident (client). shift_key itu bisa kosong/basi, sedangkan
// baris DB memakai shift_key shift ASAL temuan (mis. '2026-05-27|shift-2-active'). Saat
// keduanya beda, .eq('shift_key', ...) menghasilkan 0 baris -> DELETE tidak menghapus apa
// pun -> temuan muncul lagi setiap hydrate. Tombstone pun tertulis dengan shift_key salah
// sehingga trigger tidak memblokir re-upsert.
//
// Perbaikan: JANGAN percaya shift_key dari client. Cari baris lewat firestoreId dan/atau
// (ship_id+checkpoint_id) TANPA filter shift_key, ambil shift_key ASLI dari baris DB,
// lalu tombstone + DELETE memakai shift_key asli itu.
async function performPatrolReportDelete({ firestoreId, checkpointId, shiftKey, shipId, shipName } = {}) {
  const supabase = ensureSupabaseClient();
  const hasNaturalKey = Boolean(shipId && checkpointId);

  if (!firestoreId && !hasNaturalKey) return;

  const selectColumns = 'id, client_event_id, shift_key, ship_id, checkpoint_id, ship_name, photo_url';
  const foundRows = [];
  const seenIds = new Set();
  const collectRows = (rows) => (rows || []).forEach((row) => {
    if (row?.id != null && !seenIds.has(row.id)) { seenIds.add(row.id); foundRows.push(row); }
  });

  // Cari tanpa filter shift_key agar shift_key ASLI dari DB bisa dipakai.
  if (hasNaturalKey) {
    const { data, error } = await supabase
      .from(PATROL_REPORTS_TABLE).select(selectColumns)
      .eq('ship_id', shipId).eq('checkpoint_id', checkpointId);
    if (error) throw error;
    collectRows(data);
  }
  if (firestoreId) {
    const { data, error } = await supabase
      .from(PATROL_REPORTS_TABLE).select(selectColumns).eq('id', firestoreId);
    if (error) throw error;
    collectRows(data);
  }

  // shift_key otoritatif: ambil dari baris DB (bukan dari client).
  const firestoreRow = firestoreId ? foundRows.find((r) => String(r.id) === String(firestoreId)) : null;
  const targetShiftKey = firestoreRow?.shift_key ?? shiftKey ?? null;

  // Baris yang akan dihapus: cocok firestoreId ATAU (natural-key + shift target).
  const rowsToDelete = foundRows.filter((row) => {
    if (firestoreId && String(row.id) === String(firestoreId)) return true;
    if (!hasNaturalKey) return false;
    if (String(row.ship_id) !== String(shipId) || String(row.checkpoint_id) !== String(checkpointId)) return false;
    return targetShiftKey == null || (row.shift_key ?? null) === targetShiftKey;
  });

  const resolvedShipName = shipName
    || rowsToDelete.find((r) => r.ship_name)?.ship_name
    || foundRows.find((r) => r.ship_name)?.ship_name
    || null;

  // Tombstone memakai shift_key ASLI dari DB agar trigger mencocokkan natural key.
  const tombstoneMap = new Map();
  const addTombstone = (entry) => { if (entry.client_event_id) tombstoneMap.set(entry.client_event_id, entry); };
  rowsToDelete.forEach((row) => {
    addTombstone({
      client_event_id: row.client_event_id
        || createClientEventId({ shiftKey: row.shift_key, shipId: row.ship_id, checkpointId: row.checkpoint_id }),
      shift_key: row.shift_key ?? null,
      ship_id: row.ship_id ?? null,
      checkpoint_id: row.checkpoint_id ?? null,
      ship_name: row.ship_name || resolvedShipName,
    });
  });
  // Tombstone anti-resurrection: natural-key + shift_key asli, walau SELECT meleset.
  if (hasNaturalKey) {
    addTombstone({
      client_event_id: createClientEventId({ shiftKey: targetShiftKey, shipId, checkpointId }),
      shift_key: targetShiftKey,
      ship_id: shipId,
      checkpoint_id: checkpointId,
      ship_name: resolvedShipName,
    });
  }

  console.info('[hapus-temuan] kriteria', { firestoreId, checkpointId, shiftKey, shipId, hasNaturalKey });
  console.info('[hapus-temuan] baris ditemukan (tanpa filter shift):', foundRows.length, foundRows);
  console.info('[hapus-temuan] shift_key target (dari DB):', targetShiftKey, '| baris dihapus:', rowsToDelete.length);

  // [DIAGNOSTIK] Lihat console saat menghapus untuk mengetahui di lapisan mana penghapusan
  // gagal. Hapus blok log ini setelah akar masalah ditemukan.
  console.info('[hapus-temuan] kriteria', { firestoreId, checkpointId, shiftKey, shipId, shipName, hasNaturalKey });
  console.info('[hapus-temuan] baris ditemukan di patrol_reports (SELECT):', (rows || []).length, rows);

  if (tombstoneMap.size > 0) {
    const { data: tombstoneData, error: tombstoneError } = await supabase
      .from(PATROL_REPORT_TOMBSTONES_TABLE)
      .upsert(Array.from(tombstoneMap.values()), { onConflict: 'client_event_id' })
      .select();
    if (tombstoneError) {
      console.error('[hapus-temuan] GAGAL tulis tombstone:', tombstoneError);
      throw tombstoneError;
    }
    console.info('[hapus-temuan] tombstone tertulis:', (tombstoneData || []).length, tombstoneData);
  } else {
    console.warn('[hapus-temuan] TIDAK ada tombstone ditulis.');
  }

  for (const row of rowsToDelete) {
    if (row.photo_url) await deleteStorageAsset(row.photo_url);
  }

  let totalDeleted = 0;
  if (rowsToDelete.length > 0) {
    const { data: deletedById, error: errById } = await supabase
      .from(PATROL_REPORTS_TABLE).delete()
      .in('id', rowsToDelete.map((r) => r.id)).select();
    if (errById) { console.error('[hapus-temuan] GAGAL delete (by id):', errById); throw errById; }
    totalDeleted += (deletedById || []).length;
  }
  // Tangkap baris yang disisipkan ulang setelah SELECT (race condition lintas-device).
  if (hasNaturalKey) {
    let q = supabase.from(PATROL_REPORTS_TABLE).delete()
      .eq('ship_id', shipId).eq('checkpoint_id', checkpointId);
    if (targetShiftKey != null) q = q.eq('shift_key', targetShiftKey);
    const { data: deletedByKey, error: errByKey } = await q.select();
    if (errByKey) { console.error('[hapus-temuan] GAGAL delete (natural key):', errByKey); throw errByKey; }
    totalDeleted += (deletedByKey || []).length;
  }

  console.info('[hapus-temuan] TOTAL baris terhapus:', totalDeleted);
  if (totalDeleted === 0 && foundRows.length > 0) {
    console.warn('[hapus-temuan] 0 terhapus padahal baris ditemukan — RLS is_admin() mungkin menolak DELETE. Periksa profil admin.');
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
