/*
Tujuan: Sheet pilihan hasil patroli setelah petugas tap NFC di titik checkpoint — menampilkan
        foto kondisi awal (acuan) lalu pilihan AMAN / TEMUAN.
Caller: PatrolPage (hasil usePatrolNfcScan, atau titik tanpa NFC terdaftar).
Dependensi: AsyncImage, useReports (zoom foto acuan).
*/

import React from 'react';
import { AlertTriangle, CheckCircle2, CornerDownRight, ImageIcon, Nfc, ShieldAlert, X } from 'lucide-react';
import AsyncImage from '../AsyncImage';
import { useFocusTrap } from '../../hooks/useFocusTrap';

export default function PatrolNfcChoiceSheet({ selection, parentName, onChoose, onClose, onPreviewPhoto }) {
  const dialogRef = useFocusTrap(Boolean(selection));
  if (!selection) return null;

  const { item, definition, verified } = selection;
  const referencePhotoUrl = definition?.referencePhotoUrl || null;
  const isSub = definition?.type === 'sub';

  return (
    <div className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm animate-in fade-in" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="nfc-choice-title"
        onClick={event => event.stopPropagation()}
        className="w-full sm:max-w-md bg-[#0b1229] border-t sm:border border-cyan-700/60 rounded-t-3xl sm:rounded-3xl shadow-[0_-10px_40px_rgba(6,182,212,0.15)] max-h-[92vh] overflow-y-auto pb-safe"
      >
        <div className="p-5 space-y-4">
          <div className="flex items-start justify-between gap-3">
            {verified ? (
              <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 text-[10px] font-black uppercase tracking-widest">
                <Nfc className="w-3.5 h-3.5" /> NFC Terverifikasi
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-amber-500/15 border border-amber-500/40 text-amber-300 text-[10px] font-black uppercase tracking-widest">
                <ShieldAlert className="w-3.5 h-3.5" /> Tanpa NFC
              </span>
            )}
            <button type="button" onClick={onClose} className="p-1.5 -m-1 rounded-full text-cyan-500 hover:bg-cyan-900/40" aria-label="Tutup"><X className="w-5 h-5" /></button>
          </div>

          <div>
            {isSub && parentName && (
              <p className="text-[11px] text-sky-300 flex items-center gap-1 mb-0.5"><CornerDownRight className="w-3 h-3" /> Sub dari {parentName}</p>
            )}
            <h3 id="nfc-choice-title" className="text-xl font-black text-white leading-tight">{item.name}</h3>
            {definition?.desc && <p className="text-sm text-cyan-400 mt-1">{definition.desc}</p>}
            {!verified && (
              <p className="text-[11px] text-amber-200/80 mt-2">Titik ini belum punya tag NFC terdaftar, jadi dilaporkan tanpa verifikasi NFC.</p>
            )}
          </div>

          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-cyan-500 mb-1.5 flex items-center gap-1"><ImageIcon className="w-3.5 h-3.5" /> Foto kondisi awal (acuan)</p>
            {referencePhotoUrl ? (
              <button type="button" onClick={() => onPreviewPhoto?.(referencePhotoUrl)} className="block w-full aspect-video rounded-xl overflow-hidden border border-cyan-700" aria-label="Perbesar foto acuan">
                <AsyncImage src={referencePhotoUrl} alt={`Kondisi awal ${item.name}`} className="w-full h-full object-cover" />
              </button>
            ) : (
              <div className="w-full aspect-video rounded-xl border border-dashed border-cyan-800 flex items-center justify-center text-xs text-cyan-700">Belum ada foto acuan</div>
            )}
            <p className="text-[11px] text-cyan-600 mt-1.5">Bandingkan kondisi sekarang dengan foto ini, lalu ambil foto dari sudut yang sama.</p>
          </div>

          <p className="text-xs font-bold text-cyan-200 text-center pt-1">Bagaimana kondisi titik ini?</p>
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => onChoose('aman')}
              className="py-5 rounded-2xl border border-emerald-500/50 bg-emerald-500/10 hover:bg-emerald-500/25 text-emerald-100 font-black tracking-widest flex flex-col items-center gap-2 transition-colors"
            >
              <CheckCircle2 className="w-8 h-8 text-emerald-400" /> AMAN
            </button>
            <button
              type="button"
              onClick={() => onChoose('temuan')}
              className="py-5 rounded-2xl border border-yellow-500/50 bg-yellow-500/10 hover:bg-yellow-500/25 text-yellow-100 font-black tracking-widest flex flex-col items-center gap-2 transition-colors"
            >
              <AlertTriangle className="w-8 h-8 text-yellow-400" /> TEMUAN
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
