# SYSTEM_MAP - SmartPatrol SQL

> Terakhir diperbarui: 2026-05-22.
> Bahasa pemrograman: JavaScript (React 19 + Vite 8), SQL Postgres, Supabase Edge Functions (Deno).

## Project Summary

| Aspek | Detail |
|---|---|
| Tujuan | PWA patroli keamanan kapal/armada laut untuk checkpoint shift, insiden, SOS, dashboard admin/PIC, user, dan kapal. |
| Runtime | Browser SPA, Android WebView via Capacitor, Supabase Edge Functions. |
| Framework | React 19 + Vite 8 + TailwindCSS 4. |
| Backend | Supabase Auth, Postgres, RLS, Storage, Realtime, Edge Functions. |
| Hosting | Vercel untuk SPA; Supabase local/cloud untuk backend. |
| Offline | localStorage untuk state UI, IndexedDB `smartpatrol-images` untuk foto, IndexedDB `smartpatrol-sql/outbox_mutations` untuk retry mutation SQL. |
| Push | Tidak ada FCM/push background pada fase SQL awal; SOS/notifikasi realtime hanya saat app aktif. |
| Data Awal | Kosong bersih. Admin pertama dibuat lewat `npm run setup:admin`. |

## Core Flow

### Login dan Onboarding

```
LoginPage -> AppContextRuntime.handleLogin
  -> services/backend/auth.loginWithFirebaseEmail (alias kompatibel Supabase Auth)
  -> services/backend/access.resolveOperationalAccess
  -> Supabase Edge Function resolve-operational-access
  -> profiles.enabled + review_state approved
  -> saveAuthSession(localStorage) -> render AppShell

Register
  -> Supabase Auth signUp + metadata onboarding publik
  -> trigger auth.users -> pending_registrations bila sesi email-confirmation belum tersedia
  -> uploadRegistrationPhotoAsset (Supabase Storage registration-assets)
  -> pending_registrations insert idempotent bila sesi registrasi tersedia
  -> Admin approval via approve-pending-registration
  -> profiles upsert role/status/ship assignment
```

### Patrol Checkpoint

```
PatrolPage -> PatrolCameraModal -> imageStore IndexedDB
  -> AppContextRuntime.handleSubmitCheckpoint
  -> createTrustedTimestampRecord (Supabase Edge Function server-time anchor)
  -> savePatrolReport
  -> patrol_reports upsert dengan client_event_id idempotent
  -> Supabase Realtime listener merge ke checkpointsByShip
  -> jika offline/gagal: outbox_mutations antre dan flush saat online
```

Foto 2-storage (opsional, flag `VITE_ENABLE_R2_FULL_PHOTO=1`): capture membuat dua varian WebP —
thumbnail (≤360px) di-upload ke Supabase Storage dan ditampilkan inline, full-res (≤2000px) di-upload
ke Cloudflare R2 (presigned PUT) lewat `r2Assets`/`syncPatrolReportToDomain`. Referensi full dicatat di
tabel `patrol_report_photos` (`full_object_key`, `full_media_status`). Klik thumbnail -> `PhotoPreviewModal`
me-mint presigned GET R2 (atau fallback blob full lokal saat offline). Flag off = Supabase-only (degradasi
mulus). Detail di bagian "Pipeline Foto 2-Storage" di bawah.

### Incident dan SOS

```
Incident form/detail -> saveIncidentReport/deleteIncidentReport
  -> incidents payload JSONB + kolom query utama
  -> Supabase Realtime subscribeToIncidents
  -> offline write masuk outbox

SOSButton -> activeSOSAlert lokal
  -> cloud sync SQL + client_mutations signal
  -> perangkat lain menerima perubahan saat app aktif via Realtime
```

### Trusted Time

```
initializeTrustedTime
  -> native Android elapsedRealtime/performance.now
  -> Supabase Edge Function server-time
  -> anchor serverNowMs + drift detection
  -> offline-trusted/offline-interrupted tetap memakai monotonic timer
```

## Important Files

| Path | Peran |
|---|---|
| `src/context/AppContextRuntime.jsx` | Runtime utama state/UI. Import backend sudah diarahkan ke `src/services/backend/*`. |
| `src/services/backend/app.js` | Singleton Supabase browser client dan start outbox worker. |
| `src/services/backend/auth.js` | Supabase Auth wrapper dengan nama ekspor kompatibel context lama. |
| `src/services/backend/access.js` | Pending registration, approval/revoke/sync access via Edge Functions. |
| `src/services/backend/cloudState.js` | Hydrate/decompose state dari/ke tabel SQL dan Realtime signal. |
| `src/services/backend/patrolReports.js` | Upsert/subscribe `patrol_reports`. |
| `src/services/backend/incidentReports.js` | Upsert/subscribe/delete `incidents`. |
| `src/services/backend/assets.js` | Upload Supabase Storage + signed URL. Ekspor `dataUrlToBlob`/`resolveLocalDataUrl` dipakai ulang R2. |
| `src/services/backend/r2Assets.js` | Upload foto full-res ke Cloudflare R2 (presigned PUT) + mint presigned GET; flag `isR2FullPhotoEnabled`. |
| `supabase/functions/create-r2-upload-url/*` | Presigned PUT R2 (auth + scope kapal). |
| `supabase/functions/create-r2-download-url/*` | Presigned GET R2 TTL pendek (auth + scope kapal). |
| `src/services/backend/outbox.js` | IndexedDB outbox mutation retry. |
| `src/services/time/trustedTime.js` | Trusted time anchor memakai Supabase Edge Function. |
| `supabase/migrations/202605220001_init_smartpatrol_sql.sql` | Schema Postgres, RLS, Storage policies, Realtime publication. |
| `supabase/functions/*` | Edge Functions server-time, access, approval, revoke, upload URL, provision user. |
| `scripts/setup-admin.mjs` | Bootstrap admin pertama via service role. |
| `vercel.json` | Header keamanan dan SPA rewrite untuk Vercel. |

## SQL Data Model

Tabel utama:

- `profiles`, `pending_registrations`
- `ships`, `ship_personnel_assignments`, `ship_checkpoints`
- `shift_status_records`, `shift_status_items`
- `patrol_reports`, `patrol_report_photos`
- `incidents`, `incident_progress`, `incident_documentation`
- `sos_alerts`, `sos_acknowledgements`
- `notifications`, `media_assets`, `client_mutations`, `audit_events`

Enum:

- `app_role`: `ADMIN`, `PIC`, `PETUGAS`
- `operational_status`: `active`, `off-duty`, `disabled`
- `review_state`: `pending`, `approved`, `rejected`

RLS:

- ADMIN dapat read/write data operasional.
- PIC/PETUGAS hanya dapat membaca/menulis data kapal yang ditugaskan.
- Pending registration hanya owner atau admin.
- Storage `registration-assets` dibatasi owner/admin.
- Storage `operational-assets` dibatasi user operasional approved.

## Local Commands

```bash
npm install
supabase start
supabase db reset
supabase functions serve
npm run setup:admin -- --token=<token> --email=<email> --password=<password>
npm run dev
npm run test:security
npm run build
```

## Known Migration Notes

- `firebaseUid` masih dipakai sebagai nama field kompatibel di context lama, tetapi nilainya dipetakan ke Supabase `auth_uid`.
- `setupNativePushNotifications` sekarang no-op agar Android tidak meminta izin push dan tidak mendaftarkan token.
- `src/context/AppContext.jsx` legacy dihapus agar tidak ada import backend lama.
- Jika schema/flow utama berubah, update file ini pada sesi yang sama.

## Sinkronisasi Laporan Patroli ke Admin & Petugas Sekapal (bug fix tervalidasi)

Gejala: petugas submit laporan tapi admin (tab On Going) dan petugas lain di kapal
yang sama tidak melihatnya.

Kunci alur (semua pembaca membaca-ulang dari tabel `patrol_reports`):

1. Submit petugas → `handleSubmitPatrol` (`AppContextRuntime.jsx`) set checkpoint
   `status:'completed'` + `shiftKey/shipId/shipName` → `syncPatrolReportToDomain`
   → `savePatrolReport` → upsert `patrol_reports` (onConflict `shift_key,ship_id,checkpoint_id`).
2. Admin & petugas lain menerima lewat `hydrateStateFromSql` (`cloudState.js`, baca
   SEMUA `patrol_reports`) dan `subscribeToPatrolReports` per kapal/shift.
3. Admin On Going = `adminLiveHistoryEntries` membangun live entry dari
   `checkpointsByShip` shift berjalan; History = entry shift lampau + `shift_history_entries`.

Akar masalah & perbaikan (commit `dd75b93`):

- `hydrateStateFromSql` dulu `throw` bila SALAH SATU dari 6 query tabel error,
  sehingga error tabel sekunder (incidents/sos_alerts/notifications) ikut membuang
  laporan patroli. Fix: pisahkan domain inti (`profiles`/`ships`/`patrol_reports`,
  tetap throw → fallback cache) dari domain sekunder (log + anggap kosong).
- `savePatrolReport` dulu menelan SEMUA error tulis sebagai "offline" diam-diam.
  Fix: catat error asli (`code`/`message`/RLS hint) sebelum antre outbox.

Prasyarat agar sinkron jalan:

- Migrasi terbaru `202605280001_add_shift_history_cron.sql` ter-apply (tabel
  `shift_history_entries` + fungsi `finalize_shift`).
- Petugas & admin `enabled=true` + `review_state='approved'`; `profiles.ship_assigned`
  petugas HARUS sama persis dengan `ship_name` laporan (syarat RLS `can_access_ship_name`).
- `VITE_ENABLE_CLOUD_SYNC=1` dan `VITE_ENABLE_CLOUD_SYNC_WRITE=1`.

Cara verifikasi cepat: buka Console browser HP petugas saat submit — bila muncul
`Gagal menulis laporan patroli ke patrol_reports...` berarti tulis ditolak DB
(lihat code/message, biasanya RLS/approval).

## Hasil Patroli "Aman" Hilang di Device Lain (bug fix)

Gejala: di device yang sama hasil patroli benar; di device lain hanya "temuan" yang
tampak benar, "aman" tetap nol, dan "missed" memakan sisa.

Akar masalah: jalur rekonstruksi snapshot penuh
(`createCheckpointsByShipState`/`normalizeShipScopedCheckpoints` lalu
`migrateCheckpointStateToCurrentShift` di `AppContextRuntime.jsx`) membangun ulang
`checkpointsByShip` HANYA dari definisi base checkpoint kapal, lalu MEMBUANG laporan
`completed`/`missed` yang tak cocok base id/nama. Jalur realtime
(`mergePatrolReportDocumentsIntoCheckpoints`) justru mempertahankannya, jadi tidak
konsisten. Laporan "aman" yang dibuang berubah jadi `missed` saat finalisasi shift,
sedangkan "temuan" tetap tampak karena punya cadangan independen di tabel `incidents`.

Perbaikan: pertahankan laporan resolved (completed/missed) yang orphan
(`isResolvedResultCheckpoint`) di kedua fungsi rekonstruksi — orphan shift lampau
dipindah ke history, orphan shift berjalan disambung ke daftar live. Regresi dijaga
oleh `tests/pages/patrol-report-cross-device-sync.test.mjs`.

Catatan terkait: cron `finalize_shift` (migration `202605280001`) bergantung pada tabel
`ship_checkpoints` yang TIDAK pernah ditulis klien (definisi checkpoint disimpan di
JSONB `ships.custom_checkpoints`), sehingga history server-side praktis tidak pernah
terbentuk dan device lain bergantung penuh pada rekonstruksi klien di atas.

### Perbaikan cron finalize_shift (migration `202605290002`)

Migration `202605290002_finalize_shift_from_custom_checkpoints.sql` me-`replace`
`finalize_shift` agar:
- membaca definisi checkpoint langsung dari `ships.custom_checkpoints` (JSONB,
  `jsonb_array_elements ... with ordinality`), bukan dari tabel `ship_checkpoints` kosong;
- mencocokkan laporan TERUTAMA via nama checkpoint ternormalisasi (lower + whitespace
  tunggal) agar tahan terhadap perbedaan `checkpoint_id` antar-device, dengan fallback ke
  id runtime klien `${shipId}::slug::index`;
- menghitung aman/temuan/missed dan menyimpan snapshot checkpoints + `total_count`.

Jadwal cron (`finalize-shift-1/2/3`) tidak diubah — cukup ganti body fungsi. Diverifikasi
behavioral lewat Postgres lokal (aman/temuan/missed benar, termasuk match-by-name saat id
berbeda) dan dijaga `tests/pages/finalize-shift-source.test.mjs`.

## Pipeline Foto 2-Storage (Supabase thumbnail + Cloudflare R2 full-res)

Tujuan: pisahkan thumbnail (kecil, inline) dari full-res (besar, on-demand) agar hemat egress
Supabase dan biaya storage. Aktif hanya bila `VITE_ENABLE_R2_FULL_PHOTO=1` + secret R2 di-set;
bila off, aplikasi Supabase-only seperti sebelumnya (degradasi mulus).

Alur:
1. Capture (`handlePatrolCameraCapture`/`handleAddReportGalleryPhoto`) -> `storePhotoWithVariants`
   membuat thumbnail (≤360px q0.5) + full (≤2000px q0.8) via `src/utils/images.js`
   (`createPhotoVariants`/`resizeDataUrlToWebp`), simpan dua key di IndexedDB. Form/checkpoint
   bawa `photoUrl` (thumb) + `fullPhotoUrl` (full). Kamera dinaikkan ke 2000px sebagai sumber full.
2. Sync (`syncPatrolReportToDomain`): thumbnail di-upload ke Supabase (jalur `prepareCloudPhotoUrl`
   existing); full di-upload ke R2 via `prepareFullPhotoRef` -> `uploadFullPhotoToR2`
   (Edge Function `create-r2-upload-url`, presigned PUT, idempoten lewat `r2AssetCacheRef`).
   Hasil dicatat ke `patrol_report_photos` (`savePatrolReportPhoto`, outbox `patrol_report_photo.upsert`).
   Gagal upload R2 -> antre `failedUploadQueueRef` (`kind:'r2-full'`); fire-and-forget, tak pernah memblok submit.
3. Baca: `patrol_reports` di-select dengan embedded `patrol_report_photos`; `applyFullPhotoRefs`
   (di `patrolReports.js`, dipakai juga `cloudState.reportRowToCheckpoint`) menempel `fullObjectKey`
   ke checkpoint + galleryPhotos.
4. View: `ReportDetailView` kirim `fullObjectKey`/`fullPhotoUrl`/`shipId` ke `PhotoPreviewModal`;
   modal prioritas blob full lokal (offline) -> presigned GET R2 (`create-r2-download-url`) -> fallback thumbnail + badge.

Keamanan: bucket R2 WAJIB privat; objek R2 di luar RLS Storage, otorisasi sepenuhnya di Edge Function
(`assertOperationalShipAccess`: enabled+approved + scope kapal, ADMIN bypass). Secret R2 server-only
(`Deno.env`), bukan `VITE_`. Cron `resign-expiring-assets` di-filter `storage_provider='supabase'`
(R2 pakai presigned GET on-demand, tak perlu resign).

Skema: migration `202605310001_add_r2_photo_storage.sql` — `media_assets.storage_provider` +
`patrol_report_photos.full_storage_provider/full_object_key/full_media_status` (aditif `IF NOT EXISTS`).
Regresi dijaga `tests/pages/photo-variants.test.mjs`, `tests/pages/r2-full-photo.test.mjs`,
`tests/security/r2-access.test.mjs`. Catatan: `aws4fetch` dipakai untuk SigV4 presign R2 di Edge Function;
foto incident-progress belum dipindah ke 2-storage (di luar scope ini).
