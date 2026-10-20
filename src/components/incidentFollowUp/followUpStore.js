/*
Tujuan: Store dummy (in-memory, tanpa database) untuk alur tindak lanjut temuan: assign PIC fungsi,
        update PIC fungsi, feedback/approve PIC Security. Setelah SEMUA tindak lanjut di-approve,
        PIC Security memilih UNSOLVE (temuan tidak bisa diselesaikan → kondisi saat unsolve jadi foto
        acuan baru titik) atau NEED VERIFICATION (minta petugas security memverifikasi, atau PIC
        Security memverifikasi sendiri). Verifikasi sesuai → temuan Closed.
Caller: Komponen di folder incidentFollowUp, IncidentDetailView, PatrolPage.
Dependensi: React useSyncExternalStore, followUpPdf (nama file dokumen), shipCheckpoints (kunci nama).
Main Functions: useIncidentFollowUps, useIncidentVerification, getIncidentVerificationState,
                assignFollowUp, submitFollowUpUpdate, submitSecurityReview, returnFollowUpToPic,
                requestIncidentVerification, submitIncidentVerification, requestReverification, unsolveIncident,
                isPatrolTemuanOpen, getCheckpointReferenceOverride, seedDemoFollowUps.
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
// Foto acuan pengganti per titik setelah temuan Unsolve (dummy; nanti ke ships.customCheckpoints).
const referenceOverridesByCheckpoint = new Map();
const listeners = new Set();
const EMPTY_LIST = Object.freeze([]);

let storeVersion = 0;

function emitChange() {
  storeVersion += 1;
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

export function getIncidentCheckpointKey(incident) {
  if (!incident?.isPatrol) return '';
  return createCheckpointTemuanKey(incident.shipId || incident.shipName, incident.location);
}

// Temuan patroli dianggap masih OPEN di titiknya selama belum Closed (status meta asli, atau
// verifikasi petugas di store dummy) dan belum ditetapkan Unsolve oleh PIC Security.
export function isPatrolTemuanOpen(incident, metaStatus) {
  if (!incident?.isPatrol || incident.isSOS || metaStatus === 'closed') return false;
  const key = String(incident.id || '');
  return !closuresByIncident.has(key) && !unsolvesByIncident.has(key);
}

// Foto acuan pengganti hasil Unsolve untuk satu titik (null bila tidak ada).
export function getCheckpointReferenceOverride(checkpointKey) {
  return (checkpointKey && referenceOverridesByCheckpoint.get(checkpointKey)) || null;
}

// Satu langganan untuk halaman patroli: berubah setiap kali store berubah (Closed/Unsolve/override).
export function useFollowUpStoreVersion() {
  return useSyncExternalStore(subscribe, () => storeVersion);
}

export function useIncidentClosure(incidentId) {
  const key = String(incidentId || '');
  return useSyncExternalStore(subscribe, () => closuresByIncident.get(key) || null);
}

// verificationRequested: PIC Security sudah memilih Need Verification ke petugas security.
const EMPTY_VERIFICATION = Object.freeze({ entries: EMPTY_LIST, awaitingSecurityDecision: false, verificationRequested: false });

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

// Tindak lanjut dibuka lagi (assign baru / kembalikan ke PIC) → penolakan verifikasi selesai dan
// permintaan verifikasi lama batal; setelah semua Approved lagi PIC Security memutuskan ulang.
function resetVerificationDecision(incidentId) {
  const current = verificationsByIncident.get(String(incidentId || ''));
  if (!current?.awaitingSecurityDecision && !current?.verificationRequested) return;
  updateIncidentVerification(incidentId, (record) => ({ ...record, awaitingSecurityDecision: false, verificationRequested: false }));
}

export const INCIDENT_VERIFICATION_STATE = {
  NO_FOLLOW_UP: 'no_follow_up',
  UNSOLVED: 'unsolved',
  IN_PROGRESS: 'in_progress',
  // Semua tindak lanjut Approved → PIC Security memilih Unsolve atau Need Verification.
  READY: 'ready',
  // Need Verification: menunggu verifikasi petugas security (PIC Security tetap bisa verifikasi sendiri).
  AWAITING_VERIFICATION: 'awaiting_verification',
  AWAITING_SECURITY: 'awaiting_security',
  CLOSED: 'closed',
};

export function getIncidentVerificationState(followUps, verification, closure, unsolve = null) {
  if (unsolve) return INCIDENT_VERIFICATION_STATE.UNSOLVED;
  if (closure) return INCIDENT_VERIFICATION_STATE.CLOSED;
  if (!followUps?.length) return INCIDENT_VERIFICATION_STATE.NO_FOLLOW_UP;
  if (verification?.awaitingSecurityDecision) return INCIDENT_VERIFICATION_STATE.AWAITING_SECURITY;
  const allApproved = followUps.every((item) => item.status === FOLLOW_UP_STATUS.APPROVED || item.status === FOLLOW_UP_STATUS.DONE);
  if (!allApproved) return INCIDENT_VERIFICATION_STATE.IN_PROGRESS;
  return verification?.verificationRequested ? INCIDENT_VERIFICATION_STATE.AWAITING_VERIFICATION : INCIDENT_VERIFICATION_STATE.READY;
}

function getStoredIncidentState(key) {
  return getIncidentVerificationState(
    followUpsByIncident.get(key) || EMPTY_LIST,
    verificationsByIncident.get(key),
    closuresByIncident.get(key),
    unsolvesByIncident.get(key),
  );
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
  resetVerificationDecision(incidentId);
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
  resetVerificationDecision(incidentId);
}

// PIC Security memilih NEED VERIFICATION setelah semua tindak lanjut Approved → notifikasi ke petugas
// security untuk memverifikasi temuan. Mengembalikan true bila berhasil.
export function requestIncidentVerification(incidentId, { comment = '', actorName }) {
  const key = String(incidentId || '');
  if (getStoredIncidentState(key) !== INCIDENT_VERIFICATION_STATE.READY) return false;
  updateIncidentVerification(key, (record) => ({
    ...record,
    entries: [...record.entries, createEntry('request', { actorName, actorRole: 'PIC Security', comment })],
    verificationRequested: true,
  }));
  return true;
}

// Verifikasi 1x untuk seluruh temuan, oleh petugas security (setelah Need Verification) atau langsung
// oleh PIC Security (bySecurity). Sesuai → semua tindak lanjut Done dan temuan Closed. Belum sesuai →
// temuan kembali ke PIC Security untuk diputuskan. Mengembalikan { ok, closed }.
export function submitIncidentVerification(incidentId, { approved, comment, photoUrl, actorName, bySecurity = false }) {
  const key = String(incidentId || '');
  const state = getStoredIncidentState(key);
  const canVerify = state === INCIDENT_VERIFICATION_STATE.AWAITING_VERIFICATION
    || (bySecurity && state === INCIDENT_VERIFICATION_STATE.READY);
  if (!canVerify) return { ok: false, closed: false };

  const actorRole = bySecurity ? 'PIC Security' : 'Petugas Security';
  const entry = createEntry('verify', { actorName, actorRole, comment, photoUrl, verdict: approved ? 'approved' : 'rejected' });
  updateIncidentVerification(incidentId, (record) => ({
    entries: [...record.entries, entry],
    awaitingSecurityDecision: !approved,
    verificationRequested: false,
  }));
  if (!approved) return { ok: true, closed: false };

  updateIncidentFollowUps(incidentId, (items) => items.map((item) => ({ ...item, status: FOLLOW_UP_STATUS.DONE })));
  closuresByIncident.set(key, { id: createId('fu-close'), at: entry.at, actorName, actorRole, comment, photoUrl });
  emitChange();
  return { ok: true, closed: true };
}

// PIC Security menilai tindak lanjut yang ada sudah cukup → minta petugas memverifikasi ulang.
export function requestReverification(incidentId, { comment, actorName }) {
  updateIncidentVerification(incidentId, (record) => ({
    entries: [...record.entries, createEntry('reverify', { actorName, actorRole: 'PIC Security', comment })],
    awaitingSecurityDecision: false,
    verificationRequested: true,
  }));
}

// Foto yang menjadi acuan baru titik: evidence unsolve bila ada, selain itu foto temuan.
export function getUnsolveReferencePhotoUrl(incident, evidencePhotoUrl) {
  return evidencePhotoUrl || incident?.photoUrl || null;
}

// PIC Security menutup temuan sebagai UNSOLVE setelah semua tindak lanjut Approved (keputusan awal,
// atau setelah verifikasi belum sesuai): semua tindak lanjut ditutup (status Unsolve), catatan
// wajib, evidence opsional. Kondisi saat unsolve menjadi foto acuan baru titik checkpoint asal
// temuan sehingga patroli berikutnya bisa melapor AMAN terhadap kondisi tersebut.
// Mengembalikan { ok, referenceUpdated }.
export function unsolveIncident(incident, { comment, photoUrl = null, actorName }) {
  const key = String(incident?.id || '');
  const note = String(comment || '').trim();
  const state = getStoredIncidentState(key);
  const canUnsolve = state === INCIDENT_VERIFICATION_STATE.READY || state === INCIDENT_VERIFICATION_STATE.AWAITING_SECURITY;
  if (!key || !note || !canUnsolve) return { ok: false, referenceUpdated: false };

  const at = new Date().toISOString();
  const referencePhotoUrl = getUnsolveReferencePhotoUrl(incident, photoUrl);
  const checkpointKey = getIncidentCheckpointKey(incident);

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

const VERIFICATION_LOG_HEADLINE = {
  request: 'PIC Security memilih NEED VERIFICATION — notifikasi verifikasi dikirim ke petugas security',
  reverify: 'PIC Security meminta verifikasi ulang ke petugas security',
};

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
      headline: `Ditutup — semua tindak lanjut di-approve PIC Security & terverifikasi ${closure.actorRole === 'PIC Security' ? 'langsung oleh PIC Security' : 'petugas security'}`,
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
      headline: VERIFICATION_LOG_HEADLINE[entry.kind]
        || `${entry.actorRole} memverifikasi temuan${entry.verdict === 'approved' ? ' — SESUAI' : ' — BELUM SESUAI, dikembalikan ke PIC Security'}`,
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
