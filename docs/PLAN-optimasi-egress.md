# Rencana Optimasi Egress Supabase — SmartPatrol

> Status: **DRAFT / belum dieksekusi**
> Branch: `claude/smartpatrol-vps-capacity-eyElY`
> Tanggal: 2026-06-04
> Tujuan: Menurunkan egress Supabase >95% tanpa mengubah perilaku UI yang sudah benar.

---

## 1. Ringkasan Masalah

Egress Supabase melonjak (sampai `EXCEEDING USAGE LIMITS` di free plan, batas 5 GB/bulan)
walau **belum ada satu pun laporan disubmit** saat screenshot diambil. Akar masalahnya
adalah pola **"full refetch on every realtime event"**: setiap perubahan kecil di salah satu
dari 7 tabel memicu **seluruh client yang online** menarik ulang **semua data dari 6 tabel**.

### Akar masalah utama

| # | Masalah | Lokasi | Dampak |
|---|---------|--------|--------|
| **A** | Realtime listener memanggil `fetchState()` (full hydrate) untuk SETIAP event di 7 tabel | `cloudState.js:405-413` | ~52 MB per submit (20 user) |
| **B** | `select('*')` menarik kolom JSONB besar (`payload`, `personnel`, `documents`, `custom_checkpoints`) padahal tidak semua dipakai | `cloudState.js:327-332` | Payload 2× lebih besar |
| **C** | `profiles` & `ships` di-fetch **tanpa `.limit()`** | `cloudState.js:327-328` | Tumbuh linear seiring jumlah user/kapal |
| **D** | Polling tombstone tiap **15 detik** (240×/hari/user) | `patrolReports.js:309` | ~28 MB/user/hari |
| **E** | `subscribeToPatrolReports` & `subscribeToIncidents` juga full-refetch `select('*')` saat ada event | `patrolReports.js:91-116`, `incidentReports.js:123-153` | Berlipat per kapal aktif |

### Perhitungan egress saat ini (20 user, 1 shift 8 jam)

```
hydrateStateFromSql() sekali fetch ≈ 2.6 MB:
  profiles      (~100 baris × 3 KB)        = 0.3 MB
  ships         (~10 baris × 20 KB JSONB)  = 0.2 MB
  patrol_reports(500 baris × 2 KB)         = 1.0 MB
  incidents     (200 baris × 5 KB JSONB)   = 1.0 MB
  sos_alerts    (20 baris)                 ≈ 0.05 MB
  notifications (120 baris × 0.5 KB)       ≈ 0.06 MB

1 patrol submit → 1 realtime event
  → 20 user × 2.6 MB full refetch = 52 MB per submit

20 user × 6 checkpoint = 120 submit/shift
  → 120 × 52 MB = ~6.2 GB per shift   ← MELEBIHI kuota free 5 GB/bulan dalam 1 hari
```

---

## 2. Tujuan & Non-Tujuan

### Tujuan
1. Turunkan egress realtime dari O(events × users × all_tables) → O(events × payload_satu_baris).
2. Hilangkan/kurangi polling boros.
3. Pertahankan konsistensi state: tidak ada laporan/incident yang hilang atau basi di device lain.
4. Tidak meregresi pola "macet di skeleton" yang sudah diperbaiki (commit `deffdbe`).

### Non-Tujuan (di luar scope rencana ini)
- Migrasi ke Cloudflare/D1 (sudah dianalisis: butuh rewrite, tidak direkomendasikan).
- Mengubah skema database / migration besar.
- Memindahkan foto ke CDN eksternal (foto sudah via Storage signed URL, bukan egress DB).

---

## 3. Strategi Perbaikan (Bertahap)

Diurutkan dari **dampak tertinggi & risiko terendah** lebih dulu, agar tiap fase bisa
di-deploy & diukur terpisah.

### FASE 1 — Quick wins (risiko rendah, dampak ~50%)

Perubahan murni "kurangi ukuran/frekuensi", **tanpa mengubah arsitektur sinkronisasi**.
Aman dirilis lebih dulu.

#### 1.1 Tambah `.limit()` pada `profiles` & `ships`
- **File:** `src/services/backend/cloudState.js:327-328`
- **Sebelum:**
  ```js
  supabase.from('profiles').select('*').order('name', { ascending: true }),
  supabase.from('ships').select('*').order('name', { ascending: true }),
  ```
- **Sesudah:** tambahkan `.limit(1000)` (profiles) dan `.limit(200)` (ships) sebagai batas aman.
- **Catatan:** verifikasi dulu jumlah baris realistis agar limit tidak memotong data sah.

#### 1.2 Ganti `select('*')` → daftar kolom eksplisit
- **File:** `cloudState.js:327-332`, `patrolReports.js:94`, `incidentReports.js:130`
- **Risiko utama:** kolom `payload` (JSONB) dipakai luas oleh `reportRowToCheckpoint`,
  `incidentRowToState`, dan `incidentMeta` (`row.payload.progress`, `row.payload.documentation`).
  **Tidak boleh** dibuang sembarangan.
- **Aksi:** untuk tiap tabel, daftar persis kolom yang dibaca oleh fungsi mapper-nya:
  - `profiles` → kolom yang dipakai `profileToUser` (cloudState.js:20-44).
  - `ships` → kolom yang dipakai `shipToState` (cloudState.js:47-69) — termasuk JSONB
    `personnel`, `documents`, dll, jadi penghematan di sini kecil; **prioritas rendah**.
  - `patrol_reports` / `incidents` → tetap butuh `payload`; penghematan dari membuang
    kolom audit yang tak terpakai saja.
- **Kesimpulan realistis:** penghematan dari 1.2 lebih kecil dari dugaan awal karena `payload`
  memang dibutuhkan. **Fokus utama tetap di FASE 2.**

#### 1.3 Naikkan interval polling tombstone 15s → 60s
- **File:** `src/services/backend/patrolReports.js:309`
- **Sebelum:** `const POLL_INTERVAL_MS = 15000;`
- **Sesudah:** `const POLL_INTERVAL_MS = 60000;`
- **Dampak:** polling fallback turun 75%. Risiko: penghapusan temuan butuh ≤60s untuk
  terlihat di device lain via jalur polling (jalur realtime tetap instan).

---

### FASE 2 — Delta update (risiko sedang, dampak ~95%) ★ INTI

Ini perbaikan paling berdampak. Mengubah listener realtime dari **full refetch** menjadi
**update baris tunggal** dari `payload` event yang sudah dikirim Supabase.

#### Masalah arsitektur saat ini
`subscribeToCloudAppState` (`cloudState.js:388-419`) memanggil `fetchState()` yang menjalankan
`hydrateStateFromSql()` (full 6-tabel) pada **setiap** event. Callback `callback(payload)`
mengirim **snapshot state utuh** ke `AppContextRuntime`.

#### Pendekatan yang diusulkan
Supabase realtime `postgres_changes` mengirim `payload.new` (baris baru/diubah) dan
`payload.old` + `payload.eventType` (`INSERT`/`UPDATE`/`DELETE`). Manfaatkan ini:

1. **Hydrate penuh hanya sekali** saat subscribe (cold start) — tetap seperti sekarang.
2. **Untuk tiap event berikutnya**, kirim **patch granular** ke konsumen, bukan refetch:
   ```js
   .on('postgres_changes', { event: '*', table: 'patrol_reports' }, (payload) => {
     applyDelta('patrol_reports', payload);  // update 1 baris di state lokal
   })
   ```
3. Tambahkan API baru pada modul `cloudState.js`, mis. `subscribeToCloudAppStateDelta` yang
   memanggil dua jenis callback:
   - `onHydrate(fullPayload)` — sekali di awal / saat reconnect.
   - `onDelta({ table, eventType, row })` — per perubahan.

#### Konsekuensi di `AppContextRuntime.jsx`
Konsumen saat ini menerima **state utuh** dan me-replace. Perlu fungsi reducer yang
menggabungkan satu baris ke state yang ada (insert/update/delete by id). Ini bagian
**paling sensitif** dan butuh:
- Pemetaan `row → entitas state` memakai mapper yang sudah ada (`reportRowToCheckpoint`,
  `incidentRowToState`, `profileToUser`, `shipToState`).
- Penanganan `DELETE` (hapus by id) dan dedup terhadap mutasi lokal/outbox yang belum sync.
- Tetap menyimpan snapshot cache (`saveCacheSnapshot`) secara periodik/throttled, bukan tiap delta.

#### Mitigasi risiko konsistensi
- **Reconnect/regain focus:** saat WebView resume atau channel `SUBSCRIBED` ulang, **wajib
  hydrate penuh sekali** untuk menutup celah event yang terlewat saat offline.
  (Selaras dengan catatan CLAUDE.md soal resume WebView — hati-hati jangan picu skeleton.)
- **Throttle/debounce:** bila banyak delta beruntun (mis. bulk insert), batch update state
  dalam 1 render.
- **Fallback:** jika `payload.new` tidak lengkap (mis. kolom besar dipotong oleh konfigurasi
  realtime), fallback fetch baris tunggal `by id` — tetap jauh lebih murah dari full hydrate.

---

### FASE 3 — Optimasi subscription domain (risiko sedang, dampak tambahan)

Terapkan pola delta yang sama ke:
- `subscribeToPatrolReports` (`patrolReports.js:87-122`) — kini full-refetch `select('*')`
  per event, dan bisa ada **beberapa instance** (per kapal). Ubah ke delta by `payload`.
- `subscribeToIncidents` (`incidentReports.js:123-153`) — payload incident besar
  (array `progress`/`documentation`); delta sangat menghemat.

---

## 4. Analisis Risiko

| Risiko | Tingkat | Mitigasi |
|--------|---------|----------|
| State drift (delta merge salah → data hilang/duplikat) | **Tinggi** | Reducer by-id + hydrate penuh saat reconnect + test integrasi |
| Regresi "macet di skeleton" saat resume WebView | Sedang | Patuhi pola commit `deffdbe`: sesi hangat re-validasi di background, jangan blok UI |
| `payload.new` terpotong/realtime tidak kirim kolom besar | Sedang | Fallback fetch single-row by id |
| `.limit()` memotong data sah (user/kapal > limit) | Rendah | Verifikasi count nyata sebelum set limit; pilih limit lapang |
| Penghapusan temuan telat tampak (polling 60s) | Rendah | Jalur realtime DELETE tetap instan; polling hanya fallback |
| Race antara delta realtime & outbox flush lokal | Sedang | Dedup by `client_event_id`; mutasi lokal menang sampai server konfirmasi |

---

## 5. Rencana Pengujian

### Test otomatis (sesuai CLAUDE.md)
- `npm install` (container fresh).
- `npm run build` (vite) — wajib lulus.
- `npm run test:security` (15 test) — tidak boleh regresi.
- Test halaman (49 test) — tidak boleh regresi.

### Test fungsional manual (skenario kritis)
1. **Submit pertama & kedua + ambil foto** — pastikan TIDAK macet di skeleton (regresi `deffdbe`).
2. **Dua device, satu shift:** submit di device A → muncul di device B via delta (bukan full refetch).
3. **Hapus temuan di device A** → hilang di device B (jalur realtime instan, polling ≤60s fallback).
4. **Offline → online:** outbox flush + hydrate penuh sekali saat reconnect, tidak ada duplikat.
5. **Resume dari background (kamera native):** state konsisten, tidak ada skeleton macet.

### Pengukuran egress (validasi tujuan)
- Sebelum & sesudah tiap fase: pantau **Network throughput** & **Egress** di dashboard Supabase
  (Observability → Database / Reports) pada beban uji yang sama (mis. 20 submit terkontrol).
- Target: penurunan kumulatif >95% setelah FASE 2.

---

## 6. Urutan Eksekusi & Commit

| Langkah | Isi | Commit terpisah? |
|---------|-----|------------------|
| 1 | FASE 1.1 + 1.3 (limit + interval polling) | Ya — quick win, mudah di-revert |
| 2 | FASE 1.2 (kolom eksplisit, yang aman saja) | Ya |
| 3 | FASE 2 (delta `subscribeToCloudAppState` + reducer di AppContextRuntime) | Ya — perubahan inti, review hati-hati |
| 4 | FASE 3 (delta patrolReports & incidents) | Ya |
| 5 | Update `CLAUDE.md` dengan pola "delta sync" sebagai catatan arsitektur | Ya |

> Setiap fase di-build + test sebelum lanjut. Push ke `claude/smartpatrol-vps-capacity-eyElY`.
> Tidak membuat PR kecuali diminta.

---

## 7. Estimasi Hasil Akhir

| Metrik | Sebelum | Sesudah (proyeksi) |
|--------|---------|--------------------|
| Egress per submit (20 user) | ~52 MB | ~0.05–0.1 MB (1 baris × 20 user) |
| Egress per shift (20 user, 120 submit) | ~6.2 GB | ~0.1–0.3 GB |
| Polling tombstone/user/hari | ~28 MB | ~7 MB |
| Muat di Supabase Free (5 GB/bln) | ❌ habis <1 hari | ✅ cukup untuk operasi normal |

---

## 8. Pertanyaan Terbuka (perlu konfirmasi sebelum eksekusi)

1. Berapa jumlah realistis **user** & **kapal** di produksi? (untuk set `.limit()` yang aman)
2. Apakah Supabase realtime di project ini dikonfigurasi mengirim **full row** di `payload.new`
   (REPLICA IDENTITY FULL)? Menentukan apakah perlu fallback fetch single-row.
3. Apakah ada konsumen lain dari `subscribeToCloudAppState` selain `AppContextRuntime` yang
   bergantung pada bentuk "state utuh"?
