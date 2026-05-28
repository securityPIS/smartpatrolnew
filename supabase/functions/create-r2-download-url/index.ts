/*
Tujuan: Membuat presigned GET URL Cloudflare R2 (TTL pendek) untuk melihat foto patroli full-res.
Caller: Client (r2Assets.getR2DownloadUrl) saat thumbnail diklik di PhotoPreviewModal.
Dependensi: aws4fetch (SigV4 S3), helper auth/ship-access SmartPatrol, env R2_* (server-only).
Main Functions: Validasi auth + scope kapal, validasi objectKey ada di prefix kapal, presign GET.
Side Effects: Tidak menulis DB; hanya menandatangani URL. Bucket R2 wajib privat.

SETUP SECRET (server-only, JANGAN VITE_):
  supabase secrets set R2_ACCOUNT_ID=... R2_BUCKET=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=...
  supabase functions deploy create-r2-download-url
*/

import { AwsClient } from 'https://esm.sh/aws4fetch@1.0.20';
import {
  assertOperationalShipAccess,
  getAuthUser,
  handleOptions,
  jsonResponse,
  readJsonBody,
  sanitizeString,
} from '../_shared/smartpatrol.ts';

const DOWNLOAD_TTL_SECONDS = 300; // 5 menit

function segment(value: unknown, fallback = 'item') {
  return sanitizeString(value, 120)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/(^-|-$)/g, '') || fallback;
}

function getR2() {
  const accountId = Deno.env.get('R2_ACCOUNT_ID') || '';
  const bucket = Deno.env.get('R2_BUCKET') || '';
  const accessKeyId = Deno.env.get('R2_ACCESS_KEY_ID') || '';
  const secretAccessKey = Deno.env.get('R2_SECRET_ACCESS_KEY') || '';
  if (!accountId || !bucket || !accessKeyId || !secretAccessKey) {
    throw new Error('r2-not-configured');
  }
  const client = new AwsClient({ accessKeyId, secretAccessKey, region: 'auto', service: 's3' });
  const endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
  return { client, bucket, endpoint };
}

Deno.serve(async (request) => {
  const options = handleOptions(request);
  if (options) return options;

  try {
    const user = await getAuthUser(request);
    const payload = await readJsonBody(request);
    const shipId = sanitizeString(payload.shipId, 160);
    await assertOperationalShipAccess(user, shipId);

    // objectKey harus berada di prefix kapal yang sama agar tak bisa lintas-kapal.
    const objectKey = sanitizeString(payload.objectKey, 400);
    const expectedPrefix = `patrol-reports/${segment(shipId, 'ship')}/`;
    if (!objectKey || !objectKey.startsWith(expectedPrefix)) {
      throw new Error('permission-denied');
    }

    const { client, bucket, endpoint } = getR2();
    const url = new URL(`${endpoint}/${bucket}/${objectKey}`);
    url.searchParams.set('X-Amz-Expires', String(DOWNLOAD_TTL_SECONDS));
    const signed = await client.sign(url.toString(), {
      method: 'GET',
      aws: { signQuery: true },
    });

    return jsonResponse({
      url: signed.url,
      expiresAt: new Date(Date.now() + DOWNLOAD_TTL_SECONDS * 1000).toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'r2 download url failed';
    const status = message === 'unauthenticated' ? 401 : message === 'r2-not-configured' ? 503 : 403;
    return jsonResponse({ error: message }, status);
  }
});
