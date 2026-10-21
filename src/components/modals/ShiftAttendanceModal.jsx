/*
Tujuan: Absensi petugas shift (mode demo) — pengganti Status Shift. Setiap pergantian shift tiap
        petugas wajib absen di HP masing-masing: foto (wajib), Patroli/Istirahat, kondisi Baik/Tidak
        Baik (Tidak Baik wajib keterangan). Checklist terkunci sampai petugas yang login sudah absen.
Caller: PatrolPage saat isDemoMode (modal status shift).
Dependensi: Patrol context (handleSaveCurrentShiftStatus), ModalShell, PhotoField, AsyncImage.
Side Effects: Menyimpan record status shift (+ foto & kondisi per petugas) ke state runtime.
*/

import React from 'react';
import { Camera, CheckCircle2, Coffee, HeartPulse, ShieldCheck } from 'lucide-react';
import { usePatrol, useRole } from '../../context/AppContextRuntime';
import { ModalShell } from '../ui';
import { PhotoField } from '../incidentFollowUp/FollowUpPanels';

function buildDraft(guard, existingItem) {
  return {
    userId: guard?.id || null,
    name: guard?.name || 'Petugas',
    status: existingItem?.status || (guard?.shiftStatus === 'istirahat' ? 'istirahat' : 'patroli'),
    attendancePhotoUrl: existingItem?.attendancePhotoUrl || null,
    condition: existingItem?.condition || null,
    conditionNote: existingItem?.conditionNote || '',
  };
}

export function isAttendanceItemComplete(item) {
  if (!item?.attendancePhotoUrl || !item?.condition) return false;
  return item.condition === 'baik' || Boolean(item.conditionNote?.trim());
}

const OPTION_BASE = 'rounded-2xl border px-3 py-2.5 transition flex items-center justify-center gap-2';

function ChoiceButton({ active, activeClass, onClick, icon: Icon, label }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active} className={`${OPTION_BASE} ${active ? activeClass : 'border-slate-700 bg-slate-900 text-slate-300 hover:text-white'}`}>
      <Icon className="h-4 w-4" />
      <span className="text-sm font-bold">{label}</span>
    </button>
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
  const [draft, setDraft] = React.useState(() => buildDraft(myGuard, myExistingItem));
  const wasOpenRef = React.useRef(false);

  React.useEffect(() => {
    if (showShiftStatusModal && !wasOpenRef.current) setDraft(buildDraft(myGuard, myExistingItem));
    wasOpenRef.current = showShiftStatusModal;
  }, [myExistingItem, myGuard, showShiftStatusModal]);

  if (!showShiftStatusModal) return null;

  const canSave = Boolean(myGuard) && isAttendanceItemComplete(draft);
  const updateDraft = (patch) => setDraft((previous) => ({ ...previous, ...patch }));
  const handleSave = () => {
    if (!canSave) return;
    // Absensi rekan (dari HP mereka) dipertahankan; hanya data petugas ini yang diganti.
    const otherItems = recordItems.filter((item) => item.userId !== currentUserRecord?.id);
    handleSaveCurrentShiftStatus([...otherItems, draft]);
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
            {isAttendanceItemComplete(draft)
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

          <div>
            <p className="text-[10px] font-mono text-cyan-500 uppercase tracking-widest font-bold mb-2 ml-1">Status <span className="text-rose-400">*</span></p>
            <div className="grid grid-cols-2 gap-2">
              <ChoiceButton active={draft.status === 'patroli'} activeClass="border-emerald-300/40 bg-emerald-500/20 text-emerald-100" onClick={() => updateDraft({ status: 'patroli' })} icon={ShieldCheck} label="Patroli" />
              <ChoiceButton active={draft.status === 'istirahat'} activeClass="border-amber-300/40 bg-amber-500/20 text-amber-100" onClick={() => updateDraft({ status: 'istirahat' })} icon={Coffee} label="Istirahat" />
            </div>
          </div>

          <div>
            <p className="text-[10px] font-mono text-cyan-500 uppercase tracking-widest font-bold mb-2 ml-1">Kondisi <span className="text-rose-400">*</span></p>
            <div className="grid grid-cols-2 gap-2">
              <ChoiceButton active={draft.condition === 'baik'} activeClass="border-emerald-300/40 bg-emerald-500/20 text-emerald-100" onClick={() => updateDraft({ condition: 'baik' })} icon={HeartPulse} label="Baik" />
              <ChoiceButton active={draft.condition === 'tidak_baik'} activeClass="border-rose-300/40 bg-rose-500/20 text-rose-100" onClick={() => updateDraft({ condition: 'tidak_baik' })} icon={HeartPulse} label="Tidak Baik" />
            </div>
          </div>

          {draft.condition === 'tidak_baik' && (
            <div>
              <label htmlFor="attendance-note" className="text-[10px] font-mono text-cyan-500 uppercase tracking-widest font-bold mb-2 ml-1 block">
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
