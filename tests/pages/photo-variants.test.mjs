/*
Tujuan: Menjaga pipeline varian foto (full ≤2000px + thumbnail ≤360px WebP) tidak regresi.
Caller: Node test runner.
Dependensi: src/utils/images.js, src/context/AppContextRuntime.jsx (capture + storePhotoWithVariants).
Main Functions: Verifikasi helper varian dan wiring capture.
Side Effects: Tidak ada; membaca sumber read-only.
*/

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const imagesSource = readFileSync(new URL('../../src/utils/images.js', import.meta.url), 'utf8');
const runtimeSource = readFileSync(new URL('../../src/context/AppContextRuntime.jsx', import.meta.url), 'utf8');
const cameraSource = readFileSync(new URL('../../src/components/modals/PatrolCameraModal.jsx', import.meta.url), 'utf8');

test('images.js mengekspor helper varian WebP', () => {
  assert.match(imagesSource, /export\s+async\s+function\s+resizeDataUrlToWebp/);
  assert.match(imagesSource, /export\s+async\s+function\s+createPhotoVariants/);
  assert.match(imagesSource, /toDataURL\("image\/webp", quality\)/);
});

test('createPhotoVariants memakai full 2000px dan thumbnail 360px (thumb < full quality)', () => {
  assert.match(imagesSource, /fullMaxEdge\s*=\s*2000/);
  assert.match(imagesSource, /thumbMaxEdge\s*=\s*360/);
  assert.match(imagesSource, /fullQuality\s*=\s*0\.8/);
  assert.match(imagesSource, /thumbQuality\s*=\s*0\.5/);
  // thumbnail diturunkan dari full agar hanya satu decode tambahan
  assert.match(imagesSource, /resizeDataUrlToWebp\(full, thumbMaxEdge, thumbQuality\)/);
});

test('kamera patroli menyediakan sumber full-res ≤2000px', () => {
  assert.match(cameraSource, /PATROL_CAMERA_MAX_EDGE\s*=\s*2000/);
});

test('capture patroli menyimpan dua varian dan field fullPhotoUrl', () => {
  assert.match(runtimeSource, /async function storePhotoWithVariants/);
  // R2 off harus tetap satu gambar (degradasi mulus)
  assert.match(runtimeSource, /if \(!isR2FullPhotoEnabled\)[\s\S]*?return \{ photoUrl, fullPhotoUrl: null \}/);
  assert.match(runtimeSource, /fullPhotoUrl,/);
});
