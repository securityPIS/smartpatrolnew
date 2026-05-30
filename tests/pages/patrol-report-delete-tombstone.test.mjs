/*
Tujuan: Mencegah regresi temuan patroli yang sudah dihapus admin muncul kembali.
Caller: Node test runner saat verifikasi sinkronisasi delete temuan lintas-device.
Dependensi: AppContextRuntime, patrolReports adapter, dan migration tombstone Supabase.
Main Functions: Memastikan reset manual tidak di-sync ulang dari background, tombstone membawa deleted_at,
        dan trigger DB memblokir re-upsert stale dengan shift_key berbeda.
Side Effects: Tidak ada; test membaca file sumber secara read-only.
*/

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const runtimeSource = readFileSync(
  new URL('../../src/context/AppContextRuntime.jsx', import.meta.url),
  'utf8',
);
const patrolReportsSource = readFileSync(
  new URL('../../src/services/backend/patrolReports.js', import.meta.url),
  'utf8',
);
const migrationSource = readFileSync(
  new URL('../../supabase/migrations/202605300012_block_stale_tombstoned_finding_reupsert.sql', import.meta.url),
  'utf8',
);

test('background sync tidak menulis ulang checkpoint manual-reset', () => {
  const startIndex = runtimeSource.indexOf('patrolReportSubscriptionTargets.forEach((target) => {');
  assert.notEqual(startIndex, -1, 'efek background patrol report harus ada');
  const effectSlice = runtimeSource.slice(startIndex, startIndex + 520);

  assert.match(
    effectSlice,
    /checkpoint\?\.status === 'completed'/,
    'background sync hanya boleh mengirim checkpoint completed',
  );
  assert.doesNotMatch(
    effectSlice,
    /manual-reset/,
    'checkpoint hasil hapus admin/tombstone tidak boleh ditulis ulang sebagai pending',
  );
});

test('sync reset patrol report hanya boleh lewat jalur eksplisit', () => {
  assert.match(
    runtimeSource,
    /isCheckpointResetRecord\(checkpoint\) && !options\.allowResetSync/,
    'syncPatrolReportToDomain harus menolak reset record kecuali caller eksplisit mengizinkan',
  );
  assert.match(
    runtimeSource,
    /syncPatrolReportToDomain\(resetReport, \{[\s\S]*?allowResetSync: true,[\s\S]*?skipMediaUpload: true/,
    'hapus laporan eksplisit masih boleh menulis reset pending ke patrol_reports',
  );
});

test('delete patrol report memakai RPC server-side atomic (bukan SELECT+DELETE client)', () => {
  assert.match(
    patrolReportsSource,
    /supabase\.rpc\('admin_delete_patrol_report_findings'/,
    'delete harus memanggil RPC server-side agar shift_key + tombstone konsisten dari DB',
  );
  assert.doesNotMatch(
    patrolReportsSource,
    /baris ditemukan di patrol_reports \(SELECT\)/,
    'jalur SELECT+DELETE manual lama tidak boleh dipakai lagi',
  );
});

test('tombstone realtime membawa deleted_at untuk reset stale beda shift', () => {
  assert.match(
    patrolReportsSource,
    /\.select\('client_event_id, shift_key, ship_id, checkpoint_id, ship_name, deleted_at'\)/,
    'listener tombstone harus membaca deleted_at',
  );
  assert.match(
    patrolReportsSource,
    /deletedAt: row\.deleted_at \|\| null/,
    'deleted_at harus dimap ke client',
  );
  assert.match(
    runtimeSource,
    /function shouldApplyPatrolReportTombstoneToCheckpoint/,
    'client harus punya guard tombstone stale beda shift',
  );
  assert.match(
    runtimeSource,
    /checkpointAtMs <= deletedAtMs/,
    'checkpoint lama sebelum waktu delete admin harus di-reset walau shift_key berbeda',
  );
});

test('listener tombstone punya polling fallback saat realtime gagal', () => {
  const startIndex = patrolReportsSource.indexOf('export function subscribeToPatrolReportTombstones');
  assert.notEqual(startIndex, -1, 'fungsi subscribe tombstone harus ada');
  const fnSlice = patrolReportsSource.slice(startIndex, startIndex + 3000);
  assert.match(
    fnSlice,
    /setInterval\(/,
    'tombstone harus di-poll ulang berkala agar device petugas yang sudah terbuka tetap menerima penghapusan walau realtime mati',
  );
  assert.match(
    fnSlice,
    /clearInterval\(pollTimer\)/,
    'timer polling tombstone harus dibersihkan saat unsubscribe',
  );
});

test('migration memblokir re-upsert temuan stale walau shift_key berbeda', () => {
  assert.match(
    migrationSource,
    /create or replace function public\.patrol_report_completed_at/,
    'migration harus mengekstrak timestamp patrol dari payload/occurred_at_trusted_ms',
  );
  assert.match(
    migrationSource,
    /t\.shift_key is distinct from new\.shift_key[\s\S]*?v_completed_at <= t\.deleted_at/,
    'trigger harus blok stale finding yang natural key checkpoint sama tapi shift_key berbeda',
  );
  assert.match(
    migrationSource,
    /delete from public\.patrol_reports pr[\s\S]*?using stale_tombstoned_reports stale/,
    'migration harus membersihkan baris lama yang sudah terlanjur hidup kembali',
  );
});
