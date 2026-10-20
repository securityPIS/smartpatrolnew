# SmartPatrol — Catatan untuk Claude

## Arsitektur singkat
- React 19 SPA + Capacitor (Android WebView). Auth via Supabase (`onAuthStateChange`, `autoRefreshToken: true`).
- Gerbang skeleton: `isAuthSessionRestoring` di `AppContextRuntime.jsx` mengontrol `LoadingSkeleton` di `App.jsx`.
- Outbox IndexedDB untuk mutasi offline. Trusted time sync tiap 5 menit (`trustedTime.js`).

## Pola bug "macet di skeleton setelah take foto" (SUDAH DIPERBAIKI — commit deffdbe)
Gejala: submit laporan pertama lancar; submit kedua setelah ambil foto macet di skeleton;
harus diam ~5 menit + restart app baru bisa submit lagi.

### Akar masalah
1. Kamera native (`Camera.getPhoto`) membuat WebView ke background → saat resume Supabase
   fire `TOKEN_REFRESHED`/`SIGNED_IN` untuk **UID yang sama**.
2. Listener auth (lama) mereset `authAccessResolvedUid=''` + `authAccessBusy=true` tanpa syarat
   → skeleton muncul.
3. `resolveOperationalAccess()` memanggil Edge Function **tanpa timeout** → di jaringan jelek
   socket basi menggantung bermenit-menit → skeleton macet sampai TCP timeout (~5 mnt) atau
   restart app (socket baru).

### Perbaikan tiga lapis (pola yang harus diingat)
1. **Listener guard** (`AppContextRuntime.jsx`): pakai `authAccessResolvedUidRef` (mirror via
   `useEffect`) supaya listener `deps: []` bisa membedakan token-refresh UID-sama-sudah-resolve
   dari login UID baru. Jangan reset gerbang sesi untuk UID yang sama & sudah ter-resolve.
2. **Timeout request** (`services/backend/access.js`): `withRequestTimeout()` (Promise.race +
   setTimeout) membungkus `resolveOperationalAccess()`, `RESOLVE_ACCESS_TIMEOUT_MS = 8000`.
   Gagal cepat → retry self-heal / fallback offline ambil alih.
3. **Skeleton hanya untuk cold start** (`isAuthSessionRestoring`): jika `sessionUserRecord`
   sudah ada (sesi hangat), re-resolve di latar belakang TIDAK boleh menutup UI dengan skeleton.

### Prinsip umum
- Semua `supabase.functions.invoke` yang menggerbang UI WAJIB punya timeout.
- Event auth dari resume WebView (UID sama) jangan diperlakukan seperti login baru.
- Sesi hangat → re-validasi di background, jangan blok UI.

## Pola bug "mental logout sendiri" (PIC/Admin, browser HP)
Log Supabase: tidak ada refresh gagal/logout server, tapi user login ulang berkali-kali → reset
sesi berasal dari validator klien (`resetAuthSession`, tidak sign-out Supabase).
- Validator sesi dulu me-reset "Sesi login tidak lagi valid." SEBELUM guard `firebaseAuthReady`/
  `authAccessBusy` → saat cold start / sinkron data user (ID sesaat tak cocok) sesi sehat ditendang.
  Sekarang jalur Supabase menunggu auth siap & akses definitif; user lokal yang sesaat hilang → tunggu.
- Setiap logout otomatis dicatat (`src/utils/autoLogoutLog.js`, localStorage
  `smartpatrol:auto-logout-log`, 20 entri + konteks state) dan tampil di LoginPage ("Anda keluar
  otomatis" + kode). Minta user kirim kode itu bila masih terjadi.

## Workflow git
- Develop di branch fitur, lalu merge ke `main` (fast-forward bila bisa: `git fetch` →
  `git merge --ff-only`), push `origin main`. Jangan buat PR kecuali diminta.

## Build & test
- `npm install` dulu (container fresh sering belum ada deps; gejala: `vite: not found`).
- `npm run build` (vite). `npm run test:security` (15 test). Test halaman: 49 test.

## Titik checkpoint main/sub + NFC
- Definisi titik ada di `ships.customCheckpoints` (model & normalisasi: `src/utils/shipCheckpoints.js`):
  `type` main/sub, `parentId`, `nfcTagId`, `referencePhotoUrl` (foto kondisi awal, wajib bersama NFC).
  Admin mengatur di Armada → kapal → tab TITIK (`ShipCheckpointsTab.jsx`).
- Patroli: TIDAK ada tombol Aman/Temuan untuk titik ber-NFC. `usePatrolNfcScan` scan terus di tab
  Checkpoint → tag cocok (UID chip atau isi NDEF) → `PatrolNfcChoiceSheet` (foto acuan + Aman/Temuan)
  → `handleActionClick(id, type, nfcVerification)`; laporan menyimpan `nfcVerification`.
  Titik tanpa NFC (tambahan shift/belum didaftarkan) bisa dibuka manual (ditandai "Tanpa NFC").
- NFC native via `@capgo/capacitor-nfc` (`services/native/nfc.js`); browser pakai Web NFC. Setelah ubah
  plugin jalankan `npx cap sync android` (hapus lagi file generated yang tak di-track).

## Verifikasi temuan (tindak lanjut) — `src/components/incidentFollowUp/`
- Status tindak lanjut: Need Action → Need Review → (PIC Security) **Approved** → Done. "Konfirmasi
  Rencana" mengembalikan ke Need Action; hanya "Approve" yang dihitung selesai.
- Setelah SEMUA tindak lanjut Approved (state `READY`), PIC Security memilih:
  - **UNSOLVE** (`unsolveIncident(incident, …)`): hanya status temuan jadi Unsolved; status tiap tindak
    lanjut TETAP Approved (jangan diubah). Catatan wajib, evidence opsional. Temuan bukan Aman bukan Closed. Kondisi saat unsolve (evidence, atau foto
    temuan bila kosong) jadi foto acuan baru titik (`referenceOverridesByCheckpoint`, kunci `shipId|nama`).
  - **NEED VERIFICATION**: `requestIncidentVerification` (notifikasi ke SEMUA petugas security di kapal
    temuan, bukan hanya pelapor → state `AWAITING_VERIFICATION`, salah satu petugas kapal itu verifikasi) ATAU PIC Security verifikasi sendiri
    (`submitIncidentVerification(..., { bySecurity: true })`). Sesuai → semua Done + Closed.
  - Belum sesuai → `awaitingSecurityDecision`; PIC Security: `returnFollowUpToPic`, assign baru,
    `requestReverification`, atau Unsolve. Assign baru / kembalikan ke PIC membatalkan permintaan verifikasi.
- Label status per POV role (`getFollowUpStatusView` / `getIncidentStatusView` di store): pola **Need …**
  (giliran role itu, badge terang + "Your action") vs **Waiting …** (menunggu pihak lain, redup). Contoh:
  assign → Security "Waiting Action", PIC terkait "Need Action", Petugas "In Progress"; Need Review ↔
  Waiting Review; revisi → Waiting Revision ↔ Need Revision; Approved (Petugas: Work Done). Header temuan:
  Need Assign / In Progress (x/y) / Need Decision / Waiting|Need Verification / Waiting Decision / Closed / Unsolved.
- Assign baru atau Kembalikan ke PIC saat Need Verification → permintaan verifikasi otomatis DITUNDA
  (entry `postpone`, `postponedNotice`) dan petugas melihat kartu "Verification Postponed" + alasannya.
- Patroli (`PatrolPage` + `PatrolNfcChoiceSheet`): temuan patroli di titik (kapal+nama) yang belum
  Closed/Unsolve = OPEN (`isPatrolTemuanOpen`) → pilihan tap jadi TEMUAN BARU / UPDATE TEMUAN (berlaku
  juga untuk tap NFC asli). Update Temuan membuka detail temuan (`patrolUpdateIntentAt`) langsung ke form
  update riwayat sebagai Petugas. Tanpa temuan open → AMAN/TEMUAN, foto acuan pakai override Unsolve.
- Item checkpoint pending tidak lagi punya badge "Tap NFC"/"Tanpa NFC"; diganti tombol "Simulasi Tap"
  (buka sheet tanpa verifikasi NFC; checklist terkunci → buka modal status shift; akun yang tak bisa
  patroli kapal ini melihat alasan, tombol lapor nonaktif). "+ Update" Riwayat Update hanya role Petugas.
- Titik contoh "Pagar Dek Kiri (Contoh)" berstatus UNSOLVE selalu tampil paling atas di daftar checkpoint
  (`demoUnsolveCheckpoint.js`, data dummy): klik → sheet info unsolve (temuan awal, catatan PIC Security,
  foto kondisi saat unsolve) + AMAN/TEMUAN; pilihan hanya toast, tidak membuat laporan.
- Store masih dummy in-memory (belum ke database).
