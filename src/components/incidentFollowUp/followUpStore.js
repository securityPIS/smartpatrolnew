/*
Tujuan: Store dummy (in-memory, tanpa database) untuk alur tindak lanjut temuan: assign PIC fungsi,
        update PIC fungsi, feedback PIC Security, dan verifikasi petugas pelapor.
Caller: Komponen di folder incidentFollowUp dan IncidentDetailView.
Dependensi: React useSyncExternalStore, followUpPdf (nama file dokumen).
Main Functions: useIncidentFollowUps, assignFollowUp, submitFollowUpUpdate, submitSecurityReview,
                submitReporterVerification, seedDemoFollowUps.
Side Effects: Hanya state modul di memori; hilang saat aplikasi di-restart (sengaja, versi tampilan).
*/

import { useSyncExternalStore } from 'react';
import { buildFollowUpPdfFileName } from './followUpPdf';

export const FOLLOW_UP_STATUS = {
  NEED_ACTION: 'need_action',
  NEED_REVIEW: 'need_review',
  NEED_VERIFICATION: 'need_verification',
  DONE: 'done',
};

export const FOLLOW_UP_STATUS_META = {
  [FOLLOW_UP_STATUS.NEED_ACTION]: { label: 'Need Action', badgeClass: 'bg-amber-500/10 border-amber-500/60 text-amber-300' },
  [FOLLOW_UP_STATUS.NEED_REVIEW]: { label: 'Need Review', badgeClass: 'bg-sky-500/10 border-sky-500/60 text-sky-300' },
  [FOLLOW_UP_STATUS.NEED_VERIFICATION]: { label: 'Need Verification', badgeClass: 'bg-fuchsia-500/10 border-fuchsia-500/60 text-fuchsia-300' },
  [FOLLOW_UP_STATUS.DONE]: { label: 'Done', badgeClass: 'bg-emerald-500/10 border-emerald-500/60 text-emerald-300' },
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
const listeners = new Set();
const EMPTY_LIST = Object.freeze([]);

function emitChange() {
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

function createEntry(kind, { actorName, actorRole, comment = '', photoUrl = null, verdict = null, at = new Date().toISOString() }) {
  return { id: createId('fu-entry'), kind, actorName, actorRole, comment, photoUrl, verdict, at };
}

export function useIncidentFollowUps(incidentId) {
  const key = String(incidentId || '');
  return useSyncExternalStore(subscribe, () => followUpsByIncident.get(key) || EMPTY_LIST);
}

export function useIncidentClosure(incidentId) {
  const key = String(incidentId || '');
  return useSyncExternalStore(subscribe, () => closuresByIncident.get(key) || null);
}

// Petugas pelapor menutup temuan: semua tindak lanjut yang menunggu verifikasi ikut terverifikasi (Done).
export function closeIncidentWithVerification(incidentId, { comment, photoUrl, actorName }) {
  const key = String(incidentId || '');
  if (!key) return;
  const at = new Date().toISOString();
  const items = followUpsByIncident.get(key) || EMPTY_LIST;
  followUpsByIncident.set(key, items.map((item) => (
    item.status === FOLLOW_UP_STATUS.NEED_VERIFICATION
      ? {
        ...item,
        status: FOLLOW_UP_STATUS.DONE,
        entries: [...item.entries, createEntry('verify', { actorName, actorRole: 'Petugas Pelapor', comment, photoUrl, verdict: 'approved', at })],
      }
      : item
  )));
  closuresByIncident.set(key, { id: createId('fu-close'), at, actorName, comment, photoUrl });
  emitChange();
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
  return followUp;
}

export function submitFollowUpUpdate(incidentId, followUpId, { comment, photoUrl, actorName, actorRole }) {
  updateFollowUp(incidentId, followUpId, (item) => ({
    ...item,
    status: FOLLOW_UP_STATUS.NEED_REVIEW,
    entries: [...item.entries, createEntry('update', { actorName, actorRole, comment, photoUrl })],
  }));
}

export function submitSecurityReview(incidentId, followUpId, { approved, comment, actorName }) {
  updateFollowUp(incidentId, followUpId, (item) => ({
    ...item,
    status: approved ? FOLLOW_UP_STATUS.NEED_VERIFICATION : FOLLOW_UP_STATUS.NEED_ACTION,
    entries: [...item.entries, createEntry('review', { actorName, actorRole: 'PIC Security', comment, verdict: approved ? 'approved' : 'rejected' })],
  }));
}

export function submitReporterVerification(incidentId, followUpId, { approved, comment, photoUrl, actorName }) {
  updateFollowUp(incidentId, followUpId, (item) => ({
    ...item,
    status: approved ? FOLLOW_UP_STATUS.DONE : FOLLOW_UP_STATUS.NEED_ACTION,
    entries: [...item.entries, createEntry('verify', { actorName, actorRole: 'Petugas Pelapor', comment, photoUrl, verdict: approved ? 'approved' : 'rejected' })],
  }));
}

// Contoh data agar keempat status bisa langsung dilihat tanpa menjalankan alur dari awal.
export function seedDemoFollowUps(incident, { securityName, reporterName }) {
  const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
  const entry = (kind, minutes, payload) => ({ ...createEntry(kind, payload), at: minutesAgo(minutes) });
  const fleet = getAssigneeMeta('fleet');
  const asset = getAssigneeMeta('maritime-asset');

  const demo = [
    {
      assigneeId: 'fleet', status: FOLLOW_UP_STATUS.DONE, createdAt: minutesAgo(600), instruction: 'Ganti lampu navigasi yang mati di anjungan dan laporkan nomor work order.',
      entries: [
        entry('assign', 600, { actorName: securityName, actorRole: 'PIC Security', comment: 'Ganti lampu navigasi yang mati di anjungan dan laporkan nomor work order.' }),
        entry('update', 420, { actorName: fleet.personName, actorRole: 'PIC Fleet', comment: 'Lampu sudah diganti, WO-2026-1187.' }),
        entry('review', 400, { actorName: securityName, actorRole: 'PIC Security', comment: 'Sesuai, mohon diverifikasi di lapangan.', verdict: 'approved' }),
        entry('verify', 300, { actorName: reporterName, actorRole: 'Petugas Pelapor', comment: 'Sudah dicek saat patroli, lampu menyala normal.', verdict: 'approved' }),
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
  verify: 'mengirim verifikasi',
};

// Bentuk log yang siap digabung dengan riwayat update temuan.
export function buildFollowUpLogItems(followUps, securityName, closure = null) {
  const logs = [];
  if (closure) {
    logs.push({
      id: closure.id,
      isFollowUpLog: true,
      createdAt: closure.at,
      author: closure.actorName,
      tag: 'Temuan Ditutup',
      headline: 'Petugas Pelapor menutup temuan setelah verifikasi',
      comment: closure.comment,
      photoUrl: closure.photoUrl,
    });
  }
  followUps.forEach((followUp, index) => {
    const assignee = getAssigneeMeta(followUp.assigneeId, securityName);
    followUp.entries.forEach((entry) => {
      let verdictText = '';
      if (entry.kind === 'review') verdictText = entry.verdict === 'approved' ? ' — SESUAI, diteruskan ke verifikasi pelapor' : ' — BELUM SESUAI, dikembalikan ke PIC';
      if (entry.kind === 'verify') verdictText = entry.verdict === 'approved' ? ' — TERVERIFIKASI (Done)' : ' — DITOLAK, dikembalikan ke PIC';
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
