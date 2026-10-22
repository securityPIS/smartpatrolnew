/*
Tujuan: Popup hasil absensi satu petugas (mode demo) dari tab Info → Petugas Jaga.
Caller: PatrolPage (klik kartu petugas di HistoryDetailView).
Dependensi: ModalShell, AsyncImage, getAttendanceStatusView.
Main Functions: AttendanceDetailModal, getAttendanceStatusView.
Side Effects: Tidak ada (hanya menampilkan data absensi).
*/

import React from 'react';
import { Activity, Camera, HeartPulse, Thermometer } from 'lucide-react';
import { ModalShell } from '../ui';
import AsyncImage from '../AsyncImage';

const TONE_CLASS = {
  emerald: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
  amber: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  rose: 'border-rose-500/40 bg-rose-500/10 text-rose-300',
  slate: 'border-slate-600 bg-slate-800/60 text-slate-300',
};

// Label status absensi: "Istirahat - Kondisi Baik/Tidak Baik" atau "Patroli - Kondisi Baik".
export function getAttendanceStatusView(item) {
  if (!item?.attendancePhotoUrl) return { label: 'Belum absensi', tone: 'slate' };
  if (item.status === 'istirahat') {
    return item.condition === 'tidak_baik'
      ? { label: 'Istirahat - Kondisi Tidak Baik', tone: 'rose' }
      : { label: 'Istirahat - Kondisi Baik', tone: 'amber' };
  }
  return { label: 'Patroli - Kondisi Baik', tone: 'emerald' };
}

export function getAttendanceToneTextClass(tone) {
  return { emerald: 'text-emerald-300', amber: 'text-amber-300', rose: 'text-rose-300' }[tone] || 'text-slate-400';
}

function PhotoBlock({ label, url }) {
  return (
    <div>
      <p className="mb-2 ml-1 text-[10px] font-bold uppercase tracking-widest text-cyan-500">{label}</p>
      {url ? (
        <div className="overflow-hidden rounded-2xl border border-slate-700 bg-slate-900">
          <AsyncImage src={url} alt={label} className="max-h-72 w-full object-contain" />
        </div>
      ) : (
        <div className="flex items-center justify-center gap-2 rounded-2xl border border-dashed border-slate-700 p-4 text-xs text-slate-500">
          <Camera className="h-4 w-4" /> Tidak ada foto
        </div>
      )}
    </div>
  );
}

export default function AttendanceDetailModal({ guard, item, shiftLabel, onClose }) {
  const statusView = getAttendanceStatusView(item);
  const dcu = item?.dcu || null;

  return (
    <ModalShell title={guard?.name || item?.name || 'Petugas'} subtitle={`Hasil Absensi · ${shiftLabel || 'Shift aktif'}`} onClose={onClose} maxWidth="max-w-xl">
      <div className="space-y-4">
        <span className={`inline-block rounded-lg border px-3 py-1.5 text-xs font-bold uppercase tracking-wider ${TONE_CLASS[statusView.tone]}`}>
          {statusView.label}
        </span>

        {!item?.attendancePhotoUrl ? (
          <p className="rounded-3xl border border-dashed border-slate-700 bg-slate-900/60 p-5 text-sm text-slate-300">
            Petugas ini belum mengisi absensi untuk shift berjalan.
          </p>
        ) : (
          <>
            {item.status === 'istirahat' && item.condition === 'tidak_baik' && (
              <div className="rounded-2xl border border-rose-500/30 bg-rose-500/5 p-3">
                <p className="text-[10px] font-bold uppercase tracking-widest text-rose-300">Keterangan kondisi</p>
                <p className="mt-1 text-sm text-slate-100">{item.conditionNote || '-'}</p>
              </div>
            )}

            <PhotoBlock label="Foto Absensi" url={item.attendancePhotoUrl} />

            {dcu && (
              <div className="space-y-4 rounded-3xl border border-cyan-500/20 bg-cyan-500/5 p-4">
                <div className="flex items-center gap-2 text-cyan-300">
                  <Activity className="h-4 w-4" />
                  <p className="text-xs font-bold uppercase tracking-[0.24em]">Daily Check Up (DCU)</p>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-2xl border border-slate-700 bg-slate-950 p-3">
                    <p className="text-[10px] font-bold uppercase tracking-widest text-cyan-500"><Thermometer className="mr-1 inline h-3 w-3" />Suhu</p>
                    <p className="mt-1 text-lg font-black text-white">{dcu.temperature ?? '-'} °C</p>
                  </div>
                  <div className="rounded-2xl border border-slate-700 bg-slate-950 p-3">
                    <p className="text-[10px] font-bold uppercase tracking-widest text-cyan-500"><HeartPulse className="mr-1 inline h-3 w-3" />Tekanan darah</p>
                    <p className="mt-1 text-lg font-black text-white">{dcu.systolic ?? '-'}/{dcu.diastolic ?? '-'} <span className="text-xs font-bold text-slate-400">mmHg</span></p>
                  </div>
                </div>
                <PhotoBlock label="Foto Evidence Suhu" url={dcu.temperaturePhotoUrl} />
                <PhotoBlock label="Foto Evidence Tekanan Darah" url={dcu.bloodPressurePhotoUrl} />
              </div>
            )}
          </>
        )}
      </div>
    </ModalShell>
  );
}
