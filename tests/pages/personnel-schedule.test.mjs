/*
Tujuan: Mencegah regresi logika Jadwal Penugasan (rencana bulanan petugas per kapal).
Caller: Node test runner.
Dependensi: src/utils/personnelSchedule.js, migration 20261008120000, AppContextRuntime, App shell.
Main Functions: Menguji susunan armada per bulan (berjalan/rencana/warisan/riwayat), eksklusivitas lintas kapal,
        aturan tanpa backdate, serta wiring halaman & migration.
Side Effects: Tidak ada; hanya membaca file sumber.
*/

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  assignToMonthPlan,
  buildFleetRoster,
  formatEntryPeriod,
  getJakartaDateKey,
  normalizePersonnelMonthlyPlan,
  releaseFromMonthPlan,
  validateSchedulePeriod,
} from '../../src/utils/personnelSchedule.js';

const CUR = '2026-10';
const TODAY = '2026-10-08';
const ctx = { currentMonth: CUR };

function fleet() {
  return [
    {
      id: 's1',
      name: 'Alpha',
      personnel: ['u1', 'u2'],
      personnelNextMonth: [],
      personnelSchedules: { u2: { startDate: '', endDate: '2026-10-20', isTBC: false } },
      personnelMonthlyPlan: {},
    },
    {
      id: 's2',
      name: 'Bravo',
      personnel: ['u3'],
      personnelNextMonth: ['u4', 'u5'],
      personnelSchedules: {
        u4: { startDate: '2026-10-15', endDate: '', isTBC: false },
        u5: { startDate: '2026-12-02', endDate: '', isTBC: false },
      },
      personnelMonthlyPlan: {},
    },
  ];
}

const ids = (entries = []) => entries.map((entry) => entry.userId);

test('bulan berjalan memakai penugasan operasional + Next Assignment yang mulai bulan ini', () => {
  const roster = buildFleetRoster(fleet(), CUR, ctx);
  assert.deepEqual(ids(roster.s1), ['u1', 'u2']);
  assert.deepEqual(ids(roster.s2), ['u3', 'u4']);
  assert.equal(roster.s2[1].source, 'pending');
});

test('bulan depan tanpa rencana mewarisi bulan lalu, buang yang periodenya selesai, tambah legacy yang mulai', () => {
  const nov = buildFleetRoster(fleet(), '2026-11', ctx);
  assert.deepEqual(ids(nov.s1), ['u1'], 'u2 selesai 20 Okt → off duty di November');
  assert.deepEqual(ids(nov.s2), ['u3', 'u4']);
  const dec = buildFleetRoster(fleet(), '2026-12', ctx);
  assert.deepEqual(ids(dec.s2), ['u5', 'u3', 'u4']);
  assert.equal(dec.s2[0].source, 'legacy');
});

test('assign bulan depan membekukan rencana seluruh armada dan eksklusif lintas kapal', () => {
  const ships = assignToMonthPlan(fleet(), { ...ctx, shipId: 's2', userId: 'u1', monthKey: '2026-11', startDate: '2026-11-05', endDate: '' });
  const nov = buildFleetRoster(ships, '2026-11', ctx);
  assert.deepEqual(ids(nov.s1), []);
  assert.deepEqual(ids(nov.s2), ['u3', 'u4', 'u1']);
  assert.equal(formatEntryPeriod(nov.s2[2], '2026-11'), 'Mulai 5 Nov');
  assert.ok(Array.isArray(ships[0].personnelMonthlyPlan.months['2026-11']), 'kapal lain ikut dibekukan');
  assert.equal(ships[0].personnelMonthlyPlan.applied, CUR);
  // Bulan berjalan tidak berubah.
  assert.deepEqual(ids(buildFleetRoster(ships, CUR, ctx).s1), ['u1', 'u2']);
  // Desember mewarisi rencana November.
  assert.deepEqual(ids(buildFleetRoster(ships, '2026-12', ctx).s2), ['u5', 'u3', 'u4', 'u1']);
});

test('lepas petugas bulan depan memindahkannya ke off duty tanpa memengaruhi bulan berjalan', () => {
  const ships = releaseFromMonthPlan(fleet(), { ...ctx, shipId: 's1', userId: 'u1', monthKey: '2026-11' });
  assert.deepEqual(ids(buildFleetRoster(ships, '2026-11', ctx).s1), []);
  assert.deepEqual(ids(buildFleetRoster(ships, CUR, ctx).s1), ['u1', 'u2']);
});

test('legacy Next Assignment yang dilepas dari rencana tidak muncul kembali', () => {
  const ships = releaseFromMonthPlan(fleet(), { ...ctx, shipId: 's2', userId: 'u5', monthKey: '2026-12' });
  assert.ok(!ships[1].personnelNextMonth.includes('u5'));
  assert.deepEqual(ids(buildFleetRoster(ships, '2026-12', ctx).s2), ['u3', 'u4']);
});

test('riwayat bulan lalu dibaca dari snapshot rencana', () => {
  const ships = fleet();
  ships[0].personnelMonthlyPlan = { applied: CUR, months: { '2026-09': [{ userId: 'u9', startDate: '', endDate: '' }] } };
  assert.deepEqual(ids(buildFleetRoster(ships, '2026-09', ctx).s1), ['u9']);
  assert.deepEqual(ids(buildFleetRoster(ships, '2026-09', ctx).s2), []);
});

test('periode jaga opsional, tidak boleh backdate, harus di dalam bulan', () => {
  const base = { currentMonth: CUR, today: TODAY };
  assert.equal(validateSchedulePeriod({ ...base, monthKey: CUR }), '');
  assert.match(validateSchedulePeriod({ ...base, monthKey: CUR, startDate: '2026-10-07' }), /mundur tanggal/);
  assert.equal(validateSchedulePeriod({ ...base, monthKey: CUR, startDate: TODAY, endDate: '2026-10-31' }), '');
  assert.match(validateSchedulePeriod({ ...base, monthKey: CUR, endDate: '2026-11-01' }), /di dalam Oktober 2026/);
  assert.match(validateSchedulePeriod({ ...base, monthKey: CUR, startDate: '2026-10-20', endDate: '2026-10-10' }), /setelah tanggal mulai/);
  assert.equal(validateSchedulePeriod({ ...base, monthKey: '2026-11', startDate: '2026-11-01' }), '');
  assert.match(validateSchedulePeriod({ ...base, monthKey: '2026-09' }), /hanya bisa dilihat/);
  assert.match(validateSchedulePeriod({ ...base, monthKey: '2027-11' }), /maksimal 12 bulan/);
});

test('normalisasi rencana membuang kunci & entri tidak valid serta duplikat', () => {
  const plan = normalizePersonnelMonthlyPlan({
    applied: '2026-10',
    months: { '2026-13': [], bad: [], '2026-11': [{ userId: 'u1', startDate: 'x' }, { userId: 'u1' }, { foo: 1 }] },
  });
  assert.deepEqual(plan, { applied: '2026-10', months: { '2026-11': [{ userId: 'u1', startDate: '', endDate: '' }] } });
});

test('tanggal jadwal memakai zona Asia/Jakarta', () => {
  assert.equal(getJakartaDateKey(new Date('2026-10-31T18:30:00Z')), '2026-11-01');
});

test('halaman, menu, context, dan migration terhubung', () => {
  const appSource = readFileSync(new URL('../../App.jsx', import.meta.url), 'utf8');
  const headerSource = readFileSync(new URL('../../src/components/Header.jsx', import.meta.url), 'utf8');
  const runtimeSource = readFileSync(new URL('../../src/context/AppContextRuntime.jsx', import.meta.url), 'utf8');
  const cloudSource = readFileSync(new URL('../../src/services/backend/cloudState.js', import.meta.url), 'utf8');
  const migrationSource = readFileSync(new URL('../../supabase/migrations/20261008120000_personnel_monthly_plan.sql', import.meta.url), 'utf8');

  assert.match(appSource, /currentPage === 'schedule' && \(canAccessDashboard \? <SchedulePage \/>/);
  assert.match(headerSource, /setCurrentPage\('schedule'\)/);
  assert.match(runtimeSource, /handleScheduleAssign,\n\s+handleScheduleRelease,\n\s+refreshPersonnelPlanOnServer,/);
  assert.match(cloudSource, /personnel_monthly_plan: normalizePersonnelMonthlyPlan/);
  assert.match(cloudSource, /isMissingPersonnelPlanColumnError/, 'sync kapal tetap jalan sebelum migration diterapkan');
  assert.match(migrationSource, /add column if not exists personnel_monthly_plan jsonb/);
  assert.match(migrationSource, /auth\.uid\(\) is not null and not public\.is_admin\(\)/);
  assert.match(migrationSource, /revoke all on function public\.apply_personnel_monthly_plan\(date\) from anon/);
});
