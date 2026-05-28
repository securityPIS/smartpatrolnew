/*
Tujuan: Menjaga otorisasi Edge Function R2 (upload/download) tetap ship-scoped dan tahan path traversal.
Caller: Node test runner (npm run test:security).
Dependensi: supabase/functions/create-r2-upload-url, create-r2-download-url, _shared/smartpatrol.ts.
Main Functions: Verifikasi auth + scope kapal, sanitasi key, validasi prefix download, dan status error.
Side Effects: Tidak ada; membaca sumber read-only.
*/

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sharedSource = readFileSync(new URL('../../supabase/functions/_shared/smartpatrol.ts', import.meta.url), 'utf8');
const uploadSource = readFileSync(new URL('../../supabase/functions/create-r2-upload-url/index.ts', import.meta.url), 'utf8');
const downloadSource = readFileSync(new URL('../../supabase/functions/create-r2-download-url/index.ts', import.meta.url), 'utf8');

test('assertOperationalShipAccess menuntut enabled + approved dan mencocokkan kapal', () => {
  assert.match(sharedSource, /export async function assertOperationalShipAccess/);
  assert.match(sharedSource, /profile\.enabled !== true \|\| profile\.review_state !== 'approved'/);
  // ADMIN bypass, selain itu cocokkan ship_assigned dengan nama kapal ternormalisasi
  assert.match(sharedSource, /normalizeRole\(profile\.role\) === 'ADMIN'/);
  assert.match(sharedSource, /assigned !== normalize\(ship\.name\)/);
  assert.match(sharedSource, /throw new Error\('permission-denied'\)/);
});

test('kedua Edge Function R2 memverifikasi auth + scope kapal', () => {
  for (const source of [uploadSource, downloadSource]) {
    assert.match(source, /getAuthUser\(request\)/);
    assert.match(source, /assertOperationalShipAccess\(user, shipId\)/);
    // status: 401 unauthenticated, 503 belum dikonfigurasi, selain itu 403
    assert.match(source, /message === 'unauthenticated' \? 401/);
    assert.match(source, /message === 'r2-not-configured' \? 503/);
  }
});

test('upload R2 mensanitasi setiap segmen object key (anti path traversal)', () => {
  assert.match(uploadSource, /function segment\(/);
  assert.match(uploadSource, /replace\(\/\[\^a-z0-9\._-\]\+\/g, '-'\)/);
  assert.match(uploadSource, /'patrol-reports',[\s\S]*segment\(shipId/);
});

test('download R2 membatasi objectKey ke prefix kapal pemanggil', () => {
  assert.match(downloadSource, /const expectedPrefix = `patrol-reports\/\$\{segment\(shipId, 'ship'\)\}\/`/);
  assert.match(downloadSource, /!objectKey\.startsWith\(expectedPrefix\)/);
});

test('R2 di-presign lewat SigV4 query signing (bukan secret ke client)', () => {
  for (const source of [uploadSource, downloadSource]) {
    assert.match(source, /aws4fetch/);
    assert.match(source, /aws:\s*\{\s*signQuery:\s*true\s*\}/);
    assert.match(source, /Deno\.env\.get\('R2_SECRET_ACCESS_KEY'\)/);
  }
});
