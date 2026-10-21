/*
Tujuan: Form "Update Temuan" dari halaman patroli (mode demo): bila di satu titik ada lebih dari satu
        temuan open, petugas WAJIB mengisi update untuk SEMUA temuan sekaligus sebelum bisa mengirim.
Caller: PatrolPage (pilihan UPDATE TEMUAN di PatrolNfcChoiceSheet).
Dependensi: PhotoField (FollowUpPanels), AsyncImage, useFocusTrap.
Side Effects: Memanggil onSubmit dengan daftar { incident, comment, photoUrl }; tidak menyimpan sendiri.
*/

import React, { useState } from 'react';
import { AlertTriangle, PencilLine, Send, X } from 'lucide-react';
import AsyncImage from '../AsyncImage';
import { PhotoField } from '../incidentFollowUp/FollowUpPanels';
import { useFocusTrap } from '../../hooks/useFocusTrap';

const TEXTAREA_CLASS = 'w-full bg-[#070b19]/60 border border-cyan-800/40 rounded-2xl p-3 text-sm text-cyan-50 focus:border-sky-500/60 outline-none resize-none';

export default function PatrolTemuanUpdateModal({ checkpointName, incidents = [], onClose, onSubmit }) {
  const dialogRef = useFocusTrap(true);
  const [drafts, setDrafts] = useState(() => Object.fromEntries(incidents.map((incident) => [incident.id, { comment: '', photoUrl: null }])));
  const [isSubmitting, setIsSubmitting] = useState(false);
  const filledCount = incidents.filter((incident) => drafts[incident.id]?.comment.trim()).length;
  const canSubmit = filledCount === incidents.length && incidents.length > 0 && !isSubmitting;

  const updateDraft = (incidentId, patch) => setDrafts((previous) => ({ ...previous, [incidentId]: { ...previous[incidentId], ...patch } }));

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setIsSubmitting(true);
    try {
      await onSubmit(incidents.map((incident) => ({
        incident,
        comment: drafts[incident.id].comment.trim(),
        photoUrl: drafts[incident.id].photoUrl,
      })));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[110] flex items-end sm:items-center justify-center p-4">
      <div className="absolute inset-0 bg-[#070b19]/90 backdrop-blur-md animate-in fade-in" onClick={onClose}></div>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="patrol-temuan-update-title" className="bg-[#0b1229] w-full max-w-sm max-h-[90vh] flex flex-col rounded-[2rem] border border-cyan-900/50 shadow-2xl relative animate-in slide-in-from-bottom-10 overflow-hidden">
        <div className="p-5 border-b border-cyan-800/30 flex justify-between items-start gap-3 bg-[#070b19]/40 shrink-0">
          <div>
            <h3 id="patrol-temuan-update-title" className="font-bold text-cyan-50 flex items-center gap-2"><PencilLine className="w-4 h-4 text-sky-400" /> Update Temuan</h3>
            <p className="text-[11px] text-cyan-500 mt-0.5">{checkpointName} · wajib update semua ({incidents.length}) temuan open</p>
          </div>
          <button type="button" onClick={onClose} className="p-2 hover:bg-white/5 rounded-xl transition-all" aria-label="Tutup"><X className="w-5 h-5 text-cyan-700" /></button>
        </div>

        <div className="p-5 space-y-5 overflow-y-auto">
          {incidents.map((incident, index) => {
            const draft = drafts[incident.id] || { comment: '', photoUrl: null };
            const isFilled = Boolean(draft.comment.trim());
            return (
              <div key={incident.id} className={`p-3.5 rounded-2xl border space-y-3 ${isFilled ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-yellow-500/40 bg-yellow-500/5'}`}>
                <div className="flex items-start gap-3">
                  <div className="w-12 h-12 shrink-0 rounded-lg overflow-hidden border border-yellow-500/40 bg-[#070b19] flex items-center justify-center">
                    {incident.photoUrl
                      ? <AsyncImage src={incident.thumbUrl || incident.photoUrl} fallbackSrc={incident.photoUrl} alt="Foto temuan" className="w-full h-full object-cover" />
                      : <AlertTriangle className="w-5 h-5 text-yellow-500/70" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[10px] font-black uppercase tracking-widest text-yellow-300">Temuan {index + 1}/{incidents.length}</p>
                    <p className="text-[10px] font-mono text-cyan-500">{incident.date || '-'} · {incident.time || '-'} · {incident.reportedBy || '-'}</p>
                    <p className="text-xs text-cyan-100 line-clamp-2">{incident.deskripsi || 'Tanpa deskripsi'}</p>
                  </div>
                </div>
                <div>
                  <label htmlFor={`temuan-update-${incident.id}`} className="text-[10px] font-mono text-cyan-500 block uppercase tracking-widest font-bold mb-1.5 ml-1">
                    Update kondisi <span className="text-rose-400">*</span>
                  </label>
                  <textarea
                    id={`temuan-update-${incident.id}`}
                    rows={3}
                    maxLength={240}
                    value={draft.comment}
                    onChange={(event) => updateDraft(incident.id, { comment: event.target.value })}
                    placeholder="Jelaskan kondisi temuan ini saat patroli sekarang..."
                    className={TEXTAREA_CLASS}
                  />
                </div>
                <PhotoField label="Foto" value={draft.photoUrl} onChange={(photoUrl) => updateDraft(incident.id, { photoUrl })} />
              </div>
            );
          })}
        </div>

        <div className="p-5 bg-[#070b19]/40 border-t border-cyan-800/30 shrink-0 space-y-2">
          {!canSubmit && !isSubmitting && (
            <p className="text-[11px] text-amber-300 text-center">{filledCount}/{incidents.length} temuan sudah diisi — lengkapi semua untuk mengirim.</p>
          )}
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="w-full py-4 rounded-2xl bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white transition-all active:scale-95 flex items-center justify-center gap-2"
          >
            <Send className="w-4 h-4" />
            <span className="text-xs font-black uppercase tracking-widest">{isSubmitting ? 'Mengirim…' : `Kirim ${incidents.length} Update`}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
