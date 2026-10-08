/*
Tujuan: Logika murni jadwal penugasan petugas security per kapal per bulan (halaman Jadwal Penugasan).
Caller: AppContextRuntime (handler assign/lepas jadwal), SchedulePage, dan test node:test.
Dependensi: Tidak ada dependensi eksternal.
Main Functions:
  - Matematika kunci bulan 'YYYY-MM' dan tanggal Jakarta 'YYYY-MM-DD'.
  - normalizePersonnelMonthlyPlan: sanitasi kolom ships.personnel_monthly_plan.
  - buildFleetRoster: susunan petugas tiap kapal untuk satu bulan (riwayat / berjalan / rencana).
  - assignToMonthPlan / releaseFromMonthPlan: mutasi rencana bulan depan (eksklusif lintas kapal).
  - validateSchedulePeriod: aturan periode opsional, tidak boleh mundur tanggal (backdate).
Aturan sumber data:
  - Bulan lalu      : plan.months[M] (snapshot saat pergantian bulan), hanya lihat.
  - Bulan berjalan  : ship.personnel (+ personnelNextMonth yang mulai bulan ini) = penugasan operasional.
  - Bulan depan     : plan.months[M] bila sudah direncanakan; jika belum, mewarisi bulan sebelumnya
                      (tanpa petugas yang periodenya sudah selesai) + "Next Assignment" lama yang mulai di M.
  - Pergantian bulan diterapkan server (public.apply_personnel_monthly_plan) dengan aturan yang sama.
Side Effects: Tidak ada; semua helper bersifat pure function.
*/

export const SCHEDULE_TIME_ZONE = 'Asia/Jakarta';
export const SCHEDULE_MAX_MONTHS_AHEAD = 12;
export const SCHEDULE_HISTORY_MONTHS = 12;

export const MONTH_NAMES_ID = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
export const MONTH_SHORT_ID = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

const MONTH_KEY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_KEY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

const pad2 = (value) => String(value).padStart(2, '0');

export function isMonthKey(value) {
  return typeof value === 'string' && MONTH_KEY_PATTERN.test(value);
}

export function isDateKey(value) {
  return typeof value === 'string' && DATE_KEY_PATTERN.test(value);
}

// Tanggal kalender Jakarta (WIB) — jadwal jaga mengikuti hari lokal, bukan UTC.
export function getJakartaDateKey(date = new Date()) {
  const safeDate = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SCHEDULE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(safeDate);
  const pick = (type) => parts.find((part) => part.type === type)?.value || '';
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

export function getMonthKey(dateKey) {
  return String(dateKey || '').slice(0, 7);
}

function parseMonthKey(monthKey) {
  const [year, month] = String(monthKey).split('-').map(Number);
  return { year, month };
}

export function addMonths(monthKey, amount) {
  const { year, month } = parseMonthKey(monthKey);
  const total = (year * 12) + (month - 1) + amount;
  return `${Math.floor(total / 12)}-${pad2((total % 12) + 1)}`;
}

export function diffMonths(fromMonthKey, toMonthKey) {
  const from = parseMonthKey(fromMonthKey);
  const to = parseMonthKey(toMonthKey);
  return ((to.year - from.year) * 12) + (to.month - from.month);
}

export function daysInMonth(monthKey) {
  const { year, month } = parseMonthKey(monthKey);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function getMonthStart(monthKey) {
  return `${monthKey}-01`;
}

export function getMonthEnd(monthKey) {
  return `${monthKey}-${pad2(daysInMonth(monthKey))}`;
}

export function formatMonthLabel(monthKey) {
  const { year, month } = parseMonthKey(monthKey);
  return `${MONTH_NAMES_ID[month - 1] || ''} ${year}`;
}

export function formatDayLabel(dateKey) {
  if (!isDateKey(dateKey)) return '';
  const [, month, day] = dateKey.split('-').map(Number);
  return `${day} ${MONTH_SHORT_ID[month - 1]}`;
}

/*
Teks periode singkat untuk chip petugas pada bulan yang sedang dilihat.
Tanggal di luar bulan tampilan dipotong supaya tidak membingungkan (mis. "Sampai 15 Des").
*/
export function formatEntryPeriod(entry = {}, monthKey) {
  const monthStart = getMonthStart(monthKey);
  const monthEnd = getMonthEnd(monthKey);
  const start = isDateKey(entry.startDate) && entry.startDate > monthStart && entry.startDate <= monthEnd ? entry.startDate : '';
  const end = isDateKey(entry.endDate) && entry.endDate >= monthStart && entry.endDate < monthEnd ? entry.endDate : '';
  if (!start && !end) return 'Sebulan penuh';
  if (start && end) {
    return start === end ? formatDayLabel(start) : `${Number(start.slice(8))}–${formatDayLabel(end)}`;
  }
  return start ? `Mulai ${formatDayLabel(start)}` : `Sampai ${formatDayLabel(end)}`;
}

export function hasEntryPeriod(entry = {}, monthKey) {
  return formatEntryPeriod(entry, monthKey) !== 'Sebulan penuh';
}

function normalizeEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const userId = String(entry.userId || '').trim().slice(0, 160);
  if (!userId) return null;
  return {
    userId,
    startDate: isDateKey(entry.startDate) ? entry.startDate : '',
    endDate: isDateKey(entry.endDate) ? entry.endDate : '',
  };
}

function normalizeEntryList(list) {
  const seen = new Set();
  return (Array.isArray(list) ? list : []).reduce((result, rawEntry) => {
    const entry = normalizeEntry(rawEntry);
    if (!entry || seen.has(entry.userId)) return result;
    seen.add(entry.userId);
    result.push(entry);
    return result;
  }, []);
}

export function normalizePersonnelMonthlyPlan(rawPlan) {
  const source = rawPlan && typeof rawPlan === 'object' && !Array.isArray(rawPlan) ? rawPlan : {};
  const months = {};
  const rawMonths = source.months && typeof source.months === 'object' && !Array.isArray(source.months) ? source.months : {};
  Object.keys(rawMonths).sort().forEach((monthKey) => {
    if (!isMonthKey(monthKey) || !Array.isArray(rawMonths[monthKey])) return;
    months[monthKey] = normalizeEntryList(rawMonths[monthKey]);
  });
  const plan = { months };
  if (isMonthKey(source.applied)) plan.applied = source.applied;
  return plan;
}

function getShipPlan(ship) {
  return normalizePersonnelMonthlyPlan(ship?.personnelMonthlyPlan);
}

export function isShipMonthPlanned(ship, monthKey) {
  return Array.isArray(getShipPlan(ship).months[monthKey]);
}

function toIdList(value) {
  return Array.from(new Set((Array.isArray(value) ? value : []).map((item) => String(item || '').trim()).filter(Boolean)));
}

function getScheduleEntry(ship, userId) {
  const schedule = ship?.personnelSchedules?.[userId] || {};
  return {
    userId,
    startDate: isDateKey(schedule.startDate) ? schedule.startDate : '',
    // TBC = tanpa batas akhir.
    endDate: !schedule.isTBC && isDateKey(schedule.endDate) ? schedule.endDate : '',
  };
}

// "Next Assignment" lama (ShipsPage) yang dijadwalkan mulai di bulan tertentu.
function getLegacyNextEntries(ship, predicate) {
  return toIdList(ship?.personnelNextMonth)
    .map((userId) => getScheduleEntry(ship, userId))
    .filter((entry) => predicate(entry));
}

function createRosterCollector(ships, validUserIds) {
  const roster = Object.fromEntries(ships.map((ship) => [ship.id, []]));
  const claimed = new Set();
  const isAllowed = (userId) => !validUserIds || validUserIds.has(userId);
  const claim = (shipId, entry, source) => {
    if (!entry?.userId || claimed.has(entry.userId) || !isAllowed(entry.userId)) return;
    claimed.add(entry.userId);
    roster[shipId].push({ ...entry, source });
  };
  return { roster, claim };
}

/*
Susunan petugas seluruh armada untuk bulan monthKey.
Hasil: { [shipId]: [{ userId, startDate, endDate, source }] } — satu petugas hanya di satu kapal.
source: 'history' | 'active' | 'pending' | 'plan' | 'legacy' | 'inherited'.
*/
export function buildFleetRoster(ships = [], monthKey, options = {}) {
  const safeShips = (Array.isArray(ships) ? ships : []).filter((ship) => ship && ship.id);
  const currentMonth = options.currentMonth;
  const validUserIds = options.validUserIds instanceof Set ? options.validUserIds : null;
  const offset = diffMonths(currentMonth, monthKey);

  if (offset < 0) {
    const { roster, claim } = createRosterCollector(safeShips, validUserIds);
    safeShips.forEach((ship) => {
      (getShipPlan(ship).months[monthKey] || []).forEach((entry) => claim(ship.id, entry, 'history'));
    });
    return roster;
  }

  // Bulan berjalan: penugasan operasional adalah sumber kebenaran.
  const currentMonthEnd = getMonthEnd(currentMonth);
  let rosterForMonth;
  {
    const { roster, claim } = createRosterCollector(safeShips, validUserIds);
    safeShips.forEach((ship) => {
      toIdList(ship.personnel).forEach((userId) => claim(ship.id, getScheduleEntry(ship, userId), 'active'));
    });
    safeShips.forEach((ship) => {
      getLegacyNextEntries(ship, (entry) => !entry.startDate || entry.startDate <= currentMonthEnd)
        .forEach((entry) => claim(ship.id, entry, 'pending'));
    });
    rosterForMonth = roster;
  }

  for (let step = 1; step <= offset; step += 1) {
    const stepMonth = addMonths(currentMonth, step);
    const stepStart = getMonthStart(stepMonth);
    const previousRoster = rosterForMonth;
    const { roster, claim } = createRosterCollector(safeShips, validUserIds);

    safeShips.forEach((ship) => {
      (getShipPlan(ship).months[stepMonth] || []).forEach((entry) => claim(ship.id, entry, 'plan'));
    });
    safeShips.forEach((ship) => {
      getLegacyNextEntries(ship, (entry) => getMonthKey(entry.startDate) === stepMonth)
        .forEach((entry) => claim(ship.id, entry, 'legacy'));
    });
    safeShips.forEach((ship) => {
      if (isShipMonthPlanned(ship, stepMonth)) return;
      (previousRoster[ship.id] || [])
        .filter((entry) => !entry.endDate || entry.endDate >= stepStart)
        .forEach((entry) => claim(ship.id, { userId: entry.userId, startDate: '', endDate: entry.endDate }, 'inherited'));
    });

    rosterForMonth = roster;
  }

  return rosterForMonth;
}

export function findRosterShipId(roster = {}, userId) {
  return Object.keys(roster).find((shipId) => (roster[shipId] || []).some((entry) => entry.userId === userId)) || null;
}

function stripSource(entry) {
  return { userId: entry.userId, startDate: entry.startDate || '', endDate: entry.endDate || '' };
}

function pruneHistory(months, currentMonth) {
  const oldestKept = addMonths(currentMonth, -SCHEDULE_HISTORY_MONTHS);
  return Object.fromEntries(Object.entries(months).filter(([monthKey]) => monthKey >= oldestKept));
}

/*
Membekukan susunan bulan monthKey (> bulan berjalan) menjadi rencana eksplisit untuk SEMUA kapal,
supaya perubahan berikutnya eksklusif lintas kapal dan tidak lagi bergantung pada pewarisan.
"Next Assignment" lama yang mulai di bulan itu dipindahkan ke rencana agar tidak dobel.
*/
export function materializeMonthPlan(ships = [], monthKey, options = {}) {
  const currentMonth = options.currentMonth;
  if (diffMonths(currentMonth, monthKey) <= 0) return Array.isArray(ships) ? ships : [];
  const roster = buildFleetRoster(ships, monthKey, options);

  return ships.map((ship) => {
    if (!ship?.id) return ship;
    const plan = getShipPlan(ship);
    const legacyIds = getLegacyNextEntries(ship, (entry) => getMonthKey(entry.startDate) === monthKey).map((entry) => entry.userId);
    if (plan.months[monthKey] && legacyIds.length === 0) return ship;

    const personnel = toIdList(ship.personnel);
    const personnelSchedules = { ...(ship.personnelSchedules || {}) };
    legacyIds.forEach((userId) => {
      if (!personnel.includes(userId)) delete personnelSchedules[userId];
    });

    return {
      ...ship,
      personnelNextMonth: toIdList(ship.personnelNextMonth).filter((userId) => !legacyIds.includes(userId)),
      personnelSchedules,
      personnelMonthlyPlan: {
        ...plan,
        applied: plan.applied || currentMonth,
        months: pruneHistory({
          ...plan.months,
          [monthKey]: (roster[ship.id] || []).map(stripSource),
        }, currentMonth),
      },
    };
  });
}

function withMeta(originalShip, nextShip, mutationMeta) {
  return originalShip === nextShip ? originalShip : { ...nextShip, ...mutationMeta };
}

function setMonthEntries(ship, monthKey, updater) {
  const plan = getShipPlan(ship);
  const entries = plan.months[monthKey] || [];
  const nextEntries = updater(entries);
  if (nextEntries === entries) return ship;
  return {
    ...ship,
    personnelMonthlyPlan: { ...plan, months: { ...plan.months, [monthKey]: nextEntries } },
  };
}

export function assignToMonthPlan(ships = [], options = {}) {
  const { shipId, userId, monthKey, currentMonth, mutationMeta = {} } = options;
  if (!shipId || !userId || diffMonths(currentMonth, monthKey) <= 0) return ships;
  const entry = normalizeEntry({ userId, startDate: options.startDate, endDate: options.endDate });
  const materialized = materializeMonthPlan(ships, monthKey, options);

  return materialized.map((ship, index) => {
    const updated = setMonthEntries(ship, monthKey, (entries) => {
      const others = entries.filter((item) => item.userId !== userId);
      if (ship.id === shipId) return [...others, entry];
      return others.length === entries.length ? entries : others;
    });
    return withMeta(ships[index], updated, mutationMeta);
  });
}

export function releaseFromMonthPlan(ships = [], options = {}) {
  const { shipId, userId, monthKey, currentMonth, mutationMeta = {} } = options;
  if (!shipId || !userId || diffMonths(currentMonth, monthKey) <= 0) return ships;
  const materialized = materializeMonthPlan(ships, monthKey, options);

  return materialized.map((ship, index) => {
    if (ship.id !== shipId) return withMeta(ships[index], ship, mutationMeta);
    const updated = setMonthEntries(ship, monthKey, (entries) => {
      const others = entries.filter((item) => item.userId !== userId);
      return others.length === entries.length ? entries : others;
    });
    return withMeta(ships[index], updated, mutationMeta);
  });
}

/*
Validasi periode jaga opsional. Kosong = sebulan penuh.
Aturan: di dalam bulan yang dipilih, tidak boleh sebelum hari ini (no backdate), selesai >= mulai.
Mengembalikan pesan error (string kosong bila valid).
*/
export function validateSchedulePeriod({ monthKey, currentMonth, today, startDate = '', endDate = '' } = {}) {
  const offset = diffMonths(currentMonth, monthKey);
  if (offset < 0) return 'Bulan yang sudah lewat hanya bisa dilihat.';
  if (offset > SCHEDULE_MAX_MONTHS_AHEAD) return `Jadwal bisa dibuat maksimal ${SCHEDULE_MAX_MONTHS_AHEAD} bulan ke depan.`;
  if ((startDate && !isDateKey(startDate)) || (endDate && !isDateKey(endDate))) return 'Format tanggal tidak valid.';

  const minDate = offset === 0 ? today : getMonthStart(monthKey);
  const maxDate = getMonthEnd(monthKey);
  if ((startDate && startDate < minDate) || (endDate && endDate < minDate)) {
    return `Tanggal tidak boleh sebelum ${formatDayLabel(minDate)}. Penugasan tidak bisa mundur tanggal.`;
  }
  if ((startDate && startDate > maxDate) || (endDate && endDate > maxDate)) {
    return `Periode harus berada di dalam ${formatMonthLabel(monthKey)}.`;
  }
  if (startDate && endDate && endDate < startDate) {
    return 'Tanggal selesai harus sama dengan atau setelah tanggal mulai.';
  }
  return '';
}

export function getSchedulePeriodBounds({ monthKey, currentMonth, today }) {
  return {
    min: diffMonths(currentMonth, monthKey) === 0 ? today : getMonthStart(monthKey),
    max: getMonthEnd(monthKey),
  };
}
