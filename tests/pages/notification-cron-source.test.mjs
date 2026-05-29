/*
Tujuan: Mencegah regresi cron notifikasi (checkpoint pending & shift wrap-up) kembali
        bergantung pada tabel ship_checkpoints yang TIDAK pernah ditulis aplikasi
        (definisi checkpoint ada di ships.custom_checkpoints).
Caller: Node test runner saat verifikasi migration notifikasi summary.
Dependensi: supabase/migrations/202605300005_fix_notification_cron_from_custom_checkpoints.sql.
Main Functions: Memastikan notify_checkpoint_pending & notify_shift_wrapup membaca
        custom_checkpoints dan mencocokkan laporan via nama checkpoint.
Side Effects: Tidak ada; test membaca file sumber secara read-only.
*/

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(
  new URL('../../supabase/migrations/202605300005_fix_notification_cron_from_custom_checkpoints.sql', import.meta.url),
  'utf8',
);

test('migration mengganti kedua fungsi notifikasi cron', () => {
  assert.match(
    source,
    /create or replace function public\.notify_checkpoint_pending/,
    'harus me-replace notify_checkpoint_pending',
  );
  assert.match(
    source,
    /create or replace function public\.notify_shift_wrapup/,
    'harus me-replace notify_shift_wrapup',
  );
});

test('cron notifikasi membaca definisi dari ships.custom_checkpoints', () => {
  const matches = source.match(/jsonb_array_elements\(v_ship\.custom_checkpoints\)\s+with ordinality/g) || [];
  assert.ok(
    matches.length >= 1,
    'notify_checkpoint_pending harus mengiterasi ships.custom_checkpoints, bukan ship_checkpoints',
  );
  assert.match(
    source,
    /from\s+public\.ships\s+s[\s\S]*?jsonb_typeof\(s\.custom_checkpoints\)\s*=\s*'array'/,
    'iterasi kapal harus berbasis ships.custom_checkpoints non-kosong',
  );
});

test('cron notifikasi TIDAK lagi membaca dari tabel ship_checkpoints', () => {
  assert.doesNotMatch(
    source,
    /from\s+public\.ship_checkpoints/i,
    'cron notifikasi tidak boleh lagi membaca dari tabel ship_checkpoints yang kosong',
  );
});

test('checkpoint pending mencocokkan laporan via nama checkpoint (tahan beda id antar-device)', () => {
  assert.match(
    source,
    /regexp_replace\(lower\(btrim\(pr\.checkpoint_name\)\), '\\s\+', ' ', 'g'\)\s*=\s*v_cp_name_key/,
    'pencocokan utama harus berdasarkan nama checkpoint ternormalisasi',
  );
  assert.match(
    source,
    /or pr\.checkpoint_id = v_cp_id/,
    'tetap sediakan fallback pencocokan via id checkpoint runtime',
  );
});

test('shift wrap-up fallback menghitung total dari custom_checkpoints, bukan ship_checkpoints', () => {
  assert.match(
    source,
    /v_total\s*:=\s*jsonb_array_length\(v_ship\.custom_checkpoints\)/,
    'fallback wrap-up harus memakai jsonb_array_length(custom_checkpoints) untuk total',
  );
});
