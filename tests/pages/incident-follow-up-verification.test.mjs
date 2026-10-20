/*
Tujuan: Mencegah regresi alur tindak lanjut temuan: semua tindak lanjut harus di-approve PIC Security,
        lalu PIC Security memilih UNSOLVE atau NEED VERIFICATION (minta petugas security / verifikasi
        sendiri); sesuai → Closed, belum sesuai → kembali ke keputusan PIC Security.
Caller: Node test runner.
Dependensi: src/components/incidentFollowUp/followUpStore.js (store in-memory).
Side Effects: Tidak ada di luar state modul store.
*/

import test from 'node:test';
import assert from 'node:assert/strict';

const store = await import('../../src/components/incidentFollowUp/followUpStore.js');
const {
  FOLLOW_UP_STATUS: S, INCIDENT_VERIFICATION_STATE: V, assignFollowUp, submitFollowUpUpdate, submitSecurityReview,
  requestIncidentVerification, submitIncidentVerification, returnFollowUpToPic, requestReverification,
  getIncidentVerificationState, unsolveIncident, isPatrolTemuanOpen, getCheckpointReferenceOverride,
  getIncidentCheckpointKey, createCheckpointTemuanKey,
} = store;

const VERIFY = { approved: true, comment: 'ok', photoUrl: 'x', actorName: 'Petugas' };

function approveFlow(incidentId, followUpId) {
  submitFollowUpUpdate(incidentId, followUpId, { comment: 'selesai', actorName: 'PIC', actorRole: 'PIC Fleet' });
  submitSecurityReview(incidentId, followUpId, { approved: true, finalApproval: true, comment: '', actorName: 'Sec' });
}

test('Need Verification & Unsolve hanya setelah semua tindak lanjut Approved; petugas verifikasi setelah diminta', () => {
  const incidentId = 'inc-1';
  const a = assignFollowUp(incidentId, { assigneeId: 'fleet', instruction: 'A', actorName: 'Sec' });
  const b = assignFollowUp(incidentId, { assigneeId: 'hsse', instruction: 'B', actorName: 'Sec' });
  approveFlow(incidentId, a.id);
  assert.equal(requestIncidentVerification(incidentId, { actorName: 'Sec' }), false);
  assert.equal(unsolveIncident({ id: incidentId }, { comment: 'x', actorName: 'Sec' }).ok, false);

  // Konfirmasi rencana tidak dihitung approved.
  submitFollowUpUpdate(incidentId, b.id, { comment: 'rencana', actorName: 'PIC', actorRole: 'PIC HSSE' });
  submitSecurityReview(incidentId, b.id, { approved: true, finalApproval: false, comment: '', actorName: 'Sec' });
  assert.equal(requestIncidentVerification(incidentId, { actorName: 'Sec' }), false);

  approveFlow(incidentId, b.id);
  // Semua Approved → petugas belum bisa verifikasi sebelum PIC Security memilih Need Verification.
  assert.equal(submitIncidentVerification(incidentId, VERIFY).ok, false);
  assert.equal(requestIncidentVerification(incidentId, { comment: 'cek ya', actorName: 'Sec' }), true);
  assert.deepEqual(submitIncidentVerification(incidentId, VERIFY), { ok: true, closed: true });
  // Sudah closed → tidak bisa verifikasi lagi.
  assert.equal(submitIncidentVerification(incidentId, VERIFY).ok, false);
});

test('PIC Security bisa verifikasi sendiri tanpa meminta petugas', () => {
  const incidentId = 'inc-self';
  const a = assignFollowUp(incidentId, { assigneeId: 'fleet', instruction: 'A', actorName: 'Sec' });
  approveFlow(incidentId, a.id);
  assert.deepEqual(submitIncidentVerification(incidentId, { ...VERIFY, actorName: 'Sec', bySecurity: true }), { ok: true, closed: true });
});

test('belum sesuai → menunggu keputusan PIC Security, lalu bisa diverifikasi ulang atau Unsolve', () => {
  const incidentId = 'inc-2';
  const a = assignFollowUp(incidentId, { assigneeId: 'fleet', instruction: 'A', actorName: 'Sec' });
  approveFlow(incidentId, a.id);
  requestIncidentVerification(incidentId, { actorName: 'Sec' });
  assert.deepEqual(submitIncidentVerification(incidentId, { ...VERIFY, approved: false, comment: 'masih bocor' }), { ok: true, closed: false });
  // Selama menunggu PIC Security, petugas tidak bisa verifikasi lagi.
  assert.equal(submitIncidentVerification(incidentId, VERIFY).ok, false);

  requestReverification(incidentId, { comment: 'cek ulang', actorName: 'Sec' });
  assert.deepEqual(submitIncidentVerification(incidentId, VERIFY), { ok: true, closed: true });

  const incidentB = { id: 'inc-2b', isPatrol: true, shipId: 'ship-9', location: 'Dek' };
  const b = assignFollowUp(incidentB.id, { assigneeId: 'fleet', instruction: 'A', actorName: 'Sec' });
  approveFlow(incidentB.id, b.id);
  submitIncidentVerification(incidentB.id, { ...VERIFY, approved: false, actorName: 'Sec', bySecurity: true });
  assert.equal(unsolveIncident(incidentB, { comment: 'Tidak bisa diperbaiki', actorName: 'Sec' }).ok, true);
});

test('PIC Security mengembalikan tindak lanjut ke PIC → harus Approved & diputuskan ulang', () => {
  const incidentId = 'inc-3';
  const a = assignFollowUp(incidentId, { assigneeId: 'fleet', instruction: 'A', actorName: 'Sec' });
  approveFlow(incidentId, a.id);
  requestIncidentVerification(incidentId, { actorName: 'Sec' });
  submitIncidentVerification(incidentId, { ...VERIFY, approved: false, comment: 'belum' });
  returnFollowUpToPic(incidentId, a.id, { comment: 'ulang', actorName: 'Sec' });
  assert.equal(submitIncidentVerification(incidentId, VERIFY).ok, false);
  approveFlow(incidentId, a.id);
  // Permintaan verifikasi lama batal → PIC Security memilih lagi.
  assert.equal(submitIncidentVerification(incidentId, VERIFY).ok, false);
  assert.equal(requestIncidentVerification(incidentId, { actorName: 'Sec' }), true);
  assert.equal(submitIncidentVerification(incidentId, VERIFY).closed, true);
});

test('getIncidentVerificationState memetakan status', () => {
  const approved = [{ status: S.APPROVED }, { status: S.APPROVED }];
  assert.equal(getIncidentVerificationState([], null, null), V.NO_FOLLOW_UP);
  assert.equal(getIncidentVerificationState([{ status: S.APPROVED }, { status: S.NEED_REVIEW }], null, null), V.IN_PROGRESS);
  assert.equal(getIncidentVerificationState(approved, null, null), V.READY);
  assert.equal(getIncidentVerificationState(approved, { verificationRequested: true }, null), V.AWAITING_VERIFICATION);
  assert.equal(getIncidentVerificationState(approved, { awaitingSecurityDecision: true }, null), V.AWAITING_SECURITY);
  assert.equal(getIncidentVerificationState(approved, null, { at: 'x' }), V.CLOSED);
  assert.equal(getIncidentVerificationState(approved, null, null, { at: 'x' }), V.UNSOLVED);
});

test('Unsolve: semua tindak lanjut ditutup, temuan tidak open lagi, foto acuan titik diganti', () => {
  const incident = { id: 'inc-unsolve', isPatrol: true, shipId: 'ship-1', location: 'Ruang Mesin', photoUrl: 'foto-temuan' };
  const a = assignFollowUp(incident.id, { assigneeId: 'fleet', instruction: 'A', actorName: 'Sec' });
  approveFlow(incident.id, a.id);
  assert.equal(isPatrolTemuanOpen(incident, 'open'), true);
  assert.equal(getIncidentCheckpointKey(incident), createCheckpointTemuanKey('ship-1', 'ruang mesin '));

  // Catatan wajib.
  assert.equal(unsolveIncident(incident, { comment: '  ', actorName: 'Sec' }).ok, false);
  assert.deepEqual(unsolveIncident(incident, { comment: 'Butuh docking', photoUrl: 'evidence', actorName: 'Sec' }), { ok: true, referenceUpdated: true });
  assert.equal(store.getIncidentVerificationState([{ status: S.UNSOLVED }], undefined, null, { at: 'x' }), V.UNSOLVED);
  assert.equal(isPatrolTemuanOpen(incident, 'open'), false);
  assert.equal(getCheckpointReferenceOverride(getIncidentCheckpointKey(incident)).referencePhotoUrl, 'evidence');
  assert.equal(requestIncidentVerification(incident.id, { actorName: 'Sec' }), false);
  assert.equal(unsolveIncident(incident, { comment: 'lagi', actorName: 'Sec' }).ok, false);
});

test('Unsolve tanpa evidence memakai foto temuan; temuan Closed tidak bisa Unsolve', () => {
  const incident = { id: 'inc-unsolve-2', isPatrol: true, shipId: 'ship-2', location: 'Anjungan', photoUrl: 'foto-temuan' };
  const a = assignFollowUp(incident.id, { assigneeId: 'fleet', instruction: 'A', actorName: 'Sec' });
  approveFlow(incident.id, a.id);
  assert.deepEqual(unsolveIncident(incident, { comment: 'Diterima apa adanya', actorName: 'Sec' }), { ok: true, referenceUpdated: true });
  assert.equal(getCheckpointReferenceOverride(createCheckpointTemuanKey('ship-2', 'Anjungan')).referencePhotoUrl, 'foto-temuan');

  const closed = { id: 'inc-closed', isPatrol: true, shipId: 'ship-2', location: 'Dek' };
  const b = assignFollowUp(closed.id, { assigneeId: 'fleet', instruction: 'A', actorName: 'Sec' });
  approveFlow(closed.id, b.id);
  submitIncidentVerification(closed.id, { ...VERIFY, actorName: 'Sec', bySecurity: true });
  assert.equal(isPatrolTemuanOpen(closed, 'open'), false);
  assert.equal(unsolveIncident(closed, { comment: 'x', actorName: 'Sec' }).ok, false);
});

test('temuan open: patroli & belum Closed/Unsolve; SOS dan status closed tidak dihitung', () => {
  assert.equal(isPatrolTemuanOpen({ id: 'p-1', isPatrol: true }, undefined), true);
  assert.equal(isPatrolTemuanOpen({ id: 'p-2', isPatrol: true }, 'closed'), false);
  assert.equal(isPatrolTemuanOpen({ id: 'sos-1', isPatrol: true, isSOS: true }, undefined), false);
  assert.equal(isPatrolTemuanOpen({ id: 'manual-1' }, undefined), false);
});

test('label status per POV role: Need … untuk yang bertindak, Waiting … untuk yang menunggu', () => {
  const { getFollowUpStatusView: view, getIncidentStatusView: incidentView, SECURITY_ASSIGNEE_ID: SEC, REPORTER_ROLE_ID: PTG } = store;
  const incidentId = 'inc-pov';
  const a = assignFollowUp(incidentId, { assigneeId: 'fleet', instruction: 'A', actorName: 'Sec' });
  const current = () => store.getStoredFollowUp(incidentId, a.id);
  const labels = () => [view(current(), SEC).label, view(current(), 'fleet').label, view(current(), PTG).label];

  assert.deepEqual(labels(), ['Waiting Action', 'Need Action', 'In Progress']);
  submitFollowUpUpdate(incidentId, a.id, { comment: 'rencana', actorName: 'PIC', actorRole: 'PIC Fleet' });
  assert.deepEqual(labels(), ['Need Review', 'Waiting Review', 'In Progress']);
  submitSecurityReview(incidentId, a.id, { approved: true, finalApproval: false, comment: '', actorName: 'Sec' });
  assert.deepEqual(labels(), ['Waiting Action', 'Need Action', 'In Progress']);
  assert.equal(view(current(), 'fleet').note, 'Plan Approved');
  submitFollowUpUpdate(incidentId, a.id, { comment: 'selesai?', actorName: 'PIC', actorRole: 'PIC Fleet' });
  submitSecurityReview(incidentId, a.id, { approved: false, comment: 'belum', actorName: 'Sec' });
  assert.deepEqual(labels(), ['Waiting Revision', 'Need Revision', 'In Progress']);
  approveFlow(incidentId, a.id);
  assert.deepEqual(labels(), ['Approved', 'Approved', 'Work Done']);
  // PIC fungsi lain melihat versi netral.
  assert.equal(view(current(), 'hsse').label, 'Work Done');

  assert.equal(incidentView(V.READY, SEC).label, 'Need Decision');
  assert.equal(incidentView(V.READY, 'fleet').label, 'Waiting Decision');
  assert.equal(incidentView(V.READY, PTG).label, 'In Progress');
  assert.equal(incidentView(V.AWAITING_VERIFICATION, PTG).label, 'Need Verification');
  assert.equal(incidentView(V.AWAITING_VERIFICATION, SEC).label, 'Waiting Verification');
  assert.equal(incidentView(V.AWAITING_SECURITY, PTG).label, 'Waiting Decision');
  assert.equal(incidentView(V.NO_FOLLOW_UP, SEC).label, 'Need Assign');
  assert.equal(incidentView(V.IN_PROGRESS, SEC, { approvedCount: 1, total: 2 }).label, 'In Progress (1/2)');
});

test('assign baru saat Need Verification → verifikasi otomatis ditunda + notifikasi ke petugas', () => {
  const incidentId = 'inc-postpone';
  const a = assignFollowUp(incidentId, { assigneeId: 'fleet', instruction: 'A', actorName: 'Sec' });
  approveFlow(incidentId, a.id);
  requestIncidentVerification(incidentId, { actorName: 'Sec' });
  assert.equal(store.isVerificationRequested(incidentId), true);

  assignFollowUp(incidentId, { assigneeId: 'hsse', instruction: 'B', actorName: 'Sec' });
  const record = store.getStoredVerification(incidentId);
  assert.equal(record.verificationRequested, false);
  assert.match(record.postponedNotice.reason, /assign tindak lanjut baru/);
  assert.equal(record.entries.at(-1).kind, 'postpone');
  // Petugas tidak bisa lagi mengirim verifikasi yang sudah ditunda.
  assert.equal(submitIncidentVerification(incidentId, VERIFY).ok, false);

  // Permintaan verifikasi baru menghapus notifikasi penundaan.
  const b = store.getStoredFollowUps(incidentId).at(-1);
  approveFlow(incidentId, b.id);
  requestIncidentVerification(incidentId, { actorName: 'Sec' });
  assert.equal(store.getStoredVerification(incidentId).postponedNotice, null);
});
