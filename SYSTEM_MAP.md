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

### Auth Session Offline Guard

```
Supabase Auth listener
  -> getSession lokal untuk initial restore
  -> SIGNED_OUT/auth-null INVOLUNTER ditandai transient (flag explicitFirebaseLogout=false)
  -> AppContextRuntime mempertahankan firebaseAuthUser terakhir / sessionUserRecord
  -> authAccessOfflineUid menjaga sesi patroli sampai koneksi pulih
```

Catatan: hanya logout EKSPLISIT pengguna yang membersihkan sesi. `logoutFirebaseUser()`
men-set flag modul `explicitFirebaseLogout` selama `supabase.auth.signOut()`, sehingga
`SIGNED_OUT` yang menyusul ditandai `explicit:true` dan listener membersihkan sesi.
Auth-null involunter — `SIGNED_OUT` dari refresh token yang gagal, atau saat browser
offline — SELALU transien (tidak bergantung `navigator.onLine`, karena "internet hilang"
≠ "radio terputus": `navigator.onLine` bisa tetap `true` tanpa data). Ini mencegah petugas
ketendang login saat menekan tombol "Sync Laporan" / submit patroli di jaringan buruk.
Pencabutan akun (disabled/rejected/restricted) tetap ditegakkan jalur `resolveOperationalAccess`
→ `handleLogout` saat benar-benar online, bukan oleh listener auth.

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
| `src/services/backend/assets.js` | Upload Supabase Storage + signed URL. |
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

## Laporan Offline Tidak Muncul di Device Lain (bug fix)

Gejala: laporan (aman/temuan) yang disubmit terlihat benar HANYA di device pembuat. Di device
lain temuan tidak ada, jumlah "aman" beda, dan submit offline tidak pernah muncul walau sudah
kembali online.

Akar masalah: `syncPatrolReportToDomain` (`AppContextRuntime.jsx`) — satu-satunya jalur yang
menulis tabel `patrol_reports` — langsung `return null` saat `isOffline`. Submit offline jadi
TIDAK ditulis dan TIDAK diantrekan ke outbox. Jalur reconnect `requestCloudSync` hanya menyinkron
`profiles`/`ships` (lihat `cloudState.js` `writeStateToSql`), bukan `patrol_reports`, sehingga
laporan offline hanya hidup di state lokal device pembuat dan tak pernah sampai ke device lain.

Perbaikan:
- Penjaga `syncPatrolReportToDomain` tidak lagi memakai `isOffline`. Saat offline, `savePatrolReport`
  tetap dipanggil; tulisan gagal otomatis masuk outbox IndexedDB (`patrol_report.upsert`) dan
  ter-flush saat online (`startSqlOutboxWorker`, listener `online` + interval) → terlihat di
  semua device sekapal/ADMIN/PIC sesuai RLS.
- Upload media dilewati saat `isOffline` (Storage tak terjangkau); baris laporan tetap diantrekan,
  foto lokal disimpan di `patrolReportLocalMediaRef` untuk unggah ulang saat online.
- `savePatrolReport` mengantre dengan id deterministik (`createClientEventId`) agar submit offline
  berulang untuk titik yang sama menimpa antrean, bukan menumpuk duplikat.

Catatan: baris laporan (status/resultType/penyebab/kejadian/tindakLanjut + hitungan aman/temuan)
tersinkron lintas-device walau disubmit offline.

Foto laporan offline: `healPatrolReportMedia` + efeknya (`AppContextRuntime.jsx`) menaikkan foto
checkpoint kapal operasional yang masih lokal (`idb://`) ke Storage saat online, lalu menulis
SEKALI ke `patrol_reports` dengan URL `https` (tanpa strip-null lebih dulu, jadi tak ada jendela
foto kosong) dan menyelaraskan state lokal ke URL `https` agar konvergen (tidak diunggah berulang /
flap). Upload media helper di-ekstrak ke `uploadPatrolReportDomainMedia` dan dipakai bersama oleh
`syncPatrolReportToDomain` dan `healPatrolReportMedia`.

Notifikasi error di layar (diagnosa di HP): `savePatrolReport` membedakan gagal offline
(diantrekan, wajar) dari penolakan server (RLS/constraint/auth → `syncError`).
`syncPatrolReportToDomain` mengembalikan status (`ok`/`offline`/`blocked`/`no-access`/
`sync-disabled`) dan, untuk submit eksplisit (`notifyOnError`), memanggil
`notifyPatrolSyncIssue` → `setConfirmDialog` agar penyebab laporan tak sampai ke device
lain MUNCUL di layar (mis. nama kapal `ship_assigned` ≠ `ship_name`, akun belum approved,
atau cloud nonaktif) — tidak lagi gagal diam-diam. `ConfirmModal` memakai `whitespace-pre-line`.

### Akar gagal sinkron lintas-device: bigint vs milidetik pecahan

Gejala (terungkap lewat notifikasi error di layar): `invalid input syntax for type bigint:
"1779986567403.7"`. Penyebab: `performance.now()` membawa presisi sub-ms, sehingga
`occurredAtTrustedMs` (dari `getTrustedNowMs()`) berisi pecahan. Kolom `*_trusted_ms` dan
`client_updated_at_ms` di Postgres bertipe `bigint` → setiap tulisan `patrol_reports`
(dan `incidents`) ditolak, laporan tak pernah masuk DB, jadi tak terlihat di device lain
(ONLINE maupun offline). Inilah akar "berfungsi hanya di device sama".

Perbaikan:
- `trustedTime.js` `buildTrustedTimeSnapshot`: `nowMs = Math.round(getTrustedNowMs())` —
  semua timestamp baru jadi integer ms.
- `mapReportToRow`/`mapIncidentToRow` + insert `client_mutations`: `Math.round` pada kolom
  `*_ms` — juga memperbaiki laporan LAMA yang sudah terlanjur diantrekan di outbox dengan
  nilai berkoma (saat flush ulang).

Regresi dijaga `tests/pages/patrol-report-offline-sync.test.mjs`.

## Checkpoint Hilang Saat Back Online (bug fix)

Gejala: setelah perbaikan anti-logout reconnect, petugas tetap login saat koneksi pulih,
tetapi daftar titik patroli kosong total ("Belum ada titik patroli yang tersedia", progres
0/0). Di-refresh manual langsung normal.

Akar masalah: efek resolver akses (`AppContextRuntime.jsx`, deps `[firebaseAuthReady,
firebaseAuthUser]`) re-run saat reconnect (token refresh mengubah `firebaseAuthUser`).
Bila `resolveOperationalAccess()` gagal sesaat di momen reconnect, `.catch` men-set
`authAccessState=null` + `authAccessOfflineUid=currentUid` lalu BERHENTI (tidak pernah
retry). Akibatnya `authAccessEnabled=false` → `currentUserRecord` kolaps ke `null` (online)
→ `operationalShip` null → `checkpoints` memo `[]`. State macet sampai refresh penuh
me-resolve ulang. Ini efek samping dari fix anti-logout: logout dicegah, tapi akses gagal
dibiarkan macet.

Perbaikan (seamless, tanpa reload):
- Self-heal retry: state `authAccessResolveNonce` ditambahkan ke deps resolver. Efek baru
  `authAccessRetryRef` menjadwalkan re-resolve berbackoff (≤6 kali) saat akses belum
  ter-resolve & belum definitif & online & tidak busy; reset saat offline/teratasi. Begitu
  `resolveOperationalAccess` berhasil, `authAccessState.access` pulih →
  `buildOperationalUserRecordFromAccess` mengisi `shipAssigned`/`status` dari server →
  `operationalShip` & checkpoint kembali otomatis.
- Anti-blink: `currentUserRecord` hanya kolaps ke `null` saat resolusi DEFINITIF
  (`authAccessResolvedUid === firebaseAuthUid`). Saat resolusi gagal/menunggu retry,
  pertahankan record terakhir (`resolvePreferredUserRecord(usersData)`/`sessionUserRecord`)
  agar operationalShip tetap resolve dan checkpoint tidak hilang.

Konsisten dengan prinsip: sesi/akses operasional hanya berubah karena jawaban DEFINITIF
server, bukan kegagalan jaringan transien. Regresi dijaga `tests/security/auth-access.test.mjs`
("resolusi akses sembuh sendiri setelah reconnect").

**Status: TERVERIFIKASI di device (2026-05-29). Checkpoint kembali otomatis tanpa refresh manual.**

## Notifikasi Cron Tidak Pernah Muncul (checkpoint pending / wrap-up) (bug fix)

Gejala: notifikasi cronjob — `checkpoint_pending`, `checkpoint_pending_summary`, dan
`shift_wrap_up` — TIDAK pernah muncul. Bukan hanya push yang gagal; di in-app notif pun
tidak ada satu pun baris yang masuk.

Akar masalah (regresi dari kelas bug yang sama dengan `finalize_shift`): fungsi
`notify_checkpoint_pending` dan `notify_shift_wrapup` (migration `202605300002`)
mengiterasi kapal lewat `where exists (select 1 from ship_checkpoints sc where
sc.ship_id = s.id and sc.active = true)`. Padahal tabel `ship_checkpoints` TIDAK pernah
ditulis klien — definisi titik patroli disimpan di `ships.custom_checkpoints` (JSONB).
Akibatnya loop kapal mencocokkan NOL baris → body loop tak pernah jalan → `v_admin_lines`
tetap kosong → TIDAK ADA `insert` ke `public.notifications`. Karena tak ada baris notif
yang masuk, trigger `dispatch_push_for_notification` pun tak pernah terpicu (jadi push
ikut hilang). Bug ini sudah pernah diperbaiki untuk `finalize_shift` di `202605290002`,
tetapi cron notifikasi (dibuat sehari setelahnya) memakai ulang pola lama yang salah.

Perbaikan (migration `202605300005_fix_notification_cron_from_custom_checkpoints.sql`,
`replace` kedua fungsi — jadwal cron tidak diubah):
- iterasi kapal lewat `ships.custom_checkpoints` (array non-kosong), bukan
  `ship_checkpoints`;
- total checkpoint = `jsonb_array_length(custom_checkpoints)`;
- `notify_checkpoint_pending`: hitung pending per elemen JSONB (`jsonb_array_elements ...
  with ordinality`), cocokkan laporan `completed` TERUTAMA via nama checkpoint
  ternormalisasi (lower + whitespace tunggal), fallback id runtime `${shipId}::slug::index`;
- `notify_shift_wrapup`: tetap baca `shift_history_entries` lebih dulu; fallback hitung
  total dari `custom_checkpoints` (missed di-clamp `greatest(0, ...)`).

Regresi dijaga `tests/pages/notification-cron-source.test.mjs` (memastikan kedua fungsi
membaca `custom_checkpoints`, tidak lagi `ship_checkpoints`, dan match-by-name tersedia).
