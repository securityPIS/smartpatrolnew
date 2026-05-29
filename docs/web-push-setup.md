# Web Push Notification (FCM) — Setup

Web push membuat notifikasi tetap muncul di browser/PWA **walau tab atau aplikasi ditutup**,
tanpa Capacitor/Android. Berbasis Firebase Cloud Messaging (FCM HTTP v1).

## Arsitektur singkat

```
Notifikasi baru (INSERT ke tabel notifications)
  └─ trigger dispatch_push_for_notification()  (pg_net)
       └─ Edge Function send-push
            └─ FCM HTTP v1  →  Service Worker browser  →  Notifikasi tampil (tab tertutup pun)
```

- Token FCM per device/user disimpan di tabel `public.push_subscriptions`.
- Klien mendaftarkan token setelah login (minta izin notifikasi), via `firebase-messaging-sw.js`.
- Saat tab aktif (foreground), notifikasi masuk lewat Supabase Realtime — push hanya untuk background.

## Yang sudah ada di repo

- Migration `202605300003_add_push_subscriptions.sql` (tabel + RLS + trigger)
- Edge function `send-push` + helper `_shared/fcm.ts`
- Service worker `public/firebase-messaging-sw.js`
- Klien `src/services/native/pushNotifications.js`
- Config Firebase publik sudah ada di `.env.production` (`VITE_FIREBASE_*`, `VITE_FCM_VAPID_KEY`)

## GitHub Secrets yang perlu di-set (Settings → Secrets and variables → Actions)

Selain 4 secret deploy yang sudah ada (`SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`,
`SUPABASE_DB_PASSWORD`, `CRON_SECRET`), tambahkan:

| Secret | Isi |
|---|---|
| `FCM_SERVICE_ACCOUNT` | **Isi penuh** file JSON service account Firebase (Project Settings → Service accounts → Generate new private key) |
| `APP_URL` | URL aplikasi produksi, mis. `https://smartpatrol.example.com` (untuk deep-link klik notifikasi). Opsional. |

> `FCM_SERVICE_ACCOUNT` bersifat **rahasia** — hanya disimpan sebagai GitHub Secret / Supabase Secret,
> tidak pernah di-commit dan tidak pernah dikirim ke browser.

## Deploy

Jalankan workflow **Actions → Deploy Supabase → Run workflow**. Workflow akan:
1. `supabase db push` → buat tabel `push_subscriptions` + trigger
2. Set Supabase secret `FCM_SERVICE_ACCOUNT` (dan `APP_URL` bila ada)
3. Deploy edge function `send-push`
4. Mengisi `private.app_config(functions_url, cron_secret)` (dipakai trigger)

Jika `FCM_SERVICE_ACCOUNT` belum di-set, langkah web push otomatis dilewati — deploy lain tetap jalan.

## Catatan

- Izin notifikasi diminta otomatis setelah user login (operasional). Jika user menolak, push non-aktif untuk device itu.
- iOS Safari: web push hanya jalan bila aplikasi di-**Add to Home Screen** (PWA), iOS 16.4+.
- Reliabilitas web push bergantung pada browser tidak di-kill total oleh OS (battery saver agresif bisa menunda).
- Token mati otomatis dibersihkan dari `push_subscriptions` saat FCM mengembalikan `UNREGISTERED`/404.

## Troubleshooting: "in-app masuk tapi push notification tidak muncul"

Notifikasi in-app dan web push adalah **dua jalur berbeda**. In-app jalan lewat Supabase
Realtime; web push lewat rantai trigger → `send-push` → FCM → service worker. Jika in-app
muncul tapi push tidak, periksa berurutan:

1. **Apakah aplikasi sedang terbuka/aktif saat diuji?** Ini penyebab #1.
   Saat tab **terlihat (foreground)**, push banner OS sengaja TIDAK ditampilkan —
   yang muncul hanya in-app (lihat `src/services/native/pushNotifications.js`).
   Uji dengan tab di **background atau tertutup**. (Sejak update terbaru, saat tab
   masih hidup tapi tidak terlihat, notifikasi sistem tetap ditampilkan.)

2. **`private.app_config` sudah terisi?** Trigger membaca `functions_url` & `cron_secret`
   dari sini. Jika kosong, trigger **no-op senyap** (sekarang menulis `RAISE NOTICE`).
   Cek di SQL Editor:
   ```sql
   select key, left(value, 40) as value_preview from private.app_config;
   ```
   Bila kosong, jalankan ulang workflow Deploy Supabase atau set manual (lihat bagian Deploy).

3. **Edge function secret terpasang?** `CRON_SECRET` (harus sama dengan `private.app_config.cron_secret`)
   dan `FCM_SERVICE_ACCOUNT` harus ada di Supabase secrets. `send-push` membalas
   `401 unauthorized` bila `x-cron-secret` tak cocok.

4. **Ada token di `push_subscriptions`?** `send-push` mencari token by `user_id` =
   `target_user_id` notifikasi. Bila kosong, balasannya `{ ok: true, sent: 0, reason: 'no-tokens' }`.
   ```sql
   select user_id, left(fcm_token, 12) as token, user_agent from public.push_subscriptions;
   ```
   Pastikan izin notifikasi sudah `granted` dan SW `firebase-messaging-sw.js` aktif
   (Chrome DevTools → Application → Service Workers).

5. **Logs.** Lihat Postgres logs untuk `[send-push]` (notice dari trigger) dan
   Edge Function logs `send-push` di dashboard Supabase untuk respons FCM.
