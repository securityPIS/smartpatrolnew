/*
Tujuan: Tab TITIK di detail armada — pengaturan main checkpoint & sub checkpoint. Setiap titik
        wajib punya tag NFC dan foto kondisi awal (acuan foto patroli).
Caller: ShipsPage (shipDetailTab === 'checkpoints').
Dependensi: useShips/useReports (AppContextRuntime), utils/shipCheckpoints, services/native/nfc.
*/

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, Camera, CheckCircle2, CornerDownRight, ImageIcon, Loader2, Lock, Nfc,
  Pencil, PlusCircle, Save, ScanLine, ShieldAlert, Trash2, X,
} from 'lucide-react';
import { useReports, useShips } from '../../context/AppContextRuntime';
import AsyncImage from '../AsyncImage';
import {
  CHECKPOINT_TYPE_MAIN, CHECKPOINT_TYPE_SUB, getCheckpointCompleteness, groupCheckpointHierarchy, sanitizeNfcTagId,
} from '../../utils/shipCheckpoints';
import { isNfcScanSupported, startNfcTagScan } from '../../services/native/nfc';

const inputClass = 'w-full bg-[#070b19] border border-cyan-800/50 rounded-lg p-2.5 text-sm focus:border-cyan-400 outline-none text-white placeholder:text-cyan-800';

function RequirementChip({ ok, icon: Icon, okLabel, missingLabel }) {
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-bold tracking-wide max-w-full ${ok ? 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10' : 'text-rose-300 border-rose-500/40 bg-rose-500/10'}`}>
      <Icon className="w-3 h-3 shrink-0" />
      <span className="truncate font-mono">{ok ? okLabel : missingLabel}</span>
    </span>
  );
}

function CheckpointRow({ checkpoint, code, isSub, subCount, onEdit, onAddSub, onDelete, onPreview }) {
  const { hasNfc, hasPhoto, complete } = getCheckpointCompleteness(checkpoint);
  return (
    <div className={`p-3 rounded-xl border flex gap-3 items-start ${complete ? 'bg-[#070b19] border-cyan-800/50' : 'bg-rose-950/10 border-rose-500/30'}`}>
      <button
        type="button"
        onClick={() => (hasPhoto ? onPreview(checkpoint) : onEdit(checkpoint))}
        className={`shrink-0 rounded-lg overflow-hidden border ${isSub ? 'w-12 h-12' : 'w-16 h-16'} ${hasPhoto ? 'border-cyan-700' : 'border-dashed border-rose-500/50 bg-rose-500/5 flex items-center justify-center'}`}
        aria-label={hasPhoto ? `Lihat foto kondisi awal ${checkpoint.name}` : `Tambahkan foto kondisi awal ${checkpoint.name}`}
      >
        {hasPhoto
          ? <AsyncImage src={checkpoint.referencePhotoUrl} alt={`Kondisi awal ${checkpoint.name}`} className="w-full h-full object-cover" />
          : <Camera className="w-5 h-5 text-rose-400/80" />}
      </button>
      <div className="flex-1 min-w-0 text-left">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className={`text-[9px] font-mono px-1 rounded border shrink-0 ${isSub ? 'text-sky-300 border-sky-700' : 'text-cyan-300 border-cyan-600'}`}>{code}</span>
          <p className="font-bold text-cyan-100 text-sm break-words">{checkpoint.name}</p>
          {checkpoint.isDefault && <span className="text-[9px] uppercase tracking-widest text-emerald-300 border border-emerald-500/40 px-1 rounded shrink-0">Default</span>}
        </div>
        {checkpoint.desc && <p className="text-xs text-cyan-500 mt-0.5 break-words">{checkpoint.desc}</p>}
        <div className="flex flex-wrap gap-1 mt-1.5">
          <RequirementChip ok={hasNfc} icon={Nfc} okLabel={checkpoint.nfcTagId} missingLabel="NFC belum ada" />
          <RequirementChip ok={hasPhoto} icon={ImageIcon} okLabel="Foto acuan" missingLabel="Foto belum ada" />
          {!isSub && subCount > 0 && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-bold text-sky-300 border-sky-700/60">{subCount} sub</span>
          )}
        </div>
      </div>
      <div className="flex flex-col gap-1 shrink-0">
        <button type="button" onClick={() => onEdit(checkpoint)} className={`p-1.5 rounded-lg ${complete ? 'text-cyan-400 hover:bg-cyan-500/20' : 'text-amber-300 bg-amber-500/10 hover:bg-amber-500/20'}`} aria-label={`${complete ? 'Ubah' : 'Lengkapi'} titik ${checkpoint.name}`} title={complete ? 'Ubah' : 'Lengkapi NFC & foto'}>
          <Pencil className="w-4 h-4" />
        </button>
        {!isSub && (
          <button type="button" onClick={() => onAddSub(checkpoint)} className="p-1.5 rounded-lg text-sky-400 hover:bg-sky-500/20" aria-label={`Tambah sub checkpoint di ${checkpoint.name}`} title="Tambah sub checkpoint">
            <PlusCircle className="w-4 h-4" />
          </button>
        )}
        {checkpoint.isDefault ? (
          <span className="p-1.5 text-cyan-800" title="Titik default tidak bisa dihapus"><Lock className="w-4 h-4" /></span>
        ) : (
          <button type="button" onClick={() => onDelete(checkpoint)} className="p-1.5 rounded-lg text-rose-500 hover:bg-rose-500/20" aria-label={`Hapus titik ${checkpoint.name}`} title="Hapus">
            <Trash2 className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
}

function CheckpointEditor({ editor, parentName, onCancel, onSaved }) {
  const { saveShipCheckpointDefinition, pickShipCheckpointReferencePhoto } = useShips();
  const isEdit = Boolean(editor.checkpoint);
  const [draft, setDraft] = useState(() => ({
    name: editor.checkpoint?.name || '',
    desc: editor.checkpoint?.desc || '',
    nfcTagId: editor.checkpoint?.nfcTagId || '',
    referencePhotoUrl: editor.checkpoint?.referencePhotoUrl || null,
  }));
  const [error, setError] = useState('');
  const [nfcState, setNfcState] = useState({ scanning: false, message: '' });
  const [isPickingPhoto, setIsPickingPhoto] = useState(false);
  const stopScanRef = useRef(null);
  const nfcSupported = useMemo(() => isNfcScanSupported(), []);

  useEffect(() => () => stopScanRef.current?.(), []);

  const update = (patch) => {
    setDraft(previous => ({ ...previous, ...patch }));
    setError('');
  };

  const handleScan = () => {
    if (nfcState.scanning) {
      stopScanRef.current?.();
      setNfcState({ scanning: false, message: '' });
      return;
    }
    setNfcState({ scanning: true, message: 'Tempelkan tag NFC ke bagian belakang HP…' });
    stopScanRef.current = startNfcTagScan({
      onTag: (serialNumber) => {
        update({ nfcTagId: sanitizeNfcTagId(serialNumber) });
        setNfcState({ scanning: false, message: 'Tag terbaca.' });
      },
      onError: (scanError) => setNfcState({ scanning: false, message: scanError.message }),
    });
  };

  const handlePickPhoto = async () => {
    setIsPickingPhoto(true);
    try {
      const url = await pickShipCheckpointReferencePhoto();
      if (url) update({ referencePhotoUrl: url });
    } finally {
      setIsPickingPhoto(false);
    }
  };

  const hasName = Boolean(draft.name.trim());
  const hasNfc = Boolean(sanitizeNfcTagId(draft.nfcTagId));
  const hasPhoto = Boolean(draft.referencePhotoUrl);
  const canSave = hasName && hasNfc && hasPhoto;

  const handleSave = () => {
    const result = saveShipCheckpointDefinition({
      id: editor.checkpoint?.id,
      type: editor.type,
      parentId: editor.parentId,
      ...draft,
    });
    if (!result?.ok) {
      setError(result?.error || 'Gagal menyimpan titik.');
      return;
    }
    stopScanRef.current?.();
    onSaved(result.checkpoint);
  };

  const isSub = editor.type === CHECKPOINT_TYPE_SUB;
  const title = `${isEdit ? (getCheckpointCompleteness(editor.checkpoint).complete ? 'Ubah' : 'Lengkapi') : 'Tambah'} ${isSub ? 'Sub' : 'Main'} Checkpoint`;

  return (
    <div className="bg-[#0b1229] p-4 rounded-xl border border-cyan-500/50 shadow-[0_0_20px_rgba(6,182,212,0.15)] space-y-4 text-left animate-in fade-in">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-black text-cyan-100 uppercase tracking-widest">{title}</h4>
          {isSub && parentName && (
            <p className="text-[11px] text-sky-300 mt-1 flex items-center gap-1"><CornerDownRight className="w-3 h-3" /> Bagian dari <span className="font-bold">{parentName}</span></p>
          )}
        </div>
        <button type="button" onClick={onCancel} className="p-1.5 rounded-lg text-cyan-500 hover:bg-cyan-900/40" aria-label="Tutup form titik"><X className="w-4 h-4" /></button>
      </div>

      <div className="space-y-2">
        <label className="block text-[10px] font-bold text-cyan-500 uppercase tracking-widest" htmlFor="cp-name">Nama titik</label>
        <input id="cp-name" type="text" value={draft.name} disabled={isEdit} onChange={e => update({ name: e.target.value })} placeholder={isSub ? 'mis. Panel Kontrol Pompa 1' : 'mis. Ruang Pompa'} maxLength={80} className={`${inputClass} disabled:opacity-60`} />
        {isEdit && <p className="text-[10px] text-cyan-700">Nama tidak bisa diubah agar riwayat patroli titik ini tetap tersambung.</p>}
        <label className="block text-[10px] font-bold text-cyan-500 uppercase tracking-widest pt-1" htmlFor="cp-desc">Instruksi pemeriksaan</label>
        <textarea id="cp-desc" rows={2} value={draft.desc} onChange={e => update({ desc: e.target.value })} placeholder="Apa yang harus dicek petugas di titik ini…" maxLength={140} className={`${inputClass} resize-none`} />
      </div>

      <div className="space-y-2">
        <p className="text-[10px] font-bold text-cyan-500 uppercase tracking-widest flex items-center gap-1"><Nfc className="w-3.5 h-3.5" /> Tag NFC <span className="text-rose-400">*</span></p>
        <div className="flex gap-2">
          <input type="text" value={draft.nfcTagId} onChange={e => update({ nfcTagId: e.target.value })} onBlur={() => update({ nfcTagId: sanitizeNfcTagId(draft.nfcTagId) })} placeholder="UID tag, mis. 04:A2:3B:1C:5D:80" className={`${inputClass} font-mono flex-1 min-w-0`} />
          {nfcSupported && (
            <button type="button" onClick={handleScan} className={`shrink-0 px-3 rounded-lg text-xs font-bold uppercase tracking-wider flex items-center gap-1.5 border transition-colors ${nfcState.scanning ? 'bg-amber-500/20 text-amber-200 border-amber-500/50' : 'bg-cyan-600/20 text-cyan-200 border-cyan-500/50 hover:bg-cyan-600/40'}`}>
              {nfcState.scanning ? <><Loader2 className="w-4 h-4 animate-spin" /> Batal</> : <><ScanLine className="w-4 h-4" /> Scan</>}
            </button>
          )}
        </div>
        {nfcState.message && <p className={`text-[11px] ${nfcState.scanning ? 'text-amber-300' : 'text-cyan-400'}`}>{nfcState.message}</p>}
        {!nfcSupported && (
          <p className="text-[11px] text-cyan-600">Scan NFC langsung belum didukung di perangkat/browser ini. Ketik UID tag (bisa dibaca dengan aplikasi NFC reader).</p>
        )}
      </div>

      <div className="space-y-2">
        <p className="text-[10px] font-bold text-cyan-500 uppercase tracking-widest flex items-center gap-1"><Camera className="w-3.5 h-3.5" /> Foto kondisi awal <span className="text-rose-400">*</span></p>
        <button type="button" onClick={handlePickPhoto} disabled={isPickingPhoto} className={`relative w-full aspect-video rounded-xl overflow-hidden border flex items-center justify-center ${hasPhoto ? 'border-cyan-700' : 'border-dashed border-cyan-700/70 bg-[#070b19] hover:border-cyan-400'}`}>
          {hasPhoto ? (
            <>
              <AsyncImage src={draft.referencePhotoUrl} alt="Foto kondisi awal" className="w-full h-full object-cover" />
              <span className="absolute bottom-2 right-2 px-2 py-1 rounded-lg bg-[#070b19]/80 border border-cyan-500/50 text-[10px] font-bold text-cyan-200 uppercase tracking-wider flex items-center gap-1 backdrop-blur-sm"><Camera className="w-3 h-3" /> Ganti foto</span>
            </>
          ) : (
            <span className="flex flex-col items-center gap-2 text-cyan-500">
              {isPickingPhoto ? <Loader2 className="w-6 h-6 animate-spin" /> : <Camera className="w-6 h-6" />}
              <span className="text-xs font-bold uppercase tracking-wider">Ambil foto kondisi awal</span>
            </span>
          )}
        </button>
        <p className="text-[11px] text-cyan-600">Foto ini jadi acuan: petugas memotret dari sudut yang sama saat patroli untuk dibandingkan.</p>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {[['Nama', hasName], ['NFC', hasNfc], ['Foto acuan', hasPhoto]].map(([label, ok]) => (
          <span key={label} className={`inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded border ${ok ? 'text-emerald-300 border-emerald-500/40' : 'text-cyan-700 border-cyan-900'}`}>
            <CheckCircle2 className="w-3 h-3" /> {label}
          </span>
        ))}
      </div>

      {error && <p className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-lg p-2" role="alert">{error}</p>}

      <div className="flex gap-2">
        <button type="button" onClick={onCancel} className="flex-1 py-2.5 rounded-lg text-xs font-bold uppercase tracking-widest border border-cyan-800 text-cyan-400 hover:bg-cyan-900/30">Batal</button>
        <button type="button" onClick={handleSave} disabled={!canSave} className="flex-1 py-2.5 rounded-lg text-xs font-bold uppercase tracking-widest bg-cyan-600 hover:bg-cyan-500 text-white disabled:opacity-40 disabled:hover:bg-cyan-600 flex items-center justify-center gap-1.5"><Save className="w-4 h-4" /> Simpan</button>
      </div>
    </div>
  );
}

export default function ShipCheckpointsTab({ ship }) {
  const { deleteShipCheckpointDefinition } = useShips();
  const { setPreviewPhoto } = useReports();
  const [editor, setEditor] = useState(null);
  const editorRef = useRef(null);

  const groups = useMemo(() => groupCheckpointHierarchy(ship?.customCheckpoints), [ship?.customCheckpoints]);
  const stats = useMemo(() => {
    const all = groups.flatMap(group => [group.main, ...group.subs]);
    return {
      mainCount: groups.length,
      subCount: all.length - groups.length,
      incompleteCount: all.filter(checkpoint => !getCheckpointCompleteness(checkpoint).complete).length,
    };
  }, [groups]);

  // Tutup editor bila pindah kapal.
  useEffect(() => { setEditor(null); }, [ship?.id]);
  useEffect(() => {
    if (editor) editorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [editor]);

  const openEditor = (nextEditor) => setEditor({ ...nextEditor, key: Date.now() });
  const parentName = editor?.parentId ? groups.find(group => group.main.id === editor.parentId)?.main.name : '';

  const rowHandlers = {
    onEdit: (checkpoint) => openEditor({ checkpoint, type: checkpoint.type, parentId: checkpoint.parentId }),
    onAddSub: (main) => openEditor({ checkpoint: null, type: CHECKPOINT_TYPE_SUB, parentId: main.id }),
    onDelete: (checkpoint) => deleteShipCheckpointDefinition(checkpoint.id),
    onPreview: (checkpoint) => setPreviewPhoto({
      url: checkpoint.referencePhotoUrl,
      author: `Kondisi awal · ${checkpoint.name}`,
      time: checkpoint.referencePhotoUpdatedAt
        ? new Date(checkpoint.referencePhotoUpdatedAt).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Jakarta' })
        : '',
    }),
  };

  return (
    <div className="space-y-4 animate-in fade-in">
      <div className="bg-[#0b1229] p-4 rounded-xl border border-cyan-800/50 space-y-3 text-left">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-black text-cyan-100 uppercase tracking-widest flex items-center gap-2"><ShieldAlert className="w-4 h-4 text-cyan-400" /> Titik Checkpoint</h3>
            <p className="text-[11px] text-cyan-500 mt-1 font-mono">{stats.mainCount} main · {stats.subCount} sub</p>
          </div>
          <button type="button" onClick={() => openEditor({ checkpoint: null, type: CHECKPOINT_TYPE_MAIN, parentId: '' })} className="shrink-0 px-3 py-1.5 bg-cyan-600/20 text-cyan-300 border border-cyan-500/50 text-xs font-bold rounded-lg flex items-center gap-1 hover:bg-cyan-600/40 transition-colors">
            <PlusCircle className="w-3.5 h-3.5" /> Main Checkpoint
          </button>
        </div>
        {stats.incompleteCount > 0 ? (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5 text-[11px] text-amber-200">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <p><span className="font-bold">{stats.incompleteCount} titik belum lengkap.</span> Setiap main & sub checkpoint wajib punya tag NFC dan foto kondisi awal sebagai acuan foto patroli.</p>
          </div>
        ) : groups.length > 0 && (
          <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-2.5 text-[11px] text-emerald-200">
            <CheckCircle2 className="w-4 h-4 shrink-0" /> Semua titik sudah punya NFC & foto acuan.
          </div>
        )}
      </div>

      {editor && (
        <div ref={editorRef}>
          <CheckpointEditor
            key={editor.key}
            editor={editor}
            parentName={parentName}
            onCancel={() => setEditor(null)}
            onSaved={() => setEditor(null)}
          />
        </div>
      )}

      {groups.length === 0 ? (
        <p className="text-xs text-slate-500 text-center italic py-6">Belum ada titik checkpoint.</p>
      ) : (
        <div className="space-y-3">
          {groups.map((group, groupIndex) => {
            const mainCode = `MAIN-${String(groupIndex + 1).padStart(2, '0')}`;
            return (
              <div key={group.main.id} className="bg-[#0b1229] p-2 rounded-2xl border border-cyan-800/50 space-y-2">
                <CheckpointRow checkpoint={group.main} code={mainCode} subCount={group.subs.length} {...rowHandlers} />
                {group.subs.length > 0 && (
                  <div className="ml-4 pl-3 border-l-2 border-sky-800/60 space-y-2">
                    {group.subs.map((sub, subIndex) => (
                      <CheckpointRow key={sub.id} checkpoint={sub} code={`SUB-${groupIndex + 1}.${subIndex + 1}`} isSub {...rowHandlers} />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
