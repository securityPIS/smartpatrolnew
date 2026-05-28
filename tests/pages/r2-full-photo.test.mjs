/*
Tujuan: Menjaga pipeline 2-storage (thumbnail Supabase + full-res R2) tidak regresi pada
        client upload, persistensi ternormalisasi, dan jalur baca.
Caller: Node test runner.
Dependensi: src/services/backend/r2Assets.js, patrolReports.js, cloudState.js, AppContextRuntime.jsx,
            supabase/migrations/202605310001_add_r2_photo_storage.sql, resign-expiring-assets.
Main Functions: Verifikasi flag, idempotensi upload R2, tulis/baca patrol_report_photos, dan skip resign R2.
Side Effects: Tidak ada; membaca sumber read-only.
*/

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const r2Source = readFileSync(new URL('../../src/services/backend/r2Assets.js', import.meta.url), 'utf8');
const patrolReportsSource = readFileSync(new URL('../../src/services/backend/patrolReports.js', import.meta.url), 'utf8');
const cloudStateSource = readFileSync(new URL('../../src/services/backend/cloudState.js', import.meta.url), 'utf8');
const runtimeSource = readFileSync(new URL('../../src/context/AppContextRuntime.jsx', import.meta.url), 'utf8');
const migrationSource = readFileSync(new URL('../../supabase/migrations/202605310001_add_r2_photo_storage.sql', import.meta.url), 'utf8');
const resignSource = readFileSync(new URL('../../supabase/functions/resign-expiring-assets/index.ts', import.meta.url), 'utf8');

test('r2Assets digerbang flag VITE_ENABLE_R2_FULL_PHOTO dan memanggil Edge Function R2', () => {
  assert.match(r2Source, /VITE_ENABLE_R2_FULL_PHOTO\s*===\s*'1'/);
  assert.match(r2Source, /invokeFunction\('create-r2-upload-url'/);
  assert.match(r2Source, /invokeFunction\('create-r2-download-url'/);
  // upload PUT presigned + catat provider r2
  assert.match(r2Source, /method:\s*'PUT'/);
  assert.match(r2Source, /storage_provider:\s*'r2'/);
});

test('r2Assets tidak mengupload bila flag off (degradasi mulus)', () => {
  assert.match(r2Source, /if \(!isR2FullPhotoEnabled\) return null;/);
});

test('upload full-res R2 idempoten via cache dan antre retry saat gagal', () => {
  assert.match(runtimeSource, /const r2AssetCacheRef = useRef\(new Map\(\)\)/);
  assert.match(runtimeSource, /r2AssetCacheRef\.current\.get\(fullPhotoUrl\)/);
  // retry queue dipakai ulang dengan diskriminator kind 'r2-full'
  assert.match(runtimeSource, /kind:\s*'r2-full'/);
  assert.match(runtimeSource, /if \(item\.kind === 'r2-full'\)/);
});

test('full-res tidak pernah memblok submit (fire-and-forget)', () => {
  assert.match(runtimeSource, /void prepareFullPhotoRef\(mainFullUrl/);
});

test('patrol_report_photos ditulis dengan full_object_key dan dibaca lewat embedded select', () => {
  assert.match(patrolReportsSource, /full_object_key:\s*photo\.fullObjectKey/);
  assert.match(patrolReportsSource, /registerOutboxHandler\('patrol_report_photo\.upsert'/);
  assert.match(patrolReportsSource, /\(id, full_object_key, full_storage_provider, full_media_status, payload\)/);
  assert.match(patrolReportsSource, /export function applyFullPhotoRefs/);
});

test('cloudState menggabungkan ref full-res ke checkpoint saat hydrate', () => {
  assert.match(cloudStateSource, /patrol_report_photos\(id, full_object_key, full_storage_provider, full_media_status, payload\)/);
  assert.match(cloudStateSource, /applyFullPhotoRefs\(checkpoint, row\.patrol_report_photos\)/);
});

test('migrasi menambah kolom R2 secara aditif (IF NOT EXISTS)', () => {
  assert.match(migrationSource, /media_assets[\s\S]*ADD COLUMN IF NOT EXISTS storage_provider text NOT NULL DEFAULT 'supabase'/);
  assert.match(migrationSource, /ADD COLUMN IF NOT EXISTS full_object_key text/);
  assert.match(migrationSource, /ADD COLUMN IF NOT EXISTS full_media_status text NOT NULL DEFAULT 'none'/);
});

test('cron resign hanya memproses provider supabase (skip R2)', () => {
  assert.match(resignSource, /\.eq\('storage_provider',\s*'supabase'\)/);
});
