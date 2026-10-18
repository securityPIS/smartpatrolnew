/*
Tujuan: Store dummy (in-memory, tanpa database) untuk alur tindak lanjut temuan: assign PIC fungsi,
        update PIC fungsi, feedback/approve PIC Security, lalu SATU kali verifikasi petugas pelapor
        untuk seluruh temuan setelah semua tindak lanjut di-approve. PIC Security juga bisa menutup
        temuan sebagai UNSOLVE (tidak bisa diselesaikan) → kondisi saat unsolve menjadi foto acuan
        baru titik checkpoint dan tombol AMAN muncul lagi di titik tersebut.
Caller: Komponen di folder incidentFollowUp, IncidentDetailView, PatrolPage, PatrolNfcChoiceSheet.
Dependensi: React useSyncExternalStore, followUpPdf (nama file dokumen), shipCheckpoints (kunci nama).
Main Functions: useIncidentFollowUps, useIncidentVerification, getIncidentVerificationState,
                assignFollowUp, submitFollowUpUpdate, submitSecurityReview, returnFollowUpToPic,
                submitIncidentVerification, requestReverification, unsolveIncident,
                useCheckpointTemuanState, seedDemoFollowUps.
Side Effects: Hanya state modul di memori; hilang saat aplikasi di-restart (sengaja, versi tampilan).
*/

import { useSyncExternalStore } from 'react';
import { buildFollowUpPdfFileName } from './followUpPdf.js';
import { createCheckpointNameKey } from '../../utils/shipCheckpoints.js';

export const FOLLOW_UP_STATUS = {
  NEED_ACTION: 'need_action',
  NEED_REVIEW: 'need_review',
  APPROVED: 'approved',
  DONE: 'done',
  UNSOLVED: 'unsolved',
};

export const FOLLOW_UP_STATUS_META = {
  [FOLLOW_UP_STATUS.NEED_ACTION]: { label: 'Need Action', badgeClass: 'bg-amber-500/10 border-amber-500/60 text-amber-300' },
  [FOLLOW_UP_STATUS.NEED_REVIEW]: { label: 'Need Review', badgeClass: 'bg-sky-500/10 border-sky-500/60 text-sky-300' },
  [FOLLOW_UP_STATUS.APPROVED]: { label: 'Approved', badgeClass: 'bg-teal-500/10 border-teal-500/60 text-teal-300' },
  [FOLLOW_UP_STATUS.DONE]: { label: 'Done', badgeClass: 'bg-emerald-500/10 border-emerald-500/60 text-emerald-300' },
  [FOLLOW_UP_STATUS.UNSOLVED]: { label: 'Unsolve', badgeClass: 'bg-orange-500/10 border-orange-500/60 text-orange-300' },
};

export const SECURITY_ASSIGNEE_ID = 'security';
export const REPORTER_ROLE_ID = 'pelapor';

// Data dummy PIC fungsi terkait. Ganti dengan master data saat sudah tersambung ke database.
export const PIC_FUNCTION_OPTIONS = [
  { id: 'fleet', functionName: 'Fleet', personName: 'Budi Santoso' },
  { id: 'maritime-asset', functionName: 'Maritime Asset', personName: 'Rina Kartika' },
  { id: 'hsse', functionName: 'HSSE', personName: 'Dimas Pratama' },
  { id: 'operasi-kapal', functionName: 'Operasi Kapal', personName: 'Sari Wulandari' },
  { id: 'procurement', functionName: 'Procurement', personName: 'Agus Wijaya' },
];

export function getAssigneeMeta(assigneeId, securityName = 'PIC Security') {
  if (assigneeId === SECURITY_ASSIGNEE_ID) {
    return { id: SECURITY_ASSIGNEE_ID, functionName: 'Security', personName: securityName, label: `PIC Security (${securityName})` };
  }
  const option = PIC_FUNCTION_OPTIONS.find((item) => item.id === assigneeId);
  if (!option) return { id: assigneeId, functionName: assigneeId, personName: '-', label: assigneeId };
  return { ...option, label: `PIC ${option.functionName} (${option.personName})` };
}

const followUpsByIncident = new Map();
const closuresByIncident = new Map();
// Verifikasi tingkat temuan: { entries: [...], awaitingSecurityDecision: bool }.
const verificationsByIncident = new Map();
// Penutupan UNSOLVE oleh PIC Security: { id, at, actorName, comment, photoUrl, referencePhotoUrl }.
const unsolvesByIncident = new Map();
// Titik checkpoint asal temuan (kunci kapal|nama titik) agar halaman patroli tahu status temuannya.
const checkpointKeyByIncident = new Map();
// Foto acuan pengganti per titik setelah temuan Unsolve (dummy; nanti ke ships.customCheckpoints).
const referenceOverridesByCheckpoint = new Map();
const listeners = new Set();
const EMPTY_LIST = Object.freeze([]);

let storeVersion = 0;

function emitChange() {
  storeVersion += 1;
  checkpointTemuanCache.clear();
  listeners.forEach((listener) => listener());
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function createId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function updateIncidentFollowUps(incidentId, updater) {
  const key = String(incidentId || '');
  if (!key) return;
  const current = followUpsByIncident.get(key) || EMPTY_LIST;
  followUpsByIncident.set(key, updater(current));
  emitChange();
}

function updateFollowUp(incidentId, followUpId, updater) {
  updateIncidentFollowUps(incidentId, (items) => items.map((item) => (item.id === followUpId ? updater(item) : item)));
}

function createEntry(kind, { actorName, actorRole, comment = '', photoUrl = null, verdict = null, planConfirmed = false, at = new Date().toISOString() }) {
  return { id: createId('fu-entry'), kind, actorName, actorRole, comment, photoUrl, verdict, planConfirmed, at };
}

export function useIncidentFollowUps(incidentId) {
  const key = String(incidentId || '');
  return useSyncExternalStore(subscribe, () => followUpsByIncident.get(key) || EMPTY_LIST);
}

export function useIncidentUnsolve(incidentId) {
  const key = String(incidentId || '');
  return useSyncExternalStore(subscribe, () => unsolvesByIncident.get(key) || null);
}

// Kunci titik = kapal + nama titik, sama seperti pemetaan definisi titik di PatrolPage.
export function createCheckpointTemuanKey(shipKey, checkpointName) {
  const ship = String(shipKey || '').trim();
  const name = createCheckpointNameKey(checkpointName);
  return ship && name ? `${ship}|${name}` : '';
}

function getIncidentCheckpointKey(incident) {
  if (!incident?.isPatrol) return '';
  return createCheckpointTemuanKey(incident.shipId || incident.shipName, incident.location);
}

// Dipanggil setiap aksi tindak lanjut agar store tahu titik asal temuan.
export function rememberIncidentCheckpoint(incident) {
  const incidentKey = String(incident?.id || '');
  const checkpointKey = getIncidentCheckpointKey(incident);
  if (!incidentKey || !checkpointKey || checkpointKeyByIncident.get(incidentKey) === checkpointKey) return;
  checkpointKeyByIncident.set(incidentKey, checkpointKey);
  emitChange();
}

const checkpointTemuanCache = new Map();
const NO_CHECKPOINT_TEMUAN = Object.freeze({ hasOpenTemuan: false, openIncidentIds: EMPTY_LIST, override: null });

// Status temuan (versi dummy) untuk satu titik: masih ada temuan berjalan (tombol AMAN disembunyikan)
// dan foto acuan pengganti hasil Unsolve. Hanya temuan yang sudah masuk alur tindak lanjut dihitung.
export function getCheckpointTemuanState(checkpointKey) {
  if (!checkpointKey) return NO_CHECKPOINT_TEMUAN;
  const cached = checkpointTemuanCache.get(checkpointKey);
  if (cached) return cached;
  const openIncidentIds = [];
  checkpointKeyByIncident.forEach((key, incidentId) => {
    if (key !== checkpointKey) return;
    const hasFollowUps = (followUpsByIncident.get(incidentId) || EMPTY_LIST).length > 0;
    if (hasFollowUps && !closuresByIncident.has(incidentId) && !unsolvesByIncident.has(incidentId)) openIncidentIds.push(incidentId);
  });
  const override = referenceOverridesByCheckpoint.get(checkpointKey) || null;
  const state = openIncidentIds.length || override
    ? { hasOpenTemuan: openIncidentIds.length > 0, openIncidentIds, override }
    : NO_CHECKPOINT_TEMUAN;
  checkpointTemuanCache.set(checkpointKey, state);
  return state;
}

export function useCheckpointTemuanState(checkpointKey) {
  return useSyncExternalStore(subscribe, () => getCheckpointTemuanState(checkpointKey));
}

// Versi daftar: satu langganan untuk semua titik di halaman patroli (snapshot stabil per versi store).
export function useCheckpointTemuanVersion() {
  return useSyncExternalStore(subscribe, () => storeVersion);
}

export function useIncidentClosure(incidentId) {
  const key = String(incidentId || '');
  return useSyncExternalStore(subscribe, () => closuresByIncident.get(key) || null);
}

const EMPTY_VERIFICATION = Object.freeze({ entries: EMPTY_LIST, awaitingSecurityDecision: false });

export function useIncidentVerification(incidentId) {
  const key = String(incidentId || '');
  return useSyncExternalStore(subscribe, () => verificationsByIncident.get(key) || EMPTY_VERIFICATION);
}

function updateIncidentVerification(incidentId, updater) {
  const key = String(incidentId || '');
  if (!key) return;
  verificationsByIncident.set(key, updater(verificationsByIncident.get(key) || EMPTY_VERIFICATION));
  emitChange();
}

// Keputusan PIC Security apa pun (assign baru, kembalikan ke PIC, minta verifikasi ulang)
// menyelesaikan penolakan verifikasi sebelumnya.
function clearAwaitingSecurityDecision(incidentId) {
  const current = verificationsByIncident.get(String(incidentId || ''));
  if (!current?.awaitingSecurityDecision) return;
  updateIncidentVerification(incidentId, (record) => ({ ...record, awaitingSecurityDecision: false }));
}

export const INCIDENT_VERIFICATION_STATE = {
  NO_FOLLOW_UP: 'no_follow_up',
  UNSOLVED: 'unsolved',
  IN_PROGRESS: 'in_progress',
  READY: 'ready',
  AWAITING_SECURITY: 'awaiting_security',
  CLOSED: 'closed',
};

// READY = semua tindak lanjut sudah Approved PIC Security → petugas pelapor verifikasi 1x.
export function getIncidentVerificationState(followUps, verification, closure, unsolve = null) {
  if (unsolve) return INCIDENT_VERIFICATION_STATE.UNSOLVED;
  if (closure) return INCIDENT_VERIFICATION_STATE.CLOSED;
  if (!followUps?.length) return INCIDENT_VERIFICATION_STATE.NO_FOLLOW_UP;
  if (verification?.awaitingSecurityDecision) return INCIDENT_VERIFICATION_STATE.AWAITING_SECURITY;
  const allApproved = followUps.every((item) => item.status === FOLLOW_UP_STATUS.APPROVED || item.status === FOLLOW_UP_STATUS.DONE);
  return allApproved ? INCIDENT_VERIFICATION_STATE.READY : INCIDENT_VERIFICATION_STATE.IN_PROGRESS;
}

export function assignFollowUp(incidentId, { assigneeId, instruction, photoUrl, document, actorName }) {
  const at = new Date().toISOString();
  const followUp = {
    id: createId('fu'),
    assigneeId,
    instruction,
    photoUrl: photoUrl || null,
    document: document || null,
    status: FOLLOW_UP_STATUS.NEED_ACTION,
    createdAt: at,
    createdBy: actorName,
    entries: [createEntry('assign', { actorName, actorRole: 'PIC Security', comment: instruction, photoUrl, at })],
  };
  updateIncidentFollowUps(incidentId, (items) => [...items, followUp]);
  clearAwaitingSecurityDecision(incidentId);
  return followUp;
}

export function submitFollowUpUpdate(incidentId, followUpId, { comment, photoUrl, actorName, actorRole }) {
  updateFollowUp(incidentId, followUpId, (item) => ({
    ...item,
    status: FOLLOW_UP_STATUS.NEED_REVIEW,
    entries: [...item.entries, createEntry('update', { actorName, actorRole, comment, photoUrl })],
  }));
}

// approved + finalApproval=false → PIC Security hanya mengonfirmasi rencana tindakan PIC fungsi;
// pekerjaan belum selesai sehingga status kembali Need Action. finalApproval=true → Approved.
export function submitSecurityReview(incidentId, followUpId, { approved, finalApproval = true, comment, actorName }) {
  const planConfirmed = approved && !finalApproval;
  const nextStatus = approved && finalApproval ? FOLLOW_UP_STATUS.APPROVED : FOLLOW_UP_STATUS.NEED_ACTION;
  updateFollowUp(incidentId, followUpId, (item) => ({
    ...item,
    status: nextStatus,
    entries: [...item.entries, createEntry('review', { actorName, actorRole: 'PIC Security', comment, verdict: approved ? 'approved' : 'rejected', planConfirmed })],
  }));
}

// PIC Security mengembalikan tindak lanjut yang sudah Approved ke PIC fungsi untuk dikerjakan ulang
// (mis. setelah verifikasi petugas ditolak).
export function returnFollowUpToPic(incidentId, followUpId, { comment, actorName }) {
  updateFollowUp(incidentId, followUpId, (item) => ({
    ...item,
    status: FOLLOW_UP_STATUS.NEED_ACTION,
    entries: [...item.entries, createEntry('return', { actorName, actorRole: 'PIC Security', comment, verdict: 'rejected' })],
  }));
  clearAwaitingSecurityDecision(incidentId);
}

// Verifikasi 1x oleh petugas pelapor untuk seluruh temuan. Sesuai → semua tindak lanjut Done dan
// temuan ditutup. Belum sesuai → temuan kembali ke PIC Security untuk diputuskan.
// Mengembalikan { ok, closed }.
export function submitIncidentVerification(incidentId, { approved, comment, photoUrl, actorName }) {
  const key = String(incidentId || '');
  const followUps = followUpsByIncident.get(key) || EMPTY_LIST;
  const state = getIncidentVerificationState(followUps, verificationsByIncident.get(key), closuresByIncident.get(key), unsolvesByIncident.get(key));
  if (state !== INCIDENT_VERIFICATION_STATE.READY) return { ok: false, closed: false };

  const entry = createEntry('verify', { actorName, actorRole: 'Petugas Pelapor', comment, photoUrl, verdict: approved ? 'approved' : 'rejected' });
  updateIncidentVerification(incidentId, (record) => ({
    entries: [...record.entries, entry],
    awaitingSecurityDecision: !approved,
  }));
  if (!approved) return { ok: true, closed: false };

  updateIncidentFollowUps(incidentId, (items) => items.map((item) => ({ ...item, status: FOLLOW_UP_STATUS.DONE })));
  closuresByIncident.set(key, { id: createId('fu-close'), at: entry.at, actorName, comment, photoUrl });
  emitChange();
  return { ok: true, closed: true };
}

// PIC Security menilai tindak lanjut yang ada sudah cukup → minta petugas memverifikasi ulang.
export function requestReverification(incidentId, { comment, actorName }) {
  updateIncidentVerification(incidentId, (record) => ({
    entries: [...record.entries, createEntry('reverify', { actorName, actorRole: 'PIC Security', comment })],
    awaitingSecurityDecision: false,
  }));
}

// Foto yang menjadi acuan baru titik: evidence unsolve bila ada, selain itu foto temuan.
export function getUnsolveReferencePhotoUrl(incident, evidencePhotoUrl) {
  return evidencePhotoUrl || incident?.photoUrl || null;
}

// PIC Security menutup temuan sebagai UNSOLVE: semua tindak lanjut ditutup (status Unsolve), catatan
// wajib, evidence opsional. Kondisi saat unsolve menjadi foto acuan baru titik checkpoint asal
// temuan sehingga patroli berikutnya bisa melapor AMAN terhadap kondisi tersebut.
// Mengembalikan { ok, referenceUpdated }.
export function unsolveIncident(incident, { comment, photoUrl = null, actorName }) {
  const key = String(incident?.id || '');
  const note = String(comment || '').trim();
  if (!key || !note || closuresByIncident.has(key) || unsolvesByIncident.has(key)) return { ok: false, referenceUpdated: false };

  const at = new Date().toISOString();
  const referencePhotoUrl = getUnsolveReferencePhotoUrl(incident, photoUrl);
  const checkpointKey = getIncidentCheckpointKey(incident);
  if (checkpointKey) checkpointKeyByIncident.set(key, checkpointKey);

  updateIncidentFollowUps(key, (items) => items.map((item) => (
    item.status === FOLLOW_UP_STATUS.DONE
      ? item
      : { ...item, status: FOLLOW_UP_STATUS.UNSOLVED, entries: [...item.entries, createEntry('unsolve', { actorName, actorRole: 'PIC Security', comment: note, at })] }
  )));
  unsolvesByIncident.set(key, { id: createId('fu-unsolve'), at, actorName, comment: note, photoUrl: photoUrl || null, referencePhotoUrl, checkpointKey });
  const referenceUpdated = Boolean(checkpointKey && referencePhotoUrl);
  if (referenceUpdated) {
    referenceOverridesByCheckpoint.set(checkpointKey, {
      referencePhotoUrl,
      updatedAt: at,
      incidentId: key,
      note,
      actorName,
    });
  }
  emitChange();
  return { ok: true, referenceUpdated };
}

// Contoh data agar keempat status bisa langsung dilihat tanpa menjalankan alur dari awal.
export function seedDemoFollowUps(incident, { securityName }) {
  rememberIncidentCheckpoint(incident);
  const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
  const entry = (kind, minutes, payload) => ({ ...createEntry(kind, payload), at: minutesAgo(minutes) });
  const fleet = getAssigneeMeta('fleet');
  const asset = getAssigneeMeta('maritime-asset');

  const demo = [
    {
      assigneeId: 'fleet', status: FOLLOW_UP_STATUS.APPROVED, createdAt: minutesAgo(600), instruction: 'Ganti lampu navigasi yang mati di anjungan dan laporkan nomor work order.',
      entries: [
        entry('assign', 600, { actorName: securityName, actorRole: 'PIC Security', comment: 'Ganti lampu navigasi yang mati di anjungan dan laporkan nomor work order.' }),
        entry('update', 420, { actorName: fleet.personName, actorRole: 'PIC Fleet', comment: 'Lampu sudah diganti, WO-2026-1187.' }),
        entry('review', 400, { actorName: securityName, actorRole: 'PIC Security', comment: 'Sesuai, pekerjaan selesai.', verdict: 'approved' }),
      ],
    },
    {
      assigneeId: 'maritime-asset', status: FOLLOW_UP_STATUS.NEED_REVIEW, createdAt: minutesAgo(240), instruction: 'Periksa kondisi pagar pengaman dek dan jadwalkan perbaikan las.',
      entries: [
        entry('assign', 240, { actorName: securityName, actorRole: 'PIC Security', comment: 'Periksa kondisi pagar pengaman dek dan jadwalkan perbaikan las.' }),
        entry('update', 60, { actorName: asset.personName, actorRole: 'PIC Maritime Asset', comment: 'Perbaikan las dijadwalkan besok 08.00 oleh vendor.' }),
      ],
    },
    {
      assigneeId: 'hsse', status: FOLLOW_UP_STATUS.NEED_ACTION, createdAt: minutesAgo(30), instruction: 'Pasang rambu peringatan sementara di area temuan.',
      entries: [
        entry('assign', 30, { actorName: securityName, actorRole: 'PIC Security', comment: 'Pasang rambu peringatan sementara di area temuan.' }),
      ],
    },
  ].map((item, index) => ({
    ...item,
    id: createId('fu'),
    photoUrl: null,
    document: { fileName: buildFollowUpPdfFileName(incident, index + 1), generatedAt: item.createdAt },
    createdBy: securityName,
  }));

  updateIncidentFollowUps(incident?.id, (items) => [...demo, ...items]);
}

const ENTRY_LOG_LABEL = {
  assign: 'menugaskan tindak lanjut',
  update: 'mengirim update tindak lanjut',
  review: 'memberi feedback',
  return: 'mengembalikan tindak lanjut ke PIC',
  unsolve: 'menutup tindak lanjut sebagai UNSOLVE',
};

// Bentuk log yang siap digabung dengan riwayat update temuan.
export function buildFollowUpLogItems(followUps, securityName, closure = null, verification = null, unsolve = null) {
  const logs = [];
  if (unsolve) {
    logs.push({
      id: unsolve.id,
      isFollowUpLog: true,
      createdAt: unsolve.at,
      author: unsolve.actorName,
      tag: 'Temuan Unsolve',
      headline: `PIC Security menutup temuan sebagai UNSOLVE${unsolve.referencePhotoUrl && unsolve.checkpointKey ? ' — foto kondisi awal titik diperbarui' : ''}`,
      comment: unsolve.comment,
      photoUrl: unsolve.photoUrl,
    });
  }
  if (closure) {
    logs.push({
      id: closure.id,
      isFollowUpLog: true,
      createdAt: closure.at,
      author: closure.actorName,
      tag: 'Temuan Ditutup',
      headline: 'Ditutup — semua tindak lanjut di-approve PIC Security & terverifikasi petugas pelapor',
      comment: '',
      photoUrl: null,
    });
  }
  (verification?.entries || []).forEach((entry) => {
    logs.push({
      id: entry.id,
      isFollowUpLog: true,
      createdAt: entry.at,
      author: entry.actorName,
      tag: 'Verifikasi Temuan',
      headline: entry.kind === 'reverify'
        ? 'PIC Security meminta verifikasi ulang ke petugas pelapor'
        : `Petugas Pelapor memverifikasi temuan${entry.verdict === 'approved' ? ' — SESUAI' : ' — BELUM SESUAI, dikembalikan ke PIC Security'}`,
      comment: entry.comment,
      photoUrl: entry.photoUrl,
    });
  });
  followUps.forEach((followUp, index) => {
    const assignee = getAssigneeMeta(followUp.assigneeId, securityName);
    followUp.entries.forEach((entry) => {
      let verdictText = '';
      if (entry.kind === 'review') {
        if (entry.verdict !== 'approved') verdictText = ' — BELUM SESUAI, dikembalikan ke PIC';
        else verdictText = entry.planConfirmed ? ' — SESUAI, rencana dikonfirmasi; menunggu penyelesaian dari PIC' : ' — APPROVED';
      }
      const target = entry.kind === 'assign' ? ` ke ${assignee.label}` : '';
      logs.push({
        id: entry.id,
        isFollowUpLog: true,
        createdAt: entry.at,
        author: entry.actorName,
        tag: `Tindak Lanjut #${index + 1}`,
        headline: `${entry.actorRole} ${ENTRY_LOG_LABEL[entry.kind] || entry.kind}${target}${verdictText}`,
        comment: entry.comment,
        photoUrl: entry.photoUrl,
      });
    });
  });
  return logs;
}

export function formatFollowUpTimestamp(isoValue) {
  const date = new Date(isoValue);
  if (Number.isNaN(date.getTime())) return { date: '-', time: '-' };
  return {
    date: date.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Jakarta' }),
    time: date.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' }),
  };
}
