/*
Tujuan: Menampilkan halaman patroli live beserta gate status petugas shift sebelum checklist dibuka.
Caller: App shell saat user membuka halaman utama patroli.
Dependensi: Patrol context, trusted time, detail riwayat, dan modal status petugas shift.
Main Functions: Menyajikan info shift, daftar checkpoint, progress patroli, dan status petugas per shift.
Side Effects: Membuka modal status shift hanya dari aksi user/guard, memicu form patroli, dan menahan aksi checkpoint sampai status shift lengkap.
*/

import React from 'react';
import { ACCESS_ROLES, useHistory, useIncidents, usePatrol, useReports, useShips, useWeather } from '../context/AppContextRuntime';
import { getTrustedTimeSnapshot, subscribeTrustedTime } from '../services/time/trustedTime';
import { summarizeTimeAudit } from '../services/time/timeAudit';
import {
  CheckCircle2, AlertTriangle, Search, Ship, MapPin, ExternalLink, ArrowLeft, Plus,
  CalendarDays, Thermometer, Wind, FileText, CircleOff, TimerReset, Clock, Nfc, CornerDownRight, Settings,
  ImageIcon, ChevronDown,
} from 'lucide-react';
import { useCollapsedGroups } from '../components/CheckpointGroupToggle';
import { isDemoMode } from '../services/demoMode';
import PatrolNfcChoiceSheet from '../components/modals/PatrolNfcChoiceSheet';
import PatrolTemuanUpdateModal from '../components/modals/PatrolTemuanUpdateModal';
import { FollowUpToast } from '../components/incidentFollowUp/FollowUpPanels';
import { DEMO_UNSOLVE_CHECKPOINT } from '../components/incidentFollowUp/demoUnsolveCheckpoint';
import { usePatrolNfcScan } from '../hooks/usePatrolNfcScan';
import { openNfcSettings } from '../services/native/nfc';
import { createCheckpointNameKey, normalizeShipCheckpointDefinitions } from '../utils/shipCheckpoints';
import {
  createCheckpointTemuanKey, getCheckpointReferenceOverride, getIncidentCheckpointKey, isPatrolTemuanOpen, useFollowUpStoreVersion,
} from '../components/incidentFollowUp/followUpStore';
import AsyncImage from '../components/AsyncImage';
import HistoryDetailView from '../components/views/HistoryDetailView';
import ShiftStatusModal from '../components/modals/ShiftStatusModal';
import ShiftAttendanceModal from '../components/modals/ShiftAttendanceModal';

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function getPatrolSummary(checkpoints) {
  // Hitung pending vs missed secara eksplisit supaya UI bisa membedakan:
  //  - Shift live  → kartu ketiga pakai `pending` (belum dipatroli, status === 'pending').
  //  - History    → kartu ketiga pakai `missed`  (sudah dikunci di akhir shift).
  return ensureArray(checkpoints).reduce((acc, checkpoint) => {
    acc.total += 1;
    if (checkpoint.status === 'completed') {
      acc.completed += 1;
      if (checkpoint.resultType === 'aman') acc.aman += 1;
      if (checkpoint.resultType === 'temuan') acc.temuan += 1;
    }
    if (checkpoint.status === 'missed' || checkpoint.resultType === 'missed') {
      acc.missed += 1;
    }
    if (checkpoint.status === 'pending') {
      acc.pending += 1;
    }
    return acc;
  }, { aman: 0, temuan: 0, missed: 0, pending: 0, completed: 0, total: 0 });
}

function getSummaryCardMeta(type) {
  if (type === 'aman') {
    return {
      title: 'Kondisi Normal',
      cardClass: 'bg-emerald-950/20 border-emerald-500/30 hover:border-emerald-400/60',
      countClass: 'text-emerald-200',
      labelClass: 'text-emerald-300',
      iconWrapClass: 'bg-emerald-500/10 border-emerald-500/20',
      icon: <CheckCircle2 className="w-5 h-5 text-emerald-400" />,
      itemClass: 'bg-emerald-950/20 border-emerald-500/30',
      itemTextClass: 'text-emerald-400',
      itemIcon: <CheckCircle2 className="w-3 h-3 text-emerald-500" />,
      emptyLabel: 'kondisi normal',
    };
  }
  if (type === 'temuan') {
    return {
      title: 'Kondisi Temuan',
      cardClass: 'bg-yellow-950/20 border-yellow-500/30 hover:border-yellow-400/60',
      countClass: 'text-yellow-200',
      labelClass: 'text-yellow-300',
      iconWrapClass: 'bg-yellow-500/10 border-yellow-500/20',
      icon: <AlertTriangle className="w-5 h-5 text-yellow-400" />,
      itemClass: 'bg-yellow-950/20 border-yellow-500/30',
      itemTextClass: 'text-yellow-400',
      itemIcon: <AlertTriangle className="w-3 h-3 text-yellow-500" />,
      emptyLabel: 'temuan',
    };
  }
  if (type === 'pending') {
    return {
      title: 'Pending Checkpoint',
      cardClass: 'bg-slate-950/20 border-slate-500/30 hover:border-slate-400/60',
      countClass: 'text-slate-200',
      labelClass: 'text-slate-300',
      iconWrapClass: 'bg-slate-500/10 border-slate-500/20',
      icon: <Clock className="w-5 h-5 text-slate-400" />,
      itemClass: 'bg-slate-950/20 border-slate-500/30',
      itemTextClass: 'text-slate-400',
      itemIcon: <Clock className="w-3 h-3 text-slate-500" />,
      emptyLabel: 'checkpoint pending',
    };
  }
  return {
    title: 'Status Missed',
    cardClass: 'bg-rose-950/20 border-rose-500/30 hover:border-rose-400/60',
    countClass: 'text-rose-200',
    labelClass: 'text-rose-300',
    iconWrapClass: 'bg-rose-500/10 border-rose-500/20',
    icon: <CircleOff className="w-5 h-5 text-rose-400" />,
    itemClass: 'bg-rose-950/20 border-rose-500/30',
    itemTextClass: 'text-rose-400',
    itemIcon: <CircleOff className="w-3 h-3 text-rose-500" />,
    emptyLabel: 'status missed',
  };
}

function formatShiftCountdown(remainingMs) {
  if (remainingMs <= 0) return '00:00:00';

  const totalSeconds = Math.floor(remainingMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return [hours, minutes, seconds]
    .map(value => String(value).padStart(2, '0'))
    .join(':');
}

function getTimeStatusMeta(tone) {
  if (tone === 'success') {
    return {
      cardClass: 'border-emerald-500/30 bg-emerald-950/20',
      titleClass: 'text-emerald-300',
      labelClass: 'text-emerald-100',
      bodyClass: 'text-emerald-200/80',
      metaClass: 'text-emerald-300/70',
    };
  }

  if (tone === 'warning') {
    return {
      cardClass: 'border-yellow-500/30 bg-yellow-950/20',
      titleClass: 'text-yellow-300',
      labelClass: 'text-yellow-100',
      bodyClass: 'text-yellow-200/80',
      metaClass: 'text-yellow-300/70',
    };
  }

  return {
    cardClass: 'border-rose-500/30 bg-rose-950/20',
    titleClass: 'text-rose-300',
    labelClass: 'text-rose-100',
    bodyClass: 'text-rose-200/80',
    metaClass: 'text-rose-300/70',
  };
}

import PatrolFormView from '../components/views/PatrolFormView';
import IncidentDetailView from '../components/views/IncidentDetailView';
import ReportDetailView from '../components/views/ReportDetailView';

const PatrolPage = React.memo(function PatrolPage() {
  const [summaryDetailType, setSummaryDetailType] = React.useState(null);
  const {
    patrolTab, setPatrolTab, searchQuery, setSearchQuery, filteredCheckpoints,
    handleActionClick, handleOpenPatrolResult, handleAddCustomPatrolNode,
    completedCount, totalCount, progressPercentage, newCustomNode, setNewCustomNode,
    checkpoints, activeShiftGuardSnapshot, currentShiftMeta, currentShiftSchedule, canPatrolCurrentShip, canAddTemporaryPatrolNode,
    activeForms, isShiftStatusRequired, isCurrentShiftStatusCompleted, showShiftStatusModal, openShiftStatusModal, currentShiftStatusRecord,
    pendingPatrolCameraCapture,
  } = usePatrol();
  const { operationalShip, operationalShipName, shipsData } = useShips();
  const [nfcSelection, setNfcSelection] = React.useState(null);
  const [demoToast, setDemoToast] = React.useState(null);
  const dismissDemoToast = React.useCallback(() => setDemoToast(null), []);
  const { weatherInfo, weatherLoading, getWeatherDetail } = useWeather();
  const { setPreviewPhoto, selectedReportDetail } = useReports();
  const { selectedHistoryEntry, closeHistoryEntry } = useHistory();
  const { selectedIncident, setSelectedIncident, allIncidents, incidentMeta, handleAddProgress } = useIncidents();
  const [temuanUpdateTarget, setTemuanUpdateTarget] = React.useState(null);
  const trustedTime = React.useSyncExternalStore(
    subscribeTrustedTime,
    getTrustedTimeSnapshot,
    getTrustedTimeSnapshot,
  );

  const isHistoryMode = Boolean(selectedHistoryEntry);
  const activeCheckpoints = React.useMemo(
    () => (isHistoryMode ? ensureArray(selectedHistoryEntry?.checkpoints) : ensureArray(checkpoints)),
    [checkpoints, isHistoryMode, selectedHistoryEntry?.checkpoints],
  );
  const patrolSummary = React.useMemo(() => getPatrolSummary(activeCheckpoints), [activeCheckpoints]);
  const timeStatusMeta = React.useMemo(
    () => getTimeStatusMeta(trustedTime.tone),
    [trustedTime.tone],
  );
  const timeAuditSummary = React.useMemo(() => {
    const completed = activeCheckpoints.filter(c => c.status === 'completed');
    return summarizeTimeAudit(completed, { fallbackTimestampKeys: ['completedAt', 'updatedAt', 'createdAt'] });
  }, [activeCheckpoints]);
  
  // Check if any form or detail is active
  const hasActiveForm = Object.keys(activeForms && typeof activeForms === 'object' ? activeForms : {}).length > 0;
  const showRightPane = hasActiveForm || (selectedIncident && selectedIncident.isPatrol) || selectedReportDetail;
  const visibleCheckpoints = React.useMemo(() => ensureArray(filteredCheckpoints), [filteredCheckpoints]);
  const isCheckpointLocked = !isHistoryMode && isShiftStatusRequired && !isCurrentShiftStatusCompleted;
  const canAddShiftNode = canAddTemporaryPatrolNode && !isCheckpointLocked;

  // Definisi titik kapal (main/sub, NFC, foto acuan) dipetakan ke item patroli lewat nama.
  const checkpointDefinitions = React.useMemo(
    () => normalizeShipCheckpointDefinitions(operationalShip?.customCheckpoints),
    [operationalShip?.customCheckpoints],
  );
  const definitionByNameKey = React.useMemo(
    () => new Map(checkpointDefinitions.map(definition => [createCheckpointNameKey(definition.name), definition])),
    [checkpointDefinitions],
  );
  const definitionById = React.useMemo(
    () => new Map(checkpointDefinitions.map(definition => [definition.id, definition])),
    [checkpointDefinitions],
  );
  const getDefinitionForItem = React.useCallback((item) => (
    item?.isTemporaryShiftNode ? null : definitionByNameKey.get(createCheckpointNameKey(item?.name)) || null
  ), [definitionByNameKey]);

  // Status temuan per titik: temuan patroli yang belum Closed/Unsolve = OPEN (pilihan jadi Temuan
  // Baru / Update Temuan), temuan Unsolve mengganti foto acuan dengan kondisi saat unsolve.
  const followUpStoreVersion = useFollowUpStoreVersion();
  const openTemuanByCheckpointKey = React.useMemo(() => {
    const collection = new Map();
    if (isHistoryMode) return collection;
    ensureArray(allIncidents).forEach((incident) => {
      if (!isPatrolTemuanOpen(incident, incidentMeta?.[incident.id]?.status)) return;
      const key = getIncidentCheckpointKey(incident);
      if (key) collection.set(key, [...(collection.get(key) || []), incident]);
    });
    return collection;
  }, [allIncidents, incidentMeta, isHistoryMode, followUpStoreVersion]);
  // Jumlah temuan baru & update temuan per titik pada shift berjalan (untuk flag titik). Hanya
  // dihitung dalam shift berjalan → otomatis reset tiap pergantian shift.
  const shiftActivityByCheckpointKey = React.useMemo(() => {
    const collection = new Map();
    if (isHistoryMode) return collection;
    const shiftStartMs = new Date(currentShiftSchedule?.startAt || '').getTime();
    const shiftEndMs = new Date(currentShiftSchedule?.endAt || '').getTime();
    const hasShiftRange = Number.isFinite(shiftStartMs) && Number.isFinite(shiftEndMs);
    ensureArray(allIncidents).forEach((incident) => {
      if (!incident?.isPatrol || incident.isSOS) return;
      const key = getIncidentCheckpointKey(incident);
      if (!key) return;
      const activity = collection.get(key) || { newCount: 0, updateCount: 0 };
      if (incident.shiftKey && incident.shiftKey === currentShiftMeta?.key) activity.newCount += 1;
      ensureArray(incidentMeta?.[incident.id]?.progress).forEach((progress) => {
        const createdMs = new Date(progress?.createdAt || '').getTime();
        if (hasShiftRange && Number.isFinite(createdMs) && createdMs >= shiftStartMs && createdMs < shiftEndMs) activity.updateCount += 1;
      });
      collection.set(key, activity);
    });
    return collection;
  }, [allIncidents, currentShiftMeta?.key, currentShiftSchedule, incidentMeta, isHistoryMode]);
  const getTemuanStateForItem = React.useCallback((item) => {
    if (isHistoryMode || !item) return { openTemuan: [], override: null, newCount: 0, updateCount: 0 };
    // Temuan lama bisa menyimpan id kapal atau hanya nama kapal → cek keduanya.
    const keys = Array.from(new Set([
      createCheckpointTemuanKey(operationalShip?.id, item.name),
      createCheckpointTemuanKey(operationalShipName, item.name),
    ].filter(Boolean)));
    const activities = keys.map(key => shiftActivityByCheckpointKey.get(key)).filter(Boolean);
    return {
      openTemuan: keys.flatMap(key => openTemuanByCheckpointKey.get(key) || []),
      override: keys.map(getCheckpointReferenceOverride).find(Boolean) || null,
      newCount: activities.reduce((total, activity) => total + activity.newCount, 0),
      updateCount: activities.reduce((total, activity) => total + activity.updateCount, 0),
    };
  }, [isHistoryMode, openTemuanByCheckpointKey, operationalShip?.id, operationalShipName, shiftActivityByCheckpointKey, followUpStoreVersion]);
  const getReferencePhotoForItem = React.useCallback((item, definition) => {
    const { override } = getTemuanStateForItem(item);
    return override?.referencePhotoUrl
      ? { url: override.referencePhotoUrl, isUnsolve: true }
      : { url: definition?.referencePhotoUrl || null, isUnsolve: false };
  }, [getTemuanStateForItem]);

  const isNfcScanActive = !isHistoryMode
    && patrolTab === 'checkpoint'
    && canPatrolCurrentShip
    && !isCheckpointLocked
    && !hasActiveForm
    && !pendingPatrolCameraCapture
    && !nfcSelection;
  const nfcScan = usePatrolNfcScan({
    active: isNfcScanActive,
    ship: operationalShip,
    ships: shipsData,
    checkpoints,
    // Mode demo: titik yang sudah dilapor shift ini tetap bisa di-scan lagi (temuan baru / update).
    allowCompleted: isDemoMode,
    onCheckpointScanned: ({ item, definition, tagId }) => {
      setNfcSelection({ item, definition, verified: true, tagId, verifiedAt: new Date(getTrustedTimeSnapshot().nowMs || Date.now()).toISOString() });
    },
  });

  const handleNfcChoice = React.useCallback((type) => {
    const selection = nfcSelection;
    if (!selection) return;
    if (selection.demo) {
      // Titik contoh (dummy): hanya simulasi, tidak membuat laporan patroli.
      setNfcSelection(null);
      setDemoToast({ id: Date.now(), message: `Simulasi: petugas memilih ${type === 'aman' ? 'AMAN' : 'TEMUAN'} di ${selection.item.name}.\nTitik contoh tidak membuat laporan.` });
      return;
    }
    if (type === 'aman' && getTemuanStateForItem(selection.item).openTemuan.length > 0) return;
    if (type === 'aman' && selection.item.status === 'completed') return;
    setNfcSelection(null);
    handleActionClick(selection.item.id, type, selection.verified
      ? {
        tagId: selection.tagId,
        verifiedAt: selection.verifiedAt,
        referencePhotoUrl: getReferencePhotoForItem(selection.item, selection.definition).url,
      }
      : null);
  }, [getReferencePhotoForItem, getTemuanStateForItem, handleActionClick, nfcSelection]);

  // "Update Temuan": buka detail temuan open di titik ini langsung ke form update riwayat (Petugas).
  const handleUpdateOpenTemuan = React.useCallback((incident) => {
    setNfcSelection(null);
    setSelectedIncident({ ...incident, patrolUpdateIntentAt: Date.now() });
  }, [setSelectedIncident]);
  // Mode demo: satu form untuk SEMUA temuan open di titik (wajib diisi semua).
  const handleUpdateAllOpenTemuan = React.useCallback((incidents) => {
    const selection = nfcSelection;
    setNfcSelection(null);
    setTemuanUpdateTarget({ checkpointName: selection?.item?.name || '', incidents });
  }, [nfcSelection]);
  const submitAllTemuanUpdates = React.useCallback(async (updates) => {
    for (const update of updates) {
      await handleAddProgress(update.incident.id, { comment: update.comment, photoUrl: update.photoUrl });
    }
    setTemuanUpdateTarget(null);
    setDemoToast({ id: Date.now(), message: `${updates.length} update temuan terkirim ke Riwayat Update masing-masing temuan.` });
  }, [handleAddProgress]);

  // Kelompokkan item patroli: main diikuti sub-nya (urutan definisi sudah main → sub). Sub yang
  // induknya tidak ikut tampil (mis. tersaring pencarian) dirender sendiri dengan label induk.
  const patrolCollapse = useCollapsedGroups();
  const checkpointGroups = React.useMemo(() => {
    const groups = [];
    const groupByMainId = new Map();
    visibleCheckpoints.forEach((item) => {
      const definition = getDefinitionForItem(item);
      const parentGroup = definition?.type === 'sub' ? groupByMainId.get(definition.parentId) : null;
      if (parentGroup) {
        parentGroup.subs.push(item);
        return;
      }
      const group = { item, definition, subs: [] };
      groups.push(group);
      if (definition?.type === 'main') groupByMainId.set(definition.id, group);
    });
    return groups;
  }, [getDefinitionForItem, visibleCheckpoints]);

  // Jumlah selesai main + sub (mis. 2/4) di samping nama main, panah buka/tutup sub di paling kanan bar.
  const renderSubGroupCount = (subGroup) => (
    subGroup ? (
      <span className={`shrink-0 text-[11px] font-bold tabular-nums ${subGroup.done === subGroup.total ? 'text-emerald-300' : 'text-cyan-500'}`} title="Titik selesai (main + sub)">
        {subGroup.done}/{subGroup.total}
      </span>
    ) : null
  );
  const renderSubGroupToggle = (subGroup, itemName) => (
    subGroup ? (
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          subGroup.onToggle();
        }}
        aria-expanded={subGroup.expanded}
        aria-controls={subGroup.controlsId}
        aria-label={`${subGroup.expanded ? 'Tutup' : 'Buka'} ${subGroup.subCount} sub checkpoint ${itemName}`}
        className="shrink-0 p-2 -mr-1 rounded-lg text-sky-300 hover:bg-sky-500/10 transition-colors"
      >
        <ChevronDown className={`w-5 h-5 transition-transform ${subGroup.expanded ? 'rotate-180' : ''}`} />
      </button>
    ) : null
  );

  // Bar checkpoint = area simulasi tap NFC (laporan asli tetap lewat tap NFC fisik).
  // Checklist terkunci → arahkan ke isian status shift dulu, bukan diam saja.
  const simulateTapForItem = (item, definition) => {
    if (isCheckpointLocked) {
      openShiftStatusModal();
      return;
    }
    setNfcSelection({ item, definition, verified: false, simulated: true });
  };

  // Flag temuan open: "x temuan open" selalu tampil (temuan baru ikut terhitung di sini karena
  // masih open); keterangan temuan baru / update temuan hanya bila ada di shift berjalan.
  const renderTemuanOpenFlag = (temuanState) => {
    const openCount = temuanState.openTemuan.length;
    if (!openCount) return null;
    const label = [
      `${openCount} temuan open`,
      temuanState.newCount > 0 ? `${temuanState.newCount} temuan baru` : '',
      temuanState.updateCount > 0 ? `${temuanState.updateCount} update temuan` : '',
    ].filter(Boolean).join(' · ');
    return (
      <span className="text-[9px] uppercase tracking-widest text-yellow-300 border border-yellow-500/40 px-1.5 py-0.5 rounded" title="Masih ada temuan yang belum Closed/Unsolve">
        {label}
      </span>
    );
  };

  const renderPatrolListItem = (item, { standalone = false, subGroup = null } = {}) => {
    const definition = getDefinitionForItem(item);
    const referencePhoto = getReferencePhotoForItem(item, definition);
    const temuanState = getTemuanStateForItem(item);
    if (item.status === 'completed') {
      return renderSummaryListItem(item, {
        referencePhoto,
        countNode: renderSubGroupCount(subGroup),
        toggleNode: renderSubGroupToggle(subGroup, item.name),
        flagNode: renderTemuanOpenFlag(temuanState),
        // Mode demo: titik yang sudah dilapor bisa di-scan lagi (bar = area tap); detail lewat tombol.
        onRescan: isDemoMode ? () => simulateTapForItem(item, definition) : null,
      });
    }
    const hasOpenTemuan = temuanState.openTemuan.length > 0;
    // Label induk hanya untuk sub yang tampil di luar kelompok main-nya.
    const parentName = standalone && definition?.type === 'sub' ? definitionById.get(definition.parentId)?.name : '';
    const handleSimulateTap = () => simulateTapForItem(item, definition);

    return (
      <div
        key={item.id}
        role="button"
        tabIndex={0}
        onClick={handleSimulateTap}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            handleSimulateTap();
          }
        }}
        aria-label={`Simulasi tap NFC di ${item.name}`}
        className={`p-3 bg-[#0b1229] border rounded-xl transition-all cursor-pointer hover:border-fuchsia-500/50 active:scale-[0.99] ${definition?.type === 'sub' ? 'border-sky-900/60' : 'border-cyan-800/50'}`}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex-1 min-w-0">
            {parentName && (
              <p className="text-[10px] text-sky-400 flex items-center gap-1 mb-0.5 truncate"><CornerDownRight className="w-3 h-3 shrink-0" /> {parentName}</p>
            )}
            <div className="flex items-center gap-2 min-w-0">
              <p className="font-bold text-white truncate">{item.name}</p>
              {renderSubGroupCount(subGroup)}
              {item.isTemporaryShiftNode && (
                <span className="shrink-0 text-[9px] uppercase tracking-widest text-yellow-300 border border-yellow-500/40 px-1.5 py-0.5 rounded">
                  Tambahan Shift
                </span>
              )}
            </div>
            {(hasOpenTemuan || referencePhoto.isUnsolve) && (
              <div className="flex flex-wrap gap-1 mt-1">
                {renderTemuanOpenFlag(temuanState)}
                {referencePhoto.isUnsolve && (
                  <span className="text-[9px] uppercase tracking-widest text-orange-300 border border-orange-500/40 px-1.5 py-0.5 rounded" title="Temuan di titik ini Unsolve; foto acuan diperbarui">Unsolve</span>
                )}
              </div>
            )}
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {renderReferencePhotoButton(item, referencePhoto)}
            {renderSubGroupToggle(subGroup, item.name)}
          </div>
        </div>
      </div>
    );
  };

  // Satu titik contoh berstatus UNSOLVE (data dummy) untuk simulasi info unsolve + AMAN/TEMUAN.
  const renderDemoUnsolveItem = () => {
    const demo = DEMO_UNSOLVE_CHECKPOINT;
    return (
      <button
        type="button"
        onClick={() => setNfcSelection({ item: demo.item, definition: demo.definition, verified: false, simulated: true, demo: true })}
        className="w-full p-3 bg-[#0b1229] border border-orange-500/40 rounded-xl flex items-center gap-3 text-left hover:border-orange-400/70 transition-colors"
        aria-label={`Buka titik contoh ${demo.item.name} (Unsolve)`}
      >
        <div className="w-12 h-12 shrink-0 rounded-lg overflow-hidden border border-orange-500/50">
          <AsyncImage src={demo.override.referencePhotoUrl} alt="Kondisi saat unsolve" className="w-full h-full object-cover" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-bold text-white truncate">{demo.item.name}</p>
          <div className="flex flex-wrap gap-1 mt-1">
            <span className="text-[9px] uppercase tracking-widest text-orange-300 border border-orange-500/40 px-1.5 py-0.5 rounded">Unsolve</span>
            <span className="text-[9px] uppercase tracking-widest text-fuchsia-300 border border-fuchsia-500/40 px-1.5 py-0.5 rounded">Contoh</span>
          </div>
        </div>
      </button>
    );
  };

  const summaryCards = React.useMemo(() => ([
    { type: 'aman', count: patrolSummary.aman },
    { type: 'temuan', count: patrolSummary.temuan },
    isHistoryMode
      ? { type: 'missed', count: patrolSummary.missed }
      : { type: 'pending', count: patrolSummary.pending ?? 0 },
  ]), [isHistoryMode, patrolSummary]);
  const summaryDetailItems = React.useMemo(() => {
    if (!summaryDetailType) return [];
    return activeCheckpoints.filter((item) => {
      if (summaryDetailType === 'missed') return item.status === 'missed' || item.resultType === 'missed';
      if (summaryDetailType === 'pending') return item.status === 'pending';
      return item.status === 'completed' && item.resultType === summaryDetailType;
    });
  }, [activeCheckpoints, summaryDetailType]);

  const displayShip = isHistoryMode ? selectedHistoryEntry?.shipSnapshot : operationalShip;
  const displayShipName = isHistoryMode ? selectedHistoryEntry?.ship : operationalShipName;
  const displayDate = isHistoryMode ? selectedHistoryEntry?.date : currentShiftMeta?.dateLabel;
  const displayShiftLabel = isHistoryMode ? selectedHistoryEntry?.shift : currentShiftMeta?.label;
  const displayShiftTime = isHistoryMode ? selectedHistoryEntry?.time : currentShiftMeta?.timeRange;
  const displayWeather = isHistoryMode ? selectedHistoryEntry?.weatherSnapshot : weatherInfo;
  const displayWeatherLoading = isHistoryMode ? false : weatherLoading;
  const displayCrew = React.useMemo(() => (
    isHistoryMode
      ? ensureArray(selectedHistoryEntry?.crewSnapshot).filter(user => user?.role === ACCESS_ROLES.PETUGAS)
      : ensureArray(activeShiftGuardSnapshot)
  ), [activeShiftGuardSnapshot, isHistoryMode, selectedHistoryEntry?.crewSnapshot]);
  // Mode demo: ringkasan absensi shift berjalan sebagai SATU badge di tab Info (Petugas Jaga).
  const attendanceBadge = React.useMemo(() => {
    if (!isDemoMode || isHistoryMode) return null;
    const items = ensureArray(currentShiftStatusRecord?.items);
    const attended = items.filter(item => item.attendancePhotoUrl);
    if (!attended.length) {
      return <span className="text-[9px] font-bold uppercase tracking-wider px-2 py-1 rounded border border-amber-500/50 bg-amber-500/10 text-amber-300">Belum absensi</span>;
    }
    const notWell = attended.filter(item => item.condition === 'tidak_baik');
    const resting = attended.filter(item => item.status === 'istirahat').length;
    // Kondisi hanya relevan untuk petugas istirahat; DCU (suhu & tensi) hanya ada di shift pagi.
    const describeItem = (item) => {
      const statusText = item.status === 'istirahat'
        ? `Istirahat, ${item.condition === 'tidak_baik' ? `Tidak Baik (${item.conditionNote || '-'})` : 'Baik'}`
        : 'Patroli';
      const dcuText = item.dcu ? ` · DCU ${item.dcu.temperature ?? '-'}°C, TD ${item.dcu.systolic ?? '-'}/${item.dcu.diastolic ?? '-'}` : '';
      return `${item.name}: ${statusText}${dcuText}`;
    };
    const detail = attended.map(describeItem).join('\n');
    return (
      <span
        title={detail}
        className={`text-[9px] font-bold uppercase tracking-wider px-2 py-1 rounded border ${notWell.length ? 'border-rose-500/50 bg-rose-500/10 text-rose-300' : 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300'}`}
      >
        Absensi {attended.length}/{items.length} · {resting} istirahat{notWell.length ? ` · ${notWell.length} tidak baik` : resting ? ' · kondisi baik' : ''}
      </span>
    );
  }, [currentShiftStatusRecord, isHistoryMode]);

  const infoEntryData = React.useMemo(() => (
    isHistoryMode
      ? selectedHistoryEntry
      : {
          id: 'live-patrol-info',
          isLive: true,
          ship: displayShipName,
          shipSnapshot: displayShip,
          date: displayDate,
          shift: displayShiftLabel,
          time: displayShiftTime,
          weatherSnapshot: displayWeather,
          summary: patrolSummary,
          issue: patrolSummary.temuan,
          missed: patrolSummary.missed,
          pending: patrolSummary.pending ?? 0,
          crewSnapshot: displayCrew,
        }
  ), [
    isHistoryMode,
    selectedHistoryEntry,
    displayShipName,
    displayShip,
    displayDate,
    displayShiftLabel,
    displayShiftTime,
    displayWeather,
    patrolSummary,
    displayCrew,
  ]);

  const shiftCountdown = React.useMemo(() => {
    if (isHistoryMode || !currentShiftSchedule?.endAt) return null;

    const endTimestamp = new Date(currentShiftSchedule.endAt).getTime();
    if (Number.isNaN(endTimestamp)) return null;

    return formatShiftCountdown(Math.max(0, endTimestamp - trustedTime.nowMs));
  }, [currentShiftSchedule, isHistoryMode, trustedTime.nowMs]);

  React.useEffect(() => {
    setSummaryDetailType(null);
  }, [selectedHistoryEntry?.id]);

  const handleOpenSummaryDetail = React.useCallback((type) => {
    setSummaryDetailType(type);
  }, []);

  const handleBackToSummary = React.useCallback(() => {
    setSummaryDetailType(null);
    setPatrolTab('info');
  }, [setPatrolTab]);

  const openReferencePhoto = React.useCallback((item, referencePhoto) => {
    if (!referencePhoto?.url) return;
    setPreviewPhoto({ url: referencePhoto.url, author: `${referencePhoto.isUnsolve ? 'Kondisi saat Unsolve' : 'Kondisi awal'} · ${item.name}` });
  }, [setPreviewPhoto]);

  const renderReferencePhotoButton = React.useCallback((item, referencePhoto) => (
    referencePhoto?.url ? (
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          openReferencePhoto(item, referencePhoto);
        }}
        className={`shrink-0 p-2 rounded-xl border bg-[#070b19] transition-colors ${referencePhoto.isUnsolve ? 'border-orange-500/60 text-orange-300 hover:text-orange-100' : 'border-cyan-800/70 text-cyan-300 hover:border-cyan-500/60 hover:text-cyan-100'}`}
        aria-label={`Lihat foto kondisi awal ${item.name}`}
        title={referencePhoto.isUnsolve ? 'Foto kondisi awal (diperbarui dari Unsolve)' : 'Foto kondisi awal'}
      >
        <ImageIcon className="w-4 h-4" />
      </button>
    ) : null
  ), [openReferencePhoto]);

  const renderSummaryListItem = React.useCallback((item, options = {}) => {
    const isTemuan = item.resultType === 'temuan';
    const isMissed = item.status === 'missed' || item.resultType === 'missed';
    const meta = getSummaryCardMeta(isMissed ? 'missed' : isTemuan ? 'temuan' : 'aman');
    const completedByLabel = typeof item?.completedBy === 'string'
      ? item.completedBy.split(' ')[0]
      : '-';

    return (
      <div
        key={`${item.historyId || 'live'}-${item.id}`}
        role={options.onRescan ? 'button' : undefined}
        tabIndex={options.onRescan ? 0 : undefined}
        aria-label={options.onRescan ? `Simulasi tap NFC di ${item.name}` : undefined}
        onClick={() => (options.onRescan ? options.onRescan() : handleOpenPatrolResult(item))}
        onKeyDown={options.onRescan ? (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            options.onRescan();
          }
        } : undefined}
        className={`p-3 border rounded-xl flex items-center justify-between cursor-pointer hover:shadow-lg transition-all ${meta.itemClass}`}
      >
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-0.5">
            <p className={`font-bold ${meta.itemTextClass}`}>{item.name}</p>
            {options.countNode}
            {item.nfcVerification?.tagId && (
              <span className="inline-flex items-center gap-0.5 text-[9px] uppercase tracking-widest text-emerald-300 border border-emerald-500/40 px-1 py-0.5 rounded" title="Dilaporkan lewat tap NFC"><Nfc className="w-3 h-3" /> NFC</span>
            )}
            {item.isTemporaryShiftNode && (
              <span className="text-[9px] uppercase tracking-widest text-yellow-300 border border-yellow-500/40 px-1.5 py-0.5 rounded">
                Tambahan Shift
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 text-[11px] text-cyan-200/60 mt-1">
            {meta.itemIcon}
            <span className="truncate">
              {isMissed ? `Tidak dipatroli - ${item.time || displayShiftTime || '-'}` : `oleh ${completedByLabel} - ${item.time || '-'}`}
            </span>
          </div>
          {options.flagNode && <div className="flex flex-wrap gap-1 mt-1">{options.flagNode}</div>}
        </div>
        {options.onRescan && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              handleOpenPatrolResult(item);
            }}
            className="shrink-0 mr-2 p-2 rounded-xl border border-cyan-800/70 bg-[#070b19] text-cyan-300 hover:border-cyan-500/60 hover:text-cyan-100 transition-colors"
            aria-label={`Lihat laporan ${item.name}`}
            title="Lihat laporan"
          >
            <FileText className="w-4 h-4" />
          </button>
        )}
        {options.referencePhoto?.url && (
          <div className="mr-2">{renderReferencePhotoButton(item, options.referencePhoto)}</div>
        )}
        <div
          onClick={(event) => {
            if (!item.photoUrl) return;
            event.stopPropagation();
            setPreviewPhoto({ url: item.photoUrl, author: item.completedBy, time: item.time });
          }}
          className={`w-12 h-12 rounded-lg border overflow-hidden relative flex-shrink-0 bg-[#070b19] ${isMissed ? 'border-rose-500/40' : isTemuan ? 'border-yellow-500/40' : 'border-emerald-500/40'} ${item.photoUrl ? 'cursor-pointer hover:opacity-80' : ''}`}
        >
          {item.photoUrl ? (
            <AsyncImage src={item.thumbUrl} fallbackSrc={item.photoUrl} className="w-full h-full object-cover" alt="Thumb" />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-cyan-700">
              {isMissed ? <CircleOff className="w-4 h-4" /> : <FileText className="w-4 h-4" />}
            </div>
          )}
        </div>
        {options.toggleNode && <div className="ml-1">{options.toggleNode}</div>}
      </div>
    );
  }, [displayShiftTime, handleOpenPatrolResult, renderReferencePhotoButton, setPreviewPhoto]);

  const renderInfoContent = () => (
    <HistoryDetailView
      isInline={true}
      entryData={infoEntryData}
      crewBadge={attendanceBadge}
      onSummaryCardClick={handleOpenSummaryDetail}
      customTimeBadge={
        <div className="flex flex-wrap items-center gap-2 bg-[#0b1229] border border-cyan-800/50 rounded-2xl p-4 shadow-sm">
          {!isHistoryMode && (
            <>
              <div className={`flex items-center gap-1.5 shrink-0 px-2.5 py-1 rounded-full border bg-opacity-10 ${trustedTime.tone === 'success' ? 'bg-emerald-500 border-emerald-500/30' : trustedTime.tone === 'warning' ? 'bg-yellow-500 border-yellow-500/30' : 'bg-rose-500 border-rose-500/30'}`}>
                <span className="relative flex h-2 w-2">
                  <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${trustedTime.tone === 'success' ? 'bg-emerald-400' : trustedTime.tone === 'warning' ? 'bg-yellow-400' : 'bg-rose-400'}`}></span>
                  <span className={`relative inline-flex rounded-full h-2 w-2 ${trustedTime.tone === 'success' ? 'bg-emerald-500' : trustedTime.tone === 'warning' ? 'bg-yellow-500' : 'bg-rose-500'}`}></span>
                </span>
                <span className={`text-[10px] font-bold uppercase tracking-widest ${timeStatusMeta.titleClass}`}>Time:</span>
                <span className={`text-xs font-black ${timeStatusMeta.labelClass} leading-none py-0.5`}>{trustedTime.label}</span>
              </div>
              {timeAuditSummary.total > 0 && <div className="w-1.5 h-1.5 rounded-full bg-cyan-800/50 hidden sm:block"></div>}
            </>
          )}

          {timeAuditSummary.total > 0 && (
            <div className={`flex items-center gap-1.5 shrink-0 px-2.5 py-1 rounded-full border ${timeAuditSummary.tone === 'success' ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300' : timeAuditSummary.tone === 'warning' ? 'bg-yellow-500/10 border-yellow-500/30 text-yellow-300' : timeAuditSummary.tone === 'danger' ? 'bg-rose-500/10 border-rose-500/30 text-rose-300' : 'bg-[#0b1229] border-cyan-800/50 text-cyan-200'}`}>
              <span className="text-xs font-black leading-none py-0.5">Terverifikasi : {timeAuditSummary.counts?.verified || 0}</span>
            </div>
          )}
        </div>
      }
    />
  );

  return (
    <div className="flex h-full overflow-hidden">
      {/* Mode demo: status shift diganti absensi petugas (foto, status, kondisi). */}
      {showShiftStatusModal && (isDemoMode ? <ShiftAttendanceModal /> : <ShiftStatusModal />)}

      {/* Left Pane: List and Search */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 animate-in fade-in flex flex-col min-h-full scrollbar-thin scrollbar-thumb-cyan-900/50">
        {summaryDetailType ? (
          <div className="animate-in fade-in flex-1 flex flex-col space-y-4">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={handleBackToSummary}
                className="w-10 h-10 rounded-xl border border-cyan-700/60 bg-[#0b1229] text-cyan-300 flex items-center justify-center hover:bg-cyan-900/40 transition-colors"
                aria-label="Kembali ke patrol summary"
              >
                <ArrowLeft className="w-4 h-4" />
              </button>
              <div>
                <p className="text-[10px] font-bold uppercase tracking-widest text-cyan-500">Patrol Summary</p>
                <h2 className="text-xl font-black text-white">{getSummaryCardMeta(summaryDetailType).title}</h2>
              </div>
            </div>

            <div className="space-y-3 flex-1">
              {summaryDetailItems.length === 0 && (
                <p className="text-xs text-cyan-700 italic border border-dashed border-cyan-900/50 p-4 rounded-xl text-center">
                  Belum ada data {getSummaryCardMeta(summaryDetailType).emptyLabel} untuk patroli ini.
                </p>
              )}
              {summaryDetailItems.map(item => renderSummaryListItem(item))}
            </div>
          </div>
        ) : (
          <>
            {isHistoryMode ? (
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={closeHistoryEntry}
                  className="w-10 h-10 rounded-xl border border-cyan-700/60 bg-[#0b1229] text-cyan-300 flex items-center justify-center hover:bg-cyan-900/40 transition-colors"
                  aria-label="Kembali ke riwayat"
                >
                  <ArrowLeft className="w-4 h-4" />
                </button>
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-widest text-cyan-500">Riwayat Shift</p>
                  <h2 className="text-xl font-black text-white">Info Patroli</h2>
                </div>
              </div>
            ) : (
              <>
                <div className="flex bg-[#0b1229] p-1 rounded-xl border border-cyan-800/50 shadow-sm shrink-0">
                  <button onClick={() => setPatrolTab('checkpoint')} className={`flex-1 py-2.5 rounded-lg text-[10px] font-bold uppercase tracking-widest transition-all flex items-center justify-center gap-2 ${patrolTab === 'checkpoint' ? 'bg-cyan-600/20 text-cyan-300 border border-cyan-500/30 shadow-sm' : 'text-cyan-700 hover:text-cyan-500'}`}>
                    <CheckCircle2 className="w-4 h-4" /> Checkpoint
                  </button>
                  <button onClick={() => setPatrolTab('info')} className={`flex-1 py-2.5 rounded-lg text-[10px] font-bold uppercase tracking-widest transition-all flex items-center justify-center gap-2 ${patrolTab === 'info' ? 'bg-cyan-600/20 text-cyan-300 border border-cyan-500/30 shadow-sm' : 'text-cyan-700 hover:text-cyan-500'}`}>
                    <FileText className="w-4 h-4" /> Info
                  </button>
                </div>


              </>
            )}

            {!isHistoryMode && isCheckpointLocked && (
              <div className="rounded-2xl border border-amber-500/30 bg-amber-950/20 p-4 shadow-sm">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-widest text-amber-300">{isDemoMode ? 'Absensi Wajib Diisi' : 'Status Shift Wajib Diisi'}</p>
                    <p className="mt-2 text-sm text-amber-100">
                      {isDemoMode
                        ? 'Checklist patroli masih terkunci sampai Anda absen untuk shift ini (foto, status, kondisi).'
                        : 'Checklist patroli masih terkunci sampai status petugas shift ini disimpan.'}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={openShiftStatusModal}
                    className="shrink-0 rounded-xl border border-amber-400/40 bg-amber-500/15 px-3 py-2 text-[11px] font-bold uppercase tracking-widest text-amber-100 transition hover:bg-amber-500/25"
                  >
                    {isDemoMode ? 'Isi Absensi' : 'Isi Status'}
                  </button>
                </div>
              </div>
            )}

            <div className="lg:hidden">
              {(isHistoryMode || patrolTab === 'info') && renderInfoContent()}
            </div>
            
            <div className="hidden lg:block">
               {patrolTab === 'info' && renderInfoContent()}
            </div>

            {!isHistoryMode && patrolTab === 'checkpoint' && (
              <div className="relative animate-in fade-in flex-1 flex flex-col pb-32 lg:pb-20">
                <div className="sticky top-0 z-30 bg-[#070b19]/95 backdrop-blur-md py-3 -mx-4 px-4 border-b border-cyan-900/50 shadow-sm transition-all duration-300 mb-4">
                  <div className="relative">
                    <input type="text" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Cari titik Patroli..." className="w-full bg-[#0b1229] border border-cyan-800/80 rounded-xl py-3 pl-10 pr-4 text-sm text-cyan-50 focus:border-cyan-400 focus:shadow-[0_0_10px_rgba(34,211,238,0.2)] outline-none transition-all" />
                    <Search className="w-4 h-4 text-cyan-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
                  </div>
                </div>

                {!isCheckpointLocked && canPatrolCurrentShip && nfcScan.support.checked && (
                  <div className="mb-3 space-y-2">
                    {!nfcScan.support.supported ? (
                      <div className="flex items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-950/20 p-3 text-xs text-rose-200">
                        <Nfc className="w-4 h-4 shrink-0 mt-0.5" />
                        <p>Perangkat/browser ini tidak bisa membaca NFC. Gunakan aplikasi SmartPatrol di HP Android ber-NFC untuk melaporkan titik.</p>
                      </div>
                    ) : !nfcScan.support.enabled ? (
                      <div className="flex items-center justify-between gap-2 rounded-xl border border-amber-500/30 bg-amber-950/20 p-3 text-xs text-amber-100">
                        <p className="flex items-center gap-2"><Nfc className="w-4 h-4 shrink-0" /> NFC HP sedang mati.</p>
                        <button type="button" onClick={openNfcSettings} className="shrink-0 inline-flex items-center gap-1 rounded-lg border border-amber-400/40 bg-amber-500/15 px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-widest"><Settings className="w-3.5 h-3.5" /> Nyalakan</button>
                      </div>
                    ) : (
                      <div className={`flex items-center gap-3 rounded-xl border p-3 ${nfcScan.scanState === 'scanning' ? 'border-cyan-500/40 bg-cyan-500/10' : 'border-cyan-900/50 bg-[#0b1229]'}`}>
                        <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-cyan-500/15 text-cyan-300">
                          {nfcScan.scanState === 'scanning' && <span className="absolute inset-0 rounded-full bg-cyan-400/20 animate-ping" />}
                          <Nfc className="w-5 h-5" />
                        </span>
                        <div className="min-w-0">
                          <p className="text-xs font-bold text-cyan-100">{nfcScan.scanState === 'scanning' ? 'Siap scan NFC' : 'Scan NFC berhenti'}</p>
                          <p className="text-[11px] text-cyan-400">Tempelkan bagian belakang HP ke tag NFC di titik checkpoint untuk melapor.</p>
                        </div>
                      </div>
                    )}
                    {nfcScan.notice && (
                      <div role="alert" className={`flex items-start justify-between gap-2 rounded-xl border p-3 text-xs ${nfcScan.notice.tone === 'warning' ? 'border-amber-500/30 bg-amber-950/20 text-amber-100' : 'border-rose-500/30 bg-rose-950/20 text-rose-100'}`}>
                        <p>{nfcScan.notice.message}</p>
                        <button type="button" onClick={nfcScan.clearNotice} className="shrink-0 text-[10px] font-bold uppercase tracking-widest opacity-70 hover:opacity-100">Tutup</button>
                      </div>
                    )}
                  </div>
                )}

                <div className="space-y-3 flex-1">
                  {!isHistoryMode && !isDemoMode && !searchQuery && renderDemoUnsolveItem()}
                  {visibleCheckpoints.length === 0 && (
                    <p className="text-xs text-cyan-700 italic border border-dashed border-cyan-900/50 p-4 rounded-xl text-center">
                      {searchQuery ? `Titik patroli "${searchQuery}" tidak ditemukan.` : 'Belum ada titik patroli yang tersedia.'}
                    </p>
                  )}
                  {checkpointGroups.map((group) => {
                    if (group.subs.length === 0) return renderPatrolListItem(group.item, { standalone: true });
                    const mainId = group.definition.id;
                    const expanded = Boolean(searchQuery) || patrolCollapse.isExpanded(mainId);
                    const doneSubs = group.subs.filter(sub => sub.status === 'completed').length;
                    const listId = `patrol-subs-${mainId}`;
                    const subGroup = {
                      expanded,
                      onToggle: () => patrolCollapse.toggle(mainId),
                      subCount: group.subs.length,
                      controlsId: listId,
                      done: doneSubs + (group.item.status === 'completed' ? 1 : 0),
                      total: group.subs.length + 1,
                    };
                    return (
                      <div key={group.item.id} className="p-2 rounded-2xl border border-cyan-900/60 bg-[#0b1229]/40 space-y-2">
                        {renderPatrolListItem(group.item, { subGroup })}
                        {expanded && (
                          <div id={listId} className="ml-3 pl-3 border-l-2 border-sky-800/60 space-y-2">
                            {group.subs.map(sub => renderPatrolListItem(sub))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {canAddShiftNode && (
                  <div className="mt-4 p-4 bg-[#0b1229] border border-yellow-500/20 rounded-xl mb-2">
                    <p className="text-[10px] text-yellow-300 font-bold uppercase tracking-widest mb-1 pl-1">Titik Tambahan Shift</p>
                    <p className="text-xs text-cyan-300/80 mb-3">
                      Tambahkan titik patroli sementara jika lokasi yang Anda cek tidak ada di daftar. Titik ini hanya berlaku untuk kapal ini pada shift berjalan dan tetap masuk riwayat shift.
                    </p>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={newCustomNode}
                        onChange={event => setNewCustomNode(event.target.value)}
                        placeholder="Nama titik tambahan..."
                        className="flex-1 bg-[#070b19] border border-cyan-800/50 rounded-lg p-2.5 text-sm text-cyan-50 focus:border-cyan-400 outline-none"
                      />
                      <button onClick={handleAddCustomPatrolNode} className="px-4 bg-yellow-500/20 hover:bg-yellow-500/30 border border-yellow-500/40 text-yellow-200 rounded-lg transition-colors flex items-center justify-center">
                        <Plus className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                )}

                <div className="fixed lg:absolute bottom-[65px] lg:bottom-0 left-0 right-0 z-30 w-full sm:max-w-md lg:max-w-none sm:mx-auto lg:mx-0 bg-[#070b19]/95 backdrop-blur-md px-4 py-4 border-t border-cyan-900/50 shadow-[0_-5px_15px_rgba(0,0,0,0.3)]">
                  <div className="flex items-stretch gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex justify-between text-xs mb-2">
                        <span className="text-cyan-500 font-bold uppercase tracking-widest">Progress Patroli</span>
                        <span className="text-cyan-300 font-black">{completedCount}/{totalCount} <span className="font-normal text-[9px]">SELESAI</span></span>
                      </div>
                      <div className="w-full bg-[#0b1229] rounded-full h-2.5 border border-cyan-900/50 overflow-hidden">
                        <div className="bg-gradient-to-r from-cyan-600 via-emerald-500 to-emerald-400 h-full rounded-full transition-all duration-700 ease-out shadow-[0_0_12px_rgba(52,211,153,0.5)]" style={{ width: `${progressPercentage}%` }}></div>
                      </div>
                    </div>
                    <div className="shrink-0 min-w-[108px] rounded-xl border border-cyan-500/20 bg-[#0b1229] px-3 py-2 flex flex-col justify-center shadow-[0_0_18px_rgba(8,145,178,0.12)]">
                      <div className="flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-[0.22em] text-cyan-500">
                        <TimerReset className="w-3.5 h-3.5 text-cyan-400" />
                        Sisa Shift
                      </div>
                      <div className="mt-1 text-right text-base font-black tabular-nums text-cyan-100">
                        {shiftCountdown || '00:00:00'}
                      </div>
                    </div>
                  </div>
                 </div>
               </div>
             )}
           </>
         )}
       </div>

       {nfcSelection && (
         <PatrolNfcChoiceSheet
           selection={nfcSelection}
           openTemuan={nfcSelection.demo ? [] : getTemuanStateForItem(nfcSelection.item).openTemuan}
           referenceOverride={nfcSelection.demo ? DEMO_UNSOLVE_CHECKPOINT.override : getTemuanStateForItem(nfcSelection.item).override}
           parentName={nfcSelection.definition?.type === 'sub' ? definitionById.get(nfcSelection.definition.parentId)?.name : ''}
           onChoose={handleNfcChoice}
           onUpdateTemuan={handleUpdateOpenTemuan}
           onUpdateAllTemuan={isDemoMode && !nfcSelection.demo ? handleUpdateAllOpenTemuan : undefined}
           onlyNewTemuan={isDemoMode && nfcSelection.item.status === 'completed'}
           reportBlockedReason={canPatrolCurrentShip || nfcSelection.demo ? '' : 'Akun ini tidak ditugaskan patroli di kapal ini, jadi laporan Aman/Temuan tidak bisa dikirim. Login sebagai petugas kapal ini atau PIC untuk melapor.'}
           onClose={() => setNfcSelection(null)}
           onPreviewPhoto={(url) => setPreviewPhoto({ url, author: `Foto acuan · ${nfcSelection.item.name}` })}
         />
       )}

       <FollowUpToast toast={demoToast} onDismiss={dismissDemoToast} />

       {temuanUpdateTarget && (
         <PatrolTemuanUpdateModal
           checkpointName={temuanUpdateTarget.checkpointName}
           incidents={temuanUpdateTarget.incidents}
           onClose={() => setTemuanUpdateTarget(null)}
           onSubmit={submitAllTemuanUpdates}
         />
       )}

       {/* Right Pane: Detail Component */}
        <div className="hidden lg:block flex-1 border-l border-cyan-900/50 bg-[#070b19] shrink-0 overflow-hidden relative">
          {hasActiveForm && <PatrolFormView isInline={true} />}
          {(!hasActiveForm && selectedReportDetail) && <ReportDetailView isInline={true} />}
          {(!hasActiveForm && !selectedReportDetail && selectedIncident && selectedIncident.isPatrol) && <IncidentDetailView isInline={true} />}
          
          {/* Placeholder when nothing is selected */}
          {!showRightPane && (
            <div className="h-full flex flex-col">
               <div className="p-4 border-b border-cyan-900/50 bg-[#0b1229]/30">
                  <h3 className="text-xs font-bold text-cyan-500 uppercase tracking-widest">Info Lokasi & Armada</h3>
               </div>
               <div className="flex-1 overflow-y-auto p-6 scrollbar-thin scrollbar-thumb-cyan-900/50">
                  {renderInfoContent()}
               </div>
            </div>
          )}
       </div>
    </div>
  );
});

export default PatrolPage;
