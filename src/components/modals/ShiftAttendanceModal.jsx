/*
Tujuan: Absensi petugas shift (mode demo) — pengganti Status Shift. Setiap pergantian shift tiap
        petugas wajib absen di HP masing-masing: foto (wajib), Patroli/Istirahat. Kondisi Baik/Tidak
        Baik hanya diisi bila memilih Istirahat (Tidak Baik wajib keterangan). Khusus Shift 1 (pagi)
        ada Daily Check Up (DCU): suhu + tekanan darah, masing-masing wajib foto evidence.
        Checklist terkunci sampai petugas yang login sudah absen.
Caller: PatrolPage saat isDemoMode (modal status shift).
Dependensi: Patrol context (handleSaveCurrentShiftStatus, currentShiftMeta), ModalShell, PhotoField.
Main Functions: ShiftAttendanceModal, isAttendanceItemComplete, isDcuShiftMeta, isDcuComplete.
Side Effects: Menyimpan record status shift (+ foto, kondisi, DCU per petugas) ke state runtime.
*/

import React from 'react';
import { Activity, Camera, CheckCircle2, Coffee, HeartPulse, ShieldCheck, Thermometer } from 'lucide-react';
import { usePatrol, useRole } from '../../context/AppContextRuntime';
import { ModalShell } from '../ui';
import { PhotoField } from '../incidentFollowUp/FollowUpPanels';

// DCU hanya untuk shift pagi (Shift 1 06:00-12:00, termasuk id kompat/legacy).
const DCU_SHIFT_IDS = new Set(['shift-1-active', 'shift-1', 'shift-pagi']);

// Batas wajar input DCU agar salah ketik (mis. 365 untuk 36.5) tertolak.
const DCU_LIMITS = {
  temperature: { min: 34, max: 43 },
  systolic: { min: 60, max: 250 },
  diastolic: { min: 30, max: 150 },
};

export function isDcuShiftMeta(shiftMeta) {
  return DCU_SHIFT_IDS.has(shiftMeta?.id);
}

function parseDcuNumber(value) {
  const parsed = Number(String(value ?? '').replace(',', '.').trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function isInRange(value, { min, max }) {
  return value !== null && value >= min && value <= max;
}

export function getDcuIssues(dcu) {
  const temperature = parseDcuNumber(dcu?.temperature);
  const systolic = parseDcuNumber(dcu?.systolic);
  const diastolic = parseDcuNumber(dcu?.diastolic);
  return {
    temperature: !isInRange(temperature, DCU_LIMITS.temperature),
    bloodPressure: !isInRange(systolic, DCU_LIMITS.systolic)
      || !isInRange(diastolic, DCU_LIMITS.diastolic)
      || systolic <= diastolic,
  };
}

export function isDcuComplete(dcu) {
  const issues = getDcuIssues(dcu);
  return !issues.temperature && !issues.bloodPressure
    && Boolean(dcu?.temperaturePhotoUrl) && Boolean(dcu?.bloodPressurePhotoUrl);
}

function buildDcuDraft(existingDcu) {
  return {
    temperature: existingDcu?.temperature ?? '',
    temperaturePhotoUrl: existingDcu?.temperaturePhotoUrl || null,
    systolic: existingDcu?.systolic ?? '',
    diastolic: existingDcu?.diastolic ?? '',
    bloodPressurePhotoUrl: existingDcu?.bloodPressurePhotoUrl || null,
  };
}

function buildDraft(guard, existingItem) {
  return {
    userId: guard?.id || null,
    name: guard?.name || 'Petugas',
    status: existingItem?.status || (guard?.shiftStatus === 'istirahat' ? 'istirahat' : 'patroli'),
    attendancePhotoUrl: existingItem?.attendancePhotoUrl || null,
    condition: existingItem?.condition || null,
    conditionNote: existingItem?.conditionNote || '',
    dcu: buildDcuDraft(existingItem?.dcu),
  };
}

export function isAttendanceItemComplete(item, { requireDcu = false } = {}) {
  if (!item?.attendancePhotoUrl) return false;
  if (requireDcu && !isDcuComplete(item.dcu)) return false;
  // Kondisi hanya wajib untuk petugas yang istirahat.
  if (item.status !== 'istirahat') return true;
  if (!item.condition) return false;
  return item.condition === 'baik' || Boolean(item.conditionNote?.trim());
}

// Payload simpan: buang kondisi saat Patroli & DCU di luar shift pagi agar record tetap ringkas.
function buildSaveItem(draft, requireDcu) {
  const isRest = draft.status === 'istirahat';
  const { dcu, ...rest } = draft;
  return {
    ...rest,
    condition: isRest ? draft.condition : null,
    conditionNote: isRest && draft.condition === 'tidak_baik' ? draft.conditionNote : '',
    ...(requireDcu ? {
      dcu: {
        temperature: parseDcuNumber(dcu.temperature),
        temperaturePhotoUrl: dcu.temperaturePhotoUrl,
        systolic: parseDcuNumber(dcu.systolic),
        diastolic: parseDcuNumber(dcu.diastolic),
        bloodPressurePhotoUrl: dcu.bloodPressurePhotoUrl,
      },
    } : {}),
  };
}

const OPTION_BASE = 'rounded-2xl border px-3 py-2.5 transition flex items-center justify-center gap-2';
const FIELD_LABEL = 'text-[10px] font-mono text-cyan-500 uppercase tracking-widest font-bold mb-2 ml-1 block';
const NUMBER_INPUT = 'w-full rounded-2xl border bg-slate-950 p-3 text-sm text-slate-100 outline-none';

function ChoiceButton({ active, activeClass, onClick, icon: Icon, label }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active} className={`${OPTION_BASE} ${active ? activeClass : 'border-slate-700 bg-slate-900 text-slate-300 hover:text-white'}`}>
      <Icon className="h-4 w-4" />
      <span className="text-sm font-bold">{label}</span>
    </button>
  );
}

function DcuNumberInput({ id, value, onChange, placeholder, invalid }) {
  return (
    <input
      id={id}
      type="number"
      inputMode="decimal"
      step="any"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      className={`${NUMBER_INPUT} ${invalid ? 'border-rose-500/50 focus:border-rose-400' : 'border-slate-700 focus:border-cyan-400'}`}
    />
  );
}

function DcuSection({ dcu, onChange }) {
  const issues = getDcuIssues(dcu);
  const showTemperatureError = dcu.temperature !== '' && issues.temperature;
  const showBloodPressureError = dcu.systolic !== '' && dcu.diastolic !== '' && issues.bloodPressure;

  return (
    <div className="space-y-4 rounded-3xl border border-cyan-500/20 bg-cyan-500/5 p-4">
      <div className="flex items-center gap-2 text-cyan-300">
        <Activity className="h-4 w-4" />
        <p className="text-xs font-bold uppercase tracking-[0.24em]">Daily Check Up (DCU)</p>
      </div>

      <div className="space-y-3">
        <label htmlFor="dcu-temperature" className={FIELD_LABEL}>
          <Thermometer className="mr-1 inline h-3 w-3" />Suhu tubuh (°C) <span className="text-rose-400">*</span>
        </label>
        <DcuNumberInput id="dcu-temperature" value={dcu.temperature} onChange={(temperature) => onChange({ temperature })} placeholder="Contoh: 36.5" invalid={showTemperatureError} />
        {showTemperatureError && <p className="ml-1 text-[11px] text-rose-300">Suhu harus {DCU_LIMITS.temperature.min}–{DCU_LIMITS.temperature.max} °C.</p>}
        <PhotoField label="Foto Evidence Suhu" required value={dcu.temperaturePhotoUrl} onChange={(temperaturePhotoUrl) => onChange({ temperaturePhotoUrl })} />
      </div>

      <div className="space-y-3">
        <p className={FIELD_LABEL}>
          <HeartPulse className="mr-1 inline h-3 w-3" />Tekanan darah (mmHg) <span className="text-rose-400">*</span>
        </p>
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
          <DcuNumberInput id="dcu-systolic" value={dcu.systolic} onChange={(systolic) => onChange({ systolic })} placeholder="Sistolik 120" invalid={showBloodPressureError} />
          <span className="text-lg font-bold text-slate-500">/</span>
          <DcuNumberInput id="dcu-diastolic" value={dcu.diastolic} onChange={(diastolic) => onChange({ diastolic })} placeholder="Diastolik 80" invalid={showBloodPressureError} />
        </div>
        {showBloodPressureError && <p className="ml-1 text-[11px] text-rose-300">Tekanan darah tidak wajar (sistolik harus lebih besar dari diastolik).</p>}
        <PhotoField label="Foto Evidence Tekanan Darah" required value={dcu.bloodPressurePhotoUrl} onChange={(bloodPressurePhotoUrl) => onChange({ bloodPressurePhotoUrl })} />
      </div>
    </div>
  );
}

export default function ShiftAttendanceModal() {
  const {
    activeShiftGuardSnapshot,
    currentShiftMeta,
    currentShiftStatusRecord,
    showShiftStatusModal,
    closeShiftStatusModal,
    handleSaveCurrentShiftStatus,
  } = usePatrol();
  const { currentUserRecord } = useRole();
  // Tiap petugas absen sendiri di HP masing-masing: form hanya untuk petugas yang login.
  const myGuard = (Array.isArray(activeShiftGuardSnapshot) ? activeShiftGuardSnapshot : [])
    .find((guard) => guard?.id && guard.id === currentUserRecord?.id) || null;
  const recordItems = Array.isArray(currentShiftStatusRecord?.items) ? currentShiftStatusRecord.items : [];
  const myExistingItem = recordItems.find((item) => item.userId && item.userId === currentUserRecord?.id) || null;
  const requireDcu = isDcuShiftMeta(currentShiftMeta);
  const [draft, setDraft] = React.useState(() => buildDraft(myGuard, myExistingItem));
  const wasOpenRef = React.useRef(false);

  React.useEffect(() => {
    if (showShiftStatusModal && !wasOpenRef.current) setDraft(buildDraft(myGuard, myExistingItem));
    wasOpenRef.current = showShiftStatusModal;
  }, [myExistingItem, myGuard, showShiftStatusModal]);

  if (!showShiftStatusModal) return null;

  const isComplete = isAttendanceItemComplete(draft, { requireDcu });
  const canSave = Boolean(myGuard) && isComplete;
  const isRest = draft.status === 'istirahat';
  const updateDraft = (patch) => setDraft((previous) => ({ ...previous, ...patch }));
  const updateDcu = (patch) => setDraft((previous) => ({ ...previous, dcu: { ...previous.dcu, ...patch } }));
  const handleSave = () => {
    if (!canSave) return;
    // Absensi rekan (dari HP mereka) dipertahankan; hanya data petugas ini yang diganti.
    const otherItems = recordItems.filter((item) => item.userId !== currentUserRecord?.id);
    handleSaveCurrentShiftStatus([...otherItems, buildSaveItem(draft, requireDcu)]);
  };

  const actions = (
    <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
      <button
        type="button"
        onClick={closeShiftStatusModal}
        className="rounded-2xl border border-slate-700 bg-slate-900 px-4 py-3 text-sm font-bold text-slate-200 transition hover:border-cyan-400/40 hover:text-white"
      >
        Tutup
      </button>
      <button
        type="button"
        onClick={handleSave}
        disabled={!canSave}
        className="rounded-2xl border border-emerald-400/30 bg-emerald-500/15 px-4 py-3 text-sm font-bold text-emerald-100 transition hover:border-emerald-300/50 hover:bg-emerald-500/25 disabled:cursor-not-allowed disabled:opacity-50"
      >
        Simpan Absensi
      </button>
    </div>
  );

  const shiftLabel = `${currentShiftMeta?.label || 'Shift aktif'}${currentShiftMeta?.timeRange ? ` (${currentShiftMeta.timeRange})` : ''}`;

  return (
    <ModalShell title="Absensi Petugas Shift" subtitle={shiftLabel} onClose={closeShiftStatusModal} maxWidth="max-w-2xl" actions={actions}>
      {!myGuard ? (
        <div className="rounded-3xl border border-dashed border-slate-700 bg-slate-900/60 p-5 text-sm text-slate-300">
          Absensi diisi oleh masing-masing petugas kapal ini dari HP mereka sendiri.
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <p className="truncate text-base font-bold text-white">{draft.name}</p>
            {isComplete
              ? <span className="shrink-0 inline-flex items-center gap-1 text-emerald-300"><CheckCircle2 className="h-4 w-4" /><span className="text-[11px] font-bold uppercase tracking-wider">Lengkap</span></span>
              : <span className="shrink-0 inline-flex items-center gap-1 text-amber-300"><Camera className="h-4 w-4" /><span className="text-[11px] font-bold uppercase tracking-wider">Belum lengkap</span></span>}
          </div>

          <PhotoField
            label="Foto Absensi"
            required
            capture="user"
            value={draft.attendancePhotoUrl}
            onChange={(attendancePhotoUrl) => updateDraft({ attendancePhotoUrl })}
          />

          {requireDcu && <DcuSection dcu={draft.dcu} onChange={updateDcu} />}

          <div>
            <p className={FIELD_LABEL}>Status <span className="text-rose-400">*</span></p>
            <div className="grid grid-cols-2 gap-2">
              <ChoiceButton active={draft.status === 'patroli'} activeClass="border-emerald-300/40 bg-emerald-500/20 text-emerald-100" onClick={() => updateDraft({ status: 'patroli' })} icon={ShieldCheck} label="Patroli" />
              <ChoiceButton active={isRest} activeClass="border-amber-300/40 bg-amber-500/20 text-amber-100" onClick={() => updateDraft({ status: 'istirahat' })} icon={Coffee} label="Istirahat" />
            </div>
          </div>

          {isRest && (
            <div>
              <p className={FIELD_LABEL}>Kondisi <span className="text-rose-400">*</span></p>
              <div className="grid grid-cols-2 gap-2">
                <ChoiceButton active={draft.condition === 'baik'} activeClass="border-emerald-300/40 bg-emerald-500/20 text-emerald-100" onClick={() => updateDraft({ condition: 'baik' })} icon={HeartPulse} label="Baik" />
                <ChoiceButton active={draft.condition === 'tidak_baik'} activeClass="border-rose-300/40 bg-rose-500/20 text-rose-100" onClick={() => updateDraft({ condition: 'tidak_baik' })} icon={HeartPulse} label="Tidak Baik" />
              </div>
            </div>
          )}

          {isRest && draft.condition === 'tidak_baik' && (
            <div>
              <label htmlFor="attendance-note" className={FIELD_LABEL}>
                Keterangan kondisi <span className="text-rose-400">*</span>
              </label>
              <textarea
                id="attendance-note"
                rows={2}
                maxLength={200}
                value={draft.conditionNote}
                onChange={(event) => updateDraft({ conditionNote: event.target.value })}
                placeholder="Contoh: demam ringan, sudah minum obat."
                className="w-full rounded-2xl border border-rose-500/40 bg-slate-950 p-3 text-sm text-slate-100 outline-none focus:border-rose-400 resize-none"
              />
            </div>
          )}
        </div>
      )}
    </ModalShell>
  );
}
