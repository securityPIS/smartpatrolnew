/*
Tujuan: Absensi petugas shift (mode demo) — pengganti Status Shift. Setiap pergantian shift SEMUA
        petugas kapal wajib absen: foto (wajib), Patroli/Istirahat, kondisi Baik/Tidak Baik
        (Tidak Baik wajib keterangan). Checklist patroli terkunci sampai absensi lengkap.
Caller: PatrolPage saat isDemoMode (modal status shift).
Dependensi: Patrol context (handleSaveCurrentShiftStatus), ModalShell, PhotoField, AsyncImage.
Side Effects: Menyimpan record status shift (+ foto & kondisi per petugas) ke state runtime.
*/

import React from 'react';
import { Camera, CheckCircle2, Coffee, HeartPulse, ShieldCheck, Users } from 'lucide-react';
import { usePatrol, useShips } from '../../context/AppContextRuntime';
import { ModalShell } from '../ui';
import { PhotoField } from '../incidentFollowUp/FollowUpPanels';

function buildDraftItems(guards = []) {
  return (Array.isArray(guards) ? guards : []).map((guard) => ({
    userId: guard?.id || null,
    name: guard?.name || 'Petugas',
    status: guard?.shiftStatus === 'istirahat' ? 'istirahat' : 'patroli',
    attendancePhotoUrl: null,
    condition: null,
    conditionNote: '',
  }));
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
    showShiftStatusModal,
    closeShiftStatusModal,
    handleSaveCurrentShiftStatus,
  } = usePatrol();
  const { operationalShipName } = useShips();
  const [draftItems, setDraftItems] = React.useState(() => buildDraftItems(activeShiftGuardSnapshot));
  const wasOpenRef = React.useRef(false);

  React.useEffect(() => {
    if (showShiftStatusModal && !wasOpenRef.current) {
      setDraftItems(buildDraftItems(activeShiftGuardSnapshot));
    }
    wasOpenRef.current = showShiftStatusModal;
  }, [activeShiftGuardSnapshot, showShiftStatusModal]);

  if (!showShiftStatusModal) return null;

  const completedCount = draftItems.filter(isAttendanceItemComplete).length;
  const canSave = draftItems.length > 0 && completedCount === draftItems.length;
  const updateItem = (itemKey, patch) => {
    setDraftItems((previousItems) => previousItems.map((item) => (
      (item.userId || item.name) === itemKey ? { ...item, ...patch } : item
    )));
  };

  const actions = (
    <div className="space-y-2">
      {!canSave && (
        <p className="text-xs text-amber-200 text-center sm:text-right">{completedCount}/{draftItems.length} petugas sudah absen — semua petugas wajib absen.</p>
      )}
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
          onClick={() => handleSaveCurrentShiftStatus(draftItems)}
          disabled={!canSave}
          className="rounded-2xl border border-emerald-400/30 bg-emerald-500/15 px-4 py-3 text-sm font-bold text-emerald-100 transition hover:border-emerald-300/50 hover:bg-emerald-500/25 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Simpan Absensi
        </button>
      </div>
    </div>
  );

  return (
    <ModalShell title="Absensi Petugas Shift" subtitle="Wajib setiap pergantian shift" onClose={closeShiftStatusModal} maxWidth="max-w-2xl" actions={actions}>
      <div className="space-y-5">
        <div className="rounded-3xl border border-cyan-500/15 bg-cyan-500/5 p-4 text-sm text-slate-200">
          <div className="flex items-center gap-2 text-cyan-300">
            <Users className="h-4 w-4" />
            <p className="text-xs font-bold uppercase tracking-[0.28em]">Absensi Petugas</p>
          </div>
          <p className="mt-3 text-base font-bold text-white">{operationalShipName || 'Kapal Operasional'}</p>
          <p className="mt-1 text-sm text-slate-300">
            {currentShiftMeta?.label || 'Shift aktif'}
            {currentShiftMeta?.timeRange ? ` (${currentShiftMeta.timeRange})` : ''}
          </p>
          <p className="mt-3 text-sm text-slate-300">
            Semua petugas wajib absen: foto, status Patroli/Istirahat, dan kondisi badan. Kondisi Tidak Baik wajib diberi keterangan.
          </p>
          <div className="mt-4 inline-flex items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-500/10 px-3 py-1.5 text-xs font-semibold text-emerald-100">
            <CheckCircle2 className="h-3.5 w-3.5" />
            {completedCount}/{draftItems.length} sudah absen
          </div>
        </div>

        {draftItems.length === 0 ? (
          <div className="rounded-3xl border border-dashed border-slate-700 bg-slate-900/60 p-5 text-sm text-slate-300">
            Belum ada petugas aktif yang terdaftar pada kapal ini.
          </div>
        ) : (
          <div className="space-y-4">
            {draftItems.map((item) => {
              const itemKey = item.userId || item.name;
              const isComplete = isAttendanceItemComplete(item);
              return (
                <div key={itemKey} className={`rounded-3xl border p-4 space-y-4 ${isComplete ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-slate-800 bg-slate-950/80'}`}>
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-base font-bold text-white">{item.name}</p>
                      <p className="mt-1 text-[11px] font-bold uppercase tracking-[0.24em] text-cyan-300">Petugas Shift</p>
                    </div>
                    {isComplete
                      ? <span className="shrink-0 inline-flex items-center gap-1 text-emerald-300"><CheckCircle2 className="h-4 w-4" /><span className="text-[11px] font-bold uppercase tracking-wider">Sudah absen</span></span>
                      : <span className="shrink-0 inline-flex items-center gap-1 text-amber-300"><Camera className="h-4 w-4" /><span className="text-[11px] font-bold uppercase tracking-wider">Belum lengkap</span></span>}
                  </div>

                  <PhotoField
                    label="Foto Absensi"
                    required
                    capture="user"
                    value={item.attendancePhotoUrl}
                    onChange={(attendancePhotoUrl) => updateItem(itemKey, { attendancePhotoUrl })}
                  />

                  <div>
                    <p className="text-[10px] font-mono text-cyan-500 uppercase tracking-widest font-bold mb-2 ml-1">Status <span className="text-rose-400">*</span></p>
                    <div className="grid grid-cols-2 gap-2">
                      <ChoiceButton active={item.status === 'patroli'} activeClass="border-emerald-300/40 bg-emerald-500/20 text-emerald-100" onClick={() => updateItem(itemKey, { status: 'patroli' })} icon={ShieldCheck} label="Patroli" />
                      <ChoiceButton active={item.status === 'istirahat'} activeClass="border-amber-300/40 bg-amber-500/20 text-amber-100" onClick={() => updateItem(itemKey, { status: 'istirahat' })} icon={Coffee} label="Istirahat" />
                    </div>
                  </div>

                  <div>
                    <p className="text-[10px] font-mono text-cyan-500 uppercase tracking-widest font-bold mb-2 ml-1">Kondisi <span className="text-rose-400">*</span></p>
                    <div className="grid grid-cols-2 gap-2">
                      <ChoiceButton active={item.condition === 'baik'} activeClass="border-emerald-300/40 bg-emerald-500/20 text-emerald-100" onClick={() => updateItem(itemKey, { condition: 'baik' })} icon={HeartPulse} label="Baik" />
                      <ChoiceButton active={item.condition === 'tidak_baik'} activeClass="border-rose-300/40 bg-rose-500/20 text-rose-100" onClick={() => updateItem(itemKey, { condition: 'tidak_baik' })} icon={HeartPulse} label="Tidak Baik" />
                    </div>
                  </div>

                  {item.condition === 'tidak_baik' && (
                    <div>
                      <label htmlFor={`attendance-note-${itemKey}`} className="text-[10px] font-mono text-cyan-500 uppercase tracking-widest font-bold mb-2 ml-1 block">
                        Keterangan kondisi <span className="text-rose-400">*</span>
                      </label>
                      <textarea
                        id={`attendance-note-${itemKey}`}
                        rows={2}
                        maxLength={200}
                        value={item.conditionNote}
                        onChange={(event) => updateItem(itemKey, { conditionNote: event.target.value })}
                        placeholder="Contoh: demam ringan, sudah minum obat."
                        className="w-full rounded-2xl border border-rose-500/40 bg-slate-950 p-3 text-sm text-slate-100 outline-none focus:border-rose-400 resize-none"
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </ModalShell>
  );
}
