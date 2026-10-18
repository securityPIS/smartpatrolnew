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
  CalendarDays, Thermometer, Wind, FileText, CircleOff, TimerReset, Clock, Nfc, CornerDownRight, ShieldAlert, Settings,
  ImageIcon,
} from 'lucide-react';
import CheckpointGroupToggle, { useCollapsedGroups } from '../components/CheckpointGroupToggle';
import PatrolNfcChoiceSheet from '../components/modals/PatrolNfcChoiceSheet';
import { usePatrolNfcScan } from '../hooks/usePatrolNfcScan';
import { openNfcSettings } from '../services/native/nfc';
import { createCheckpointNameKey, normalizeShipCheckpointDefinitions } from '../utils/shipCheckpoints';
import { createCheckpointTemuanKey, getCheckpointTemuanState, useCheckpointTemuanVersion } from '../components/incidentFollowUp/followUpStore';
import AsyncImage from '../components/AsyncImage';
import HistoryDetailView from '../components/views/HistoryDetailView';
import ShiftStatusModal from '../components/modals/ShiftStatusModal';

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
    activeForms, isShiftStatusRequired, isCurrentShiftStatusCompleted, showShiftStatusModal, openShiftStatusModal,
    pendingPatrolCameraCapture,
  } = usePatrol();
  const { operationalShip, operationalShipName, shipsData } = useShips();
  const [nfcSelection, setNfcSelection] = React.useState(null);
  const { weatherInfo, weatherLoading, getWeatherDetail } = useWeather();
  const { setPreviewPhoto, selectedReportDetail } = useReports();
  const { selectedHistoryEntry, closeHistoryEntry } = useHistory();
  const { selectedIncident } = useIncidents();
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

  // Status temuan per titik (store tindak lanjut dummy): temuan berjalan menyembunyikan AMAN,
  // temuan Unsolve mengganti foto acuan dengan kondisi saat unsolve.
  const checkpointTemuanVersion = useCheckpointTemuanVersion();
  const temuanShipKey = operationalShip?.id || operationalShipName || '';
  const getTemuanStateForItem = React.useCallback((item) => (
    isHistoryMode || item?.isTemporaryShiftNode
      ? getCheckpointTemuanState('')
      : getCheckpointTemuanState(createCheckpointTemuanKey(temuanShipKey, item?.name))
  ), [isHistoryMode, temuanShipKey, checkpointTemuanVersion]);
  const getReferencePhotoForItem = React.useCallback((item, definition) => {
    const override = getTemuanStateForItem(item).override;
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
    onCheckpointScanned: ({ item, definition, tagId }) => {
      setNfcSelection({ item, definition, verified: true, tagId, verifiedAt: new Date(getTrustedTimeSnapshot().nowMs || Date.now()).toISOString() });
    },
  });

  const handleNfcChoice = React.useCallback((type) => {
    const selection = nfcSelection;
    if (!selection) return;
    if (type === 'aman' && getTemuanStateForItem(selection.item).hasOpenTemuan) return;
    setNfcSelection(null);
    handleActionClick(selection.item.id, type, selection.verified
      ? {
        tagId: selection.tagId,
        verifiedAt: selection.verifiedAt,
        referencePhotoUrl: getReferencePhotoForItem(selection.item, selection.definition).url,
      }
      : null);
  }, [getReferencePhotoForItem, getTemuanStateForItem, handleActionClick, nfcSelection]);

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

  const renderPatrolListItem = (item, { standalone = false } = {}) => {
    const definition = getDefinitionForItem(item);
    const referencePhoto = getReferencePhotoForItem(item, definition);
    if (item.status === 'completed') return renderSummaryListItem(item, { referencePhoto });
    const { hasOpenTemuan } = getTemuanStateForItem(item);

    const hasNfc = Boolean(definition?.nfcTagId);
    // Label induk hanya untuk sub yang tampil di luar kelompok main-nya.
    const parentName = standalone && definition?.type === 'sub' ? definitionById.get(definition.parentId)?.name : '';
    // Titik ber-NFC hanya bisa dilaporkan lewat tap NFC. Titik tanpa NFC (titik tambahan
    // shift / belum didaftarkan admin) tetap bisa dibuka manual agar patroli tidak macet.
    const canOpenManually = !hasNfc && !isCheckpointLocked;

    return (
      <div
        key={item.id}
        role={canOpenManually ? 'button' : undefined}
        tabIndex={canOpenManually ? 0 : undefined}
        onClick={canOpenManually ? () => setNfcSelection({ item, definition, verified: false }) : undefined}
        onKeyDown={canOpenManually ? (event) => { if (event.key === 'Enter') setNfcSelection({ item, definition, verified: false }); } : undefined}
        className={`p-3 bg-[#0b1229] border rounded-xl transition-all ${definition?.type === 'sub' ? 'border-sky-900/60' : 'border-cyan-800/50'} ${canOpenManually ? 'cursor-pointer hover:border-amber-500/40' : ''}`}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex-1 min-w-0">
            {parentName && (
              <p className="text-[10px] text-sky-400 flex items-center gap-1 mb-0.5 truncate"><CornerDownRight className="w-3 h-3 shrink-0" /> {parentName}</p>
            )}
            <div className="flex items-center gap-2 min-w-0">
              <p className="font-bold text-white truncate">{item.name}</p>
              {item.isTemporaryShiftNode && (
                <span className="shrink-0 text-[9px] uppercase tracking-widest text-yellow-300 border border-yellow-500/40 px-1.5 py-0.5 rounded">
                  Tambahan Shift
                </span>
              )}
            </div>
            {(hasOpenTemuan || referencePhoto.isUnsolve) && (
              <div className="flex flex-wrap gap-1 mt-1">
                {hasOpenTemuan && (
                  <span className="text-[9px] uppercase tracking-widest text-yellow-300 border border-yellow-500/40 px-1.5 py-0.5 rounded" title="Temuan masih dalam tindak lanjut">Temuan Open</span>
                )}
                {referencePhoto.isUnsolve && (
                  <span className="text-[9px] uppercase tracking-widest text-orange-300 border border-orange-500/40 px-1.5 py-0.5 rounded" title="Foto acuan diperbarui dari temuan Unsolve">Acuan Unsolve</span>
                )}
              </div>
            )}
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {renderReferencePhotoButton(item, referencePhoto)}
            {hasNfc ? (
              <span className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border text-[10px] font-bold uppercase tracking-wider ${isCheckpointLocked ? 'border-slate-800 text-slate-500' : 'border-cyan-600/50 bg-cyan-500/10 text-cyan-200'}`}>
                <Nfc className="w-3.5 h-3.5" /> Tap NFC
              </span>
            ) : (
              <span className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border text-[10px] font-bold uppercase tracking-wider ${isCheckpointLocked ? 'border-slate-800 text-slate-500' : 'border-amber-600/40 text-amber-300'}`}>
                <ShieldAlert className="w-3.5 h-3.5" /> Tanpa NFC
              </span>
            )}
          </div>
        </div>
      </div>
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
        onClick={() => handleOpenPatrolResult(item)}
        className={`p-3 border rounded-xl flex items-center justify-between cursor-pointer hover:shadow-lg transition-all ${meta.itemClass}`}
      >
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-0.5">
            <p className={`font-bold ${meta.itemTextClass}`}>{item.name}</p>
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
        </div>
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
      </div>
    );
  }, [displayShiftTime, handleOpenPatrolResult, renderReferencePhotoButton, setPreviewPhoto]);

  const renderInfoContent = () => (
    <HistoryDetailView
      isInline={true}
      entryData={infoEntryData}
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
      {showShiftStatusModal && <ShiftStatusModal />}

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
                    <p className="text-[10px] font-bold uppercase tracking-widest text-amber-300">Status Shift Wajib Diisi</p>
                    <p className="mt-2 text-sm text-amber-100">
                      Checklist patroli masih terkunci sampai status petugas shift ini disimpan.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={openShiftStatusModal}
                    className="shrink-0 rounded-xl border border-amber-400/40 bg-amber-500/15 px-3 py-2 text-[11px] font-bold uppercase tracking-widest text-amber-100 transition hover:bg-amber-500/25"
                  >
                    Isi Status
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
                    return (
                      <div key={group.item.id} className="p-2 rounded-2xl border border-cyan-900/60 bg-[#0b1229]/40 space-y-2">
                        {renderPatrolListItem(group.item)}
                        <CheckpointGroupToggle
                          expanded={expanded}
                          onToggle={() => patrolCollapse.toggle(mainId)}
                          subCount={group.subs.length}
                          controlsId={listId}
                          summary={`${doneSubs}/${group.subs.length} selesai`}
                          summaryTone={doneSubs === group.subs.length ? 'good' : 'muted'}
                        />
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
           temuanState={getTemuanStateForItem(nfcSelection.item)}
           parentName={nfcSelection.definition?.type === 'sub' ? definitionById.get(nfcSelection.definition.parentId)?.name : ''}
           onChoose={handleNfcChoice}
           onClose={() => setNfcSelection(null)}
           onPreviewPhoto={(url) => setPreviewPhoto({ url, author: `Foto acuan · ${nfcSelection.item.name}` })}
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
