/*
Tujuan: Mengirim Web Push (FCM HTTP v1) untuk satu baris notifikasi ke semua device milik user.
Caller: Trigger DB dispatch_push_for_notification() via pg_net (header x-cron-secret).
Dependensi: Supabase service role (baca/hapus push_subscriptions), helper _shared/fcm.ts,
            env CRON_SECRET, FCM_SERVICE_ACCOUNT, opsional APP_URL.
Main Functions: Validasi cron secret, ambil token FCM user, kirim pesan, bersihkan token mati.
Side Effects: HTTP ke FCM; DELETE push_subscriptions untuk token yang sudah tidak valid.
*/

import { getServiceClient, handleOptions, jsonResponse, readJsonBody } from '../_shared/smartpatrol.ts';
import { sendToToken } from '../_shared/fcm.ts';

function sanitize(value: unknown, maxLength = 240): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f<>]/g, " ").trim().slice(0, maxLength);
}

function buildLink(appUrl: string, payload: Record<string, unknown>): string | null {
  if (!appUrl) return null;
  const base = appUrl.replace(/\/+$/, '');
  const incidentId = sanitize(payload.incidentId || payload.sosId || '', 180);
  if (incidentId) return `${base}/?incidentId=${encodeURIComponent(incidentId)}`;
  return `${base}/`;
}

Deno.serve(async (request) => {
  const options = handleOptions(request);
  if (options) return options;

  try {
    const expectedSecret = Deno.env.get('CRON_SECRET') || '';
    const providedSecret = request.headers.get('x-cron-secret') || '';
    if (!expectedSecret || providedSecret !== expectedSecret) {
      return jsonResponse({ error: 'unauthorized' }, 401);
    }

    const body = await readJsonBody(request);
    const userId = sanitize(body.userId, 160);
    if (!userId) return jsonResponse({ error: 'userId-required' }, 400);

    const type = sanitize(body.type, 80) || 'general';
    const title = sanitize(body.title, 120) || 'SmartPatrol';
    const messageBody = sanitize(body.body, 240);
    const shipName = sanitize(body.shipName, 100);
    const payload = (body.payload && typeof body.payload === 'object') ? body.payload : {};

    const supabase = getServiceClient();
    const { data: subscriptions, error } = await supabase
      .from('push_subscriptions')
      .select('fcm_token')
      .eq('user_id', userId);
    if (error) throw error;

    const tokens = (subscriptions || []).map((row) => row.fcm_token).filter(Boolean);
    if (tokens.length === 0) {
      return jsonResponse({ ok: true, sent: 0, reason: 'no-tokens' });
    }

    const appUrl = Deno.env.get('APP_URL') || '';
    const link = buildLink(appUrl, payload);

    // Data payload FCM harus berupa string semua — dipakai handler foreground/SW untuk routing.
    const data: Record<string, string> = {
      type,
      title,
      body: messageBody,
      route: sanitize(payload.route, 100),
      incidentId: sanitize(payload.incidentId || payload.sosId || '', 180),
      shipName,
      shiftKey: sanitize(payload.shiftKey, 160),
      historyId: sanitize(payload.historyId, 180),
      senderName: sanitize(payload.senderName, 100) || 'SmartPatrol',
      notificationId: sanitize(body.notificationId, 200),
      createdAt: sanitize(payload.createdAt, 80),
    };

    const webpush: Record<string, unknown> = {
      notification: {
        title,
        body: messageBody,
        icon: '/favicon-smartpatrol.svg',
        badge: '/favicon-smartpatrol.svg',
        tag: type,
      },
    };
    if (link) webpush.fcm_options = { link };

    const message = { data, webpush };

    const results = await Promise.allSettled(tokens.map((token) => sendToToken(token, message)));

    const tokensToRemove: string[] = [];
    let sent = 0;
    results.forEach((result) => {
      if (result.status === 'fulfilled') {
        if (result.value.ok) sent += 1;
        if (result.value.shouldRemove) tokensToRemove.push(result.value.token);
      }
    });

    if (tokensToRemove.length > 0) {
      await supabase.from('push_subscriptions').delete().in('fcm_token', tokensToRemove);
    }

    return jsonResponse({ ok: true, sent, total: tokens.length, removed: tokensToRemove.length });
  } catch (error) {
    const messageText = error instanceof Error ? error.message : 'send-push failed';
    return jsonResponse({ error: messageText }, 500);
  }
});
