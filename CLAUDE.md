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
- Petugas pelapor verifikasi **1x per temuan** (`submitIncidentVerification`) hanya bila SEMUA tindak
  lanjut Approved. Sesuai → semua Done + temuan Closed. Belum sesuai → `awaitingSecurityDecision`;
  PIC Security memutuskan: `returnFollowUpToPic`, assign baru, atau `requestReverification`.
- Store masih dummy in-memory (belum ke database).
