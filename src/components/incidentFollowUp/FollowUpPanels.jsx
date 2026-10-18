/*
Tujuan: Tampilan alur tindak lanjut temuan (versi dummy): assign oleh PIC Security, update PIC fungsi,
        feedback/approve PIC Security, lalu satu kali verifikasi petugas pelapor setelah semua
        tindak lanjut Approved, penutupan UNSOLVE oleh PIC Security, beserta switcher simulasi role.
Caller: IncidentDetailView (tab Info di bawah HOW, dan tab Update di atas Riwayat Update).
Dependensi: followUpStore (state dummy), followUpPdf (dokumen otomatis), AsyncImage, ikon lucide-react.
Main Functions: FollowUpRoleSwitcher, FollowUpAssignCard, FollowUpSectionList, FollowUpToast.
                FollowUpSectionList juga memuat tombol & modal Unsolve (khusus PIC Security).
Side Effects: Mengubah store dummy di memori dan membuka PDF; tidak menyentuh database.
*/

import React, { useEffect, useRef, useState } from 'react';
import { Ban, Camera, CheckCircle2, ChevronDown, ClipboardList, Eye, FileText, ImageIcon, RotateCcw, Send, ShieldAlert, ShieldCheck, UserCheck, X, XCircle } from 'lucide-react';
import AsyncImage from '../AsyncImage';
import PatrolNfcChoiceSheet from '../modals/PatrolNfcChoiceSheet';
import {
  FOLLOW_UP_STATUS,
  FOLLOW_UP_STATUS_META,
  INCIDENT_VERIFICATION_STATE,
  PIC_FUNCTION_OPTIONS,
  REPORTER_ROLE_ID,
  SECURITY_ASSIGNEE_ID,
  assignFollowUp,
  createCheckpointTemuanKey,
  formatFollowUpTimestamp,
  getAssigneeMeta,
  getIncidentVerificationState,
  getUnsolveReferencePhotoUrl,
  rememberIncidentCheckpoint,
  requestReverification,
  returnFollowUpToPic,
  seedDemoFollowUps,
  submitFollowUpUpdate,
  submitIncidentVerification,
  submitSecurityReview,
  unsolveIncident,
  useCheckpointTemuanState,
} from './followUpStore';
import { buildFollowUpPdfFileName, openFollowUpPdf } from './followUpPdf';

const LABEL_CLASS = 'text-[10px] font-mono text-cyan-500 block uppercase tracking-widest font-bold mb-2 ml-1';
const TEXTAREA_CLASS = 'w-full bg-[#070b19]/60 border border-cyan-800/40 rounded-2xl p-4 text-sm text-cyan-50 focus:border-emerald-500/50 outline-none resize-none';

export function getSimulationRoleOptions() {
  return [
    { id: SECURITY_ASSIGNEE_ID, label: 'PIC Security' },
    ...PIC_FUNCTION_OPTIONS.map((option) => ({ id: option.id, label: `PIC ${option.functionName}` })),
    { id: REPORTER_ROLE_ID, label: 'Petugas Pelapor' },
  ];
}

function resizeImageFile(file, maxSize = 1280) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onerror = () => resolve(null);
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => resolve(reader.result);
      image.onload = () => {
        const scale = Math.min(1, maxSize / Math.max(image.naturalWidth, image.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(image.naturalWidth * scale);
        canvas.height = Math.round(image.naturalHeight * scale);
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function PhotoField({ label, value, onChange, required = false }) {
  const inputRef = useRef(null);

  const handleFileChange = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const dataUrl = await resizeImageFile(file);
    if (dataUrl) onChange(dataUrl);
  };

  return (
    <div className="space-y-2.5">
      <label className={LABEL_CLASS}>{label} {required ? <span className="text-rose-400">*</span> : <span className="text-cyan-700 normal-case">(opsional)</span>}</label>
      <input ref={inputRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={handleFileChange} />
      {!value ? (
        <button type="button" onClick={() => inputRef.current?.click()} className="w-full py-6 rounded-2xl border-2 border-dashed border-cyan-800/30 bg-[#070b19]/40 text-cyan-600 text-xs font-bold flex flex-col items-center justify-center gap-2 hover:text-cyan-400 transition-all group">
          <Camera className="w-6 h-6 text-cyan-700 group-hover:text-emerald-500" />
          <span className="tracking-widest uppercase text-[10px]">Ketuk untuk ambil / pilih foto</span>
        </button>
      ) : (
        <div className="relative aspect-video rounded-2xl overflow-hidden border border-emerald-500/30 shadow-2xl">
          <AsyncImage src={value} className="w-full h-full object-cover" alt="Preview" />
          <button type="button" onClick={() => onChange(null)} className="absolute top-3 right-3 p-2 bg-rose-500 text-white rounded-xl hover:bg-rose-600 transition-all active:scale-95" aria-label="Hapus foto"><X className="w-4 h-4" /></button>
        </div>
      )}
    </div>
  );
}

function VerdictToggle({ value, onChange, approveLabel = 'Sudah Sesuai', rejectLabel = 'Belum Sesuai' }) {
  const baseClass = 'flex-1 py-3 rounded-xl border flex items-center justify-center transition-all';
  return (
    <div className="flex gap-3">
      <button type="button" onClick={() => onChange(true)} aria-label={approveLabel} aria-pressed={value === true} title={approveLabel} className={`${baseClass} ${value === true ? 'bg-emerald-600 border-emerald-400 text-white' : 'border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10'}`}>
        <CheckCircle2 className="w-7 h-7" />
      </button>
      <button type="button" onClick={() => onChange(false)} aria-label={rejectLabel} aria-pressed={value === false} title={rejectLabel} className={`${baseClass} ${value === false ? 'bg-rose-600 border-rose-400 text-white' : 'border-rose-500/30 text-rose-400 hover:bg-rose-500/10'}`}>
        <XCircle className="w-7 h-7" />
      </button>
    </div>
  );
}

const PRIMARY_ACTION_CLASS = 'bg-emerald-600 hover:bg-emerald-500 shadow-emerald-500/20 border-emerald-400/20';

// `actions` opsional: beberapa tombol submit berdampingan; default satu tombol submit.
function FollowUpModal({ title, subtitle, onClose, onSubmit, submitLabel, canSubmit, submitColorClass = PRIMARY_ACTION_CLASS, actions, children }) {
  const footerActions = actions || [{ key: 'submit', label: submitLabel, onClick: onSubmit, disabled: !canSubmit, colorClass: submitColorClass }];
  return (
    <div className="fixed inset-0 z-[110] flex items-end sm:items-center justify-center p-4">
      <div className="absolute inset-0 bg-[#070b19]/90 backdrop-blur-md animate-in fade-in" onClick={onClose}></div>
      <div className="bg-[#0b1229] w-full max-w-sm max-h-[90vh] flex flex-col rounded-[2rem] border border-cyan-900/50 shadow-2xl relative animate-in slide-in-from-bottom-10 overflow-hidden">
        <div className="p-5 border-b border-cyan-800/30 flex justify-between items-center bg-[#070b19]/40 shrink-0">
          <div>
            <h3 className="font-bold text-cyan-50">{title}</h3>
            {subtitle && <p className="text-[11px] text-cyan-500 mt-0.5">{subtitle}</p>}
          </div>
          <button type="button" onClick={onClose} className="p-2 hover:bg-white/5 rounded-xl transition-all" aria-label="Tutup"><X className="w-5 h-5 text-cyan-700" /></button>
        </div>
        <div className="p-6 space-y-5 overflow-y-auto">{children}</div>
        <div className="p-5 bg-[#070b19]/40 border-t border-cyan-800/30 flex gap-3 shrink-0">
          {footerActions.map((action) => (
            <button key={action.key} type="button" disabled={action.disabled} onClick={action.onClick} className={`flex-1 py-4 px-2 text-white disabled:opacity-50 rounded-2xl text-xs font-black uppercase whitespace-nowrap transition-all shadow-xl active:scale-95 border flex items-center justify-center gap-2 ${footerActions.length > 1 ? 'tracking-normal' : 'tracking-widest'} ${action.colorClass || PRIMARY_ACTION_CLASS}`}>
              <Send className="w-4 h-4 shrink-0" /> {action.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function DocumentCard({ fileName, onOpen, note }) {
  const [isBusy, setIsBusy] = useState(false);
  const handleOpen = async () => {
    if (isBusy) return;
    setIsBusy(true);
    try {
      await onOpen();
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <button type="button" onClick={handleOpen} className="w-full flex items-center gap-3 p-3 rounded-xl border border-rose-500/30 bg-rose-500/5 text-left hover:bg-rose-500/10 transition-all">
      <div className="w-10 h-10 rounded-lg bg-rose-500/15 border border-rose-500/40 flex items-center justify-center shrink-0">
        <FileText className="w-5 h-5 text-rose-300" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-bold text-cyan-50 truncate">{fileName}</p>
        <p className="text-[10px] text-cyan-600">{isBusy ? 'Menyiapkan PDF…' : note}</p>
      </div>
      <Eye className="w-4 h-4 text-rose-300 shrink-0" />
    </button>
  );
}

function StatusBadge({ status }) {
  const meta = FOLLOW_UP_STATUS_META[status] || FOLLOW_UP_STATUS_META[FOLLOW_UP_STATUS.NEED_ACTION];
  return <span className={`text-[9px] px-2 py-1 border rounded font-black tracking-widest uppercase whitespace-nowrap ${meta.badgeClass}`}>{meta.label}</span>;
}

export function FollowUpToast({ toast, onDismiss }) {
  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(onDismiss, 3500);
    return () => clearTimeout(timer);
  }, [toast, onDismiss]);

  if (!toast) return null;
  return (
    <div className="fixed left-1/2 -translate-x-1/2 bottom-24 z-[120] w-[calc(100%-2rem)] max-w-sm" role="status" aria-live="polite">
      <div className="flex items-start gap-3 p-4 rounded-2xl border border-emerald-500/40 bg-[#0b1229] shadow-2xl animate-in slide-in-from-bottom-4">
        <ShieldCheck className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
        <p className="text-xs text-cyan-50 leading-relaxed flex-1 whitespace-pre-line">{toast.message}</p>
        <button type="button" onClick={onDismiss} className="text-cyan-600 hover:text-cyan-300" aria-label="Tutup notifikasi"><X className="w-4 h-4" /></button>
      </div>
    </div>
  );
}

export function FollowUpRoleSwitcher({ simRole, onChange }) {
  const [isVisible, setIsVisible] = useState(false);
  const options = getSimulationRoleOptions();
  const activeLabel = options.find((option) => option.id === simRole)?.label || '-';
  return (
    <div className="px-4 py-2 bg-[#070b19] border-b border-cyan-900/50 shrink-0">
      <button
        type="button"
        onClick={() => setIsVisible((value) => !value)}
        className="w-full flex items-center gap-1.5 text-left"
        aria-expanded={isVisible}
        aria-label={isVisible ? 'Sembunyikan pilihan role simulasi' : 'Tampilkan pilihan role simulasi'}
      >
        <UserCheck className="w-3 h-3 text-cyan-600 shrink-0" />
        <span className="flex-1 min-w-0 truncate text-[9px] font-bold uppercase tracking-widest text-cyan-600">
          Simulasi sebagai: <span className="text-cyan-300">{activeLabel}</span>
        </span>
        <ChevronDown className={`w-3.5 h-3.5 text-cyan-600 shrink-0 transition-transform ${isVisible ? 'rotate-180' : ''}`} />
      </button>
      {isVisible && (
      <div className="flex gap-2 overflow-x-auto pt-2 pb-1 -mx-1 px-1 animate-in fade-in">
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => onChange(option.id)}
            className={`shrink-0 px-3 py-1.5 rounded-full border text-[10px] font-bold uppercase tracking-wider transition-all ${simRole === option.id ? 'bg-cyan-500 border-cyan-300 text-[#070b19]' : 'border-cyan-800/60 text-cyan-400 hover:bg-cyan-900/30'}`}
          >
            {option.label}
          </button>
        ))}
      </div>
      )}
    </div>
  );
}

function AssignFollowUpModal({ incident, securityName, nextSequence, onClose, onAssigned }) {
  const [assigneeId, setAssigneeId] = useState('');
  const [instruction, setInstruction] = useState('');
  const [photoUrl, setPhotoUrl] = useState(null);
  const fileName = buildFollowUpPdfFileName(incident, nextSequence);
  const assignee = assigneeId ? getAssigneeMeta(assigneeId, securityName) : null;
  const canSubmit = Boolean(assigneeId && instruction.trim());

  const pickerOptions = [
    ...PIC_FUNCTION_OPTIONS.map((option) => ({ id: option.id, title: `PIC ${option.functionName}`, subtitle: option.personName })),
    { id: SECURITY_ASSIGNEE_ID, title: 'Diri sendiri', subtitle: `PIC Security · ${securityName}` },
  ];

  const handleSubmit = () => {
    if (!canSubmit) return;
    rememberIncidentCheckpoint(incident);
    assignFollowUp(incident.id, {
      assigneeId,
      instruction: instruction.trim(),
      photoUrl,
      document: { fileName, generatedAt: new Date().toISOString() },
      actorName: securityName,
    });
    onAssigned(assignee);
  };

  return (
    <FollowUpModal title="Assign Tindak Lanjut" subtitle={`Tindak lanjut #${nextSequence} · ${incident.location || 'Temuan'}`} onClose={onClose} onSubmit={handleSubmit} submitLabel="Submit & Kirim" canSubmit={canSubmit}>
      <div>
        <label className={LABEL_CLASS}>PIC Fungsi Terkait <span className="text-rose-400">*</span></label>
        <div className="grid grid-cols-2 gap-2">
          {pickerOptions.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => setAssigneeId(option.id)}
              className={`p-3 rounded-xl border text-left transition-all ${assigneeId === option.id ? 'border-emerald-400 bg-emerald-500/10' : 'border-cyan-800/50 bg-[#070b19]/40 hover:border-cyan-600'}`}
            >
              <p className={`text-xs font-bold ${assigneeId === option.id ? 'text-emerald-300' : 'text-cyan-100'}`}>{option.title}</p>
              <p className="text-[10px] text-cyan-600 truncate">{option.subtitle}</p>
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className={LABEL_CLASS}>Instruksi <span className="text-rose-400">*</span></label>
        <textarea value={instruction} onChange={(event) => setInstruction(event.target.value)} rows={4} placeholder="Tuliskan instruksi tindak lanjut untuk PIC terkait..." className={TEXTAREA_CLASS} />
      </div>

      <PhotoField label="Foto" value={photoUrl} onChange={setPhotoUrl} />

      <div>
        <label className={LABEL_CLASS}>Dokumen <span className="text-cyan-700 normal-case">(dibuat otomatis)</span></label>
        <DocumentCard
          fileName={fileName}
          note="Ringkasan 5W1H + instruksi · ketuk untuk pratinjau"
          onOpen={() => openFollowUpPdf({
            incident,
            instruction: instruction.trim() || '(instruksi belum diisi)',
            assigneeLabel: assignee?.label || '(PIC belum dipilih)',
            securityName,
            photoUrl,
            sequence: nextSequence,
            fileName,
          })}
        />
      </div>
    </FollowUpModal>
  );
}

function UpdateFollowUpModal({ incident, followUp, sequence, actor, onClose, onSubmitted }) {
  const [comment, setComment] = useState('');
  const [photoUrl, setPhotoUrl] = useState(null);
  const canSubmit = Boolean(comment.trim());

  const handleSubmit = () => {
    if (!canSubmit) return;
    submitFollowUpUpdate(incident.id, followUp.id, { comment: comment.trim(), photoUrl, actorName: actor.personName, actorRole: `PIC ${actor.functionName}` });
    onSubmitted();
  };

  return (
    <FollowUpModal title="Update Tindak Lanjut" subtitle={`Tindak lanjut #${sequence} · ${actor.label}`} onClose={onClose} onSubmit={handleSubmit} submitLabel="Kirim Update" canSubmit={canSubmit}>
      <div className="p-3 rounded-xl border border-cyan-900/50 bg-[#070b19]/40">
        <p className="text-[9px] font-bold uppercase tracking-widest text-cyan-600 mb-1">Instruksi PIC Security</p>
        <p className="text-xs text-cyan-100 whitespace-pre-wrap">{followUp.instruction}</p>
      </div>
      <div>
        <label className={LABEL_CLASS}>Hasil Tindak Lanjut <span className="text-rose-400">*</span></label>
        <textarea autoFocus value={comment} onChange={(event) => setComment(event.target.value)} rows={4} placeholder="Jelaskan tindakan yang sudah dilakukan..." className={TEXTAREA_CLASS} />
      </div>
      <PhotoField label="Foto Bukti" value={photoUrl} onChange={setPhotoUrl} />
    </FollowUpModal>
  );
}

function ReviewFollowUpModal({ incident, followUp, sequence, securityName, onClose, onSubmitted }) {
  const [approved, setApproved] = useState(null);
  const [comment, setComment] = useState('');
  const latestUpdate = [...followUp.entries].reverse().find((entry) => entry.kind === 'update');
  const canSubmit = approved === true || (approved === false && Boolean(comment.trim()));

  const handleSubmit = (finalApproval) => {
    if (!canSubmit) return;
    submitSecurityReview(incident.id, followUp.id, { approved, finalApproval, comment: comment.trim(), actorName: securityName });
    onSubmitted({ approved, finalApproval });
  };

  const actions = approved
    ? [
      { key: 'plan', label: 'Konfirmasi Rencana', onClick: () => handleSubmit(false), disabled: !canSubmit, colorClass: 'bg-sky-700 hover:bg-sky-600 shadow-sky-500/20 border-sky-400/20' },
      { key: 'approve', label: 'Approve', onClick: () => handleSubmit(true), disabled: !canSubmit, colorClass: 'bg-teal-600 hover:bg-teal-500 shadow-teal-500/20 border-teal-400/20' },
    ]
    : [{ key: 'submit', label: 'Submit', onClick: () => handleSubmit(false), disabled: !canSubmit, colorClass: PRIMARY_ACTION_CLASS }];

  return (
    <FollowUpModal title="Feedback PIC Security" subtitle={`Tindak lanjut #${sequence}`} onClose={onClose} actions={actions}>
      {latestUpdate && (
        <div className="p-3 rounded-xl border border-sky-900/50 bg-sky-950/20">
          <p className="text-[9px] font-bold uppercase tracking-widest text-sky-500 mb-1">Update terakhir · {latestUpdate.actorName}</p>
          <p className="text-xs text-cyan-100 whitespace-pre-wrap">{latestUpdate.comment}</p>
        </div>
      )}
      <div>
        <label className={LABEL_CLASS}>Apakah sudah sesuai? <span className="text-rose-400">*</span></label>
        <VerdictToggle value={approved} onChange={setApproved} />
      </div>
      {approved !== null && (
        <div>
          <label className={LABEL_CLASS}>
            {approved ? 'Catatan' : 'Komentar'} {approved ? <span className="text-cyan-700 normal-case">(opsional)</span> : <span className="text-rose-400">*</span>}
          </label>
          <textarea value={comment} onChange={(event) => setComment(event.target.value)} rows={3} placeholder={approved ? 'Contoh: rencana disetujui, kabari setelah pekerjaan selesai.' : 'Jelaskan apa yang belum sesuai...'} className={TEXTAREA_CLASS} />
          {approved && (
            <div className="text-[10px] mt-2 ml-1 space-y-1">
              <p className="text-sky-300"><span className="font-bold">Konfirmasi Rencana</span>: rencana tindakan PIC fungsi disetujui. Status kembali Need Action sampai pekerjaan selesai dan diupdate lagi.</p>
              <p className="text-teal-300"><span className="font-bold">Approve</span>: pekerjaan selesai. Setelah semua tindak lanjut Approved, petugas pelapor ({incident.reportedBy || '-'}) memverifikasi temuan 1x.</p>
            </div>
          )}
          {!approved && <p className="text-[10px] text-amber-300 mt-2 ml-1">Status kembali menjadi Need Action untuk ditindaklanjuti ulang.</p>}
        </div>
      )}
    </FollowUpModal>
  );
}

function VerifyIncidentModal({ incident, followUps, securityName, reporterName, onClose, onSubmitted }) {
  const [approved, setApproved] = useState(null);
  const [comment, setComment] = useState('');
  const [photoUrl, setPhotoUrl] = useState(null);
  const canSubmit = approved !== null && Boolean(comment.trim()) && Boolean(photoUrl);

  const handleSubmit = () => {
    if (!canSubmit) return;
    const result = submitIncidentVerification(incident.id, { approved, comment: comment.trim(), photoUrl, actorName: reporterName });
    onSubmitted({ approved, ...result });
  };

  return (
    <FollowUpModal title="Verifikasi Temuan" subtitle={`${followUps.length} tindak lanjut · ${reporterName}`} onClose={onClose} onSubmit={handleSubmit} submitLabel="Kirim Verifikasi" canSubmit={canSubmit}>
      <div className="space-y-2">
        <p className={LABEL_CLASS}>Tindak lanjut yang sudah di-approve PIC Security</p>
        {followUps.map((followUp, index) => {
          const assignee = getAssigneeMeta(followUp.assigneeId, securityName);
          const latestUpdate = [...followUp.entries].reverse().find((entry) => entry.kind === 'update');
          return (
            <div key={followUp.id} className="p-3 rounded-xl border border-cyan-900/50 bg-[#070b19]/40">
              <p className="text-[10px] font-bold uppercase tracking-widest text-teal-300">#{index + 1} · PIC {assignee.functionName}</p>
              <p className="text-xs text-cyan-100 whitespace-pre-wrap mt-1">{followUp.instruction}</p>
              {latestUpdate?.comment && <p className="text-[11px] text-cyan-500 whitespace-pre-wrap mt-1">Hasil: {latestUpdate.comment}</p>}
            </div>
          );
        })}
      </div>
      <div>
        <label className={LABEL_CLASS}>Hasil verifikasi lapangan <span className="text-rose-400">*</span></label>
        <VerdictToggle value={approved} onChange={setApproved} approveLabel="Terverifikasi" rejectLabel="Belum Sesuai" />
        {approved === true && <p className="text-[10px] text-emerald-300 mt-2 ml-1">Semua tindak lanjut menjadi Done dan temuan ditutup (Closed).</p>}
        {approved === false && <p className="text-[10px] text-amber-300 mt-2 ml-1">Temuan dikembalikan ke PIC Security untuk ditindaklanjuti.</p>}
      </div>
      <div>
        <label className={LABEL_CLASS}>Catatan Verifikasi <span className="text-rose-400">*</span></label>
        <textarea value={comment} onChange={(event) => setComment(event.target.value)} rows={3} placeholder="Jelaskan kondisi di lapangan saat verifikasi..." className={TEXTAREA_CLASS} />
      </div>
      <PhotoField label="Evidence" value={photoUrl} onChange={setPhotoUrl} required />
    </FollowUpModal>
  );
}

function ReturnFollowUpModal({ incident, followUp, sequence, securityName, onClose, onSubmitted }) {
  const [comment, setComment] = useState('');
  const assignee = getAssigneeMeta(followUp.assigneeId, securityName);
  const canSubmit = Boolean(comment.trim());

  const handleSubmit = () => {
    if (!canSubmit) return;
    returnFollowUpToPic(incident.id, followUp.id, { comment: comment.trim(), actorName: securityName });
    onSubmitted(assignee);
  };

  return (
    <FollowUpModal title="Kembalikan ke PIC" subtitle={`Tindak lanjut #${sequence} · ${assignee.label}`} onClose={onClose} onSubmit={handleSubmit} submitLabel="Kembalikan" canSubmit={canSubmit}>
      <div className="p-3 rounded-xl border border-cyan-900/50 bg-[#070b19]/40">
        <p className="text-[9px] font-bold uppercase tracking-widest text-cyan-600 mb-1">Instruksi</p>
        <p className="text-xs text-cyan-100 whitespace-pre-wrap">{followUp.instruction}</p>
      </div>
      <div>
        <label className={LABEL_CLASS}>Apa yang harus diperbaiki? <span className="text-rose-400">*</span></label>
        <textarea autoFocus value={comment} onChange={(event) => setComment(event.target.value)} rows={3} placeholder="Jelaskan apa yang perlu dikerjakan ulang..." className={TEXTAREA_CLASS} />
        <p className="text-[10px] text-amber-300 mt-2 ml-1">Status tindak lanjut kembali Need Action.</p>
      </div>
    </FollowUpModal>
  );
}

function ReverifyRequestModal({ incident, reporterName, securityName, onClose, onSubmitted }) {
  const [comment, setComment] = useState('');
  const canSubmit = Boolean(comment.trim());
  const handleSubmit = () => {
    if (!canSubmit) return;
    requestReverification(incident.id, { comment: comment.trim(), actorName: securityName });
    onSubmitted();
  };
  return (
    <FollowUpModal title="Minta Verifikasi Ulang" subtitle={`Ke petugas pelapor · ${reporterName}`} onClose={onClose} onSubmit={handleSubmit} submitLabel="Kirim" canSubmit={canSubmit}>
      <div>
        <label className={LABEL_CLASS}>Catatan untuk petugas <span className="text-rose-400">*</span></label>
        <textarea autoFocus value={comment} onChange={(event) => setComment(event.target.value)} rows={3} placeholder="Contoh: tindak lanjut sudah sesuai instruksi, mohon dicek ulang bagian ..." className={TEXTAREA_CLASS} />
      </div>
    </FollowUpModal>
  );
}

const UNSOLVE_ACTION_CLASS = 'bg-orange-600 hover:bg-orange-500 shadow-orange-500/20 border-orange-400/20';

function UnsolveIncidentModal({ incident, followUps, securityName, onClose, onSubmitted }) {
  const [comment, setComment] = useState('');
  const [photoUrl, setPhotoUrl] = useState(null);
  const canSubmit = Boolean(comment.trim());
  const openFollowUps = followUps.filter((item) => item.status !== FOLLOW_UP_STATUS.DONE);
  const nextReferencePhotoUrl = getUnsolveReferencePhotoUrl(incident, photoUrl);
  const checkpointName = incident.isPatrol ? incident.location : '';

  const handleSubmit = () => {
    if (!canSubmit) return;
    const result = unsolveIncident(incident, { comment: comment.trim(), photoUrl, actorName: securityName });
    onSubmitted({ ...result, checkpointName });
  };

  return (
    <FollowUpModal title="Unsolve Temuan" subtitle={`${incident.location || 'Temuan'} · PIC Security`} onClose={onClose} onSubmit={handleSubmit} submitLabel="Tetapkan Unsolve" canSubmit={canSubmit} submitColorClass={UNSOLVE_ACTION_CLASS}>
      <div className="p-3 rounded-xl border border-orange-500/40 bg-orange-500/5 space-y-1">
        <p className="text-[10px] font-bold uppercase tracking-widest text-orange-300">Temuan tidak dapat diselesaikan</p>
        <p className="text-[11px] text-cyan-200 leading-relaxed">
          Status temuan menjadi <span className="font-bold text-orange-300">UNSOLVE</span> (bukan Aman, bukan Closed).
          {openFollowUps.length > 0 ? ` ${openFollowUps.length} tindak lanjut ikut ditutup.` : ' Belum ada tindak lanjut yang berjalan.'}
        </p>
      </div>

      {openFollowUps.length > 0 && (
        <div className="space-y-1.5">
          {openFollowUps.map((followUp) => (
            <div key={followUp.id} className="flex items-center justify-between gap-2 text-xs">
              <span className="text-cyan-100 truncate">#{followUps.indexOf(followUp) + 1} · {getAssigneeMeta(followUp.assigneeId, securityName).label}</span>
              <span className="flex items-center gap-1 shrink-0"><StatusBadge status={followUp.status} /><span className="text-cyan-700">→</span><StatusBadge status={FOLLOW_UP_STATUS.UNSOLVED} /></span>
            </div>
          ))}
        </div>
      )}

      <div>
        <label className={LABEL_CLASS}>Catatan Unsolve <span className="text-rose-400">*</span></label>
        <textarea autoFocus value={comment} onChange={(event) => setComment(event.target.value)} rows={4} placeholder="Jelaskan kenapa temuan tidak dapat diselesaikan dan kondisi yang diterima saat ini..." className={TEXTAREA_CLASS} />
      </div>

      <PhotoField label="Evidence" value={photoUrl} onChange={setPhotoUrl} />

      {checkpointName && (
        <div>
          <label className={LABEL_CLASS}>Foto kondisi awal titik baru</label>
          <div className="flex items-center gap-3 p-3 rounded-xl border border-cyan-900/50 bg-[#070b19]/40">
            <div className="w-20 h-14 rounded-lg overflow-hidden border border-cyan-800 shrink-0 bg-[#070b19] flex items-center justify-center">
              {nextReferencePhotoUrl
                ? <AsyncImage src={nextReferencePhotoUrl} className="w-full h-full object-cover" alt="Foto acuan baru" />
                : <ImageIcon className="w-5 h-5 text-cyan-800" />}
            </div>
            <p className="text-[11px] text-cyan-300 leading-relaxed">
              {nextReferencePhotoUrl
                ? <>Foto acuan titik <span className="font-bold text-cyan-100">{checkpointName}</span> diganti dengan {photoUrl ? 'evidence ini' : 'foto temuan'}. Tombol <span className="font-bold text-emerald-300">AMAN</span> muncul lagi di titik ini.</>
                : <>Tidak ada foto; foto acuan titik <span className="font-bold text-cyan-100">{checkpointName}</span> tetap. Tombol <span className="font-bold text-emerald-300">AMAN</span> muncul lagi di titik ini.</>}
            </p>
          </div>
        </div>
      )}
    </FollowUpModal>
  );
}

export function FollowUpAssignCard({ incident, followUps, simRole, securityName, isClosed, isUnsolved = false, onToast, onOpenUpdateTab }) {
  const [showAssignForm, setShowAssignForm] = useState(false);
  const canAssign = !isClosed && simRole === SECURITY_ASSIGNEE_ID;
  const approvedCount = followUps.filter((item) => item.status === FOLLOW_UP_STATUS.APPROVED || item.status === FOLLOW_UP_STATUS.DONE).length;

  return (
    <div className="p-4 rounded-xl border bg-cyan-950/20 border-cyan-800/40">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <p className="text-[10px] font-bold flex items-center gap-1.5 uppercase tracking-widest text-cyan-400"><ClipboardList className="w-3 h-3" /> Penugasan Tindak Lanjut</p>
          <p className="text-[11px] text-cyan-600 mt-1">
            {followUps.length === 0 ? 'Belum ada tindak lanjut yang ditugaskan.' : `${followUps.length} tindak lanjut · ${approvedCount} approved`}
          </p>
        </div>
        {followUps.length > 0 && (
          <button type="button" onClick={onOpenUpdateTab} className="text-[10px] font-bold uppercase tracking-widest text-emerald-400 hover:text-emerald-300 whitespace-nowrap">Lihat progres</button>
        )}
      </div>

      {followUps.length > 0 && (
        <div className="space-y-1.5 mb-3">
          {followUps.map((followUp, index) => (
            <div key={followUp.id} className="flex items-center justify-between gap-2 text-xs">
              <span className="text-cyan-100 truncate">#{index + 1} · {getAssigneeMeta(followUp.assigneeId, securityName).label}</span>
              <StatusBadge status={followUp.status} />
            </div>
          ))}
        </div>
      )}

      {canAssign ? (
        <button type="button" onClick={() => setShowAssignForm(true)} className="w-full py-3 bg-emerald-600/10 border border-emerald-500/30 text-emerald-400 rounded-xl text-xs font-black uppercase tracking-widest flex items-center justify-center gap-2 hover:bg-emerald-600 hover:text-white transition-all active:scale-[0.98]">
          <Send className="w-4 h-4" /> Assign Tindak Lanjut
        </button>
      ) : (
        <p className="text-[11px] text-amber-300/80">{isUnsolved ? 'Temuan Unsolve — ditutup PIC Security tanpa penyelesaian.' : isClosed ? 'Temuan sudah ditutup.' : 'Hanya PIC Security yang dapat menugaskan tindak lanjut.'}</p>
      )}

      {showAssignForm && (
        <AssignFollowUpModal
          incident={incident}
          securityName={securityName}
          nextSequence={followUps.length + 1}
          onClose={() => setShowAssignForm(false)}
          onAssigned={(assignee) => {
            setShowAssignForm(false);
            onToast(assignee.id === SECURITY_ASSIGNEE_ID
              ? 'Tindak lanjut ditugaskan ke diri sendiri (PIC Security).'
              : `Notifikasi terkirim ke ${assignee.label}.\nStatus tindak lanjut: Need Action.`);
          }}
        />
      )}
    </div>
  );
}

function getWaitingHint(followUp, assignee, reporterName, isClosed) {
  if (followUp.status === FOLLOW_UP_STATUS.UNSOLVED) return 'Ditutup sebagai Unsolve oleh PIC Security.';
  if (isClosed && followUp.status !== FOLLOW_UP_STATUS.DONE) return 'Temuan sudah ditutup.';
  if (followUp.status === FOLLOW_UP_STATUS.NEED_ACTION) {
    const lastReview = [...followUp.entries].reverse().find((entry) => entry.kind === 'review');
    return lastReview?.planConfirmed
      ? `Rencana sudah dikonfirmasi PIC Security. Menunggu update penyelesaian dari ${assignee.label}.`
      : `Menunggu update dari ${assignee.label}.`;
  }
  if (followUp.status === FOLLOW_UP_STATUS.NEED_REVIEW) return 'Menunggu feedback PIC Security.';
  if (followUp.status === FOLLOW_UP_STATUS.APPROVED) return `Sudah di-approve PIC Security. Verifikasi petugas pelapor (${reporterName}) dilakukan 1x setelah semua tindak lanjut Approved.`;
  return 'Tindak lanjut selesai dan temuan sudah terverifikasi.';
}

const ENTRY_TITLES = {
  assign: 'Instruksi',
  update: 'Update PIC',
  review: 'Feedback PIC Security',
  return: 'Dikembalikan ke PIC',
  unsolve: 'Ditutup · Unsolve',
};

function getFollowUpActions(followUp, simRole, isClosed) {
  return {
    canUpdate: !isClosed && followUp.status === FOLLOW_UP_STATUS.NEED_ACTION && simRole === followUp.assigneeId,
    canReview: !isClosed && followUp.status === FOLLOW_UP_STATUS.NEED_REVIEW && simRole === SECURITY_ASSIGNEE_ID,
    canReturn: !isClosed && followUp.status === FOLLOW_UP_STATUS.APPROVED && simRole === SECURITY_ASSIGNEE_ID,
  };
}

function FollowUpSection({ incident, followUp, sequence, simRole, securityName, reporterName, isClosed, onPreviewPhoto, onAction }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const assignee = getAssigneeMeta(followUp.assigneeId, securityName);
  const createdStamp = formatFollowUpTimestamp(followUp.createdAt);
  const { canUpdate, canReview, canReturn } = getFollowUpActions(followUp, simRole, isClosed);
  // "Kembalikan ke PIC" adalah opsi, bukan tindakan wajib → tidak ditandai "perlu tindakan".
  const hasAction = canUpdate || canReview;
  const activityEntries = followUp.entries.filter((entry) => entry.kind !== 'assign');

  return (
    <div className={`rounded-xl border bg-[#0b1229] shadow-sm overflow-hidden transition-colors ${hasAction ? 'border-emerald-500/50' : 'border-cyan-900/50'}`}>
      <button type="button" onClick={() => setIsExpanded((value) => !value)} className="w-full p-3.5 flex items-center gap-3 text-left" aria-expanded={isExpanded}>
        <div className="w-8 h-8 rounded-lg bg-cyan-900/40 border border-cyan-800/60 flex items-center justify-center text-xs font-black text-cyan-300 shrink-0">#{sequence}</div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold text-cyan-50 truncate">PIC {assignee.functionName}</p>
          <p className="text-[10px] text-cyan-600 truncate">{assignee.personName} · {createdStamp.date} {createdStamp.time}</p>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <StatusBadge status={followUp.status} />
          {hasAction && <span className="text-[9px] font-bold text-emerald-400 uppercase tracking-wider">Perlu tindakan Anda</span>}
        </div>
        <ChevronDown className={`w-4 h-4 text-cyan-600 shrink-0 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
      </button>

      {isExpanded && (
        <div className="px-3.5 pb-4 space-y-4 border-t border-cyan-900/40 pt-4 animate-in fade-in">
          <div>
            <p className="text-[9px] font-bold uppercase tracking-widest text-cyan-600 mb-1">Instruksi · {followUp.createdBy}</p>
            <p className="text-sm text-cyan-50 whitespace-pre-wrap leading-relaxed">{followUp.instruction}</p>
          </div>

          {(followUp.photoUrl || followUp.document) && (
            <div className="space-y-2">
              {followUp.photoUrl && (
                <button type="button" onClick={() => onPreviewPhoto({ url: followUp.photoUrl, author: followUp.createdBy, time: `${createdStamp.date} ${createdStamp.time}` })} className="block w-24 h-24 rounded-lg overflow-hidden border border-cyan-800 hover:opacity-80 transition-all">
                  <AsyncImage src={followUp.photoUrl} className="w-full h-full object-cover" alt="Foto instruksi" />
                </button>
              )}
              {followUp.document && (
                <DocumentCard
                  fileName={followUp.document.fileName}
                  note="Dokumen temuan · dibuat otomatis"
                  onOpen={() => openFollowUpPdf({
                    incident,
                    instruction: followUp.instruction,
                    assigneeLabel: assignee.label,
                    securityName: followUp.createdBy,
                    photoUrl: followUp.photoUrl,
                    generatedAt: followUp.document.generatedAt,
                    sequence,
                    fileName: followUp.document.fileName,
                  })}
                />
              )}
            </div>
          )}

          {activityEntries.length > 0 && (
            <div>
              <p className="text-[9px] font-bold uppercase tracking-widest text-cyan-600 mb-2">Aktivitas</p>
              <div className="space-y-3 border-l-2 border-cyan-900 ml-1 pl-3">
                {activityEntries.map((entry) => {
                  const stamp = formatFollowUpTimestamp(entry.at);
                  const verdictClass = entry.kind === 'unsolve' ? 'text-orange-300' : entry.verdict === 'approved' ? 'text-emerald-400' : entry.verdict === 'rejected' ? 'text-rose-400' : 'text-cyan-400';
                  return (
                    <div key={entry.id}>
                      <p className="text-[10px] font-mono text-cyan-600">{stamp.date} {stamp.time} · <span className="text-cyan-300 font-bold">{entry.actorName}</span></p>
                      <p className={`text-[10px] font-bold uppercase tracking-wider ${verdictClass}`}>
                        {ENTRY_TITLES[entry.kind] || entry.kind}{entry.kind !== 'return' && entry.verdict === 'approved' ? (entry.planConfirmed ? ' · Rencana dikonfirmasi' : ' · Approved') : entry.kind !== 'return' && entry.verdict === 'rejected' ? ' · Belum sesuai' : ''}
                      </p>
                      {entry.comment && <p className="text-xs text-cyan-100 whitespace-pre-wrap mt-0.5">{entry.comment}</p>}
                      {entry.photoUrl && (
                        <button type="button" onClick={() => onPreviewPhoto({ url: entry.photoUrl, author: entry.actorName, time: `${stamp.date} ${stamp.time}` })} className="mt-1.5 block w-16 h-16 rounded-lg overflow-hidden border border-cyan-800 hover:opacity-80 transition-all">
                          <AsyncImage src={entry.photoUrl} className="w-full h-full object-cover" alt="Lampiran" />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {canUpdate && (
            <button type="button" onClick={() => onAction('update', followUp, sequence)} className="w-full py-3 bg-emerald-600 text-white rounded-xl text-xs font-black uppercase tracking-widest flex items-center justify-center gap-2 hover:bg-emerald-500 transition-all active:scale-[0.98]">
              <Send className="w-4 h-4" /> Update
            </button>
          )}
          {canReview && (
            <button type="button" onClick={() => onAction('review', followUp, sequence)} className="w-full py-3 bg-sky-600 text-white rounded-xl text-xs font-black uppercase tracking-widest flex items-center justify-center gap-2 hover:bg-sky-500 transition-all active:scale-[0.98]">
              <ShieldCheck className="w-4 h-4" /> Beri Feedback
            </button>
          )}
          {!hasAction && <p className="text-[11px] text-cyan-600 italic">{getWaitingHint(followUp, assignee, reporterName, isClosed)}</p>}
          {canReturn && (
            <button type="button" onClick={() => onAction('return', followUp, sequence)} className="w-full py-3 border border-amber-500/40 text-amber-300 rounded-xl text-xs font-black uppercase tracking-widest flex items-center justify-center gap-2 hover:bg-amber-500/10 transition-all active:scale-[0.98]">
              <RotateCcw className="w-4 h-4" /> Kembalikan ke PIC
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function IncidentUnsolveCard({ unsolve, onPreviewPhoto }) {
  const stamp = formatFollowUpTimestamp(unsolve.at);
  return (
    <div className="p-3.5 rounded-xl border border-orange-500/40 bg-orange-500/5 space-y-2">
      <div className="flex items-start gap-3">
        <Ban className="w-5 h-5 text-orange-400 shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold text-orange-300 uppercase tracking-widest">Temuan Unsolve</p>
          <p className="text-[11px] text-cyan-400 mt-0.5">Ditutup oleh {unsolve.actorName} · {stamp.date} {stamp.time}</p>
          <p className="text-xs text-cyan-100 whitespace-pre-wrap mt-1.5">{unsolve.comment}</p>
        </div>
        {unsolve.photoUrl && (
          <button type="button" onClick={() => onPreviewPhoto({ url: unsolve.photoUrl, author: unsolve.actorName, time: `${stamp.date} ${stamp.time}` })} className="w-14 h-14 rounded-lg overflow-hidden border border-orange-500/40 shrink-0 hover:opacity-80 transition-all" aria-label="Lihat evidence unsolve">
            <AsyncImage src={unsolve.photoUrl} className="w-full h-full object-cover" alt="Evidence unsolve" />
          </button>
        )}
      </div>
      {unsolve.checkpointKey && unsolve.referencePhotoUrl && (
        <p className="text-[10px] text-emerald-300/90 flex items-center gap-1.5"><ImageIcon className="w-3 h-3 shrink-0" /> Foto kondisi awal titik diperbarui · tombol AMAN tersedia lagi.</p>
      )}
    </div>
  );
}

function UnsolveActionButton({ onClick }) {
  return (
    <button type="button" onClick={onClick} className="w-full py-3 border border-orange-500/50 text-orange-300 rounded-xl text-xs font-black uppercase tracking-widest flex items-center justify-center gap-2 hover:bg-orange-500/10 transition-all active:scale-[0.98]">
      <Ban className="w-4 h-4" /> Unsolve Temuan
    </button>
  );
}

function IncidentVerificationCard({ state, followUps, verification, closure, simRole, reporterName, onAction }) {
  if (state === INCIDENT_VERIFICATION_STATE.NO_FOLLOW_UP || state === INCIDENT_VERIFICATION_STATE.UNSOLVED) return null;
  const approvedCount = followUps.filter((item) => item.status === FOLLOW_UP_STATUS.APPROVED || item.status === FOLLOW_UP_STATUS.DONE).length;
  const lastVerify = [...(verification?.entries || [])].reverse().find((entry) => entry.kind === 'verify');

  if (state === INCIDENT_VERIFICATION_STATE.CLOSED) {
    const stamp = formatFollowUpTimestamp(closure.at);
    return (
      <div className="p-3.5 rounded-xl border border-emerald-500/40 bg-emerald-500/5 flex items-start gap-3">
        <ShieldCheck className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
        <div>
          <p className="text-xs font-bold text-emerald-300 uppercase tracking-widest">Temuan Closed</p>
          <p className="text-[11px] text-cyan-400 mt-0.5">Terverifikasi oleh {closure.actorName} · {stamp.date} {stamp.time}</p>
        </div>
      </div>
    );
  }

  if (state === INCIDENT_VERIFICATION_STATE.AWAITING_SECURITY) {
    return (
      <div className="p-3.5 rounded-xl border border-rose-500/40 bg-rose-950/20 space-y-3">
        <div className="flex items-start gap-3">
          <ShieldAlert className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
          <div className="min-w-0">
            <p className="text-xs font-bold text-rose-300 uppercase tracking-widest">Verifikasi Belum Sesuai</p>
            <p className="text-[11px] text-cyan-400 mt-0.5">{lastVerify?.actorName || reporterName}: {lastVerify?.comment || '-'}</p>
          </div>
        </div>
        {simRole === SECURITY_ASSIGNEE_ID ? (
          <>
            <p className="text-[11px] text-amber-200/90">Putuskan tindakan: kembalikan tindak lanjut tertentu ke PIC fungsi, assign tindak lanjut baru (tab Info), atau minta petugas verifikasi ulang.</p>
            <button type="button" onClick={() => onAction('reverify')} className="w-full py-3 border border-fuchsia-500/50 text-fuchsia-200 rounded-xl text-xs font-black uppercase tracking-widest flex items-center justify-center gap-2 hover:bg-fuchsia-500/10 transition-all active:scale-[0.98]">
              <RotateCcw className="w-4 h-4" /> Minta Verifikasi Ulang
            </button>
          </>
        ) : (
          <p className="text-[11px] text-cyan-600 italic">Menunggu keputusan PIC Security.</p>
        )}
      </div>
    );
  }

  if (state === INCIDENT_VERIFICATION_STATE.READY) {
    return (
      <div className={`p-3.5 rounded-xl border space-y-3 ${simRole === REPORTER_ROLE_ID ? 'border-fuchsia-500/50 bg-fuchsia-500/5' : 'border-fuchsia-900/50 bg-[#0b1229]/60'}`}>
        <div className="flex items-start gap-3">
          <CheckCircle2 className="w-5 h-5 text-fuchsia-300 shrink-0 mt-0.5" />
          <div>
            <p className="text-xs font-bold text-fuchsia-200 uppercase tracking-widest">Siap Diverifikasi</p>
            <p className="text-[11px] text-cyan-400 mt-0.5">Semua tindak lanjut ({followUps.length}) sudah di-approve PIC Security.</p>
          </div>
        </div>
        {simRole === REPORTER_ROLE_ID ? (
          <button type="button" onClick={() => onAction('verify')} className="w-full py-3 bg-fuchsia-600 text-white rounded-xl text-xs font-black uppercase tracking-widest flex items-center justify-center gap-2 hover:bg-fuchsia-500 transition-all active:scale-[0.98]">
            <CheckCircle2 className="w-4 h-4" /> Verifikasi Temuan
          </button>
        ) : (
          <p className="text-[11px] text-cyan-600 italic">Menunggu verifikasi petugas pelapor ({reporterName}).</p>
        )}
      </div>
    );
  }

  return (
    <div className="p-3.5 rounded-xl border border-cyan-900/50 bg-[#0b1229]/60 flex items-start gap-3">
      <ShieldCheck className="w-5 h-5 text-cyan-600 shrink-0 mt-0.5" />
      <div>
        <p className="text-xs font-bold text-cyan-400 uppercase tracking-widest">Verifikasi Petugas Pelapor</p>
        <p className="text-[11px] text-cyan-600 mt-0.5">{approvedCount}/{followUps.length} tindak lanjut approved. Verifikasi 1x tersedia setelah semua di-approve PIC Security.</p>
      </div>
    </div>
  );
}

export function FollowUpSectionList({ incident, followUps, verification, closure, unsolve = null, simRole, securityName, reporterName, isClosed, onToast, onPreviewPhoto }) {
  const [activeAction, setActiveAction] = useState(null);
  const [isListExpanded, setIsListExpanded] = useState(false);
  const approvedCount = followUps.filter((followUp) => followUp.status === FOLLOW_UP_STATUS.APPROVED || followUp.status === FOLLOW_UP_STATUS.DONE).length;
  const verificationState = getIncidentVerificationState(followUps, verification, closure, unsolve);
  // Unsolve: opsi PIC Security selama temuan masih berjalan (bukan tindakan wajib → tidak dihitung).
  const canUnsolve = !isClosed && simRole === SECURITY_ASSIGNEE_ID;
  const hasIncidentAction = (verificationState === INCIDENT_VERIFICATION_STATE.READY && simRole === REPORTER_ROLE_ID)
    || (verificationState === INCIDENT_VERIFICATION_STATE.AWAITING_SECURITY && simRole === SECURITY_ASSIGNEE_ID);
  const myActionCount = followUps.filter((followUp) => {
    const { canUpdate, canReview } = getFollowUpActions(followUp, simRole, isClosed);
    return canUpdate || canReview;
  }).length + (hasIncidentAction ? 1 : 0);
  const closeAction = () => setActiveAction(null);

  const handleSeedDemo = () => {
    seedDemoFollowUps(incident, { securityName });
    onToast('Data contoh tindak lanjut dimuat.');
  };

  return (
    <div>
      <div className={`rounded-xl border bg-[#0b1229]/60 shadow-sm ${myActionCount > 0 ? 'border-emerald-500/40' : 'border-cyan-900/50'}`}>
        <button type="button" onClick={() => setIsListExpanded((value) => !value)} className="w-full p-3.5 flex items-center gap-3 text-left" aria-expanded={isListExpanded} aria-label="Daftar tindak lanjut">
          <ClipboardList className="w-4 h-4 text-cyan-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-bold text-cyan-400 uppercase tracking-widest">Tindak Lanjut ({followUps.length})</p>
            <p className="text-[10px] text-cyan-600 mt-0.5">
              {unsolve
                ? <span className="text-orange-300">Unsolve · semua tindak lanjut ditutup</span>
                : followUps.length === 0 ? 'Belum ada tindak lanjut' : `${approvedCount} approved · ${followUps.length - approvedCount} berjalan`}
            </p>
          </div>
          {myActionCount > 0 && <span className="text-[9px] font-bold text-emerald-400 uppercase tracking-wider shrink-0">{myActionCount} perlu tindakan</span>}
          <ChevronDown className={`w-4 h-4 text-cyan-600 shrink-0 transition-transform ${isListExpanded ? 'rotate-180' : ''}`} />
        </button>

        {isListExpanded && (
          <div className="px-3 pb-3 space-y-3 animate-in fade-in">
            {unsolve && <IncidentUnsolveCard unsolve={unsolve} onPreviewPhoto={onPreviewPhoto} />}
            {followUps.length === 0 ? (
              !unsolve && (
                <div className="text-center border border-dashed border-cyan-900/50 p-4 rounded-xl space-y-2">
                  <p className="text-sm text-cyan-700 italic">Belum ada tindak lanjut. PIC Security dapat menugaskan dari tab Info (5W1H) di bawah HOW.</p>
                  <button type="button" onClick={handleSeedDemo} className="text-[10px] font-bold uppercase tracking-widest text-cyan-400 hover:text-cyan-200 underline underline-offset-4">Muat data contoh</button>
                </div>
              )
            ) : (
              <div className="space-y-3">
                <IncidentVerificationCard
                  state={verificationState}
                  followUps={followUps}
                  verification={verification}
                  closure={closure}
                  simRole={simRole}
                  reporterName={reporterName}
                  onAction={(type) => setActiveAction({ type })}
                />
                {followUps.map((followUp, index) => (
                  <FollowUpSection
                    key={followUp.id}
                    incident={incident}
                    followUp={followUp}
                    sequence={index + 1}
                    simRole={simRole}
                    isClosed={isClosed}
                    securityName={securityName}
                    reporterName={reporterName}
                    onPreviewPhoto={onPreviewPhoto}
                    onAction={(type, item, sequence) => setActiveAction({ type, followUp: item, sequence })}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {canUnsolve && (
        <div className="mt-3">
          <UnsolveActionButton onClick={() => setActiveAction({ type: 'unsolve' })} />
          <p className="text-[10px] text-cyan-700 mt-1.5 ml-1">Hanya PIC Security · menutup semua tindak lanjut bila temuan tidak dapat diselesaikan.</p>
        </div>
      )}

      {activeAction?.type === 'update' && (
        <UpdateFollowUpModal
          incident={incident}
          followUp={activeAction.followUp}
          sequence={activeAction.sequence}
          actor={getAssigneeMeta(activeAction.followUp.assigneeId, securityName)}
          onClose={closeAction}
          onSubmitted={() => {
            closeAction();
            onToast('Update terkirim. Status: Need Review — menunggu feedback PIC Security.');
          }}
        />
      )}
      {activeAction?.type === 'review' && (
        <ReviewFollowUpModal
          incident={incident}
          followUp={activeAction.followUp}
          sequence={activeAction.sequence}
          securityName={securityName}
          onClose={closeAction}
          onSubmitted={({ approved, finalApproval }) => {
            closeAction();
            if (!approved) onToast('Feedback terkirim. Status kembali ke Need Action.');
            else if (finalApproval) onToast('Tindak lanjut di-approve. Petugas pelapor memverifikasi 1x setelah semua tindak lanjut Approved.');
            else onToast('Rencana tindakan dikonfirmasi. Status: Need Action — menunggu penyelesaian dari PIC fungsi.');
          }}
        />
      )}
      {activeAction?.type === 'return' && (
        <ReturnFollowUpModal
          incident={incident}
          followUp={activeAction.followUp}
          sequence={activeAction.sequence}
          securityName={securityName}
          onClose={closeAction}
          onSubmitted={(assignee) => {
            closeAction();
            onToast(`Tindak lanjut dikembalikan ke ${assignee.label}. Status: Need Action.`);
          }}
        />
      )}
      {activeAction?.type === 'verify' && (
        <VerifyIncidentModal
          incident={incident}
          followUps={followUps}
          securityName={securityName}
          reporterName={reporterName}
          onClose={closeAction}
          onSubmitted={({ approved, ok, closed }) => {
            closeAction();
            if (!ok) onToast('Verifikasi tidak bisa dikirim: status tindak lanjut berubah. Muat ulang detail temuan.');
            else if (!approved) onToast('Verifikasi: belum sesuai. Temuan dikembalikan ke PIC Security.');
            else if (closed) onToast('Verifikasi terkirim. Semua tindak lanjut Done — temuan ditutup (Closed).');
          }}
        />
      )}
      {activeAction?.type === 'unsolve' && (
        <UnsolveIncidentModal
          incident={incident}
          followUps={followUps}
          securityName={securityName}
          onClose={closeAction}
          onSubmitted={({ ok, referenceUpdated, checkpointName }) => {
            closeAction();
            if (!ok) onToast('Unsolve tidak bisa disimpan: temuan sudah ditutup.');
            else if (referenceUpdated) onToast(`Temuan ditetapkan UNSOLVE. Semua tindak lanjut ditutup.\nFoto kondisi awal titik ${checkpointName} diperbarui — tombol AMAN tersedia lagi.`);
            else onToast('Temuan ditetapkan UNSOLVE. Semua tindak lanjut ditutup.');
          }}
        />
      )}
      {activeAction?.type === 'reverify' && (
        <ReverifyRequestModal
          incident={incident}
          reporterName={reporterName}
          securityName={securityName}
          onClose={closeAction}
          onSubmitted={() => {
            closeAction();
            onToast(`Permintaan verifikasi ulang dikirim ke petugas pelapor (${reporterName}).`);
          }}
        />
      )}
    </div>
  );
}

// Simulasi (dummy) tampilan petugas saat tap NFC di titik asal temuan: memperlihatkan efek status
// temuan pada titik — AMAN tersembunyi selama tindak lanjut berjalan, foto acuan & AMAN setelah Unsolve.
export function CheckpointPatrolSimulation({ incident, definition, onToast, onPreviewPhoto }) {
  const [isOpen, setIsOpen] = useState(false);
  const temuanState = useCheckpointTemuanState(createCheckpointTemuanKey(incident?.shipId || incident?.shipName, incident?.location));
  if (!incident?.isPatrol || !incident.location) return null;

  const statusText = temuanState.override
    ? 'Foto acuan diperbarui (Unsolve) · tombol AMAN tersedia'
    : temuanState.hasOpenTemuan
      ? 'Temuan berjalan · tombol AMAN disembunyikan'
      : 'Tombol AMAN & TEMUAN tersedia';

  return (
    <div className="rounded-xl border border-fuchsia-900/50 bg-[#0b1229]/60 p-3.5 flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <p className="text-xs font-bold text-fuchsia-300 uppercase tracking-widest">Titik {incident.location}</p>
        <p className="text-[10px] text-cyan-600 mt-0.5">{statusText}</p>
      </div>
      <button type="button" onClick={() => setIsOpen(true)} className="shrink-0 px-3 py-2 rounded-xl border border-fuchsia-500/40 text-fuchsia-200 hover:bg-fuchsia-500/10 transition-all">
        <span className="text-[10px] font-black uppercase tracking-widest">Simulasi Tap</span>
      </button>
      {isOpen && (
        <PatrolNfcChoiceSheet
          selection={{ item: { id: `sim-${incident.id}`, name: incident.location }, definition, verified: Boolean(definition?.nfcTagId) }}
          temuanState={temuanState}
          zIndexClass="z-[115]"
          simulationLabel="Simulasi tampilan petugas patroli"
          onChoose={(type) => {
            setIsOpen(false);
            onToast(`Simulasi: petugas memilih ${type === 'aman' ? 'AMAN' : 'TEMUAN'} di titik ${incident.location}. (Tidak membuat laporan)`);
          }}
          onClose={() => setIsOpen(false)}
          onPreviewPhoto={(url) => onPreviewPhoto({ url, author: `Foto acuan · ${incident.location}` })}
        />
      )}
    </div>
  );
}
