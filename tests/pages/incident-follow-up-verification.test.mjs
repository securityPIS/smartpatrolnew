/*
Tujuan: Mencegah regresi alur verifikasi temuan: petugas pelapor memverifikasi 1x setelah SEMUA
        tindak lanjut di-approve PIC Security; sesuai → Closed, belum sesuai → kembali ke PIC Security.
Caller: Node test runner.
Dependensi: src/components/incidentFollowUp/followUpStore.js (store in-memory).
Side Effects: Tidak ada di luar state modul store.
*/

import test from 'node:test';
import assert from 'node:assert/strict';

const store = await import('../../src/components/incidentFollowUp/followUpStore.js');
const {
  FOLLOW_UP_STATUS: S, INCIDENT_VERIFICATION_STATE: V, assignFollowUp, submitFollowUpUpdate, submitSecurityReview,
  submitIncidentVerification, returnFollowUpToPic, requestReverification, getIncidentVerificationState,
} = store;

function approveFlow(incidentId, followUpId) {
  submitFollowUpUpdate(incidentId, followUpId, { comment: 'selesai', actorName: 'PIC', actorRole: 'PIC Fleet' });
  submitSecurityReview(incidentId, followUpId, { approved: true, finalApproval: true, comment: '', actorName: 'Sec' });
}

test('verifikasi hanya bisa setelah semua tindak lanjut Approved; sesuai → Closed', () => {
  const incidentId = 'inc-1';
  const a = assignFollowUp(incidentId, { assigneeId: 'fleet', instruction: 'A', actorName: 'Sec' });
  const b = assignFollowUp(incidentId, { assigneeId: 'hsse', instruction: 'B', actorName: 'Sec' });
  approveFlow(incidentId, a.id);
  assert.deepEqual(submitIncidentVerification(incidentId, { approved: true, comment: 'ok', photoUrl: 'data:image/png;base64,x', actorName: 'Petugas' }), { ok: false, closed: false });

  // Konfirmasi rencana tidak dihitung approved.
  submitFollowUpUpdate(incidentId, b.id, { comment: 'rencana', actorName: 'PIC', actorRole: 'PIC HSSE' });
  submitSecurityReview(incidentId, b.id, { approved: true, finalApproval: false, comment: '', actorName: 'Sec' });
  assert.equal(submitIncidentVerification(incidentId, { approved: true, comment: 'ok', photoUrl: 'x', actorName: 'Petugas' }).ok, false);

  approveFlow(incidentId, b.id);
  assert.deepEqual(submitIncidentVerification(incidentId, { approved: true, comment: 'ok', photoUrl: 'x', actorName: 'Petugas' }), { ok: true, closed: true });
  // Sudah closed → tidak bisa verifikasi lagi.
  assert.equal(submitIncidentVerification(incidentId, { approved: true, comment: 'ok', photoUrl: 'x', actorName: 'Petugas' }).ok, false);
});

test('belum sesuai → menunggu keputusan PIC Security, lalu bisa diverifikasi ulang', () => {
  const incidentId = 'inc-2';
  const a = assignFollowUp(incidentId, { assigneeId: 'fleet', instruction: 'A', actorName: 'Sec' });
  approveFlow(incidentId, a.id);
  assert.deepEqual(submitIncidentVerification(incidentId, { approved: false, comment: 'masih bocor', photoUrl: 'x', actorName: 'Petugas' }), { ok: true, closed: false });
  // Selama menunggu PIC Security, petugas tidak bisa verifikasi lagi.
  assert.equal(submitIncidentVerification(incidentId, { approved: true, comment: 'ok', photoUrl: 'x', actorName: 'Petugas' }).ok, false);

  requestReverification(incidentId, { comment: 'cek ulang', actorName: 'Sec' });
  assert.deepEqual(submitIncidentVerification(incidentId, { approved: true, comment: 'ok', photoUrl: 'x', actorName: 'Petugas' }), { ok: true, closed: true });
});

test('PIC Security mengembalikan tindak lanjut ke PIC → harus Approved lagi sebelum verifikasi', () => {
  const incidentId = 'inc-3';
  const a = assignFollowUp(incidentId, { assigneeId: 'fleet', instruction: 'A', actorName: 'Sec' });
  approveFlow(incidentId, a.id);
  submitIncidentVerification(incidentId, { approved: false, comment: 'belum', photoUrl: 'x', actorName: 'Petugas' });
  returnFollowUpToPic(incidentId, a.id, { comment: 'ulang', actorName: 'Sec' });
  assert.equal(submitIncidentVerification(incidentId, { approved: true, comment: 'ok', photoUrl: 'x', actorName: 'Petugas' }).ok, false);
  approveFlow(incidentId, a.id);
  assert.equal(submitIncidentVerification(incidentId, { approved: true, comment: 'ok', photoUrl: 'x', actorName: 'Petugas' }).closed, true);
});

test('getIncidentVerificationState memetakan status', () => {
  const approved = [{ status: S.APPROVED }, { status: S.APPROVED }];
  assert.equal(getIncidentVerificationState([], null, null), V.NO_FOLLOW_UP);
  assert.equal(getIncidentVerificationState([{ status: S.APPROVED }, { status: S.NEED_REVIEW }], null, null), V.IN_PROGRESS);
  assert.equal(getIncidentVerificationState(approved, null, null), V.READY);
  assert.equal(getIncidentVerificationState(approved, { awaitingSecurityDecision: true }, null), V.AWAITING_SECURITY);
  assert.equal(getIncidentVerificationState(approved, null, { at: 'x' }), V.CLOSED);
});
