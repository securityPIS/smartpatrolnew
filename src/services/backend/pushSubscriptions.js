/*
Tujuan: Menyimpan/menghapus FCM registration token (web push) pada tabel push_subscriptions.
Caller: services/native/pushNotifications.js saat setup & teardown web push.
Dependensi: Supabase client (RLS push_subscriptions_owner_*), user_id = profile id.
Main Functions: Upsert token milik user aktif, hapus token saat user berganti/logout.
Side Effects: Menulis/menghapus baris public.push_subscriptions.
*/

import { ensureSupabaseClient, isSupabaseConfigured } from './app';

export async function upsertPushSubscription({ userId, token, userAgent } = {}) {
  if (!isSupabaseConfigured || !userId || !token) return;
  const supabase = ensureSupabaseClient();
  const { error } = await supabase
    .from('push_subscriptions')
    .upsert({
      user_id: userId,
      fcm_token: token,
      user_agent: String(userAgent || '').slice(0, 400),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'fcm_token' });
  if (error) throw error;
}

export async function removePushSubscription(token) {
  if (!isSupabaseConfigured || !token) return;
  const supabase = ensureSupabaseClient();
  await supabase.from('push_subscriptions').delete().eq('fcm_token', token);
}
