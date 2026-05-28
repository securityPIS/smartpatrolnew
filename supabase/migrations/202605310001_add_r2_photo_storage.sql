/*
Tujuan: Menambah dukungan penyimpanan foto 2-storage — thumbnail di Supabase Storage dan
        full-res di Cloudflare R2 — pada tabel patrol_report_photos dan media_assets.
Caller: Supabase migration runner.
Dependensi: Tabel public.patrol_report_photos dan public.media_assets (migration init 202605220001).
Main Functions:
  - media_assets.storage_provider untuk membedakan objek Supabase vs R2 (dipakai cron resign agar skip R2).
  - patrol_report_photos: kolom referensi full-res R2 (provider, object key, status media).
Side Effects: ALTER TABLE (additive, IF NOT EXISTS). Tidak mengubah RLS — kebijakan ship-scoped existing tetap berlaku.

CATATAN KEAMANAN:
  Objek R2 TIDAK berada di Supabase Storage, jadi RLS storage.objects tidak melindunginya.
  Otorisasi akses R2 sepenuhnya dijaga Edge Function create-r2-upload-url / create-r2-download-url
  (cek enabled/approved + scope kapal). Bucket R2 WAJIB privat (tanpa public access).
*/

-- ─────────────────────────────────────────────
-- 1. media_assets: pembeda provider penyimpanan
-- ─────────────────────────────────────────────
ALTER TABLE public.media_assets
  ADD COLUMN IF NOT EXISTS storage_provider text NOT NULL DEFAULT 'supabase';

COMMENT ON COLUMN public.media_assets.storage_provider IS
  'Provider penyimpanan objek: ''supabase'' (Storage) atau ''r2'' (Cloudflare R2). Cron resign hanya memproses ''supabase''.';

CREATE INDEX IF NOT EXISTS media_assets_provider_ship_idx
  ON public.media_assets (storage_provider, ship_id);

-- ─────────────────────────────────────────────
-- 2. patrol_report_photos: referensi full-res R2
--    (kolom existing object_path/photo_url dipakai untuk thumbnail Supabase)
-- ─────────────────────────────────────────────
ALTER TABLE public.patrol_report_photos
  ADD COLUMN IF NOT EXISTS full_storage_provider text,
  ADD COLUMN IF NOT EXISTS full_object_key text,
  ADD COLUMN IF NOT EXISTS full_media_status text NOT NULL DEFAULT 'none';

COMMENT ON COLUMN public.patrol_report_photos.full_object_key IS
  'Object key foto full-res di Cloudflare R2. Diakses lewat presigned GET dari Edge Function.';
COMMENT ON COLUMN public.patrol_report_photos.full_media_status IS
  'Status upload full-res: none | uploading | ready | failed.';
