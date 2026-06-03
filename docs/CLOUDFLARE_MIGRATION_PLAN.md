# SmartPatrol → Full Cloudflare Rebuild — Planning

> Repo baru: `securityPIS/SmartpatrolCloudflare` (greenfield, repo Supabase lama TETAP jalan & tidak disentuh).
> Keputusan yang sudah dikunci:
> 1. **Full Cloudflare** (Workers + D1 + R2 + Durable Objects + custom auth). Supabase lama dibiarkan hidup paralel.
> 2. **Zustand** (store kecil per-slice) untuk memecah `AppContextRuntime.jsx` (11.034 baris) jadi context/slice sangat kecil.
> 3. **Firebase FCM dipertahankan** untuk push.
> 4. Arsitektur **clean architecture**, dipecah jadi **microtask** (1 concern = 1 PR/commit).

---

## 1. Kenapa & sasaran

Masalah inti kode lama: `src/context/AppContextRuntime.jsx` = **11.034 baris**, 71 `useState`,
55 `useEffect`, 41 `useRef`, 106 `useCallback`, 47 `useMemo`. Satu file ini menggabungkan
auth, patrol, incident, sos, ship, user, notifikasi, time, outbox → setiap render menyentuh
semua, susah di-maintain, dan permukaan bug/security besar.

Sasaran rebuild:
- **Security**: authorization eksplisit & teruji (gantikan RLS Postgres), tiap endpoint punya
  policy unit-test; rahasia hanya di server (Worker secrets), bukan di bundle client.
- **Performance**: store granular (Zustand) → re-render minimal; edge compute (Workers) dekat
  pengguna; asset immutable di Pages CDN.
- **Maintainability**: clean architecture berlapis + feature-sliced di web; microtask kecil.

---

## 2. Pemetaan komponen (Supabase → Cloudflare)

| Lama (Supabase/Vercel) | Baru (Cloudflare) | Catatan migrasi |
|---|---|---|
| Vercel (SPA) | **Cloudflare Pages** | `vercel.json` headers → `_headers` + `_redirects` |
| Supabase Auth | **Custom auth Worker** | email+password, hashing `@noble/hashes` (scrypt/argon2), JWT access + refresh session di D1/KV |
| Postgres + **RLS** | **D1 (SQLite)** + Drizzle | RLS → policy authorization di layer aplikasi Worker (teruji) |
| pg triggers (tombstone, finalize_shift) | **Use-case Worker** | logika eksplisit + test, bukan trigger tersembunyi |
| pg_cron | **Cloudflare Cron Triggers** | `scheduled()` handler |
| Supabase Realtime | **Durable Objects + WebSocket** | 1 DO per kapal (`ShipChannel`), fan-out sinyal perubahan |
| Supabase Storage | **R2** | signed upload/GET URL via Worker |
| Edge Functions (Deno) | **Workers routes (Hono/TS)** | tulis ulang 11 fungsi |
| Edge fn `server-time` | **Worker `/server-time`** | trusted time anchor |
| **Firebase FCM** | **TETAP FCM** | `send-push` Worker → FCM HTTP v1; web client tetap pakai Firebase SDK utk token |
| Outbox IndexedDB | **TETAP** (client) | offline mutation retry |
| Capacitor Android | **TETAP** | hanya ganti base URL API |
| `.env` / Supabase secrets | **Wrangler secrets + Pages env** | |

### Catatan teknis penting
- **Email**: Supabase Auth dulu mengirim email konfirmasi/approval. Cloudflare tidak punya
  email bawaan → butuh provider (rekomendasi **Resend**, free tier ~3k/bln). Ini tugas Anda set up.
- **Durable Objects**: kini tersedia di Workers free plan (SQLite-backed) — verifikasi limit;
  untuk produksi pertimbangkan **Workers Paid ($5/bln)**.
- **D1 limit**: free ~5GB; cukup untuk skala app ini. JSONB → kolom TEXT/JSON. `bigint`
  (`*_trusted_ms`) → SQLite INTEGER (64-bit) aman; tetap `Math.round` di client.
- **Hilangnya RLS** = bug authz jadi bug aplikasi → dimitigasi dengan **matriks test policy**
  (Phase 2) yang meniru aturan RLS lama persis.

---

## 3. Struktur repo target (monorepo, clean architecture)

```
SmartpatrolCloudflare/
├─ apps/
│  ├─ web/                      # React 19 + Vite + Zustand + Tailwind → Cloudflare Pages
│  │  └─ src/
│  │     ├─ app/                # bootstrap, router, providers global
│  │     ├─ features/           # FEATURE-SLICED (pengganti monolith context)
│  │     │   ├─ auth/           # ui/ model(store zustand)/ api/ lib/
│  │     │   ├─ patrol/
│  │     │   ├─ incident/
│  │     │   ├─ sos/
│  │     │   ├─ ship/
│  │     │   ├─ user/
│  │     │   ├─ notification/
│  │     │   └─ dashboard/
│  │     ├─ entities/           # model domain dipakai lintas-feature
│  │     ├─ shared/             # ui-kit, hooks, utils, api-client, realtime-client
│  │     └─ stores/             # store Zustand root + slice composition
│  └─ api/                      # Cloudflare Worker (Hono) — clean architecture
│     └─ src/
│        ├─ domain/             # entities + value objects + domain service (PURE, no IO)
│        ├─ application/        # use-cases (interactors) + ports (interface repo/gateway)
│        ├─ infrastructure/     # adapters: D1 repo (Drizzle), R2, FCM, JWT, email, DO client
│        ├─ interface/          # http routes (Hono) + middleware (auth/authz) + DTO mapper
│        ├─ realtime/           # Durable Object: ShipChannel (WebSocket hibernation)
│        ├─ cron/               # scheduled handlers
│        └─ index.ts            # entry: fetch + scheduled + export DO
├─ packages/
│  ├─ contracts/                # zod schema + tipe TS share web<->api (sumber kebenaran DTO)
│  ├─ db/                       # Drizzle schema + migrations D1
│  └─ config/                   # eslint, tsconfig base, tailwind preset
├─ android/                     # Capacitor (reuse), arahkan ke API baru
├─ infra/                       # wrangler.toml, catatan resource Cloudflare
└─ docs/
```

Aturan dependensi (clean architecture, hanya menunjuk ke dalam):
`interface/infrastructure → application → domain`. Domain murni (tanpa IO), gampang ditest.

---

## 4. Roadmap berfase (microtask)

Setiap baris `[ ]` = 1 microtask = ±1 PR/commit kecil. Fase berurutan; di dalam fase banyak
yang paralel.

### Phase 0 — Fondasi & kontrak
- [ ] 0.1 Init monorepo (npm/pnpm workspaces) + Prettier/ESLint/TS/Vitest
- [ ] 0.2 `packages/contracts`: skema zod (auth, profile, ship, patrol_report, incident, sos, notification, time)
- [ ] 0.3 `packages/db`: Drizzle schema D1 mirror Postgres + migration awal + D1 lokal (wrangler)
- [ ] 0.4 `apps/api`: Worker skeleton (Hono) + healthcheck + `/server-time`
- [ ] 0.5 `apps/web`: Vite + Tailwind + Zustand + router + api-client + env
- [ ] 0.6 CI GitHub Actions: build web, build worker, test, `wrangler deploy --dry-run`
- [ ] 0.7 `wrangler.toml`: binding D1/R2/KV/DO + cron (resource dibuat Anda)

### Phase 1 — Auth & session (RISIKO TERTINGGI, dikerjakan awal)
- [ ] 1.1 D1: tabel `profiles`, `pending_registrations`, `sessions`
- [ ] 1.2 Util hashing password (`@noble/hashes`) + test
- [ ] 1.3 JWT issue/verify (`jose`) + rotasi refresh token
- [ ] 1.4 Use-case: register, verifyEmail, login, refresh, logout, me
- [ ] 1.5 Middleware Hono: ekstrak user+role dari JWT
- [ ] 1.6 Adapter email (Resend) utk konfirmasi/approval (API key dari Anda)
- [ ] 1.7 Web: `auth` store Zustand + halaman login/register
- [ ] 1.8 Web: reimplement **offline-auth guard** (auth-null involunter = transient; logout hanya eksplisit) — port prinsip dari SYSTEM_MAP lama

### Phase 2 — Authorization (pengganti RLS)
- [ ] 2.1 Modul policy: role (ADMIN/PIC/PETUGAS) + `canAccessShip(user, shipName)`
- [ ] 2.2 Terapkan policy di tiap use-case
- [ ] 2.3 **Matriks test policy** meniru RLS lama (admin full; PIC/PETUGAS hanya kapal ditugaskan; pending owner/admin; storage scope)

### Phase 3 — Ships, Users, Profiles (admin)
- [ ] 3.1 Repo+use-case+route `ships` (incl. `custom_checkpoints` JSON)
- [ ] 3.2 Repo+use-case+route `profiles`/users (enable/disable, assign ship)
- [ ] 3.3 Approval flow: approve/reject pending registration + provision user
- [ ] 3.4 Web slice `ship` + `user` (store + ui)

### Phase 4 — Patrol reports & checkpoints (jantung app)
- [ ] 4.1 Repo+use-case `savePatrolReport` upsert natural key (`shift_key,ship_id,checkpoint_id`)
- [ ] 4.2 Tombstone anti-resurrection sebagai use-case (blok HANYA re-upsert basi: `completed_at <= deleted_at`) + test (port pelajaran SYSTEM_MAP)
- [ ] 4.3 `finalize_shift` dari `custom_checkpoints` (match-by-name ternormalisasi, fallback id runtime) → cron Phase 8
- [ ] 4.4 Web slice `patrol`: store + checkpoint state + rekonstruksi snapshot (pertahankan orphan resolved)
- [ ] 4.5 Web: kamera (port `PatrolCameraModal`) + `imageStore` IndexedDB
- [ ] 4.6 Client outbox IndexedDB (offline submit → flush saat online) + id deterministik

### Phase 5 — Incidents & SOS
- [ ] 5.1 Repo+use-case+route `incidents` (CRUD, JSON payload + kolom query)
- [ ] 5.2 Repo+use-case+route `sos_alerts` + `sos_acknowledgements`
- [ ] 5.3 Web slice `incident` + `sos` (store + ui + SOSButton + audio)

### Phase 6 — Storage R2
- [ ] 6.1 Worker `create-upload-url` (signed PUT R2) + signed GET
- [ ] 6.2 Client upload + `AsyncImage` (idb:// → https)
- [ ] 6.3 `healPatrolReportMedia` (naikkan foto lokal → R2 → tulis sekali URL https)
- [ ] 6.4 Cron resign asset kadaluarsa (Phase 8)

### Phase 7 — Realtime (Durable Objects)
- [ ] 7.1 DO `ShipChannel` (WebSocket hibernation, fan-out per kapal/shift)
- [ ] 7.2 Worker: publish sinyal saat write patrol/incident/sos/notification
- [ ] 7.3 Web `realtime-client` (WebSocket) → merge ke store (pola "sinyal + re-read")
- [ ] 7.4 Reconnect/backoff + dedup

### Phase 8 — Notifikasi + Push (FCM) + Cron
- [ ] 8.1 D1 `notifications` + in-app notif store
- [ ] 8.2 Registrasi token push (web client Firebase SDK) → tabel `push_subscriptions`
- [ ] 8.3 Worker `send-push` → FCM HTTP v1 (service account dari Anda)
- [ ] 8.4 Cron: `checkpoint_pending` + summary, `shift_wrap_up`, `finalize_shift`, `resign_assets` — semua baca `custom_checkpoints`, JANGAN `ship_checkpoints`
- [ ] 8.5 Trigger push saat notif baru masuk

### Phase 9 — Trusted time, hardening, security
- [ ] 9.1 Worker `/server-time` + client `trustedTime` (anchor + drift + offline monotonic)
- [ ] 9.2 `_headers` Pages: CSP, X-Content-Type-Options, Referrer-Policy, Permissions-Policy (camera/geo self), COOP/CORP
- [ ] 9.3 Rate limiting (Cloudflare WAF/Workers) endpoint auth & write
- [ ] 9.4 `audit_events` + `client_mutations` signal
- [ ] 9.5 Security review (lihat `tests/security` lama sebagai acuan) + `npm run test:security` setara

### Phase 10 — Android & cutover
- [ ] 10.1 Capacitor → base URL API baru; test kamera/geo/network
- [ ] 10.2 Build APK + smoke test device
- [ ] 10.3 (Opsional) skrip migrasi data Supabase→D1 jika mau pindah data
- [ ] 10.4 QA paralel + go-live + monitoring (Cloudflare Analytics/Logpush)

---

## 5. Pembagian tugas

### Yang HARUS Anda lakukan (akun/infra/keputusan — saya tak bisa)
1. **Akses repo baru** ke sesi ini (lihat §6) ATAU izinkan saya scaffold di repo ini utk Anda transfer.
2. Buat **akun Cloudflare**; siapkan `account_id`. (Aktifkan Workers Paid bila perlu DO produksi.)
3. Buat resource: **D1 database**, **R2 bucket**, **KV namespace**, project **Pages**.
4. Set **secrets** (`wrangler secret put`): `JWT_SECRET`, `FCM_SERVICE_ACCOUNT`, `RESEND_API_KEY`, `APP_URL`, dll.
5. Pilih + daftar **email provider** (Resend/SendGrid) — pengganti email Supabase Auth.
6. **Domain/DNS** di Cloudflare (custom domain Pages + Worker).
7. **Firebase**: sediakan config web (publik) + service account JSON (rahasia) utk FCM.
8. **Review & approve** tiap PR per fase.
9. Keputusan **data**: mulai kosong atau migrasi dari Supabase lama (Phase 10.3).

### Yang SAYA lakukan
- Seluruh **kode**: monorepo scaffold, Drizzle schema+migrations, Worker (Hono) clean
  architecture, custom auth, authz policy + matriks test, use-cases, D1 repo, R2 adapter,
  Durable Objects realtime, cron handlers, FCM `send-push`, web feature slices + store Zustand,
  test, CI, `wrangler.toml`, dokumentasi, wiring Capacitor.
- Pecah jadi **microtask kecil**, 1 PR/commit per task, dengan test.
- Pelihara `SYSTEM_MAP` baru + dokumen ini.

---

## 6. Blocker akses repo (harus dibereskan dulu)

Saat ini saya **tidak bisa push** ke `SmartpatrolCloudflare` dari sesi ini (proxy git: "repository
not authorized"; scope MCP hanya `smartpatrolnew`). Dua opsi:

- **Opsi A (disarankan):** Tambahkan repo `securityPIS/SmartpatrolCloudflare` ke scope sesi
  Claude Code (lewat pengaturan environment/integration GitHub App agar repo ini diizinkan),
  lalu mulai sesi baru / lanjut sesi yang menarget repo itu. Saya langsung scaffold Phase 0 di sana.
- **Opsi B:** Saya scaffold seluruh struktur di repo INI (branch fitur, mis. folder `cf/`), Anda
  `git subtree`/copy + push ke repo baru. Cepat tapi sekali transfer manual.

---

## 7. Risiko & mitigasi
- **Kehilangan RLS** → matriks test policy (2.3) meniru RLS lama 1:1.
- **Auth ditulis ulang** (paling rawan) → dikerjakan paling awal (Phase 1) + test menyeluruh.
- **Email tak lagi gratis via Supabase** → provider (Resend) sebagai dependency baru.
- **Semantik realtime beda** dari Supabase Realtime → uji ulang skenario sinkron lintas-device.
- **Biaya** Durable Objects/produksi → verifikasi free-tier vs Workers Paid.
- **Lingkup besar** → fase berurutan, app lama tetap jalan sampai cutover (Phase 10).
