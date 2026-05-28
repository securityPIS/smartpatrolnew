/*
Tujuan: Adapter client untuk foto full-res di Cloudflare R2 (upload via presigned PUT, view via presigned GET).
Caller: AppContextRuntime (sync laporan patroli) dan PhotoPreviewModal (view foto full-res).
Dependensi: Supabase Edge Functions create-r2-upload-url / create-r2-download-url, IndexedDB image store, tabel media_assets.
Main Functions: isR2FullPhotoEnabled (flag), uploadFullPhotoToR2 (upload presigned PUT), getR2DownloadUrl (mint presigned GET).
Side Effects: Memanggil Edge Function R2, PUT object ke R2, dan mencatat metadata ke media_assets (storage_provider='r2').
*/

import { ensureSupabaseClient } from './app';
import { dataUrlToBlob, resolveLocalDataUrl } from './assets';

// Flag rollout: full-res R2 hanya aktif bila VITE_ENABLE_R2_FULL_PHOTO === '1'.
// Saat off, aplikasi degrade mulus ke Supabase-only (perilaku lama).
export const isR2FullPhotoEnabled = import.meta.env.VITE_ENABLE_R2_FULL_PHOTO === '1';

async function invokeFunction(name, payload = {}) {
  const supabase = ensureSupabaseClient();
  const { data, error } = await supabase.functions.invoke(name, { body: payload });
  if (error) throw error;
  return data || null;
}

// Upload foto full-res ke Cloudflare R2 lewat presigned PUT dari Edge Function.
// Mengembalikan { objectKey } bila sukses; null bila flag off atau aset lokal tak tersedia.
// Melempar error bila presign/PUT gagal agar pemanggil bisa antre retry.
export async function uploadFullPhotoToR2({ photoUrl, shipId, shiftKey, checkpointId, photoId }) {
  if (!isR2FullPhotoEnabled) return null;

  const dataUrl = await resolveLocalDataUrl(photoUrl);
  if (!dataUrl) return null;

  const signed = await invokeFunction('create-r2-upload-url', {
    shipId,
    shiftKey,
    checkpointId,
    photoId,
  });
  if (!signed?.uploadUrl || !signed?.objectKey) {
    throw new Error('Presigned upload URL R2 tidak valid.');
  }

  const blob = dataUrlToBlob(dataUrl);
  const response = await fetch(signed.uploadUrl, {
    method: 'PUT',
    headers: signed.headers || { 'Content-Type': 'image/webp' },
    body: blob,
  });
  if (!response.ok) {
    throw new Error(`Upload R2 gagal (${response.status}).`);
  }

  // Catat metadata: agar bisa dilacak dan cron resign men-skip provider 'r2'.
  const supabase = ensureSupabaseClient();
  await supabase.from('media_assets').upsert({
    bucket: signed.bucket || 'r2',
    object_path: signed.objectKey,
    ship_id: shipId || null,
    domain: 'operational',
    mime_type: blob.type || 'image/webp',
    byte_size: blob.size,
    storage_provider: 'r2',
  }, { onConflict: 'bucket,object_path' }).throwOnError();

  return { objectKey: signed.objectKey };
}

// Mint presigned GET URL untuk melihat foto full-res R2 (akses kapal dicek server-side).
export async function getR2DownloadUrl({ shipId, objectKey }) {
  if (!isR2FullPhotoEnabled || !objectKey) return null;
  const signed = await invokeFunction('create-r2-download-url', { shipId, objectKey });
  return signed?.url || null;
}
