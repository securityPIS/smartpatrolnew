/*
Tujuan: Sheet pilihan hasil patroli setelah petugas tap NFC (atau simulasi tap) di titik checkpoint —
        menampilkan foto kondisi awal (acuan) lalu pilihan AMAN / TEMUAN. Bila masih ada temuan OPEN
        di titik ini, pilihannya menjadi TEMUAN BARU / UPDATE TEMUAN. Setelah temuan Unsolve, foto
        acuan diganti kondisi saat unsolve.
Caller: PatrolPage (hasil usePatrolNfcScan, atau tombol Simulasi Tap di item checkpoint).
Dependensi: AsyncImage, useFocusTrap.
*/

import React from 'react';
import { AlertTriangle, Ban, CheckCircle2, ChevronLeft, CornerDownRight, FilePlus2, ImageIcon, Nfc, PencilLine, X } from 'lucide-react';
import AsyncImage from '../AsyncImage';
import { useFocusTrap } from '../../hooks/useFocusTrap';

function formatUnsolveDate(isoValue) {
  const date = new Date(isoValue);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Jakarta' });
}

function OpenTemuanCard({ incident, onClick }) {
  const content = (
    <>
      <div className="w-12 h-12 shrink-0 rounded-lg overflow-hidden border border-yellow-500/40 bg-[#070b19] flex items-center justify-center">
        {incident.photoUrl
          ? <AsyncImage src={incident.photoUrl} alt="Foto temuan" className="w-full h-full object-cover" />
          : <AlertTriangle className="w-5 h-5 text-yellow-500/70" />}
      </div>
      <div className="min-w-0 flex-1 text-left">
        <p className="text-[10px] font-mono text-yellow-300">{incident.date || '-'} · {incident.time || '-'} · {incident.reportedBy || '-'}</p>
        <p className="text-xs text-cyan-100 line-clamp-2">{incident.deskripsi || 'Tanpa deskripsi'}</p>
      </div>
    </>
  );
  const className = 'w-full flex items-center gap-3 p-2.5 rounded-xl border border-yellow-500/30 bg-yellow-500/5';
  return onClick
    ? <button type="button" onClick={onClick} className={`${className} hover:bg-yellow-500/15 transition-colors`}>{content}</button>
    : <div className={className}>{content}</div>;
}

export default function PatrolNfcChoiceSheet({ selection, openTemuan = [], referenceOverride = null, reportBlockedReason = '', parentName, onChoose, onUpdateTemuan, onClose, onPreviewPhoto }) {
  const dialogRef = useFocusTrap(Boolean(selection));
  const [isPickingTemuan, setIsPickingTemuan] = React.useState(false);
  if (!selection) return null;

  const { item, definition, verified, simulated } = selection;
  const referencePhotoUrl = referenceOverride?.referencePhotoUrl || definition?.referencePhotoUrl || null;
  const hasOpenTemuan = openTemuan.length > 0;
  const isSub = definition?.type === 'sub';

  const handleUpdateTemuan = () => {
    if (openTemuan.length === 1) onUpdateTemuan(openTemuan[0]);
    else setIsPickingTemuan(true);
  };

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
            {simulated ? (
              <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-fuchsia-500/15 border border-fuchsia-500/40 text-fuchsia-200 text-[10px] font-black uppercase tracking-widest">
                <Nfc className="w-3.5 h-3.5" /> Simulasi Tap NFC
              </span>
            ) : (
              <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-[10px] font-black uppercase tracking-widest border ${verified ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300' : 'bg-amber-500/15 border-amber-500/40 text-amber-300'}`}>
                <Nfc className="w-3.5 h-3.5" /> {verified ? 'NFC Terverifikasi' : 'Tanpa NFC'}
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
          </div>

          {isPickingTemuan ? (
            <div className="space-y-2">
              <button type="button" onClick={() => setIsPickingTemuan(false)} className="flex items-center gap-1 text-cyan-400 hover:text-cyan-200">
                <ChevronLeft className="w-4 h-4" /> <span className="text-[11px] font-bold">Kembali</span>
              </button>
              <p className="text-xs font-bold text-cyan-200">Pilih temuan yang akan di-update</p>
              {openTemuan.map((incident) => (
                <OpenTemuanCard key={incident.id} incident={incident} onClick={() => onUpdateTemuan(incident)} />
              ))}
            </div>
          ) : (
            <>
              <div>
                <p className={`text-[10px] font-bold uppercase tracking-widest mb-1.5 flex items-center gap-1 ${referenceOverride ? 'text-orange-300' : 'text-cyan-500'}`}>
                  <ImageIcon className="w-3.5 h-3.5" /> {referenceOverride ? 'Foto kondisi awal (kondisi saat Unsolve)' : 'Foto kondisi awal (acuan)'}
                </p>
                {referencePhotoUrl ? (
                  <button type="button" onClick={() => onPreviewPhoto?.(referencePhotoUrl)} className={`block w-full aspect-video rounded-xl overflow-hidden border ${referenceOverride ? 'border-orange-500/60' : 'border-cyan-700'}`} aria-label="Perbesar foto acuan">
                    <AsyncImage src={referencePhotoUrl} alt={`Kondisi awal ${item.name}`} className="w-full h-full object-cover" />
                  </button>
                ) : (
                  <div className="w-full aspect-video rounded-xl border border-dashed border-cyan-800 flex items-center justify-center text-xs text-cyan-700">Belum ada foto acuan</div>
                )}
                {referenceOverride && (
                  <div className="mt-2 p-2.5 rounded-xl border border-orange-500/40 bg-orange-500/5">
                    <p className="text-[10px] font-black uppercase tracking-widest text-orange-300 flex items-center gap-1"><Ban className="w-3.5 h-3.5" /> Temuan Unsolve · {formatUnsolveDate(referenceOverride.updatedAt)}</p>
                    <p className="text-[11px] text-cyan-200 mt-1 whitespace-pre-wrap">{referenceOverride.note}</p>
                    <p className="text-[10px] text-cyan-600 mt-1">Ditetapkan oleh {referenceOverride.actorName}. Kondisi ini menjadi acuan baru — laporkan AMAN bila tidak ada perubahan.</p>
                  </div>
                )}
                <p className="text-[11px] text-cyan-600 mt-1.5">Bandingkan kondisi sekarang dengan foto ini, lalu ambil foto dari sudut yang sama.</p>
              </div>

              {hasOpenTemuan && (
                <div className="space-y-2">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-yellow-400 flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" /> {openTemuan.length} temuan masih open di titik ini</p>
                  <OpenTemuanCard incident={openTemuan[0]} />
                  {openTemuan.length > 1 && <p className="text-[10px] text-cyan-600">+{openTemuan.length - 1} temuan open lainnya</p>}
                </div>
              )}

              <p className="text-xs font-bold text-cyan-200 text-center pt-1">{hasOpenTemuan ? 'Apa yang ingin dilaporkan?' : 'Bagaimana kondisi titik ini?'}</p>
              {reportBlockedReason && (
                <p role="alert" className="text-[11px] text-amber-200 text-center px-2 py-2 rounded-xl border border-amber-500/40 bg-amber-950/20">{reportBlockedReason}</p>
              )}
              {hasOpenTemuan ? (
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => onChoose('temuan')}
                    disabled={Boolean(reportBlockedReason)}
                    className="disabled:opacity-40 py-5 rounded-2xl border border-yellow-500/50 bg-yellow-500/10 hover:bg-yellow-500/25 text-yellow-100 font-black tracking-widest flex flex-col items-center gap-2 transition-colors"
                  >
                    <FilePlus2 className="w-8 h-8 text-yellow-400" /> TEMUAN BARU
                  </button>
                  <button
                    type="button"
                    onClick={handleUpdateTemuan}
                    className="py-5 rounded-2xl border border-sky-500/50 bg-sky-500/10 hover:bg-sky-500/25 text-sky-100 font-black tracking-widest flex flex-col items-center gap-2 transition-colors"
                  >
                    <PencilLine className="w-8 h-8 text-sky-400" /> UPDATE TEMUAN
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => onChoose('aman')}
                    disabled={Boolean(reportBlockedReason)}
                    className="disabled:opacity-40 py-5 rounded-2xl border border-emerald-500/50 bg-emerald-500/10 hover:bg-emerald-500/25 text-emerald-100 font-black tracking-widest flex flex-col items-center gap-2 transition-colors"
                  >
                    <CheckCircle2 className="w-8 h-8 text-emerald-400" /> AMAN
                  </button>
                  <button
                    type="button"
                    onClick={() => onChoose('temuan')}
                    disabled={Boolean(reportBlockedReason)}
                    className="disabled:opacity-40 py-5 rounded-2xl border border-yellow-500/50 bg-yellow-500/10 hover:bg-yellow-500/25 text-yellow-100 font-black tracking-widest flex flex-col items-center gap-2 transition-colors"
                  >
                    <AlertTriangle className="w-8 h-8 text-yellow-400" /> TEMUAN
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
