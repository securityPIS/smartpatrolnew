/*
Tujuan: Adapter SQL/Reatime untuk laporan checkpoint patroli.
Caller: AppContextRuntime saat submit laporan, backfill offline, dan listener lintas-device.
Dependensi: Supabase Postgres/Reatime dan outbox IndexedDB.
Main Functions: Subscribe laporan per shift/kapal dan upsert laporan idempotent per checkpoint.
Side Effects: Membaca/menulis tabel patrol_reports dan mengantre mutation saat offline.
*/

import { ensureSupabaseClient } from './app';
import { enqueueOutboxMutation, registerOutboxHandler } from './outbox';

const PATROL_REPORTS_TABLE = 'patrol_reports';
const PATROL_REPORT_PHOTOS_TABLE = 'patrol_report_photos';
const PATROL_REPORTS_SCHEMA_VERSION = 1;
const PATROL_REPORTS_LISTEN_LIMIT = 120;

// Embed referensi full-res R2 dari patrol_report_photos lewat FK report_id (satu query, tanpa N+1).
const PATROL_REPORTS_SELECT = `*, ${PATROL_REPORT_PHOTOS_TABLE}(id, full_object_key, full_storage_provider, full_media_status, payload)`;

// Gabungkan referensi foto full-res R2 (dari patrol_report_photos) ke report + galleryPhotos.
// Pencocokan via payload.kind ('main'|'gallery') dan payload.galleryPhotoId agar tahan beda id antar-device.
export function applyFullPhotoRefs(report, photoRows) {
  if (!report || !Array.isArray(photoRows) || photoRows.length === 0) return report;
  const next = { ...report };

  const mainRow = photoRows.find((row) => (row?.payload?.kind || 'main') === 'main' && row?.full_object_key);
  if (mainRow) {
    next.fullObjectKey = mainRow.full_object_key;
    next.fullStorageProvider = mainRow.full_storage_provider || 'r2';
  }

  const galleryRows = new Map();
  photoRows.forEach((row) => {
    if ((row?.payload?.kind || '') === 'gallery' && row?.full_object_key) {
      galleryRows.set(String(row.payload?.galleryPhotoId || ''), row);
    }
  });
  if (galleryRows.size > 0 && Array.isArray(next.galleryPhotos)) {
    next.galleryPhotos = next.galleryPhotos.map((galleryPhoto) => {
      const row = galleryRows.get(String(galleryPhoto?.id || ''));
      return row
        ? { ...galleryPhoto, fullObjectKey: row.full_object_key, fullStorageProvider: row.full_storage_provider || 'r2' }
        : galleryPhoto;
    });
  }
  return next;
}

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
    occurred_at_trusted_ms: Number.isFinite(report.occurredAtTrustedMs) ? report.occurredAtTrustedMs : null,
    client_updated_at_ms: clientUpdatedAt,
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
  const report = {
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
  return applyFullPhotoRefs(report, row[PATROL_REPORT_PHOTOS_TABLE]);
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

async function writePatrolReportPhoto(photo = {}) {
  const supabase = ensureSupabaseClient();
  const photoId = String(photo.id || '');
  if (!photoId) throw new Error('patrol_report_photo: id wajib diisi.');

  // Resolusi report_id (FK opsional) best-effort dari kunci natural laporan.
  let reportId = photo.reportId || null;
  if (!reportId && photo.shiftKey && photo.shipId && photo.checkpointId) {
    const { data, error } = await supabase
      .from(PATROL_REPORTS_TABLE)
      .select('id')
      .eq('shift_key', photo.shiftKey)
      .eq('ship_id', photo.shipId)
      .eq('checkpoint_id', photo.checkpointId)
      .maybeSingle();
    if (error) throw error;
    reportId = data?.id || null;
  }

  const row = {
    id: photoId,
    report_id: reportId,
    ship_id: String(photo.shipId || ''),
    object_path: photo.thumbObjectPath || photo.fullObjectKey || photoId,
    photo_url: photo.thumbUrl || null,
    author_id: photo.authorId || null,
    occurred_at_trusted_ms: Number.isFinite(photo.occurredAtTrustedMs) ? photo.occurredAtTrustedMs : null,
    full_storage_provider: photo.fullObjectKey ? 'r2' : null,
    full_object_key: photo.fullObjectKey || null,
    full_media_status: photo.fullObjectKey ? 'ready' : 'none',
    payload: {
      kind: photo.kind || 'main',
      galleryPhotoId: photo.galleryPhotoId || null,
    },
  };

  const { error } = await supabase
    .from(PATROL_REPORT_PHOTOS_TABLE)
    .upsert(row, { onConflict: 'id' });
  if (error) throw error;
  return row;
}

registerOutboxHandler('patrol_report_photo.upsert', writePatrolReportPhoto);

export async function savePatrolReportPhoto(photo = {}) {
  try {
    return await writePatrolReportPhoto(photo);
  } catch (error) {
    console.error('Gagal menulis patrol_report_photos, mengantre ke outbox', {
      code: error?.code,
      message: error?.message,
      id: photo?.id || null,
    });
    await enqueueOutboxMutation({
      type: 'patrol_report_photo.upsert',
      payload: photo,
      id: photo?.id,
    });
    return { ...photo, pendingOfflineSync: true };
  }
}

export function subscribeToPatrolReports({ shiftKey, shipId, shipName }, callback, onError) {
  const supabase = ensureSupabaseClient();
  let disposed = false;

  const fetchRows = async () => {
    let query = supabase
      .from(PATROL_REPORTS_TABLE)
      .select(PATROL_REPORTS_SELECT)
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
    return await writePatrolReport(report, options);
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
      type: 'patrol_report.upsert',
      payload: report,
    });
    return {
      ...report,
      schemaVersion: PATROL_REPORTS_SCHEMA_VERSION,
      clientUpdatedAt: Number.isFinite(options.clientUpdatedAt) ? options.clientUpdatedAt : Date.now(),
      pendingOfflineSync: true,
    };
  }
}

export { PATROL_REPORTS_SCHEMA_VERSION };
