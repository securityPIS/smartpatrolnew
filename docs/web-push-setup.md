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

3. **Edge function secret terpasang & VALID?** `CRON_SECRET` (harus sama dengan
   `private.app_config.cron_secret`) dan `FCM_SERVICE_ACCOUNT` harus ada di Supabase secrets.
   `send-push` membalas `401 unauthorized` bila `x-cron-secret` tak cocok.

   ⚠️ **Penyebab nyata yang pernah terjadi:** log `send-push` menampilkan
   `pengiriman gagal (rejected) { reason: "FCM_SERVICE_ACCOUNT bukan JSON valid." }`
   sehingga `sent: 0` walau token ada. Artinya isi secret `FCM_SERVICE_ACCOUNT`
   bukan JSON utuh (kepotong / kena smart-quote / salah paste). **Solusi:** download
   ulang file JSON service account di Firebase Console (Project Settings → Service
   accounts → Generate new private key), copy **seluruh** isinya (dari `{` sampai `}`),
   lalu set ulang secret `FCM_SERVICE_ACCOUNT` (GitHub Secret + Run workflow Deploy,
   atau langsung di Supabase → Edge Functions → Secrets). Pastikan ada field
   `client_email`, `private_key`, dan `project_id`.

4. **Ada token di `push_subscriptions`?** `send-push` mencari token by `user_id` =
   `target_user_id` notifikasi. Bila kosong, balasannya `{ ok: true, sent: 0, reason: 'no-tokens' }`.
   ```sql
   select user_id, left(fcm_token, 12) as token, user_agent from public.push_subscriptions;
   ```
   Pastikan izin notifikasi sudah `granted` dan SW `firebase-messaging-sw.js` aktif
   (Chrome DevTools → Application → Service Workers).

5. **Logs.** Lihat Postgres logs untuk `[send-push]` (notice dari trigger) dan
   Edge Function logs `send-push` di dashboard Supabase untuk respons FCM.

## Playbook diagnosis cepat (terbukti, 2026-05-29)

Urutan ini berhasil menemukan & menyelesaikan kasus "in-app masuk tapi push tidak muncul".
Ikuti **berurutan** — tiap langkah mempersempit titik gagal.

1. **Pastikan tes dengan cara benar.** App target harus di **background / layar terkunci /
   tab tertutup**. Saat app aktif di depan, push banner memang tidak ditampilkan (by-design).

2. **Cek konfigurasi DB** (SQL Editor): `select key, left(value,40) from private.app_config;`
   → harus ada `functions_url` & `cron_secret`. Kosong → jalankan workflow Deploy Supabase.

3. **Cek token** (SQL Editor): `select user_id, left(fcm_token,12) from public.push_subscriptions;`
   → harus ada baris untuk user target.

4. **Cek secret** (Supabase → Edge Functions → Secrets): `CRON_SECRET`, `FCM_SERVICE_ACCOUNT`,
   `APP_URL` ada; dan function `send-push` muncul di tab Functions (status deployed).

5. **PALING PENTING — baca Logs `send-push`.** Trigger 1 notifikasi, lalu buka
   Edge Functions → `send-push` → **Logs**. Cari baris `[send-push] ...`:
   - Tidak ada baris `[send-push]` sama sekali → fungsi belum di-deploy ulang (cek
     "X minutes ago" di header; harus baru). Jalankan Deploy Supabase.
   - `request diterima` lalu `token ditemukan { tokenCount: 0 }` → token target tidak ada (langkah 3).
   - `pengiriman gagal (rejected) { reason: "FCM_SERVICE_ACCOUNT bukan JSON valid." }`
     → **inilah akar masalah yang kemarin terjadi.** Secret JSON service account
     rusak/terpotong. **Solusi yang berhasil:** download ulang file JSON di
     Firebase Console (Project Settings → Service accounts → Generate new private key),
     copy **seluruh** isi (dari `{` sampai `}`), set ulang `FCM_SERVICE_ACCOUNT`, re-deploy.
   - `selesai { sent: 1 }` → ✅ terkirim ke FCM. Jika HP tetap tak terima → masalah di
     sisi device (izin notifikasi OS, battery saver mematikan browser).
   - `unauthorized` → `CRON_SECRET` ≠ `private.app_config.cron_secret`.

> Kunci yang membuat diagnosis ini bisa dilakukan: `send-push` & `_shared/fcm.ts`
> menulis log detail di tiap tahap dan menangkap pesan error FCM. Jangan menebak —
> selalu mulai dari **Logs `send-push`**.
