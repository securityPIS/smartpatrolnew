/*
Tujuan: Tampilan alur tindak lanjut temuan (versi dummy): assign oleh PIC Security, update PIC fungsi,
        feedback PIC Security, verifikasi petugas pelapor, beserta switcher simulasi role.
Caller: IncidentDetailView (tab Info di bawah HOW, dan tab Update di atas Riwayat Update).
Dependensi: followUpStore (state dummy), followUpPdf (dokumen otomatis), AsyncImage, ikon lucide-react.
Main Functions: FollowUpRoleSwitcher, FollowUpAssignCard, FollowUpSectionList, FollowUpToast.
Side Effects: Mengubah store dummy di memori dan membuka PDF; tidak menyentuh database.
*/

import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Camera, CheckCircle2, ChevronDown, ClipboardList, Eye, FileText, Send, ShieldCheck, UserCheck, X, XCircle } from 'lucide-react';
import AsyncImage from '../AsyncImage';
import {
  FOLLOW_UP_STATUS,
  FOLLOW_UP_STATUS_META,
  PIC_FUNCTION_OPTIONS,
  REPORTER_ROLE_ID,
  SECURITY_ASSIGNEE_ID,
  assignFollowUp,
  closeIncidentWithVerification,
  formatFollowUpTimestamp,
  getAssigneeMeta,
  seedDemoFollowUps,
  submitFollowUpUpdate,
  submitReporterVerification,
  submitSecurityReview,
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
function FollowUpModal({ title, subtitle, onClose, onSubmit, submitLabel, canSubmit, actions, children }) {
  const footerActions = actions || [{ key: 'submit', label: submitLabel, onClick: onSubmit, disabled: !canSubmit, colorClass: PRIMARY_ACTION_CLASS }];
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
  const options = getSimulationRoleOptions();
  return (
    <div className="px-4 py-2.5 bg-[#070b19] border-b border-cyan-900/50 shrink-0">
      <p className="text-[9px] font-bold uppercase tracking-widest text-cyan-600 mb-1.5 flex items-center gap-1.5"><UserCheck className="w-3 h-3" /> Simulasi tindak lanjut sebagai (data dummy)</p>
      <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
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

  const handleSubmit = (requestVerification) => {
    if (!canSubmit) return;
    submitSecurityReview(incident.id, followUp.id, { approved, requestVerification, comment: comment.trim(), actorName: securityName });
    onSubmitted({ approved, requestVerification });
  };

  const actions = [
    { key: 'submit', label: 'Submit', onClick: () => handleSubmit(false), disabled: !canSubmit, colorClass: PRIMARY_ACTION_CLASS },
    ...(approved ? [{ key: 'verify', label: 'Need Verification', onClick: () => handleSubmit(true), disabled: !canSubmit, colorClass: 'bg-fuchsia-600 hover:bg-fuchsia-500 shadow-fuchsia-500/20 border-fuchsia-400/20' }] : []),
  ];

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
          <textarea value={comment} onChange={(event) => setComment(event.target.value)} rows={3} placeholder={approved ? 'Contoh: pekerjaan sudah sesuai instruksi.' : 'Jelaskan apa yang belum sesuai...'} className={TEXTAREA_CLASS} />
          {approved && (
            <div className="text-[10px] mt-2 ml-1 space-y-1">
              <p className="text-emerald-300"><span className="font-bold">Submit</span>: tindak lanjut langsung selesai (Done) tanpa verifikasi.</p>
              <p className="text-fuchsia-300"><span className="font-bold">Need Verification</span>: permintaan verifikasi dikirim ke petugas pelapor ({incident.reportedBy || '-'}).</p>
            </div>
          )}
          {!approved && <p className="text-[10px] text-amber-300 mt-2 ml-1">Status kembali menjadi Need Action untuk ditindaklanjuti ulang.</p>}
        </div>
      )}
    </FollowUpModal>
  );
}

function VerifyFollowUpModal({ incident, followUp, sequence, reporterName, onClose, onSubmitted }) {
  const [approved, setApproved] = useState(null);
  const [comment, setComment] = useState('');
  const [photoUrl, setPhotoUrl] = useState(null);
  const canSubmit = approved !== null && Boolean(comment.trim()) && Boolean(photoUrl);

  const handleSubmit = () => {
    if (!canSubmit) return;
    submitReporterVerification(incident.id, followUp.id, { approved, comment: comment.trim(), photoUrl, actorName: reporterName });
    onSubmitted(approved);
  };

  return (
    <FollowUpModal title="Verifikasi Petugas Pelapor" subtitle={`Tindak lanjut #${sequence} · ${reporterName}`} onClose={onClose} onSubmit={handleSubmit} submitLabel="Kirim Verifikasi" canSubmit={canSubmit}>
      <div className="p-3 rounded-xl border border-cyan-900/50 bg-[#070b19]/40">
        <p className="text-[9px] font-bold uppercase tracking-widest text-cyan-600 mb-1">Instruksi</p>
        <p className="text-xs text-cyan-100 whitespace-pre-wrap">{followUp.instruction}</p>
      </div>
      <div>
        <label className={LABEL_CLASS}>Hasil verifikasi lapangan <span className="text-rose-400">*</span></label>
        <VerdictToggle value={approved} onChange={setApproved} approveLabel="Terverifikasi" rejectLabel="Belum Sesuai" />
      </div>
      <div>
        <label className={LABEL_CLASS}>Catatan Verifikasi <span className="text-rose-400">*</span></label>
        <textarea value={comment} onChange={(event) => setComment(event.target.value)} rows={3} placeholder="Jelaskan kondisi di lapangan saat verifikasi..." className={TEXTAREA_CLASS} />
      </div>
      <PhotoField label="Evidence" value={photoUrl} onChange={setPhotoUrl} required />
    </FollowUpModal>
  );
}

export function FollowUpAssignCard({ incident, followUps, simRole, securityName, isClosed, onToast, onOpenUpdateTab }) {
  const [showAssignForm, setShowAssignForm] = useState(false);
  const canAssign = !isClosed && simRole === SECURITY_ASSIGNEE_ID;
  const doneCount = followUps.filter((item) => item.status === FOLLOW_UP_STATUS.DONE).length;

  return (
    <div className="p-4 rounded-xl border bg-cyan-950/20 border-cyan-800/40">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <p className="text-[10px] font-bold flex items-center gap-1.5 uppercase tracking-widest text-cyan-400"><ClipboardList className="w-3 h-3" /> Penugasan Tindak Lanjut</p>
          <p className="text-[11px] text-cyan-600 mt-1">
            {followUps.length === 0 ? 'Belum ada tindak lanjut yang ditugaskan.' : `${followUps.length} tindak lanjut · ${doneCount} selesai`}
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
        <p className="text-[11px] text-amber-300/80">{isClosed ? 'Temuan sudah ditutup.' : 'Hanya PIC Security yang dapat menugaskan tindak lanjut.'}</p>
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
  if (isClosed && followUp.status !== FOLLOW_UP_STATUS.DONE) return 'Temuan sudah ditutup.';
  if (followUp.status === FOLLOW_UP_STATUS.NEED_ACTION) return `Menunggu update dari ${assignee.label}.`;
  if (followUp.status === FOLLOW_UP_STATUS.NEED_REVIEW) return 'Menunggu feedback PIC Security.';
  if (followUp.status === FOLLOW_UP_STATUS.NEED_VERIFICATION) return `Menunggu verifikasi petugas pelapor (${reporterName}).`;
  return 'Tindak lanjut selesai dan sudah terverifikasi.';
}

const ENTRY_TITLES = {
  assign: 'Instruksi',
  update: 'Update PIC',
  review: 'Feedback PIC Security',
  verify: 'Verifikasi Pelapor',
};

function getFollowUpActions(followUp, simRole, isClosed) {
  return {
    canUpdate: !isClosed && followUp.status === FOLLOW_UP_STATUS.NEED_ACTION && simRole === followUp.assigneeId,
    canReview: !isClosed && followUp.status === FOLLOW_UP_STATUS.NEED_REVIEW && simRole === SECURITY_ASSIGNEE_ID,
    canVerify: !isClosed && followUp.status === FOLLOW_UP_STATUS.NEED_VERIFICATION && simRole === REPORTER_ROLE_ID,
  };
}

function FollowUpSection({ incident, followUp, sequence, simRole, securityName, reporterName, isClosed, onPreviewPhoto, onAction }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const assignee = getAssigneeMeta(followUp.assigneeId, securityName);
  const createdStamp = formatFollowUpTimestamp(followUp.createdAt);
  const { canUpdate, canReview, canVerify } = getFollowUpActions(followUp, simRole, isClosed);
  const hasAction = canUpdate || canReview || canVerify;
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
                  const verdictClass = entry.verdict === 'approved' ? 'text-emerald-400' : entry.verdict === 'rejected' ? 'text-rose-400' : 'text-cyan-400';
                  return (
                    <div key={entry.id}>
                      <p className="text-[10px] font-mono text-cyan-600">{stamp.date} {stamp.time} · <span className="text-cyan-300 font-bold">{entry.actorName}</span></p>
                      <p className={`text-[10px] font-bold uppercase tracking-wider ${verdictClass}`}>
                        {ENTRY_TITLES[entry.kind]}{entry.verdict === 'approved' ? ' · Sesuai' : entry.verdict === 'rejected' ? ' · Belum sesuai' : ''}{entry.skipVerification ? ' · Selesai tanpa verifikasi' : ''}
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
          {canVerify && (
            <button type="button" onClick={() => onAction('verify', followUp, sequence)} className="w-full py-3 bg-fuchsia-600 text-white rounded-xl text-xs font-black uppercase tracking-widest flex items-center justify-center gap-2 hover:bg-fuchsia-500 transition-all active:scale-[0.98]">
              <CheckCircle2 className="w-4 h-4" /> Verifikasi
            </button>
          )}
          {!hasAction && <p className="text-[11px] text-cyan-600 italic">{getWaitingHint(followUp, assignee, reporterName, isClosed)}</p>}
        </div>
      )}
    </div>
  );
}

export function FollowUpSectionList({ incident, followUps, simRole, securityName, reporterName, isClosed, onToast, onPreviewPhoto }) {
  const [activeAction, setActiveAction] = useState(null);
  const [isListExpanded, setIsListExpanded] = useState(false);
  const doneCount = followUps.filter((followUp) => followUp.status === FOLLOW_UP_STATUS.DONE).length;
  const myActionCount = followUps.filter((followUp) => Object.values(getFollowUpActions(followUp, simRole, isClosed)).some(Boolean)).length;
  const closeAction = () => setActiveAction(null);

  const handleSeedDemo = () => {
    seedDemoFollowUps(incident, { securityName, reporterName });
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
              {followUps.length === 0 ? 'Belum ada tindak lanjut' : `${doneCount} selesai · ${followUps.length - doneCount} berjalan`}
            </p>
          </div>
          {myActionCount > 0 && <span className="text-[9px] font-bold text-emerald-400 uppercase tracking-wider shrink-0">{myActionCount} perlu tindakan</span>}
          <ChevronDown className={`w-4 h-4 text-cyan-600 shrink-0 transition-transform ${isListExpanded ? 'rotate-180' : ''}`} />
        </button>

        {isListExpanded && (
          <div className="px-3 pb-3 animate-in fade-in">
            {followUps.length === 0 ? (
              <div className="text-center border border-dashed border-cyan-900/50 p-4 rounded-xl space-y-2">
                <p className="text-sm text-cyan-700 italic">Belum ada tindak lanjut. PIC Security dapat menugaskan dari tab Info (5W1H) di bawah HOW.</p>
                <button type="button" onClick={handleSeedDemo} className="text-[10px] font-bold uppercase tracking-widest text-cyan-400 hover:text-cyan-200 underline underline-offset-4">Muat data contoh</button>
              </div>
            ) : (
              <div className="space-y-3">
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
          onSubmitted={({ approved, requestVerification }) => {
            closeAction();
            if (!approved) onToast('Feedback terkirim. Status kembali ke Need Action.');
            else if (requestVerification) onToast(`Permintaan verifikasi dikirim ke petugas pelapor (${reporterName}). Status: Need Verification.`);
            else onToast('Tindak lanjut dikonfirmasi sesuai. Status: Done (tanpa verifikasi).');
          }}
        />
      )}
      {activeAction?.type === 'verify' && (
        <VerifyFollowUpModal
          incident={incident}
          followUp={activeAction.followUp}
          sequence={activeAction.sequence}
          reporterName={reporterName}
          onClose={closeAction}
          onSubmitted={(approved) => {
            closeAction();
            onToast(approved
              ? 'Verifikasi terkirim. Tindak lanjut selesai (Done).'
              : 'Verifikasi ditolak. Status kembali ke Need Action.');
          }}
        />
      )}
    </div>
  );
}

export function CloseIncidentModal({ incident, followUps, securityName, reporterName, onClose, onClosed }) {
  const [comment, setComment] = useState('');
  const [photoUrl, setPhotoUrl] = useState(null);
  const canSubmit = Boolean(comment.trim()) && Boolean(photoUrl);
  const pendingVerification = followUps
    .map((followUp, index) => ({ followUp, sequence: index + 1 }))
    .filter(({ followUp }) => followUp.status === FOLLOW_UP_STATUS.NEED_VERIFICATION);
  const stillOpenCount = followUps.filter((followUp) => (
    followUp.status === FOLLOW_UP_STATUS.NEED_ACTION || followUp.status === FOLLOW_UP_STATUS.NEED_REVIEW
  )).length;

  const handleSubmit = () => {
    if (!canSubmit) return;
    closeIncidentWithVerification(incident.id, { comment: comment.trim(), photoUrl, actorName: reporterName });
    onClosed();
  };

  return (
    <FollowUpModal title="Tutup Temuan" subtitle={`${incident.location || 'Temuan'} · ${reporterName}`} onClose={onClose} onSubmit={handleSubmit} submitLabel="Verifikasi & Tutup" canSubmit={canSubmit}>
      <div className="p-3 rounded-xl border border-fuchsia-900/50 bg-fuchsia-950/20 space-y-2">
        <p className="text-[9px] font-bold uppercase tracking-widest text-fuchsia-400">Tindak lanjut yang diverifikasi</p>
        {pendingVerification.map(({ followUp, sequence }) => (
          <div key={followUp.id}>
            <p className="text-xs font-bold text-cyan-50">#{sequence} · {getAssigneeMeta(followUp.assigneeId, securityName).label}</p>
            <p className="text-[11px] text-cyan-300 whitespace-pre-wrap">{followUp.instruction}</p>
          </div>
        ))}
      </div>
      {stillOpenCount > 0 && (
        <p className="text-[11px] text-amber-300 flex items-start gap-1.5"><AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> Masih ada {stillOpenCount} tindak lanjut lain yang belum selesai. Temuan tetap akan ditutup.</p>
      )}
      <div>
        <label className={LABEL_CLASS}>Catatan Verifikasi <span className="text-rose-400">*</span></label>
        <textarea value={comment} onChange={(event) => setComment(event.target.value)} rows={3} placeholder="Jelaskan kondisi di lapangan saat verifikasi..." className={TEXTAREA_CLASS} />
      </div>
      <PhotoField label="Evidence" value={photoUrl} onChange={setPhotoUrl} required />
    </FollowUpModal>
  );
}
