/*
Tujuan: Mencegah regresi model titik checkpoint kapal (main/sub + NFC + foto kondisi awal).
Caller: Node test runner.
Dependensi: src/utils/shipCheckpoints.js.
Main Functions: Menguji normalisasi NFC, merge titik default dengan data tersimpan, urutan main→sub,
        sub yatim, kelengkapan wajib, dan keunikan tag NFC lintas armada.
Side Effects: Tidak ada; data dummy in-memory.
*/

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  findNfcTagOwner,
  getCheckpointCompleteness,
  groupCheckpointHierarchy,
  normalizeShipCheckpointDefinitions,
  sanitizeNfcTagId,
} from '../../src/utils/shipCheckpoints.js';

test('UID NFC manual dan hasil scan dinormalisasi ke format yang sama', () => {
  assert.equal(sanitizeNfcTagId('04a23b1c'), '04:A2:3B:1C');
  assert.equal(sanitizeNfcTagId('04:a2:3b:1c'), '04:A2:3B:1C');
  assert.equal(sanitizeNfcTagId(' 04-A2-3B-1C '), '04:A2:3B:1C');
  assert.equal(sanitizeNfcTagId('TAG<x>-01'), 'TAGX-01');
  assert.equal(sanitizeNfcTagId(''), '');
});

test('NFC & foto pada titik default tidak hilang saat default dibuat ulang', () => {
  const defaults = [{ name: 'Anjungan', isDefault: true }];
  const saved = [{ name: 'Anjungan', isDefault: true, nfcTagId: '04aa', referencePhotoUrl: 'https://x.test/a.jpg', desc: 'Cek radar' }];
  const [anjungan] = normalizeShipCheckpointDefinitions([...defaults, ...saved]);
  assert.equal(anjungan.nfcTagId, '04:AA');
  assert.equal(anjungan.referencePhotoUrl, 'https://x.test/a.jpg');
  assert.equal(anjungan.desc, 'Cek radar');
  assert.equal(anjungan.type, 'main');
  assert.ok(anjungan.id);
});

test('sub checkpoint selalu diurutkan tepat setelah main induknya', () => {
  const list = normalizeShipCheckpointDefinitions([
    { id: 'm1', name: 'Ruang Mesin' },
    { id: 'm2', name: 'Dek' },
    { id: 's1', name: 'Generator', type: 'sub', parentId: 'm1' },
    { id: 's2', name: 'Sekoci', type: 'sub', parentId: 'm2' },
  ]);
  assert.deepEqual(list.map(item => item.id), ['m1', 's1', 'm2', 's2']);
  const groups = groupCheckpointHierarchy(list);
  assert.deepEqual(groups.map(group => [group.main.id, group.subs.map(sub => sub.id)]), [['m1', ['s1']], ['m2', ['s2']]]);
});

test('sub tanpa induk valid dinaikkan jadi main, bukan dibuang', () => {
  const list = normalizeShipCheckpointDefinitions([
    { id: 'm1', name: 'Dek' },
    { id: 's1', name: 'Yatim', type: 'sub', parentId: 'hilang' },
    { id: 's2', name: 'Cucu', type: 'sub', parentId: 's1' },
  ]);
  assert.equal(list.length, 3);
  assert.ok(list.every(item => item.type === 'main' && item.parentId === ''));
});

test('titik default tidak bisa menjadi sub', () => {
  const [item] = normalizeShipCheckpointDefinitions([{ id: 'd', name: 'Anjungan', isDefault: true, type: 'sub', parentId: 'x' }]);
  assert.equal(item.type, 'main');
});

test('kelengkapan: NFC dan foto kondisi awal wajib', () => {
  assert.deepEqual(getCheckpointCompleteness({ nfcTagId: '04aa', referencePhotoUrl: 'idb://img-1' }), { hasNfc: true, hasPhoto: true, complete: true });
  assert.equal(getCheckpointCompleteness({ nfcTagId: '04aa' }).complete, false);
  assert.equal(getCheckpointCompleteness({ referencePhotoUrl: 'https://x.test/a.jpg' }).complete, false);
  assert.equal(getCheckpointCompleteness({ nfcTagId: '04aa', referencePhotoUrl: 'javascript:alert(1)' }).hasPhoto, false);
});

test('satu tag NFC tidak boleh dipakai dua titik di seluruh armada', () => {
  const ships = [
    { id: 'a', name: 'KM A', customCheckpoints: [{ id: 'cp1', name: 'Dek', nfcTagId: '04:AA' }] },
    { id: 'b', name: 'KM B', customCheckpoints: [] },
  ];
  assert.deepEqual(findNfcTagOwner(ships, '04aa'), { shipId: 'a', shipName: 'KM A', checkpointName: 'Dek' });
  assert.equal(findNfcTagOwner(ships, '04aa', { excludeShipId: 'a', excludeCheckpointId: 'cp1' }), null);
  assert.equal(findNfcTagOwner(ships, '04bb'), null);
});
