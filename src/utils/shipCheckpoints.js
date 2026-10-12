/*
Tujuan: Model definisi titik checkpoint kapal (main/sub) beserta tag NFC dan foto kondisi awal
        yang menjadi acuan foto patroli.
Caller: AppContextRuntime (normalisasi ships.customCheckpoints + handler admin) dan tab TITIK
        di ShipsPage.
Dependensi: utils/sanitize.
Main Functions: normalizeShipCheckpointDefinitions (dedupe + merge + urutkan main→sub),
        groupCheckpointHierarchy (untuk tampilan), getCheckpointCompleteness (NFC & foto wajib),
        sanitizeNfcTagId, findNfcTagOwner (cegah satu tag dipakai dua titik).
Side Effects: Tidak ada (fungsi murni).
*/

import { sanitizeMultilineText, sanitizeText, sanitizeUrl } from './sanitize.js';

export const CHECKPOINT_TYPE_MAIN = 'main';
export const CHECKPOINT_TYPE_SUB = 'sub';

export function createCheckpointNameKey(name) {
  return sanitizeText(name || '', 120).trim().toLowerCase();
}

function slugifyCheckpointName(name) {
  return createCheckpointNameKey(name)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

// ID deterministik dari nama untuk data lama (belum punya id) agar semua device sepakat.
export function createCheckpointDefinitionId(name) {
  return `cpdef-${slugifyCheckpointName(name) || 'titik'}`;
}

export function createUniqueCheckpointDefinitionId(name, existingIds = []) {
  const taken = new Set(existingIds);
  const baseId = createCheckpointDefinitionId(name);
  if (!taken.has(baseId)) return baseId;
  let suffix = 2;
  while (taken.has(`${baseId}-${suffix}`)) suffix += 1;
  return `${baseId}-${suffix}`;
}

// UID tag NFC: heksadesimal dinormalisasi jadi pasangan "04:A2:3B:..." supaya input manual
// ("04a23b") dan hasil scan ("04:a2:3b") dianggap sama. Format lain (ID teks) disimpan apa adanya
// dalam huruf besar.
export function sanitizeNfcTagId(value) {
  const compact = sanitizeText(value || '', 96).toUpperCase().replace(/\s+/g, '');
  if (!compact) return '';
  const hexOnly = compact.replace(/[:-]/g, '');
  if (/^[0-9A-F]+$/.test(hexOnly) && hexOnly.length % 2 === 0) {
    return hexOnly.match(/.{2}/g).join(':').slice(0, 64);
  }
  return compact.replace(/[^0-9A-Z:_-]/g, '').slice(0, 64);
}

function normalizeCheckpointDefinition(checkpoint) {
  const name = sanitizeText(checkpoint?.name || '', 80);
  const isDefault = Boolean(checkpoint?.isDefault);
  const type = !isDefault && checkpoint?.type === CHECKPOINT_TYPE_SUB ? CHECKPOINT_TYPE_SUB : CHECKPOINT_TYPE_MAIN;
  return {
    id: sanitizeText(checkpoint?.id || '', 120) || createCheckpointDefinitionId(name),
    name,
    desc: sanitizeMultilineText(checkpoint?.desc || '', 140),
    isDefault,
    type,
    parentId: type === CHECKPOINT_TYPE_SUB ? sanitizeText(checkpoint?.parentId || '', 120) : '',
    nfcTagId: sanitizeNfcTagId(checkpoint?.nfcTagId),
    referencePhotoUrl: sanitizeUrl(checkpoint?.referencePhotoUrl || '') || null,
    referencePhotoUpdatedAt: sanitizeText(checkpoint?.referencePhotoUpdatedAt || '', 40) || null,
  };
}

/*
Dedupe per nama. Entri berikutnya dengan nama sama MENGISI field yang terisi (NFC, foto, desc)
di atas entri pertama — penting karena initializeShipCheckpointDefinitions menaruh titik default
(tanpa NFC/foto) lebih dulu, lalu data tersimpan kapal; tanpa merge, NFC & foto titik default
hilang setiap normalisasi. Hasil diurutkan: setiap main diikuti sub-nya. Sub yang induknya
tidak ada (atau induknya sendiri sub) dinaikkan jadi main agar tidak hilang.
*/
export function normalizeShipCheckpointDefinitions(checkpoints = []) {
  const byName = new Map();

  (Array.isArray(checkpoints) ? checkpoints : []).forEach((checkpoint) => {
    const next = normalizeCheckpointDefinition(checkpoint);
    const key = createCheckpointNameKey(next.name);
    if (!key) return;
    const existing = byName.get(key);
    if (!existing) {
      byName.set(key, next);
      return;
    }
    const isDefault = existing.isDefault || next.isDefault;
    const keepExistingStructure = isDefault || existing.type === CHECKPOINT_TYPE_SUB;
    byName.set(key, {
      ...existing,
      desc: next.desc || existing.desc,
      isDefault,
      type: isDefault ? CHECKPOINT_TYPE_MAIN : (keepExistingStructure ? existing.type : next.type),
      parentId: isDefault ? '' : (keepExistingStructure ? existing.parentId : next.parentId),
      nfcTagId: next.nfcTagId || existing.nfcTagId,
      referencePhotoUrl: next.referencePhotoUrl || existing.referencePhotoUrl,
      referencePhotoUpdatedAt: next.referencePhotoUrl
        ? (next.referencePhotoUpdatedAt || existing.referencePhotoUpdatedAt)
        : existing.referencePhotoUpdatedAt,
    });
  });

  const definitions = Array.from(byName.values());
  const mainIds = new Set(
    definitions.filter(item => item.type === CHECKPOINT_TYPE_MAIN).map(item => item.id),
  );
  const mains = [];
  const subsByParent = new Map();

  definitions.forEach((definition) => {
    if (definition.type === CHECKPOINT_TYPE_SUB && mainIds.has(definition.parentId)) {
      const siblings = subsByParent.get(definition.parentId) || [];
      siblings.push(definition);
      subsByParent.set(definition.parentId, siblings);
      return;
    }
    mains.push({ ...definition, type: CHECKPOINT_TYPE_MAIN, parentId: '' });
  });

  return mains.flatMap(main => [main, ...(subsByParent.get(main.id) || [])]);
}

export function groupCheckpointHierarchy(checkpoints = []) {
  const normalized = normalizeShipCheckpointDefinitions(checkpoints);
  const groups = [];
  normalized.forEach((checkpoint) => {
    if (checkpoint.type === CHECKPOINT_TYPE_MAIN) {
      groups.push({ main: checkpoint, subs: [] });
      return;
    }
    groups[groups.length - 1]?.subs.push(checkpoint);
  });
  return groups;
}

export function getCheckpointCompleteness(checkpoint) {
  const hasNfc = Boolean(sanitizeNfcTagId(checkpoint?.nfcTagId));
  const hasPhoto = Boolean(sanitizeUrl(checkpoint?.referencePhotoUrl || ''));
  return { hasNfc, hasPhoto, complete: hasNfc && hasPhoto };
}

// Satu tag fisik = satu titik. Cari pemakai lain tag ini di seluruh armada.
export function findNfcTagOwner(ships = [], nfcTagId, { excludeShipId = null, excludeCheckpointId = null } = {}) {
  const safeTagId = sanitizeNfcTagId(nfcTagId);
  if (!safeTagId) return null;
  for (const ship of Array.isArray(ships) ? ships : []) {
    for (const checkpoint of Array.isArray(ship?.customCheckpoints) ? ship.customCheckpoints : []) {
      const isExcluded = ship?.id === excludeShipId
        && (checkpoint?.id || createCheckpointDefinitionId(checkpoint?.name)) === excludeCheckpointId;
      if (isExcluded) continue;
      if (sanitizeNfcTagId(checkpoint?.nfcTagId) === safeTagId) {
        return { shipId: ship.id, shipName: ship.name || '', checkpointName: checkpoint.name || '' };
      }
    }
  }
  return null;
}

// Kunci identitas tag hasil scan: UID chip + isi NDEF (teks/URI). Titik cocok bila nfcTagId
// terdaftar sama dengan salah satunya — jadi admin bebas mendaftarkan UID atau isi tag.
export function getScannedNfcKeys(tag) {
  const keys = [tag?.uid, ...(Array.isArray(tag?.contents) ? tag.contents : [])]
    .map(sanitizeNfcTagId)
    .filter(Boolean);
  return Array.from(new Set(keys));
}

// Nilai yang disimpan saat admin mendaftarkan tag: UID bila ada (unik per chip), selain itu isi tag.
export function getRegistrableNfcTagId(tag) {
  return sanitizeNfcTagId(tag?.uid) || sanitizeNfcTagId(tag?.contents?.[0]);
}

export function findCheckpointByNfcTag(checkpoints = [], tag) {
  const keys = new Set(getScannedNfcKeys(tag));
  if (keys.size === 0) return null;
  return (Array.isArray(checkpoints) ? checkpoints : [])
    .find(checkpoint => keys.has(sanitizeNfcTagId(checkpoint?.nfcTagId))) || null;
}

export function findShipCheckpointByNfcTag(ships = [], tag) {
  for (const ship of Array.isArray(ships) ? ships : []) {
    const checkpoint = findCheckpointByNfcTag(ship?.customCheckpoints, tag);
    if (checkpoint) return { ship, checkpoint };
  }
  return null;
}
