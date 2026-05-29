/*
Tujuan: Mengunggah aset SmartPatrol ke Supabase Storage tanpa Firebase Storage.
Caller: Adapter cloud state, access onboarding, dan domain report/incident.
Dependensi: Supabase Storage, IndexedDB image store, dan utilitas sanitasi.
Main Functions: Resolve data URL lokal, upload object ke bucket terkontrol, dan membuat signed URL sementara.
Side Effects: Menulis object ke Supabase Storage serta record metadata opsional ke tabel media_assets.
*/

import { loadImageFromDB } from '../../utils/imageStore';
import { sanitizeText, sanitizeUrl } from '../../utils/sanitize';
import { ensureSupabaseClient } from './app';

const OPERATIONAL_BUCKET = 'operational-assets';
const REGISTRATION_BUCKET = 'registration-assets';
const SIGNED_URL_TTL_SECONDS = 30 * 24 * 60 * 60;

function sanitizeStorageSegment(value, fallback = 'item') {
  return sanitizeText(String(value || ''), 120)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/(^-|-$)/g, '') || fallback;
}

async function resolveLocalDataUrl(url) {
  if (!url || typeof url !== 'string') return null;
  if (url.startsWith('data:')) return url;
  if (url.startsWith('idb://')) return loadImageFromDB(url);
  return null;
}

function dataUrlToBlob(dataUrl) {
  const [meta, base64Payload] = String(dataUrl || '').split(',');
  const mimeMatch = /^data:([^;]+);base64$/i.exec(meta || '');
  if (!mimeMatch || !base64Payload) {
    throw new Error('Data URL aset tidak valid.');
  }
  const binary = atob(base64Payload);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mimeMatch[1] });
}

async function createSignedUrl(bucket, path) {
  const supabase = ensureSupabaseClient();
  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);

  if (error) throw error;
  return data?.signedUrl || '';
}

export function buildRegistrationAssetPath(uid, ...segments) {
  return [
    sanitizeStorageSegment(uid, 'anonymous'),
    ...segments.map((segment, index) => sanitizeStorageSegment(segment, `part-${index + 1}`)),
  ].join('/');
}

export async function uploadDataUrlAsset({ bucket = OPERATIONAL_BUCKET, dataUrl, path, metadata = {} }) {
  if (!dataUrl || !path) return null;

  const supabase = ensureSupabaseClient();
  const blob = dataUrlToBlob(dataUrl);
  const { error } = await supabase.storage
    .from(bucket)
    .upload(path, blob, {
      contentType: blob.type || 'application/octet-stream',
      upsert: true,
    });

  if (error) throw error;

  const signedUrl = await createSignedUrl(bucket, path);

  await supabase.from('media_assets').upsert({
    bucket,
    object_path: path,
    owner_id: metadata.ownerId || null,
    ship_id: metadata.shipId || null,
    domain: metadata.domain || 'operational',
    mime_type: blob.type || null,
    byte_size: blob.size,
    signed_url: signedUrl,
    signed_url_expires_at: new Date(Date.now() + (SIGNED_URL_TTL_SECONDS * 1000)).toISOString(),
  }, { onConflict: 'bucket,object_path' }).throwOnError();

  return signedUrl;
}

export async function uploadCloudDataUrlAsset({ dataUrl, path }) {
  const resolvedDataUrl = await resolveLocalDataUrl(dataUrl);
  if (!resolvedDataUrl) return sanitizeUrl(dataUrl || '') || null;

  return uploadDataUrlAsset({
    bucket: OPERATIONAL_BUCKET,
    dataUrl: resolvedDataUrl,
    path: String(path || '').split('/').map((segment, index) => sanitizeStorageSegment(segment, `part-${index + 1}`)).join('/'),
    metadata: { domain: 'operational' },
  });
}

export async function uploadRegistrationPhotoAsset({ uid, photoUrl }) {
  if (!uid || !photoUrl) {
    return {
      photoUrl: sanitizeUrl(photoUrl || '') || '',
      photoPath: '',
    };
  }

  const resolvedDataUrl = await resolveLocalDataUrl(photoUrl);
  if (!resolvedDataUrl) {
    return {
      photoUrl: sanitizeUrl(photoUrl || '') || '',
      photoPath: '',
    };
  }

  const photoPath = buildRegistrationAssetPath(uid, 'profile', `avatar-${Date.now()}.webp`);
  const signedUrl = await uploadDataUrlAsset({
    bucket: REGISTRATION_BUCKET,
    dataUrl: resolvedDataUrl,
    path: photoPath,
    metadata: {
      ownerId: uid,
      domain: 'registration',
    },
  });

  return {
    photoUrl: signedUrl,
    photoPath,
  };
}

export async function deleteStorageAsset(photoUrl) {
  if (!photoUrl || typeof photoUrl !== 'string') return;
  // Ekstrak bucket dan object_path dari Supabase Storage URL
  // Format: .../storage/v1/object/sign/<bucket>/<path>?token=... atau /public/<bucket>/<path>
  const match = photoUrl.match(/\/storage\/v1\/object\/(?:sign|public)\/([^/?]+)\/(.+?)(?:\?|$)/);
  if (!match) return;
  const bucket = match[1];
  const objectPath = match[2];

  const supabase = ensureSupabaseClient();
  await supabase.storage.from(bucket).remove([objectPath]).catch(() => {});
  await supabase.from('media_assets').delete()
    .eq('bucket', bucket)
    .eq('object_path', objectPath)
    .catch(() => {});
}

export { OPERATIONAL_BUCKET, REGISTRATION_BUCKET };
