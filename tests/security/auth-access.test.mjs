import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  ACCESS_ROLES,
  buildOperationalAccessPayload,
  buildPendingRegistrationPayload,
} from '../../src/services/backend/accessModels.js';

const authSource = readFileSync(new URL('../../src/services/backend/auth.js', import.meta.url), 'utf8');
const accessSource = readFileSync(new URL('../../src/services/backend/access.js', import.meta.url), 'utf8');
const cloudStateSource = readFileSync(new URL('../../src/services/backend/cloudState.js', import.meta.url), 'utf8');
const appContextSource = readFileSync(new URL('../../src/context/AppContextRuntime.jsx', import.meta.url), 'utf8');
const syncAccessSource = readFileSync(new URL('../../supabase/functions/sync-operational-access/index.ts', import.meta.url), 'utf8');
const registrationMigrationSource = readFileSync(new URL('../../supabase/migrations/202605250001_fix_registration_profile_sync.sql', import.meta.url), 'utf8');

test('pending registration payload tetap membuang field sensitif dan approval field liar', () => {
  const payload = buildPendingRegistrationPayload({
    uid: 'uid-public-1',
    email: 'PUBLIC@EXAMPLE.COM',
    name: '  Petugas Baru  ',
    phone: '0812-3456-7890',
    role: ACCESS_ROLES.ADMIN,
    shipAssigned: 'MT MENGGALA',
    status: 'pending',
    reviewNote: 'should-not-stick',
  });

  assert.equal(payload.uid, 'uid-public-1');
  assert.equal(payload.email, 'public@example.com');
  assert.equal(payload.name, 'Petugas Baru');
  assert.equal(payload.phone, '081234567890');
  assert.equal(payload.status, 'pending');
  assert.equal(payload.reviewNote, 'should-not-stick');
  assert.equal(Object.hasOwn(payload, 'role'), false);
  assert.equal(Object.hasOwn(payload, 'shipAssigned'), false);
});

test('akses petugas off-duty tanpa assignment tidak langsung enabled', () => {
  const payload = buildOperationalAccessPayload({
    uid: 'uid-guard-1',
    email: 'guard@example.com',
    name: 'Guard One',
    role: ACCESS_ROLES.PETUGAS,
    status: 'off-duty',
    shipAssigned: '',
  });

  assert.equal(payload.role, ACCESS_ROLES.PETUGAS);
  assert.equal(payload.status, 'off-duty');
  assert.equal(payload.shipAssigned, null);
  assert.equal(payload.enabled, false);
});

test('admin operasional selalu enabled saat review approved', () => {
  const payload = buildOperationalAccessPayload({
    uid: 'uid-admin-1',
    email: 'admin@smartpatrol.local',
    name: 'Admin One',
    role: ACCESS_ROLES.ADMIN,
    status: 'active',
  });

  assert.equal(payload.role, ACCESS_ROLES.ADMIN);
  assert.equal(payload.enabled, true);
  assert.equal(payload.reviewState, 'approved');
});

test('registrasi publik membawa metadata khusus untuk trigger onboarding Supabase Auth', () => {
  assert.match(
    authSource,
    /options:\s*Object\.keys\(metadata\s*\|\|\s*\{\}\)\.length\s*>\s*0[\s\S]*\{\s*data:\s*metadata\s*\}/,
    'signUp harus meneruskan metadata terkontrol ke Supabase Auth',
  );
  assert.match(
    appContextSource,
    /smartpatrol_registration_flow:\s*'public'/,
    'flow register publik harus memberi marker agar trigger tidak menangkap user admin/provisioned',
  );
  assert.match(
    registrationMigrationSource,
    /after insert on auth\.users[\s\S]*create_pending_registration_from_auth_user/,
    'migration harus membuat pending registration dari auth.users saat session signUp tidak tersedia',
  );
});

test('pending registration client insert aman terhadap duplikasi dari trigger auth', () => {
  assert.match(
    accessSource,
    /\.from\(PENDING_REGISTRATIONS_TABLE\)[\s\S]*\.insert\(payload\)/,
    'client harus memakai insert biasa agar tidak membutuhkan UPDATE policy pending_registrations',
  );
  assert.match(
    accessSource,
    /isDuplicateKeyError\(error\)/,
    'duplicate dari trigger auth harus dianggap idempotent, bukan gagal registrasi',
  );
});

test('sync operational access mempertahankan profile id existing berdasarkan auth_uid', () => {
  assert.match(
    syncAccessSource,
    /findExistingProfile\(supabase,\s*proposedRow\)/,
    'sync harus mencari row existing sebelum upsert agar tidak bentrok unique auth_uid',
  );
  assert.match(
    syncAccessSource,
    /legacyUserId:\s*existingProfile\.id/,
    'upsert harus memakai id profile existing saat auth_uid/email sudah ada di database',
  );
});

test('state sync merekonsiliasi id profile sebelum upsert profiles', () => {
  assert.match(
    cloudStateSource,
    /await\s+reconcileProfileRowIds\(supabase,\s*profileRows\)/,
    'cloud state sync harus memakai id profile cloud existing sebelum upsert',
  );
  assert.match(
    cloudStateSource,
    /Pertahankan primary key profile cloud/,
    'rekonsiliasi id perlu terdokumentasi karena mencegah unique auth_uid conflict',
  );
});

test('listener auth tidak mengubah gagal jaringan menjadi logout final', () => {
  assert.match(
    authSource,
    /supabase\.auth\.getSession\(\)/,
    'initial session harus membaca sesi lokal Supabase agar cold-start offline tidak bergantung getUser network',
  );
  assert.doesNotMatch(
    authSource,
    /supabase\.auth\.getUser\(\)[\s\S]*?catch\(\(\)\s*=>\s*\{[\s\S]*?callback\(null\)/,
    'kegagalan getUser network tidak boleh langsung diterjemahkan menjadi user null/logout',
  );
  assert.match(
    authSource,
    /isTransientAuthError\(error\)/,
    'error auth jaringan harus ditandai transien agar context tidak menghapus sesi offline',
  );
  assert.match(
    authSource,
    /explicitFirebaseLogout\s*=\s*true[\s\S]*supabase\.auth\.signOut\(\)[\s\S]*explicitFirebaseLogout\s*=\s*false/,
    'logout eksplisit harus men-set flag selama signOut agar SIGNED_OUT yang menyusul dikenali eksplisit',
  );
  assert.match(
    authSource,
    /const isExplicitLogout\s*=\s*event\s*===\s*'SIGNED_OUT'\s*&&\s*explicitFirebaseLogout/,
    'listener harus membedakan SIGNED_OUT eksplisit dari auth-null involunter',
  );
  assert.match(
    authSource,
    /isTransient:\s*!normalizedUser\s*&&\s*!isExplicitLogout\s*&&\s*\(isBrowserOffline\(\)\s*\|\|\s*event\s*===\s*'SIGNED_OUT'\)/,
    'SIGNED_OUT involunter / browser offline harus transien; hanya logout eksplisit yang final',
  );
});

test('restore sesi cold-start yang gagal transien tidak menjadi logout final', () => {
  // supabase-js mengirim INITIAL_SESSION null bila getSession gagal (refresh token gagal
  // jaringan / timeout lock). Event itu dulu dianggap logout -> "Sesi cloud berakhir".
  assert.match(
    authSource,
    /if \(event === 'INITIAL_SESSION'\) return;/,
    'listener harus mengabaikan INITIAL_SESSION; restore awal ditangani getSession yang membawa info error',
  );
  assert.match(
    authSource,
    /status >= 400 && status < 500[\s\S]*?return false;[\s\S]*?return true;/,
    'hanya penolakan server 4xx yang definitif; gangguan jaringan/5xx/lock harus transien',
  );
  assert.match(
    authSource,
    /if \(isTransient\) scheduleRestoreRetry\(\);/,
    'restore yang gagal transien harus diretry agar sesi pulih tanpa login ulang',
  );
  assert.match(
    appContextSource,
    /if \(activeUid\) setAuthAccessOfflineUid\(activeUid\);\s*else setIsAuthRestorePending\(true\);/,
    'auth-null transien tanpa user aktif harus menandai restore pending',
  );
  const restoreGuards = appContextSource.match(/isAuthRestorePending\) return;/g) || [];
  assert.equal(restoreGuards.length, 2, 'kedua validator reset sesi cloud harus menahan reset selama restore pending');
});

test('runtime auth mempertahankan sesi patroli saat auth-null offline', () => {
  assert.match(
    appContextSource,
    /const isTransientAuthNull = !nextUser\s*&& !authEvent\?\.explicit\s*&& \(authEvent\?\.isTransient \|\| isOfflineRef\.current\)[\s\S]*?return;/,
    'callback auth-null transien (non-eksplisit) harus berhenti sebelum setFirebaseAuthUser(null)',
  );
  assert.match(
    appContextSource,
    /const offlineSessionUser = \(isOffline \|\| isAuthRestorePending\) && sessionUserId && sessionUserRecord[\s\S]*?return offlineSessionUser;/,
    'currentUserRecord harus tetap memakai sessionUserRecord saat offline / restore sesi masih diretry',
  );
  assert.match(
    appContextSource,
    /if \(isOffline\) \{[\s\S]*?setAuthAccessOfflineUid\(offlineUid\);[\s\S]*?return;[\s\S]*?(?:resetAuthSession\(|autoReset\('[^']+', )'Sesi cloud Anda telah berakhir/,
    'validator tidak boleh reset sesi cloud ketika device sedang offline dan masih ada user lokal aktif',
  );
});

test('validator sesi hanya reset saat resolusi akses DEFINITIF (anti tendangan reconnect)', () => {
  // Reset cloud session hanya boleh saat resolveOperationalAccess memberi jawaban definitif
  // untuk UID aktif. Resolusi gagal jaringan (authAccessOfflineUid di-set) saat baru pulih
  // koneksi TIDAK boleh memicu reset — itulah penyebab logout "saat back online".
  const definitiveGuards = appContextSource.match(
    /if \(authAccessResolvedUid !== currentUid\) return;\s*\n\s*(?:resetAuthSession\(|autoReset\('[^']+', |const message = )'Sesi cloud Anda telah berakhir/g,
  ) || [];
  assert.equal(
    definitiveGuards.length,
    2,
    'kedua validator harus pakai guard definitif resolvedUid sebelum resetAuthSession',
  );
  assert.doesNotMatch(
    appContextSource,
    /authAccessResolvedUid !== currentUid && authAccessOfflineUid !== currentUid\) return;\s*\n\s*resetAuthSession/,
    'guard lama yang ikut reset saat offlineUid cocok harus dihapus (penyebab logout reconnect)',
  );
  assert.match(
    appContextSource,
    /if \(!shipsData\?\.length\) return;/,
    'validasi armada petugas harus ditunda saat ships belum termuat agar tidak kick di window reconnect',
  );
});

test('validator tidak reset "Sesi login tidak lagi valid" sebelum auth Supabase siap', () => {
  // Cek "user tidak ditemukan" dulu berjalan sebelum guard firebaseAuthReady/authAccessBusy,
  // sehingga cold start / sinkronisasi data user menendang sesi Supabase yang masih sehat.
  assert.match(
    appContextSource,
    /if \(isFirebaseAuthEnabled\) \{[\s\S]*?if \(!firebaseAuthReady \|\| authBusy \|\| authAccessBusy\) return;[\s\S]*?if \(!activeUser\) return;[\s\S]*?\} else if \(!activeUser\) \{\s*\n\s*autoReset\('session-user-missing'/,
    'jalur Supabase harus menunggu auth siap dan tidak me-reset saat user lokal sesaat tidak ditemukan',
  );
  assert.doesNotMatch(
    appContextSource,
    /if \(!sessionUserId\) return;\s*\n\s*const activeUser = [^\n]*\n\s*if \(!activeUser\) \{\s*\n\s*resetAuthSession\('Sesi login tidak lagi valid/,
    'reset tanpa guard di awal validator (penyebab mental logout) tidak boleh kembali',
  );
  assert.match(appContextSource, /recordAutoLogout\(code, message, buildLogoutContext\(\)\)/, 'logout otomatis harus dicatat untuk diagnosis');
});

test('resolusi akses sembuh sendiri setelah reconnect (checkpoint tidak hilang)', () => {
  // Resolver akses harus bisa di-ulang lewat nonce, dan ada retry berbackoff saat
  // resolusi gagal jaringan agar authAccessState (sumber shipAssigned/status) pulih
  // tanpa refresh manual. Tanpa ini, currentUserRecord null -> operationalShip null
  // -> "Belum ada titik patroli" sampai user refresh.
  assert.match(
    appContextSource,
    /\}, \[firebaseAuthReady, firebaseAuthUser, authAccessResolveNonce\]\);/,
    'effect resolver akses harus bergantung pada authAccessResolveNonce agar bisa di-retry',
  );
  assert.match(
    appContextSource,
    /authAccessRetryRef[\s\S]*?setTimeout\([\s\S]*?setAuthAccessResolveNonce\(\(nonce\) => nonce \+ 1\)/,
    'harus ada retry resolusi akses berbackoff yang menaikkan authAccessResolveNonce',
  );
  // currentUserRecord tidak boleh kolaps ke null saat resolusi belum definitif —
  // pertahankan record terakhir agar operationalShip & checkpoint tetap tampil.
  assert.match(
    appContextSource,
    /const isAccessResolutionDefinitive = authAccessResolvedUid === firebaseAuthUid;\s*\n\s*if \(isAccessResolutionDefinitive\) return offlineSessionUser;/,
    'currentUserRecord hanya boleh kolaps ke null saat resolusi akses sudah definitif',
  );
});
