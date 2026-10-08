/*
Tujuan: Halaman Jadwal Penugasan — atur petugas security yang berjaga di setiap kapal per bulan.
Caller: App shell (currentPage 'schedule'), dibuka dari menu pengaturan header (Admin & PIC).
Dependensi: ShipContext (handleScheduleAssign/Release), UsersContext, RoleContext, utils/personnelSchedule.
Main Functions:
  - Pemilih bulan (riwayat 12 bulan ke belakang, rencana 12 bulan ke depan).
  - Tombol + → form tugaskan petugas dengan periode jaga opsional (tidak bisa backdate).
  - Tombol X → konfirmasi lepas tugas, petugas pindah ke sidebar Off duty.
  - Seret nama dari Off duty ke kapal (desktop), urungkan lewat toast.
  - PIC: hanya lihat.
Side Effects: Memanggil handler context yang mengubah shipsData/usersData dan memicu cloud sync.
*/

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CalendarDays, CalendarRange, ChevronLeft, ChevronRight, GripVertical, History, Info, Plus, Search, UserMinus, X,
} from 'lucide-react';
import { useRole, useShips, useUI, useUsers } from '../context/AppContextRuntime';
import { getTrustedDate } from '../services/time/trustedTime';
import { isPersonnelPlanCloudUnavailable } from '../services/backend/cloudState';
import {
  SCHEDULE_HISTORY_MONTHS,
  SCHEDULE_MAX_MONTHS_AHEAD,
  addMonths,
  buildFleetRoster,
  diffMonths,
  formatDayLabel,
  formatEntryPeriod,
  formatMonthLabel,
  getJakartaDateKey,
  getMonthKey,
  getSchedulePeriodBounds,
  hasEntryPeriod,
  isShipMonthPlanned,
  MONTH_NAMES_ID,
  validateSchedulePeriod,
} from '../utils/personnelSchedule';
import './SchedulePage.css';

const TOAST_MS = 5000;

const initialsOf = (name = '') => name.split(' ').filter(Boolean).slice(0, 2).map((word) => word[0]).join('').toUpperCase() || 'SP';
const hueOf = (text = '') => {
  let hue = 0;
  for (const char of text) hue = ((hue * 31) + char.charCodeAt(0)) % 360;
  return hue;
};
const firstNameOf = (name = '') => name.split(' ')[0] || name;

function Avatar({ name }) {
  return (
    <span className="sched-av" style={{ '--h': hueOf(name) }} aria-hidden="true">{initialsOf(name)}</span>
  );
}

function useScheduleClock() {
  const read = () => {
    const today = getJakartaDateKey(getTrustedDate());
    return { today, currentMonth: getMonthKey(today) };
  };
  const [clock, setClock] = useState(read);
  useEffect(() => {
    // Ganti hari/bulan tanpa reload app (mis. halaman terbuka melewati tengah malam).
    const timer = setInterval(() => {
      setClock((previous) => {
        const next = read();
        return next.today === previous.today ? previous : next;
      });
    }, 60000);
    return () => clearInterval(timer);
  }, []);
  return clock;
}

function AssignDialog({ state, setState, ships, offDuty, monthKey, clock, onSubmit, onClose }) {
  const { min, max } = getSchedulePeriodBounds({ monthKey, currentMonth: clock.currentMonth, today: clock.today });
  const query = state.officerQuery.trim().toLowerCase();
  const visibleOfficers = offDuty.filter((officer) => officer.name.toLowerCase().includes(query) || (officer.workerNumber || '').toLowerCase().includes(query));
  const firstFieldRef = useRef(null);

  useEffect(() => {
    firstFieldRef.current?.focus();
  }, []);

  const update = (patch) => setState((previous) => ({ ...previous, error: '', ...patch }));

  return (
    <div className="sched-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="sched-dialog" role="dialog" aria-modal="true" aria-labelledby="sched-assign-title">
        <form className="sched-dlg-form" noValidate onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
          <div className="sched-dlg-head">
            <div>
              <h2 id="sched-assign-title">Tugaskan petugas</h2>
              <p>Penugasan untuk {formatMonthLabel(monthKey)}</p>
            </div>
            <button className="sched-icon-btn" type="button" onClick={onClose} aria-label="Tutup"><X size={20} /></button>
          </div>

          <div className="sched-dlg-body">
            <label className="sched-field">
              <span>Kapal</span>
              <select value={state.shipId} onChange={(event) => update({ shipId: event.target.value })}>
                {ships.map((ship) => <option key={ship.id} value={ship.id}>{ship.name}</option>)}
              </select>
            </label>

            <fieldset className="sched-field">
              <legend>Petugas off duty</legend>
              {offDuty.length >= 6 && (
                <input
                  ref={state.officerId ? undefined : firstFieldRef}
                  className="sched-pick-search"
                  type="search"
                  placeholder="Cari nama atau nomor pekerja"
                  autoComplete="off"
                  aria-label="Cari nama petugas"
                  value={state.officerQuery}
                  onChange={(event) => update({ officerQuery: event.target.value })}
                />
              )}
              <div className="sched-pick" role="radiogroup" aria-label="Pilih petugas">
                {visibleOfficers.map((officer, index) => {
                  const checked = state.officerId === officer.id;
                  return (
                    <label key={officer.id} className={`sched-pick-item${checked ? ' is-checked' : ''}`}>
                      <input
                        ref={!state.officerId && offDuty.length < 6 && index === 0 ? firstFieldRef : undefined}
                        type="radio"
                        name="sched-officer"
                        value={officer.id}
                        checked={checked}
                        onChange={() => update({ officerId: officer.id })}
                      />
                      <Avatar name={officer.name} />
                      <span className="sched-pick-text">
                        <span>{officer.name}</span>
                        <small>{officer.workerNumber || officer.type || 'Petugas security'}</small>
                      </span>
                      <span className="sched-pick-check" aria-hidden="true" />
                    </label>
                  );
                })}
                {visibleOfficers.length === 0 && <p className="sched-pick-none">Nama tidak ditemukan.</p>}
              </div>
            </fieldset>

            <div>
              <label className="sched-toggle">
                <span className="sched-toggle-title">Atur periode jaga</span>
                <small>Opsional. Tanpa periode, petugas berjaga sebulan penuh.</small>
                <input
                  className="sched-switch"
                  type="checkbox"
                  checked={state.periodOn}
                  onChange={(event) => update({ periodOn: event.target.checked })}
                />
              </label>
              {state.periodOn && (
                <div className="sched-dates">
                  <label className="sched-field">
                    <span>Dari tanggal</span>
                    <input
                      type="date"
                      min={min}
                      max={max}
                      value={state.startDate}
                      onChange={(event) => update({ startDate: event.target.value })}
                    />
                  </label>
                  <label className="sched-field">
                    <span>Sampai tanggal</span>
                    <input
                      type="date"
                      min={state.startDate || min}
                      max={max}
                      value={state.endDate}
                      onChange={(event) => update({ endDate: event.target.value })}
                    />
                  </label>
                  <p className="sched-hint">
                    Pilih tanggal antara {formatDayLabel(min)} dan {formatDayLabel(max)} {monthKey.slice(0, 4)}. Boleh isi salah satu saja. Tanggal yang sudah lewat tidak bisa dipilih.
                  </p>
                </div>
              )}
            </div>

            {state.error && <p className="sched-err" role="alert">{state.error}</p>}
          </div>

          <div className="sched-dlg-foot">
            <button className="sched-btn is-ghost" type="button" onClick={onClose}>Batal</button>
            <button className="sched-btn is-primary" type="submit" disabled={state.submitting}>
              {state.submitting ? 'Menyimpan…' : 'Tugaskan'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ConfirmDialog({ officerName, shipName, monthKey, busy, onCancel, onConfirm }) {
  const cancelRef = useRef(null);
  useEffect(() => { cancelRef.current?.focus(); }, []);

  return (
    <div className="sched-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <div className="sched-dialog is-confirm" role="alertdialog" aria-modal="true" aria-labelledby="sched-confirm-title" aria-describedby="sched-confirm-text">
        <div className="sched-confirm">
          <div className="sched-confirm-ic"><UserMinus size={24} /></div>
          <h2 id="sched-confirm-title">Lepas {officerName} dari {shipName}?</h2>
          <p id="sched-confirm-text">{firstNameOf(officerName)} akan dipindahkan ke daftar off duty untuk {formatMonthLabel(monthKey)}.</p>
        </div>
        <div className="sched-dlg-foot">
          <button ref={cancelRef} className="sched-btn is-ghost" type="button" onClick={onCancel}>Batal</button>
          <button className="sched-btn is-danger" type="button" onClick={onConfirm} disabled={busy}>
            {busy ? 'Memproses…' : 'Lepas tugas'}
          </button>
        </div>
      </div>
    </div>
  );
}

const SchedulePage = React.memo(function SchedulePage() {
  const { shipsData, handleScheduleAssign, handleScheduleRelease, refreshPersonnelPlanOnServer } = useShips();
  const { usersData } = useUsers();
  const { isAdmin, isPic } = useRole();
  const { setCurrentPage } = useUI();
  const clock = useScheduleClock();

  const [view, setView] = useState(clock.currentMonth);
  const [query, setQuery] = useState('');
  const [assign, setAssign] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const [flashId, setFlashId] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [dropShipId, setDropShipId] = useState(null);
  const vesselRefs = useRef({});

  // Undo memanggil handler TERBARU (bukan closure lama) agar tidak menimpa perubahan lain.
  const handlersRef = useRef({ handleScheduleAssign, handleScheduleRelease });
  handlersRef.current = { handleScheduleAssign, handleScheduleRelease };

  useEffect(() => {
    if (isAdmin) refreshPersonnelPlanOnServer?.();
  }, [isAdmin, refreshPersonnelPlanOnServer]);

  // Saat bulan berganti, tampilan "bulan berjalan" ikut maju.
  const previousCurrentMonthRef = useRef(clock.currentMonth);
  useEffect(() => {
    if (previousCurrentMonthRef.current !== clock.currentMonth) {
      setView((previous) => (previous === previousCurrentMonthRef.current ? clock.currentMonth : previous));
      previousCurrentMonthRef.current = clock.currentMonth;
    }
  }, [clock.currentMonth]);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!flashId) return undefined;
    const timer = setTimeout(() => setFlashId(null), 1900);
    return () => clearTimeout(timer);
  }, [flashId]);

  useEffect(() => {
    if (!assign && !confirm) return undefined;
    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      if (confirm) setConfirm(null);
      else setAssign(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [assign, confirm]);

  const offset = diffMonths(clock.currentMonth, view);
  const isPast = offset < 0;
  const canEdit = isAdmin && !isPast;

  const officers = useMemo(() => usersData
    .filter((user) => String(user.role || '').toUpperCase() === 'PETUGAS' && user.status !== 'disabled')
    .sort((left, right) => left.name.localeCompare(right.name, 'id')), [usersData]);
  const officerById = useMemo(() => Object.fromEntries(officers.map((officer) => [officer.id, officer])), [officers]);
  const shipById = useMemo(() => Object.fromEntries(shipsData.map((ship) => [ship.id, ship])), [shipsData]);

  const roster = useMemo(() => buildFleetRoster(shipsData, view, {
    currentMonth: clock.currentMonth,
    validUserIds: new Set(officers.map((officer) => officer.id)),
  }), [clock.currentMonth, officers, shipsData, view]);

  const offDuty = useMemo(() => {
    const assigned = new Set(Object.values(roster).flat().map((entry) => entry.userId));
    return officers.filter((officer) => !assigned.has(officer.id));
  }, [officers, roster]);

  const onDutyCount = officers.length - offDuty.length;
  const staffedShips = shipsData.filter((ship) => (roster[ship.id] || []).length > 0).length;
  const searchTerm = query.trim().toLowerCase();
  const visibleShips = shipsData.filter((ship) => ship.name.toLowerCase().includes(searchTerm));
  const anyShipPlanned = offset > 0 && shipsData.some((ship) => isShipMonthPlanned(ship, view));
  const cloudPlanUnavailable = isAdmin && offset > 0 && isPersonnelPlanCloudUnavailable();

  if (!isAdmin && !isPic) return null;

  const showToast = (message, undo = null) => setToast({ message, undo, id: Date.now() });

  const openAssign = ({ shipId, officerId } = {}) => {
    if (!canEdit) return;
    if (shipsData.length === 0) {
      showToast('Belum ada kapal. Tambahkan armada di Menu Armada.');
      return;
    }
    if (offDuty.length === 0) {
      showToast(`Semua petugas sudah bertugas di ${formatMonthLabel(view)}.`);
      return;
    }
    setAssign({
      shipId: shipId || visibleShips[0]?.id || shipsData[0].id,
      officerId: officerId || '',
      officerQuery: '',
      periodOn: false,
      startDate: '',
      endDate: '',
      error: '',
      submitting: false,
    });
  };

  const submitAssign = async () => {
    if (!assign || assign.submitting) return;
    if (!assign.officerId) {
      setAssign((previous) => ({ ...previous, error: 'Pilih petugas yang akan ditugaskan.' }));
      return;
    }
    const startDate = assign.periodOn ? assign.startDate : '';
    const endDate = assign.periodOn ? assign.endDate : '';
    if (assign.periodOn && !startDate && !endDate) {
      setAssign((previous) => ({ ...previous, error: 'Isi tanggal mulai atau selesai, atau matikan pengaturan periode.' }));
      return;
    }
    const validationError = validateSchedulePeriod({ monthKey: view, currentMonth: clock.currentMonth, today: clock.today, startDate, endDate });
    if (validationError) {
      setAssign((previous) => ({ ...previous, error: validationError }));
      return;
    }

    const { shipId, officerId } = assign;
    setAssign((previous) => ({ ...previous, submitting: true, error: '' }));
    const result = await handlersRef.current.handleScheduleAssign({ shipId, userId: officerId, monthKey: view, startDate, endDate });
    if (!result?.ok) {
      setAssign((previous) => (previous ? { ...previous, submitting: false, error: result?.error || 'Gagal menugaskan petugas.' } : previous));
      return;
    }

    const monthKey = view;
    setAssign(null);
    setFlashId(officerId);
    requestAnimationFrame(() => {
      vesselRefs.current[shipId]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
    showToast(`${officerById[officerId]?.name || 'Petugas'} ditugaskan ke ${shipById[shipId]?.name || 'kapal'}.`, async () => {
      await handlersRef.current.handleScheduleRelease({ shipId, userId: officerId, monthKey });
      setView(monthKey);
    });
  };

  const confirmRelease = async () => {
    if (!confirm || confirmBusy) return;
    const { shipId, userId, entry } = confirm;
    const monthKey = view;
    setConfirmBusy(true);
    const result = await handlersRef.current.handleScheduleRelease({ shipId, userId, monthKey });
    setConfirmBusy(false);
    setConfirm(null);
    if (!result?.ok) {
      showToast(result?.error || 'Gagal melepas petugas.');
      return;
    }
    setFlashId(userId);
    showToast(`${officerById[userId]?.name || 'Petugas'} dipindahkan ke off duty.`, async () => {
      await handlersRef.current.handleScheduleAssign({
        shipId,
        userId,
        monthKey,
        startDate: entry?.startDate || '',
        endDate: entry?.endDate || '',
        skipValidation: true,
      });
      setView(monthKey);
    });
  };

  const goMonth = (delta) => {
    const next = addMonths(view, delta);
    const nextOffset = diffMonths(clock.currentMonth, next);
    if (nextOffset > SCHEDULE_MAX_MONTHS_AHEAD || nextOffset < -SCHEDULE_HISTORY_MONTHS) return;
    setFlashId(null);
    setView(next);
  };

  const monthTag = offset === 0 ? 'Bulan berjalan' : offset > 0 ? 'Perencanaan' : 'Riwayat, hanya lihat';
  const [viewYear, viewMonth] = view.split('-').map(Number);

  const endDrag = () => {
    setDragging(false);
    setDropShipId(null);
  };

  return (
    <div className={`sched${dragging ? ' is-dragging' : ''}`}>
      <section className="sched-hero">
        <div>
          <span className="sched-eyebrow"><CalendarRange size={14} /> Shipping &amp; Marine</span>
          <h1>Jadwal penugasan petugas</h1>
          <p className="sched-hero-sub">Atur petugas security yang berjaga di setiap kapal untuk tiap bulan.</p>
        </div>
        <div className="sched-month" role="group" aria-label="Pilih bulan">
          <button
            className="sched-month-btn"
            type="button"
            onClick={() => goMonth(-1)}
            disabled={offset <= -SCHEDULE_HISTORY_MONTHS}
            aria-label="Bulan sebelumnya"
          >
            <ChevronLeft size={20} />
          </button>
          <div className="sched-month-label" aria-live="polite">
            <span className="sched-month-name">{MONTH_NAMES_ID[viewMonth - 1]}</span>
            <span className="sched-month-year">{viewYear}</span>
            <div>
              <span className={`sched-month-tag${offset > 0 ? ' is-plan' : ''}${offset < 0 ? ' is-past' : ''}`}>
                {offset < 0 ? <History size={13} /> : <CalendarDays size={13} />} {monthTag}
              </span>
            </div>
          </div>
          <button
            className="sched-month-btn"
            type="button"
            onClick={() => goMonth(1)}
            disabled={offset >= SCHEDULE_MAX_MONTHS_AHEAD}
            aria-label="Bulan berikutnya"
            title={offset >= SCHEDULE_MAX_MONTHS_AHEAD ? `Jadwal bisa dibuat maksimal ${SCHEDULE_MAX_MONTHS_AHEAD} bulan ke depan` : 'Bulan berikutnya'}
          >
            <ChevronRight size={20} />
          </button>
        </div>
      </section>

      <div className="sched-toolbar">
        <p className="sched-stats">
          <span><strong>{onDutyCount}</strong>bertugas</span>
          <span><strong>{offDuty.length}</strong>off duty</span>
          <span><strong>{staffedShips}</strong>dari {shipsData.length} kapal terisi</span>
        </p>
        <label className="sched-search">
          <Search size={18} />
          <span className="sched-sr">Cari kapal</span>
          <input type="search" placeholder="Cari kapal" autoComplete="off" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
      </div>

      {isPast && (
        <div className="sched-notice" role="status">
          <History size={20} />
          <p><strong>Riwayat penugasan.</strong> Bulan yang sudah lewat hanya bisa dilihat. Penugasan baru dibuat mulai bulan berjalan.</p>
          <button className="sched-linkbtn" type="button" onClick={() => setView(clock.currentMonth)}>Ke bulan berjalan</button>
        </div>
      )}
      {!isPast && !isAdmin && (
        <div className="sched-notice" role="status">
          <Info size={20} />
          <p><strong>Mode lihat.</strong> Hanya admin yang dapat menugaskan atau melepas petugas.</p>
        </div>
      )}
      {offset > 0 && !anyShipPlanned && (
        <div className="sched-notice is-plan" role="status">
          <CalendarDays size={20} />
          <p>
            <strong>Mengikuti {formatMonthLabel(addMonths(view, -1))}.</strong> Belum ada perubahan untuk {formatMonthLabel(view)}, jadi susunan
            petugas dibawa dari bulan sebelumnya (kecuali yang periodenya sudah selesai). Perubahan di sini berlaku mulai 1 {MONTH_NAMES_ID[viewMonth - 1]}.
          </p>
        </div>
      )}
      {cloudPlanUnavailable && (
        <div className="sched-notice is-warn" role="status">
          <Info size={20} />
          <p><strong>Database belum diperbarui.</strong> Rencana bulan depan baru tersimpan di perangkat ini sampai migration jadwal diterapkan di Supabase.</p>
        </div>
      )}

      <div className="sched-layout">
        <main className="sched-vessels" aria-label="Daftar kapal">
          {shipsData.length === 0 ? (
            <div className="sched-empty">
              Belum ada kapal terdaftar.{' '}
              {isAdmin && <button className="sched-linkbtn" type="button" onClick={() => setCurrentPage('ships')}>Tambah armada</button>}
            </div>
          ) : visibleShips.length === 0 ? (
            <p className="sched-empty">Tidak ada kapal yang cocok dengan “{query.trim()}”.</p>
          ) : visibleShips.map((ship) => {
            const crew = (roster[ship.id] || []).filter((entry) => officerById[entry.userId]);
            const isInherited = offset > 0 && crew.length > 0 && crew.every((entry) => entry.source === 'inherited');
            return (
              <article
                key={ship.id}
                ref={(node) => { vesselRefs.current[ship.id] = node; }}
                className={`sched-vessel${crew.length ? '' : ' is-empty'}${dropShipId === ship.id ? ' is-drop-over' : ''}`}
                onDragOver={canEdit ? (event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; if (dropShipId !== ship.id) setDropShipId(ship.id); } : undefined}
                onDragLeave={canEdit ? (event) => { if (!event.currentTarget.contains(event.relatedTarget)) setDropShipId((current) => (current === ship.id ? null : current)); } : undefined}
                onDrop={canEdit ? (event) => {
                  event.preventDefault();
                  const officerId = event.dataTransfer.getData('text/plain');
                  endDrag();
                  if (officerById[officerId]) openAssign({ shipId: ship.id, officerId });
                } : undefined}
              >
                <div className="sched-plate">
                  <div>
                    <h3 className="sched-plate-name">{ship.name}</h3>
                    <p className="sched-plate-type">{ship.type || ship.status || 'Kapal'}</p>
                  </div>
                  <p className="sched-plate-count"><strong>{crew.length}</strong>petugas</p>
                </div>
                <div className="sched-crew">
                  {crew.map((entry) => {
                    const officer = officerById[entry.userId];
                    const withPeriod = hasEntryPeriod(entry, view);
                    const isExpired = offset === 0 && entry.endDate && entry.endDate < clock.today;
                    const isPending = entry.source === 'pending';
                    return (
                      <div key={entry.userId} className={`sched-chip${flashId === entry.userId ? ' sched-is-new' : ''}`}>
                        <Avatar name={officer.name} />
                        <span className="sched-chip-text">
                          <span className="sched-chip-name" title={officer.name}>{officer.name}</span>
                          <span className={`sched-chip-sub${isExpired ? ' is-expired' : withPeriod ? ' has-period' : ''}`}>
                            {withPeriod && <CalendarDays size={13} />}
                            {isExpired ? `Periode selesai ${formatDayLabel(entry.endDate)}` : `${isPending ? 'Belum mulai · ' : ''}${formatEntryPeriod(entry, view)}`}
                          </span>
                        </span>
                        {canEdit && (
                          <button
                            className="sched-x"
                            type="button"
                            onClick={() => setConfirm({ shipId: ship.id, userId: entry.userId, entry })}
                            aria-label={`Lepas ${officer.name} dari ${ship.name}`}
                          >
                            <X size={16} />
                          </button>
                        )}
                      </div>
                    );
                  })}
                  {crew.length === 0 && <p className="sched-crew-empty">{isPast ? 'Tidak ada petugas jaga.' : 'Belum ada petugas jaga.'}</p>}
                  {canEdit && (
                    <button
                      className="sched-add"
                      type="button"
                      onClick={() => openAssign({ shipId: ship.id })}
                      aria-label={`Tambah petugas ke ${ship.name}`}
                      title="Tambah petugas"
                    >
                      <Plus size={20} />
                      <span className="sched-add-txt">Tambah petugas</span>
                    </button>
                  )}
                  {isInherited && anyShipPlanned && (
                    <p className="sched-inherit"><Info size={13} /> Mengikuti susunan {formatMonthLabel(addMonths(view, -1))}.</p>
                  )}
                </div>
              </article>
            );
          })}
        </main>

        <aside className="sched-offduty" aria-labelledby="sched-off-title">
          <div className="sched-off-head">
            <h2 id="sched-off-title">Off duty</h2>
            <span className="sched-count" aria-label="Jumlah petugas off duty">{offDuty.length}</span>
          </div>
          <p className="sched-off-sub">
            {offDuty.length === 0
              ? `Tidak ada petugas off duty di ${formatMonthLabel(view)}.`
              : !canEdit
                ? `Tidak bertugas di ${formatMonthLabel(view)}.`
                : `Belum ditugaskan di ${formatMonthLabel(view)}. Seret nama ke kapal, atau ketuk untuk menugaskan.`}
          </p>
          <ul className="sched-off-list">
            {offDuty.length === 0 ? (
              <li className="sched-off-empty">{officers.length === 0 ? 'Belum ada akun petugas.' : 'Semua petugas sudah ditugaskan.'}</li>
            ) : offDuty.map((officer) => (
              <li key={officer.id}>
                {canEdit ? (
                  <button
                    type="button"
                    className={`sched-off-item${flashId === officer.id ? ' sched-is-new' : ''}`}
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.setData('text/plain', officer.id);
                      event.dataTransfer.effectAllowed = 'move';
                      setDragging(true);
                    }}
                    onDragEnd={endDrag}
                    onClick={() => openAssign({ officerId: officer.id })}
                    aria-label={`Tugaskan ${officer.name}`}
                  >
                    <Avatar name={officer.name} />
                    <span className="sched-off-text">
                      <span className="sched-off-name">{officer.name}</span>
                      <span className="sched-off-nrp">{officer.workerNumber || officer.type || 'Petugas'}</span>
                    </span>
                    <GripVertical size={16} className="sched-off-icon is-drag" aria-hidden="true" />
                    <Plus size={18} className="sched-off-icon is-tap" aria-hidden="true" />
                  </button>
                ) : (
                  <div className={`sched-off-item${flashId === officer.id ? ' sched-is-new' : ''}`}>
                    <Avatar name={officer.name} />
                    <span className="sched-off-text">
                      <span className="sched-off-name">{officer.name}</span>
                      <span className="sched-off-nrp">{officer.workerNumber || officer.type || 'Petugas'}</span>
                    </span>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </aside>
      </div>

      {assign && (
        <AssignDialog
          state={assign}
          setState={setAssign}
          ships={shipsData}
          offDuty={offDuty}
          monthKey={view}
          clock={clock}
          onSubmit={submitAssign}
          onClose={() => setAssign(null)}
        />
      )}

      {confirm && officerById[confirm.userId] && (
        <ConfirmDialog
          officerName={officerById[confirm.userId].name}
          shipName={shipById[confirm.shipId]?.name || 'kapal'}
          monthKey={view}
          busy={confirmBusy}
          onCancel={() => setConfirm(null)}
          onConfirm={confirmRelease}
        />
      )}

      {toast && (
        <div className="sched-toast" role="status" aria-live="polite" key={toast.id}>
          <span>{toast.message}</span>
          {toast.undo && (
            <button
              type="button"
              onClick={async () => {
                const { undo } = toast;
                setToast(null);
                await undo();
              }}
            >
              Urungkan
            </button>
          )}
        </div>
      )}
    </div>
  );
});

export default SchedulePage;
