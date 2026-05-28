/*
Tujuan: Re-sign Supabase Storage signed URL yang hampir atau sudah kedaluwarsa agar foto tidak hilang.
Caller: pg_cron harian via net.http_post, atau trigger manual admin.
Dependensi: Supabase service client, tabel media_assets, tabel profiles.
Main Functions:
  - Scan media_assets dengan signed_url_expires_at < now() + 48 jam
  - Re-sign setiap object, perpanjang TTL 30 hari
  - Update signed_url + signed_url_expires_at di media_assets
  - Untuk domain 'registration': update profiles.photo_url WHERE auth_uid = owner_id
Side Effects: Write ke media_assets dan profiles; tidak ada perubahan Storage object.
*/

import {
  getServiceClient,
  handleOptions,
  jsonResponse,
} from '../_shared/smartpatrol.ts';

/** TTL signed URL baru: 30 hari */
const SIGNED_URL_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Re-sign bila kedaluwarsa dalam waktu ini */
const RESIGN_THRESHOLD_HOURS = 48;

/** Maksimal aset diproses per run agar tidak timeout */
const BATCH_LIMIT = 200;

Deno.serve(async (request) => {
  const options = handleOptions(request);
  if (options) return options;

  // Verifikasi CRON_SECRET agar endpoint tidak bisa dipanggil sembarangan.
  // Jika CRON_SECRET env var kosong, endpoint terbuka (hanya untuk dev/local).
  const cronSecret = Deno.env.get('CRON_SECRET') ?? '';
  const requestSecret = request.headers.get('x-cron-secret') ?? '';
  if (cronSecret && requestSecret !== cronSecret) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }

  try {
    const supabase = getServiceClient();
    const thresholdTime = new Date(
      Date.now() + RESIGN_THRESHOLD_HOURS * 60 * 60 * 1000,
    ).toISOString();

    // Ambil semua aset yang akan segera kedaluwarsa atau belum punya expiry
    const { data: expiringAssets, error: queryError } = await supabase
      .from('media_assets')
      .select('id, bucket, object_path, owner_id, domain, signed_url_expires_at')
      // Hanya objek Supabase Storage yang punya signed URL. Objek R2 (storage_provider='r2')
      // diakses lewat presigned GET on-demand, jadi tak perlu (dan tak bisa) di-resign di sini.
      .eq('storage_provider', 'supabase')
      .or(`signed_url_expires_at.is.null,signed_url_expires_at.lt.${thresholdTime}`)
      .order('signed_url_expires_at', { ascending: true, nullsFirst: true })
      .limit(BATCH_LIMIT);

    if (queryError) throw queryError;

    if (!expiringAssets?.length) {
      return jsonResponse({ resigned: 0, message: 'Tidak ada aset yang perlu di-resign.' });
    }

    const newExpiresAt = new Date(
      Date.now() + SIGNED_URL_TTL_SECONDS * 1000,
    ).toISOString();

    let resignedCount = 0;
    let failedCount = 0;

    for (const asset of expiringAssets) {
      try {
        // Buat signed URL baru dengan TTL 30 hari
        const { data: signData, error: signError } = await supabase.storage
          .from(asset.bucket)
          .createSignedUrl(asset.object_path, SIGNED_URL_TTL_SECONDS);

        if (signError || !signData?.signedUrl) {
          console.error(
            `[resign] Gagal re-sign ${asset.bucket}/${asset.object_path}:`,
            signError?.message ?? 'no signedUrl returned',
          );
          failedCount++;
          continue;
        }

        const newSignedUrl = signData.signedUrl;

        // Update media_assets: simpan URL baru dan expiry baru
        const { error: updateMediaError } = await supabase
          .from('media_assets')
          .update({ signed_url: newSignedUrl, signed_url_expires_at: newExpiresAt })
          .eq('id', asset.id);

        if (updateMediaError) {
          console.error(`[resign] Gagal update media_assets id=${asset.id}:`, updateMediaError.message);
          failedCount++;
          continue;
        }

        // Untuk foto profil dari registrasi: update profiles.photo_url
        if (asset.domain === 'registration' && asset.owner_id) {
          const { error: updateProfileError } = await supabase
            .from('profiles')
            .update({ photo_url: newSignedUrl })
            .eq('auth_uid', asset.owner_id);

          if (updateProfileError) {
            console.warn(
              `[resign] Gagal update profiles.photo_url untuk owner=${asset.owner_id}:`,
              updateProfileError.message,
            );
            // Tidak fatal — media_assets sudah terupdate, profile bisa sync berikutnya
          }
        }

        resignedCount++;
      } catch (assetError) {
        const msg = assetError instanceof Error ? assetError.message : String(assetError);
        console.error(`[resign] Error pada aset id=${asset.id}:`, msg);
        failedCount++;
      }
    }

    console.log(
      `[resign] Selesai: ${resignedCount} berhasil, ${failedCount} gagal, dari ${expiringAssets.length} aset.`,
    );

    return jsonResponse({
      resigned: resignedCount,
      failed: failedCount,
      total: expiringAssets.length,
      message: `Re-sign selesai: ${resignedCount}/${expiringAssets.length} aset diperbarui.`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'resign-expiring-assets gagal';
    console.error('[resign] Fatal error:', message);
    return jsonResponse({ error: message }, 500);
  }
});
