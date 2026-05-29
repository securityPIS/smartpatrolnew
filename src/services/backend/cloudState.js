/*
Tujuan: Menyediakan sinkronisasi state cloud SmartPatrol di atas tabel SQL normalisasi.
Caller: AppContextRuntime untuk hydrate state, publish sinyal realtime, simpan snapshot, dan upload aset.
Dependensi: Supabase Postgres/Realtime, adapter aset, outbox IndexedDB, dan mapping state legacy.
Main Functions: Fetch/hydrate state dari SQL, decompose state lokal ke tabel SQL, subscribe perubahan realtime, dan signal ringan.
Side Effects: Membaca/menulis tabel profiles, ships, patrol_reports, incidents, client_mutations, serta cache IndexedDB.
*/

import { sanitizeEmail, sanitizePhone, sanitizeText, sanitizeUrl } from '../../utils/sanitize';
import { ensureSupabaseClient, isSupabaseConfigured } from './app';
import { uploadCloudDataUrlAsset } from './assets';
import { enqueueOutboxMutation, loadCacheSnapshot, registerOutboxHandler, saveCacheSnapshot } from './outbox';

const CLOUD_STATE_SCHEMA_VERSION = 1;
const isCloudSyncAllowedByEnv = import.meta.env.VITE_ENABLE_CLOUD_SYNC !== '0';
const isCloudWriteAllowedByEnv = import.meta.env.VITE_ENABLE_CLOUD_SYNC_WRITE !== '0';
const isCloudSyncEnabled = Boolean(isSupabaseConfigured) && isCloudSyncAllowedByEnv;
const isCloudWriteEnabled = isCloudSyncEnabled && isCloudWriteAllowedByEnv;

function profileToUser(row = {}) {
  return {
    id: row.id || row.auth_uid || '',
    name: sanitizeText(row.name || '', 80) || 'Personil',
    role: sanitizeText(row.role || 'PETUGAS', 20).toUpperCase(),
    type: sanitizeText(row.type || 'BUJP', 20) || 'BUJP',
    workerNumber: sanitizeText(row.worker_number || '', 40),
    status: sanitizeText(row.status || 'off-duty', 20).toLowerCase(),
    shipAssigned: sanitizeText(row.ship_assigned || '', 80) || null,
    email: sanitizeEmail(row.email || ''),
    authProvider: 'supabase',
    firebaseUid: row.auth_uid || row.id || null,
    phone: sanitizePhone(row.phone || ''),
    dob: sanitizeText(row.dob || '', 20),
    address: sanitizeText(row.address || '', 180),
    officeAddress: sanitizeText(row.office_address || '', 180),
    emergencyName: sanitizeText(row.emergency_name || '', 80),
    emergencyContact: sanitizePhone(row.emergency_contact || ''),
    emergencyRelation: sanitizeText(row.emergency_relation || 'Orang Tua', 40) || 'Orang Tua',
    photoUrl: sanitizeUrl(row.photo_url || '') || null,
    credentialUpdatedAt: row.credential_updated_at || null,
    dutyEndDate: row.duty_end_date || null,
    dutyStatus: row.duty_status || null,
    updatedAt: row.updated_at || null,
  };
}

function shipToState(row = {}) {
  return {
    id: row.id || '',
    name: sanitizeText(row.name || '', 100) || 'Kapal',
    type: sanitizeText(row.type || '', 40),
    imoNumber: sanitizeText(row.imo_number || '', 20),
    lat: sanitizeText(row.lat || '', 40),
    lng: sanitizeText(row.lng || '', 40),
    status: sanitizeText(row.status || 'Non Operasional', 30),
    route: sanitizeText(row.route || '', 120),
    routeLoading: sanitizeText(row.route_loading || '', 120),
    routeDischarge: sanitizeText(row.route_discharge || '', 120),
    cargoType: sanitizeText(row.cargo_type || '', 80),
    cargoAmount: sanitizeText(row.cargo_amount || '', 80),
    photoUrl: sanitizeUrl(row.photo_url || '') || null,
    personnel: Array.isArray(row.personnel) ? row.personnel : [],
    personnelNextMonth: Array.isArray(row.personnel_next_month) ? row.personnel_next_month : [],
    personnelSchedules: row.personnel_schedules || {},
    customCheckpoints: Array.isArray(row.custom_checkpoints) ? row.custom_checkpoints : [],
    documents: Array.isArray(row.documents) ? row.documents : [],
    sosRecipientShipIds: Array.isArray(row.sos_recipient_ship_ids) ? row.sos_recipient_ship_ids : [],
    updatedAt: row.updated_at || null,
  };
}

function reportRowToCheckpoint(row = {}) {
  return {
    ...(row.payload || {}),
    id: row.checkpoint_id || row.payload?.id || row.payload?.checkpointId,
    checkpointId: row.checkpoint_id || row.payload?.checkpointId,
    shipId: row.ship_id || row.payload?.shipId,
    shipName: row.ship_name || row.payload?.shipName,
    shiftKey: row.shift_key || row.payload?.shiftKey,
    status: row.status || row.payload?.status || 'pending',
    resultType: row.result_type || row.payload?.resultType || null,
    photoUrl: row.photo_url || row.payload?.photoUrl || null,
  };
}

function incidentRowToState(row = {}) {
  return {
    ...(row.payload || {}),
    id: row.id || row.payload?.id,
    shipName: row.ship_name || row.payload?.shipName,
    status: row.status || row.payload?.status || 'open',
    location: row.location || row.payload?.location || '',
    reportedBy: row.reported_by || row.payload?.reportedBy || '',
    photoUrl: row.photo_url || row.payload?.photoUrl || null,
  };
}

function userToProfileRow(user = {}) {
  return {
    id: String(user.id || user.firebaseUid || ''),
    auth_uid: user.firebaseUid || null,
    email: sanitizeEmail(user.email || ''),
    name: sanitizeText(user.name || '', 80) || 'Personil',
    role: sanitizeText(user.role || 'PETUGAS', 20).toUpperCase(),
    status: sanitizeText(user.status || 'off-duty', 20).toLowerCase(),
    ship_assigned: sanitizeText(user.shipAssigned || '', 80) || null,
    type: sanitizeText(user.type || 'BUJP', 20) || 'BUJP',
    worker_number: sanitizeText(user.workerNumber || '', 40),
    phone: sanitizePhone(user.phone || ''),
    dob: sanitizeText(user.dob || '', 20),
    address: sanitizeText(user.address || '', 180),
    office_address: sanitizeText(user.officeAddress || '', 180),
    emergency_name: sanitizeText(user.emergencyName || '', 80),
    emergency_contact: sanitizePhone(user.emergencyContact || ''),
    emergency_relation: sanitizeText(user.emergencyRelation || '', 40),
    photo_url: sanitizeUrl(user.photoUrl || '') || null,
    enabled: user.status !== 'disabled',
    review_state: 'approved',
  };
}

function isUuidLike(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

async function reconcileProfileRowIds(supabase, profileRows = []) {
  const rowsWithAuthUid = profileRows.filter(row => row?.auth_uid && isUuidLike(row.auth_uid));
  const emailValues = Array.from(new Set(profileRows.map(row => row?.email).filter(Boolean)));
  const authUidValues = Array.from(new Set(rowsWithAuthUid.map(row => row.auth_uid)));
  if (authUidValues.length === 0 && emailValues.length === 0) return profileRows;

  try {
    const existingRows = [];
    if (authUidValues.length > 0) {
      const { data, error } = await supabase
        .from('profiles')
        .select('id,auth_uid,email')
        .in('auth_uid', authUidValues);
      if (error) throw error;
      existingRows.push(...(data || []));
    }
    if (emailValues.length > 0) {
      const { data, error } = await supabase
        .from('profiles')
        .select('id,auth_uid,email')
        .in('email', emailValues);
      if (error) throw error;
      existingRows.push(...(data || []));
    }

    const existingByAuthUid = new Map();
    const existingByEmail = new Map();
    existingRows.forEach((row) => {
      if (row?.auth_uid) existingByAuthUid.set(String(row.auth_uid), row);
      if (row?.email) existingByEmail.set(sanitizeEmail(row.email), row);
    });

    return profileRows.map((row) => {
      const existing = (
        (row.auth_uid && existingByAuthUid.get(String(row.auth_uid)))
        || (row.email && existingByEmail.get(sanitizeEmail(row.email)))
      );
      if (!existing?.id || existing.id === row.id) return row;
      // Pertahankan primary key profile cloud agar auth_uid unik tidak bentrok saat state lokal lama masih memakai id legacy.
      return {
        ...row,
        id: existing.id,
      };
    });
  } catch (error) {
    console.warn('Gagal rekonsiliasi id profile cloud, lanjutkan payload lokal', error);
    return profileRows;
  }
}

function shipToRow(ship = {}) {
  return {
    id: String(ship.id || ''),
    name: sanitizeText(ship.name || '', 100) || 'Kapal',
    type: sanitizeText(ship.type || '', 40),
    imo_number: sanitizeText(ship.imoNumber || '', 20),
    lat: sanitizeText(ship.lat || '', 40),
    lng: sanitizeText(ship.lng || '', 40),
    status: sanitizeText(ship.status || 'Non Operasional', 30),
    route: sanitizeText(ship.route || '', 120),
    route_loading: sanitizeText(ship.routeLoading || '', 120),
    route_discharge: sanitizeText(ship.routeDischarge || '', 120),
    cargo_type: sanitizeText(ship.cargoType || '', 80),
    cargo_amount: sanitizeText(ship.cargoAmount || '', 80),
    photo_url: sanitizeUrl(ship.photoUrl || '') || null,
    personnel: Array.isArray(ship.personnel) ? ship.personnel : [],
    personnel_next_month: Array.isArray(ship.personnelNextMonth) ? ship.personnelNextMonth : [],
    personnel_schedules: ship.personnelSchedules || {},
    custom_checkpoints: Array.isArray(ship.customCheckpoints) ? ship.customCheckpoints : [],
    documents: Array.isArray(ship.documents) ? ship.documents : [],
    sos_recipient_ship_ids: Array.isArray(ship.sosRecipientShipIds) ? ship.sosRecipientShipIds : [],
  };
}

function isRowLevelSecurityError(error) {
  return String(error?.message || '').toLowerCase().includes('row-level security');
}

function deriveNotificationTone(type = '') {
  if (type === 'sos' || type === 'sos_triggered' || type.startsWith('sos')) return 'critical';
  if (
    type === 'checkpoint_pending'
    || type === 'checkpoint_missed'
    || type === 'registration_pending'
    || type.startsWith('incident')
  ) {
    return 'warning';
  }
  if (type === 'welcome_to_ship' || type === 'registration_approved') return 'success';
  return 'info';
}

// Id stabil lintas-client untuk satu notifikasi logis. Pakai dedupeKey bila ada agar
// notifikasi yang sama yang dibuat oleh beberapa device (mis. shift_started dari banyak
// petugas, registration_pending dari banyak admin) bertabrakan di baris DB yang sama
// (ON CONFLICT DO NOTHING) alih-alih menghasilkan duplikat di inbox penerima.
export function getNotificationCloudBaseId(record = {}) {
  return sanitizeText(record?.dedupeKey || record?.id || '', 200);
}

// Mengubah satu notifikasi frontend (banyak penerima) menjadi banyak baris DB fan-out
// (satu baris per penerima). target_user_id terisi agar RLS notifications_read_target
// dan status baca per-user bekerja natural, sekaligus siap untuk push notification.
function notificationRecordToRows(record = {}) {
  const baseId = getNotificationCloudBaseId(record);
  if (!baseId) return [];
  const targetUserIds = Array.from(new Set(
    (Array.isArray(record.targetUserIds) ? record.targetUserIds : []).filter(Boolean),
  ));
  if (targetUserIds.length === 0) return [];
  const readSet = new Set((Array.isArray(record.readByUserIds) ? record.readByUserIds : []).filter(Boolean));
  const shipName = sanitizeText(record.shipName || '', 120) || null;
  const type = sanitizeText(record.type || 'general', 80) || 'general';
  const title = sanitizeText(record.title || 'Notifikasi Sistem', 200) || 'Notifikasi Sistem';
  const body = sanitizeText(record.message || '', 1500);
  const tone = deriveNotificationTone(type);
  const createdAt = record.createdAt || new Date().toISOString();
  const payload = { ...record, baseId };
  return targetUserIds.map((targetUserId) => ({
    id: `${baseId}::${targetUserId}`,
    target_user_id: targetUserId,
    target_role: null,
    ship_name: shipName,
    type,
    title,
    body,
    tone,
    read: readSet.has(targetUserId),
    payload,
    created_at: createdAt,
  }));
}

// Kebalikan dari fan-out: gabungkan kembali baris-baris DB menjadi satu record frontend
// dengan targetUserIds[] dan readByUserIds[]. Baris (kolom read) adalah sumber kebenaran
// status baca per penerima.
function reconstructNotificationsFromRows(rows = []) {
  const groups = new Map();
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const payload = row?.payload && typeof row.payload === 'object' ? row.payload : {};
    const baseId = payload.baseId
      || (typeof row?.id === 'string' && row.id.includes('::') ? row.id.split('::')[0] : row?.id);
    if (!baseId) return;
    let group = groups.get(baseId);
    if (!group) {
      const { targetUserIds: _ignoreTargets, readByUserIds: _ignoreReads, ...baseRest } = payload;
      group = {
        base: { ...baseRest, id: baseId },
        targetUserIds: new Set(),
        readByUserIds: new Set(),
        createdAt: payload.createdAt || row?.created_at || new Date().toISOString(),
      };
      groups.set(baseId, group);
    }
    if (row?.target_user_id) {
      group.targetUserIds.add(row.target_user_id);
      if (row.read) group.readByUserIds.add(row.target_user_id);
    }
  });
  return Array.from(groups.values()).map((group) => ({
    ...group.base,
    targetUserIds: Array.from(group.targetUserIds),
    readByUserIds: Array.from(group.readByUserIds),
    createdAt: group.createdAt,
  }));
}

// Persist notifikasi baru ke tabel (fan-out). ignoreDuplicates memastikan status baca
// baris yang sudah ada tidak pernah ditimpa — pembaruan status baca lewat
// markNotificationRecipientRead. Aman dipanggil idempoten oleh device mana pun.
export async function persistNotificationRecords(records = []) {
  if (!isCloudWriteEnabled) return;
  const rows = (Array.isArray(records) ? records : []).flatMap(notificationRecordToRows);
  if (rows.length === 0) return;
  const supabase = ensureSupabaseClient();
  const { error } = await supabase
    .from('notifications')
    .upsert(rows, { onConflict: 'id', ignoreDuplicates: true });
  if (error && !isRowLevelSecurityError(error)) throw error;
}

// Tandai notifikasi sebagai dibaca hanya untuk baris milik user ini (RLS update
// hanya mengizinkan target_user_id = current_profile_id()).
export async function markNotificationRecipientRead(baseIds = [], userId = '') {
  if (!isCloudWriteEnabled || !userId) return;
  const ids = (Array.isArray(baseIds) ? baseIds : [])
    .filter(Boolean)
    .map((baseId) => `${baseId}::${userId}`);
  if (ids.length === 0) return;
  const supabase = ensureSupabaseClient();
  const { error } = await supabase
    .from('notifications')
    .update({ read: true })
    .in('id', ids);
  if (error && !isRowLevelSecurityError(error)) throw error;
}

async function hydrateStateFromSql() {
  const supabase = ensureSupabaseClient();
  const [profiles, ships, reports, incidents, sosAlerts, notifications] = await Promise.all([
    supabase.from('profiles').select('*').order('name', { ascending: true }),
    supabase.from('ships').select('*').order('name', { ascending: true }),
    supabase.from('patrol_reports').select('*').limit(500),
    supabase.from('incidents').select('*').order('created_at', { ascending: false }).limit(200),
    supabase.from('sos_alerts').select('*').order('triggered_at', { ascending: false }).limit(20),
    supabase.from('notifications').select('*').order('created_at', { ascending: false }).limit(120),
  ]);

  // Domain inti — tanpa data ini state tidak bisa dibangun, jadi gagalkan hydrate
  // agar fallback cache dipakai. Laporan patroli termasuk inti supaya admin/petugas
  // tetap melihat laporan walau domain lain (incidents/sos/notifications) bermasalah.
  for (const result of [profiles, ships, reports]) {
    if (result.error) throw result.error;
  }
  // Domain sekunder — bila gagal (mis. RLS atau drift skema), jangan jatuhkan seluruh
  // sinkronisasi; cukup perlakukan sebagai kosong agar laporan patroli tetap tersinkron.
  for (const [label, result] of [['incidents', incidents], ['sos_alerts', sosAlerts], ['notifications', notifications]]) {
    if (result.error) {
      console.error(`Gagal memuat domain '${label}' saat hydrate cloud, lanjut tanpa data domain tersebut`, result.error);
      result.data = [];
    }
  }

  const checkpointsByShip = {};
  (reports.data || []).forEach((row) => {
    const shipId = row.ship_id || row.payload?.shipId;
    if (!shipId) return;
    checkpointsByShip[shipId] = checkpointsByShip[shipId] || [];
    checkpointsByShip[shipId].push(reportRowToCheckpoint(row));
  });

  const incidentMeta = {};
  const incidentsData = (incidents.data || []).map((row) => {
    const incident = incidentRowToState(row);
    incidentMeta[incident.id] = {
      progress: row.payload?.progress || [],
      documentation: row.payload?.documentation || [],
    };
    return incident;
  });

  const activeSosRow = (sosAlerts.data || []).find(row => row.status === 'active') || null;

  return {
    schemaVersion: CLOUD_STATE_SCHEMA_VERSION,
    clientUpdatedAt: Date.now(),
    state: {
      shipsData: (ships.data || []).map(shipToState),
      usersData: (profiles.data || []).map(profileToUser),
      checkpointsByShip,
      incidentsData,
      incidentMeta,
      historyEntries: [],
      notifications: reconstructNotificationsFromRows(notifications.data || []),
      activeSOSAlert: activeSosRow?.payload || null,
      sosHistory: (sosAlerts.data || []).filter(row => row.status !== 'active').map(row => row.payload || row),
      shiftStatusRecords: {},
    },
  };
}

export function subscribeToCloudAppState(callback, onError) {
  if (!isCloudSyncEnabled) return () => {};
  const supabase = ensureSupabaseClient();
  let disposed = false;

  const fetchState = async () => {
    const payload = await hydrateStateFromSql();
    await saveCacheSnapshot('cloud-state', payload);
    if (!disposed) callback(payload);
  };

  fetchState().catch(async (error) => {
    const cached = await loadCacheSnapshot('cloud-state').catch(() => null);
    if (cached && !disposed) callback(cached);
    onError?.(error);
  });

  const channel = supabase.channel('smartpatrol-sql-state')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'client_mutations' }, () => fetchState().catch(onError))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'patrol_reports' }, () => fetchState().catch(onError))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'incidents' }, () => fetchState().catch(onError))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sos_alerts' }, () => fetchState().catch(onError))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, () => fetchState().catch(onError))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'pending_registrations' }, () => fetchState().catch(onError))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications' }, () => fetchState().catch(onError))
    .subscribe();

  return () => {
    disposed = true;
    supabase.removeChannel(channel);
  };
}

export function subscribeToCloudSyncSignal(callback, onError) {
  if (!isCloudSyncEnabled) return () => {};
  const supabase = ensureSupabaseClient();

  const channel = supabase.channel('smartpatrol-sql-signal')
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'client_mutations',
    }, (payload) => {
      callback({
        schemaVersion: CLOUD_STATE_SCHEMA_VERSION,
        clientUpdatedAt: payload.new?.client_updated_at_ms || Date.now(),
        signal: payload.new?.payload || payload.new,
      });
    })
    .subscribe((status) => {
      if (status === 'CHANNEL_ERROR') onError?.(new Error('Realtime signal Supabase gagal.'));
    });

  return () => {
    supabase.removeChannel(channel);
  };
}

export async function fetchCloudAppState() {
  if (!isCloudSyncEnabled) return null;
  try {
    const payload = await hydrateStateFromSql();
    await saveCacheSnapshot('cloud-state', payload);
    return payload;
  } catch (error) {
    return loadCacheSnapshot('cloud-state').catch(() => {
      throw error;
    });
  }
}

async function writeStateToSql(state, options = {}) {
  if (!isCloudWriteEnabled || !state) return state;
  const supabase = ensureSupabaseClient();

  const profileRows = Array.isArray(state.usersData)
    ? state.usersData.map(userToProfileRow).filter(row => row.id && row.email)
    : [];
  const shipRows = Array.isArray(state.shipsData)
    ? state.shipsData.map(shipToRow).filter(row => row.id)
    : [];

  if (profileRows.length > 0) {
    const reconciledProfileRows = await reconcileProfileRowIds(supabase, profileRows);
    const { error } = await supabase.from('profiles').upsert(reconciledProfileRows, { onConflict: 'id' });
    if (error && !String(error.message || '').toLowerCase().includes('row-level security')) throw error;
  }
  if (shipRows.length > 0) {
    const { error } = await supabase.from('ships').upsert(shipRows, { onConflict: 'id' });
    if (error && !String(error.message || '').toLowerCase().includes('row-level security')) throw error;
  }

  await supabase.from('client_mutations').insert({
    client_event_id: `state-sync-${options.clientUpdatedAt || Date.now()}`,
    mutation_type: 'state-sync',
    client_updated_at_ms: Math.round(options.clientUpdatedAt || Date.now()),
    payload: {
      reason: options.reason || 'state-sync',
      users: profileRows.length,
      ships: shipRows.length,
    },
  }).throwOnError();

  return state;
}

registerOutboxHandler('app_state.sync', writeStateToSql);

export async function saveCloudAppState(state, options = {}) {
  const clientUpdatedAt = Number.isFinite(options.clientUpdatedAt) ? options.clientUpdatedAt : Date.now();
  const resolvedState = typeof options.mergeState === 'function'
    ? options.mergeState(null, state)
    : state;

  try {
    return await writeStateToSql(resolvedState, {
      ...options,
      clientUpdatedAt,
    });
  } catch (error) {
    await enqueueOutboxMutation({
      type: 'app_state.sync',
      payload: resolvedState,
    });
    return resolvedState;
  }
}

registerOutboxHandler('signal.publish', async (payload) => {
  const supabase = ensureSupabaseClient();
  await supabase.from('client_mutations').insert(payload).throwOnError();
});

export async function publishCloudSyncSignal(signal) {
  if (!isCloudWriteEnabled || !signal || typeof signal !== 'object') return null;
  const clientUpdatedAt = Math.round(Number.isFinite(signal.clientUpdatedAt) ? signal.clientUpdatedAt : Date.now());
  const payload = {
    client_event_id: signal.clientEventId || `signal-${clientUpdatedAt}-${Math.random().toString(36).slice(2, 8)}`,
    mutation_type: signal.reason || 'state-signal',
    client_updated_at_ms: clientUpdatedAt,
    payload: {
      ...signal,
      clientUpdatedAt,
    },
  };

  try {
    const supabase = ensureSupabaseClient();
    await supabase.from('client_mutations').insert(payload).throwOnError();
    return signal;
  } catch (error) {
    await enqueueOutboxMutation({
      type: 'signal.publish',
      payload,
    });
    return signal;
  }
}

export {
  CLOUD_STATE_SCHEMA_VERSION,
  isCloudSyncEnabled,
  isCloudWriteEnabled,
  uploadCloudDataUrlAsset,
};
