/*
Tujuan: Adapter SQL/Realtime untuk insiden dan update temuan SmartPatrol.
Caller: AppContextRuntime saat submit/update/delete insiden dan listener lintas-device.
Dependensi: Supabase Postgres/Reatime dan outbox IndexedDB.
Main Functions: Subscribe insiden, upsert payload insiden idempotent, append progress/dokumentasi, dan delete admin.
Side Effects: Membaca/menulis tabel incidents serta mengantre mutation offline bila jaringan gagal.
*/

import { ensureSupabaseClient } from './app';
import { enqueueOutboxMutation, registerOutboxHandler } from './outbox';
import { deleteStorageAsset } from './assets';

const INCIDENTS_TABLE = 'incidents';
const INCIDENTS_SCHEMA_VERSION = 1;
const INCIDENTS_LISTEN_LIMIT = 200;

function mapIncidentToRow(incident = {}, options = {}) {
  const clientUpdatedAt = Number.isFinite(options.clientUpdatedAt)
    ? options.clientUpdatedAt
    : Date.now();

  const payload = {
    ...incident,
    schemaVersion: INCIDENTS_SCHEMA_VERSION,
    clientUpdatedAt,
  };

  return {
    id: String(incident.id || incident.incidentId || ''),
    client_event_id: incident.clientEventId || incident.client_event_id || String(incident.id || incident.incidentId || ''),
    ship_name: String(incident.shipName || ''),
    status: incident.status || 'open',
    location: incident.location || '',
    reported_by: incident.reportedBy || '',
    // Kolom *_ms bertipe bigint: paksa integer (performance.now() bisa berkoma → ditolak Postgres).
    occurred_at_trusted_ms: Number.isFinite(incident.occurredAtTrustedMs) ? Math.round(incident.occurredAtTrustedMs) : null,
    client_updated_at_ms: Math.round(clientUpdatedAt),
    photo_url: incident.photoUrl || null,
    payload,
  };
}

function mapRowToIncident(row = {}) {
  return {
    ...(row.payload || {}),
    firestoreId: row.id,
    id: row.id || row.payload?.id || '',
    schemaVersion: row.payload?.schemaVersion || INCIDENTS_SCHEMA_VERSION,
    clientUpdatedAt: row.client_updated_at_ms || row.payload?.clientUpdatedAt || null,
    serverUpdatedAt: row.server_updated_at || row.updated_at || null,
    shipName: row.ship_name || row.payload?.shipName || '',
    status: row.status || row.payload?.status || 'open',
    location: row.location || row.payload?.location || '',
    reportedBy: row.reported_by || row.payload?.reportedBy || '',
    photoUrl: row.photo_url || row.payload?.photoUrl || null,
    progress: row.payload?.progress || [],
    documentation: row.payload?.documentation || [],
  };
}

async function mergeAppendPayload(row, options = {}) {
  const appendProgressItems = Array.isArray(options.appendProgressItems)
    ? options.appendProgressItems.filter(Boolean)
    : [];
  const appendDocumentationItems = Array.isArray(options.appendDocumentationItems)
    ? options.appendDocumentationItems.filter(Boolean)
    : [];

  if (appendProgressItems.length === 0 && appendDocumentationItems.length === 0) {
    return row;
  }

  const supabase = ensureSupabaseClient();
  const { data, error } = await supabase
    .from(INCIDENTS_TABLE)
    .select('payload')
    .eq('id', row.id)
    .maybeSingle();
  if (error) throw error;

  const currentPayload = data?.payload || {};
  return {
    ...row,
    payload: {
      ...currentPayload,
      ...row.payload,
      progress: [
        ...(Array.isArray(currentPayload.progress) ? currentPayload.progress : []),
        ...appendProgressItems,
      ],
      documentation: [
        ...(Array.isArray(currentPayload.documentation) ? currentPayload.documentation : []),
        ...appendDocumentationItems,
      ],
    },
  };
}

async function writeIncidentReport(incident, options = {}) {
  const supabase = ensureSupabaseClient();
  const row = await mergeAppendPayload(mapIncidentToRow(incident, options), options);
  if (!row.id) throw new Error('incident-id-required');

  const { error } = await supabase
    .from(INCIDENTS_TABLE)
    .upsert(row, { onConflict: 'id' });
  if (error) throw error;
  return row.payload;
}

registerOutboxHandler('incident.upsert', writeIncidentReport);
registerOutboxHandler('incident.delete', async ({ incidentId }) => {
  const supabase = ensureSupabaseClient();
  const { error } = await supabase.from(INCIDENTS_TABLE).delete().eq('id', incidentId);
  if (error) throw error;
});
registerOutboxHandler('sos_alert.delete', async ({ sosId }) => {
  const supabase = ensureSupabaseClient();
  const { error } = await supabase.from('sos_alerts').delete().eq('id', sosId);
  if (error) throw error;
});

export function subscribeToIncidents(callback, onError) {
  const supabase = ensureSupabaseClient();
  let disposed = false;

  const fetchRows = async () => {
    const { data, error } = await supabase
      .from(INCIDENTS_TABLE)
      .select('*')
      .order('created_at', { ascending: false })
      .limit(INCIDENTS_LISTEN_LIMIT);
    if (error) throw error;
    if (!disposed) callback((data || []).map(mapRowToIncident));
  };

  fetchRows().catch(onError);

  const channel = supabase.channel('incidents')
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: INCIDENTS_TABLE,
    }, () => {
      fetchRows().catch(onError);
    })
    .subscribe();

  return () => {
    disposed = true;
    supabase.removeChannel(channel);
  };
}

export async function saveIncidentReport(incident, options = {}) {
  try {
    return await writeIncidentReport(incident, options);
  } catch (error) {
    await enqueueOutboxMutation({
      type: 'incident.upsert',
      payload: incident,
    });
    return {
      ...incident,
      schemaVersion: INCIDENTS_SCHEMA_VERSION,
      pendingOfflineSync: true,
    };
  }
}

export async function deleteIncidentReport(incidentId, photoUrl = null) {
  const supabase = ensureSupabaseClient();
  try {
    if (photoUrl) await deleteStorageAsset(photoUrl);
    const { error } = await supabase.from(INCIDENTS_TABLE).delete().eq('id', incidentId);
    if (error) throw error;
    return true;
  } catch (error) {
    await enqueueOutboxMutation({
      type: 'incident.delete',
      payload: { incidentId },
    });
    return false;
  }
}

export async function deleteSosAlert(sosId) {
  if (!sosId) return false;
  const supabase = ensureSupabaseClient();
  try {
    const { error } = await supabase.from('sos_alerts').delete().eq('id', sosId);
    if (error) throw error;
    return true;
  } catch (error) {
    await enqueueOutboxMutation({
      type: 'sos_alert.delete',
      payload: { sosId },
    });
    return false;
  }
}

export { INCIDENTS_SCHEMA_VERSION };
