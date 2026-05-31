/*
Tujuan: Menampilkan riwayat patroli dan shift aktif agar admin bisa memonitor progres secara cepat.
Caller: App shell saat user membuka halaman riwayat.
Dependensi: History context, reports context, incidents context, dan HistoryDetailView.
Main Functions: Menyaring daftar riwayat, menonjolkan entry ON GOING, dan membuka detail ringkasan patroli.
Side Effects: Mengubah selected history, membuka detail laporan/temuan, dan menghapus riwayat arsip bila diizinkan.
*/

import React, { useEffect, useMemo, useState } from 'react';
import { useHistory, useIncidents, useReports, useRole } from '../context/AppContextRuntime';
import { FileText, CalendarDays, Clock, CheckCircle2, AlertTriangle, CircleOff, Check, Trash2, ArrowLeft, Ship, Filter, FilterX, CheckSquare, Square, ChevronRight, ChevronDown } from 'lucide-react';
import HistoryDetailView from '../components/views/HistoryDetailView';
import ReportDetailView from '../components/views/ReportDetailView';
import IncidentDetailView from '../components/views/IncidentDetailView';
import AsyncImage from '../components/AsyncImage';

// Helper murni: jumlahkan agregat stats (aman/temuan/missed) lintas history entries.
function sumSummaries(entries) {
  return (entries || []).reduce(
    (acc, entry) => {
      const s = entry?.summary || {};
      acc.aman += Number(s.aman) || 0;
      acc.temuan += Number(s.temuan) || Number(entry?.issue) || 0;
      acc.missed += Number(s.missed) || Number(entry?.missed) || 0;
      return acc;
    },
    { aman: 0, temuan: 0, missed: 0 },
  );
}

// Fallback label tanggal: pakai `entry.date` yang sudah ter-format Indo, atau parse `dateKey`.
function deriveDateLabel(dateKey, sampleEntry) {
  if (sampleEntry?.date) return sampleEntry.date;
  if (!dateKey || dateKey === '__unknown__') return 'Tanggal Tidak Diketahui';
  try {
    const parsed = new Date(`${dateKey}T00:00:00`);
    if (Number.isFinite(parsed.getTime())) {
      return parsed.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
    }
  } catch {
    /* fallthrough */
  }
  return dateKey;
}

const UNKNOWN_DATE_KEY = '__unknown__';
const UNKNOWN_SHIP_NAME = 'Tanpa Kapal';

// Strip status sejajar: 3 sel fixed-width (ikon + angka tabular-nums) supaya kolom rapi lintas baris.
function StatStrip({ summary, compact = false }) {
  const aman = summary?.aman || 0;
  const temuan = summary?.temuan || 0;
  const missed = summary?.missed || 0;
  const cellClass = compact
    ? 'w-12 flex items-center justify-end gap-1.5 tabular-nums text-sm font-semibold'
    : 'w-14 flex items-center justify-end gap-1.5 tabular-nums text-base font-bold';
  const iconSize = compact ? 'w-4 h-4' : 'w-5 h-5';
  return (
    <div className="flex items-center gap-3 shrink-0">
      <span className={`${cellClass} text-emerald-300`} title={`${aman} aman`}>
        <CheckCircle2 className={`${iconSize} text-emerald-400`} />{aman}
      </span>
      <span className={`${cellClass} ${temuan > 0 ? 'text-yellow-300' : 'text-cyan-700'}`} title={`${temuan} temuan`}>
        <AlertTriangle className={`${iconSize} ${temuan > 0 ? 'text-yellow-400' : 'text-cyan-700'}`} />{temuan}
      </span>
      <span className={`${cellClass} ${missed > 0 ? 'text-rose-300' : 'text-cyan-700'}`} title={`${missed} missed`}>
        <CircleOff className={`${iconSize} ${missed > 0 ? 'text-rose-400' : 'text-cyan-700'}`} />{missed}
      </span>
    </div>
  );
}

export default function HistoryPage() {
  const { historyEntries, closeHistoryEntry, handleDeleteHistoryEntry, handleDeleteHistoryEntriesBulk, selectedHistoryEntry, setSelectedHistoryId, handleOpenPatrolResult } = useHistory();
  const { isAdmin } = useRole();
  const { selectedReportDetail, setSelectedReportDetail, setPreviewPhoto } = useReports();
  const { selectedIncident, setSelectedIncident } = useIncidents();
  const [summaryDetailType, setSummaryDetailType] = useState(null);
  const [showFilters, setShowFilters] = useState(false);
  const [shipFilter, setShipFilter] = useState('');
  const [shiftFilter, setShiftFilter] = useState('');
  const [startDateFilter, setStartDateFilter] = useState('');
  const [endDateFilter, setEndDateFilter] = useState('');
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIdsForBulk, setSelectedIdsForBulk] = useState(() => new Set());
  const [expandedDateKeys, setExpandedDateKeys] = useState(() => new Set());
  const [expandedShipKeys, setExpandedShipKeys] = useState(() => new Set());
  const [activeTab, setActiveTab] = useState('ongoing'); // 'ongoing' | 'history'

  const shipOptions = useMemo(() => (
    Array.from(new Set(historyEntries.map(entry => entry.ship).filter(Boolean))).sort((left, right) => left.localeCompare(right))
  ), [historyEntries]);
  const shiftOptions = useMemo(() => (
    Array.from(
      new Set(
        historyEntries
          .map(entry => entry.shift)
          .filter(Boolean)
      )
    ).sort((left, right) => left.localeCompare(right))
  ), [historyEntries]);

  const filteredHistoryEntries = useMemo(() => historyEntries.filter((entry) => {
    const entryDateKey = String(entry.dateKey || '');
    if (shipFilter && entry.ship !== shipFilter) return false;
    if (shiftFilter && entry.shift !== shiftFilter) return false;
    if (startDateFilter && entryDateKey && entryDateKey < startDateFilter) return false;
    if (endDateFilter && entryDateKey && entryDateKey > endDateFilter) return false;
    return true;
  }), [endDateFilter, historyEntries, shipFilter, shiftFilter, startDateFilter]);

  const hasActiveFilter = Boolean(shipFilter || shiftFilter || startDateFilter || endDateFilter);
  const showMobileDetail = Boolean(selectedHistoryEntry) && !selectMode;

  const selectableHistoryEntries = useMemo(() => (
    filteredHistoryEntries.filter(entry => !entry.isLive)
  ), [filteredHistoryEntries]);

  // Pisahkan entry ON GOING (tidak di-grouping) dan build struktur date -> ship -> entries[] untuk arsip.
  const { liveEntries, dateGroups } = useMemo(() => {
    const live = [];
    const buckets = new Map(); // dateKey -> Map<ship, Entry[]>
    for (const entry of filteredHistoryEntries) {
      if (entry?.isLive) { live.push(entry); continue; }
      const dk = entry?.dateKey || UNKNOWN_DATE_KEY;
      if (!buckets.has(dk)) buckets.set(dk, new Map());
      const shipsMap = buckets.get(dk);
      const shipName = entry?.ship || UNKNOWN_SHIP_NAME;
      if (!shipsMap.has(shipName)) shipsMap.set(shipName, []);
      shipsMap.get(shipName).push(entry);
    }
    const groups = Array.from(buckets.entries())
      .sort(([a], [b]) => {
        if (a === UNKNOWN_DATE_KEY) return 1;
        if (b === UNKNOWN_DATE_KEY) return -1;
        return b.localeCompare(a); // descending by YYYY-MM-DD
      })
      .map(([dateKey, shipsMap]) => {
        const ships = Array.from(shipsMap.entries())
          .sort(([a], [b]) => a.localeCompare(b)) // ship ascending
          .map(([shipName, rows]) => {
            const sortedRows = rows.slice().sort((x, y) => (
              (x.time || '').localeCompare(y.time || '')
              || new Date(y.createdAt || 0).getTime() - new Date(x.createdAt || 0).getTime()
            ));
            return {
              ship: shipName,
              dateKey,
              shipKey: `${dateKey}::${shipName}`,
              dateLabel: deriveDateLabel(dateKey, sortedRows[0]),
              rows: sortedRows,
              summary: sumSummaries(sortedRows),
            };
          });
        return {
          dateKey,
          dateLabel: deriveDateLabel(dateKey, ships[0]?.rows[0]),
          ships,
          summary: sumSummaries(ships.flatMap(s => s.rows)),
        };
      });
    return { liveEntries: live, dateGroups: groups };
  }, [filteredHistoryEntries]);

  const allSelectableSelected = selectableHistoryEntries.length > 0
    && selectableHistoryEntries.every(entry => selectedIdsForBulk.has(entry.id));
  const selectedBulkCount = selectedIdsForBulk.size;

  const clearBulkSelection = () => {
    setSelectedIdsForBulk(new Set());
  };

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelectedIdsForBulk(new Set());
  };

  const toggleEntrySelected = (id) => {
    setSelectedIdsForBulk((previousSet) => {
      const nextSet = new Set(previousSet);
      if (nextSet.has(id)) nextSet.delete(id);
      else nextSet.add(id);
      return nextSet;
    });
  };

  const handleToggleSelectAllBulk = () => {
    setSelectedIdsForBulk((previousSet) => {
      const everySelected = selectableHistoryEntries.length > 0
        && selectableHistoryEntries.every(entry => previousSet.has(entry.id));
      if (everySelected) return new Set();
      return new Set(selectableHistoryEntries.map(entry => entry.id));
    });
  };

  const handleConfirmBulkDelete = () => {
    if (selectedBulkCount === 0) return;
    handleDeleteHistoryEntriesBulk(Array.from(selectedIdsForBulk), {
      onAfterDelete: () => {
        setSelectedIdsForBulk(new Set());
        setSelectMode(false);
      },
    });
  };

  const handleEntryClick = (id) => {
    if (selectMode) {
      const target = filteredHistoryEntries.find(entry => entry.id === id);
      if (target?.isLive) return; // Riwayat live tidak boleh dipilih untuk dihapus.
      toggleEntrySelected(id);
      return;
    }
    setSelectedHistoryId(id);
  };

  const toggleDateExpanded = (dateKey) => {
    setExpandedDateKeys((previousSet) => {
      const nextSet = new Set(previousSet);
      if (nextSet.has(dateKey)) nextSet.delete(dateKey);
      else nextSet.add(dateKey);
      return nextSet;
    });
  };

  const toggleShipExpanded = (shipKey) => {
    setExpandedShipKeys((previousSet) => {
      const nextSet = new Set(previousSet);
      if (nextSet.has(shipKey)) nextSet.delete(shipKey);
      else nextSet.add(shipKey);
      return nextSet;
    });
  };

  // Auto-expand: saat ada filter aktif atau selectMode aktif, buka semua grup yang terlihat
  // supaya admin tidak perlu klik manual setiap kali memperketat filter atau memilih banyak.
  useEffect(() => {
    if (!hasActiveFilter && !selectMode) return;
    const dateKeys = new Set();
    const shipKeys = new Set();
    dateGroups.forEach((group) => {
      dateKeys.add(group.dateKey);
      group.ships.forEach((ship) => shipKeys.add(ship.shipKey));
    });
    setExpandedDateKeys((previous) => {
      let changed = previous.size !== dateKeys.size;
      if (!changed) { for (const k of dateKeys) if (!previous.has(k)) { changed = true; break; } }
      return changed ? new Set([...previous, ...dateKeys]) : previous;
    });
    setExpandedShipKeys((previous) => {
      let changed = false;
      for (const k of shipKeys) if (!previous.has(k)) { changed = true; break; }
      return changed ? new Set([...previous, ...shipKeys]) : previous;
    });
  }, [dateGroups, hasActiveFilter, selectMode]);

  // Auto-expand path saat ada selectedHistoryEntry (mis. user buka detail dari notifikasi).
  useEffect(() => {
    if (!selectedHistoryEntry || selectedHistoryEntry.isLive) return;
    const dk = selectedHistoryEntry.dateKey || UNKNOWN_DATE_KEY;
    const sk = `${dk}::${selectedHistoryEntry.ship || UNKNOWN_SHIP_NAME}`;
    setExpandedDateKeys((previous) => (previous.has(dk) ? previous : new Set([...previous, dk])));
    setExpandedShipKeys((previous) => (previous.has(sk) ? previous : new Set([...previous, sk])));
  }, [selectedHistoryEntry]);

  // Exit select mode otomatis bila user bukan admin lagi (mis. logout).
  useEffect(() => {
    if (isAdmin) return;
    if (!selectMode && selectedIdsForBulk.size === 0) return;
    exitSelectMode();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  // Bersihkan id yang sudah tidak ada di daftar tersaring (mis. terhapus atau filter berubah).
  useEffect(() => {
    if (selectedIdsForBulk.size === 0) return;
    const visibleIds = new Set(filteredHistoryEntries.map(entry => entry.id));
    let changed = false;
    const nextSet = new Set();
    selectedIdsForBulk.forEach((id) => {
      if (visibleIds.has(id)) nextSet.add(id);
      else changed = true;
    });
    if (changed) setSelectedIdsForBulk(nextSet);
  }, [filteredHistoryEntries, selectedIdsForBulk]);

  useEffect(() => {
    setSummaryDetailType(null);
    setSelectedReportDetail(null);
    setSelectedIncident(null);
  }, [selectedHistoryEntry?.id, setSelectedIncident, setSelectedReportDetail]);

  useEffect(() => {
    if (!selectedHistoryEntry?.id) return;
    if (filteredHistoryEntries.some(entry => entry.id === selectedHistoryEntry.id)) return;
    setSelectedHistoryId(null);
  }, [filteredHistoryEntries, selectedHistoryEntry?.id, setSelectedHistoryId]);

  const summaryDetailItems = useMemo(() => {
    if (!selectedHistoryEntry || !summaryDetailType) return [];
    return (selectedHistoryEntry.checkpoints || []).filter((item) => {
      if (summaryDetailType === 'missed') return item.status === 'missed' || item.resultType === 'missed';
      return item.status === 'completed' && item.resultType === summaryDetailType;
    });
  }, [selectedHistoryEntry, summaryDetailType]);

  const getSummaryMeta = (type) => {
    if (type === 'aman') {
      return {
        title: 'Kondisi Normal',
        itemClass: 'bg-emerald-950/20 border-emerald-500/30',
        itemTextClass: 'text-emerald-400',
        itemIcon: <CheckCircle2 className="w-3 h-3 text-emerald-500" />,
        emptyLabel: 'kondisi normal',
      };
    }
    if (type === 'temuan') {
      return {
        title: 'Kondisi Temuan',
        itemClass: 'bg-yellow-950/20 border-yellow-500/30',
        itemTextClass: 'text-yellow-400',
        itemIcon: <AlertTriangle className="w-3 h-3 text-yellow-500" />,
        emptyLabel: 'temuan',
      };
    }
    return {
      title: 'Status Missed',
      itemClass: 'bg-rose-950/20 border-rose-500/30',
      itemTextClass: 'text-rose-400',
      itemIcon: <CircleOff className="w-3 h-3 text-rose-500" />,
      emptyLabel: 'status missed',
    };
  };

  const handleOpenSummaryDetail = (type) => {
    setSelectedReportDetail(null);
    setSelectedIncident(null);
    setSummaryDetailType(type);
  };

  const handleBackToHistorySummary = () => {
    setSelectedReportDetail(null);
    setSelectedIncident(null);
    setSummaryDetailType(null);
  };

  const renderSummaryListItem = (item) => {
    const isTemuan = item.resultType === 'temuan';
    const isMissed = item.status === 'missed' || item.resultType === 'missed';
    const meta = getSummaryMeta(isMissed ? 'missed' : isTemuan ? 'temuan' : 'aman');

    return (
      <div
        key={`${item.historyId || 'history'}-${item.id}`}
        onClick={() => handleOpenPatrolResult(item)}
        className={`p-3 border rounded-xl flex items-center justify-between cursor-pointer hover:shadow-lg transition-all ${meta.itemClass}`}
      >
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-0.5">
            <p className={`font-bold ${meta.itemTextClass}`}>{item.name}</p>
          </div>
          <div className="flex items-center gap-1.5 text-[11px] text-cyan-200/60 mt-1">
            {meta.itemIcon}
            <span className="truncate">
              {isMissed ? `Tidak dipatroli - ${item.time || '-'}` : `oleh ${item.completedBy?.split(' ')[0] || '-'} - ${item.time || '-'}`}
            </span>
          </div>
        </div>
        <div
          onClick={(event) => {
            if (!item.photoUrl) return;
            event.stopPropagation();
            setPreviewPhoto({ url: item.photoUrl, author: item.completedBy, time: `${selectedHistoryEntry?.date || '-'} ${item.time || '-'}` });
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
  };

  const renderRightPane = () => {
    if (selectedIncident?.readOnly) {
      return (
        <div className="h-full flex flex-col">
          <div className="p-4 border-b border-cyan-900/50 bg-[#0b1229] flex items-center gap-3">
            <button
              type="button"
              onClick={() => setSelectedIncident(null)}
              className="w-10 h-10 rounded-xl border border-cyan-700/60 bg-[#070b19] text-cyan-300 flex items-center justify-center hover:bg-cyan-900/40 transition-colors"
              aria-label="Kembali ke patrol summary"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-cyan-500">Riwayat Shift</p>
              <h3 className="text-lg font-black text-white">Detail Temuan</h3>
            </div>
          </div>
          <div className="flex-1 overflow-hidden">
            <IncidentDetailView isInline={true} />
          </div>
        </div>
      );
    }

    if (selectedReportDetail?.readOnly) {
      return (
        <div className="h-full flex flex-col">
          <div className="p-4 border-b border-cyan-900/50 bg-[#0b1229] flex items-center gap-3">
            <button
              type="button"
              onClick={() => setSelectedReportDetail(null)}
              className="w-10 h-10 rounded-xl border border-cyan-700/60 bg-[#070b19] text-cyan-300 flex items-center justify-center hover:bg-cyan-900/40 transition-colors"
              aria-label="Kembali ke patrol summary"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-cyan-500">Riwayat Shift</p>
              <h3 className="text-lg font-black text-white">Detail Laporan</h3>
            </div>
          </div>
          <div className="flex-1 overflow-hidden">
            <ReportDetailView isInline={true} />
          </div>
        </div>
      );
    }

    if (summaryDetailType) {
      return (
        <div className="h-full flex flex-col">
          <div className="p-4 border-b border-cyan-900/50 bg-[#0b1229] flex items-center gap-3">
            <button
              type="button"
              onClick={handleBackToHistorySummary}
              className="w-10 h-10 rounded-xl border border-cyan-700/60 bg-[#070b19] text-cyan-300 flex items-center justify-center hover:bg-cyan-900/40 transition-colors"
              aria-label="Kembali ke ringkasan riwayat"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-cyan-500">Patrol Summary</p>
              <h3 className="text-lg font-black text-white">{getSummaryMeta(summaryDetailType).title}</h3>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-3 scrollbar-thin scrollbar-thumb-cyan-900/50">
            {summaryDetailItems.length === 0 && (
              <p className="text-xs text-cyan-700 italic border border-dashed border-cyan-900/50 p-4 rounded-xl text-center">
                Belum ada data {getSummaryMeta(summaryDetailType).emptyLabel} untuk riwayat ini.
              </p>
            )}
            {summaryDetailItems.map(renderSummaryListItem)}
          </div>
        </div>
      );
    }

    return (
      <div className="h-full flex flex-col">
        {selectedHistoryEntry && (
          <div className="p-4 border-b border-cyan-900/50 bg-[#0b1229] flex items-center gap-3">
            <button
              type="button"
              onClick={closeHistoryEntry}
              className="w-10 h-10 rounded-xl border border-cyan-700/60 bg-[#070b19] text-cyan-300 flex items-center justify-center hover:bg-cyan-900/40 transition-colors"
              aria-label="Kembali ke daftar riwayat"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-cyan-500">Riwayat Shift</p>
              <h3 className="text-lg font-black text-white">Detail Ringkasan</h3>
            </div>
          </div>
        )}
        <div className="flex-1 overflow-hidden">
          <HistoryDetailView isInline={true} onSummaryCardClick={handleOpenSummaryDetail} />
        </div>
      </div>
    );
  };

  return (
    <div className="flex h-full overflow-hidden animate-in fade-in">
      {/* Left Pane: List */}
      <div className={`flex-1 overflow-y-auto p-4 space-y-4 lg:border-r lg:border-cyan-900/50 ${showMobileDetail ? 'hidden lg:block' : ''}`}>
        <div className="flex items-center justify-between gap-3 mb-2">
          <h2 className="text-xl font-bold text-cyan-50">Laporan</h2>
          {(!isAdmin || activeTab === 'history') && (
            <button
              type="button"
              onClick={() => setShowFilters(previousValue => !previousValue)}
              className={`px-3 py-2 rounded-xl border text-xs font-bold uppercase tracking-widest transition-colors flex items-center gap-2 ${
                showFilters || hasActiveFilter
                  ? 'border-cyan-400/50 bg-cyan-500/10 text-cyan-200'
                  : 'border-cyan-800/60 text-cyan-400 hover:bg-cyan-900/30'
              }`}
            >
              <Filter className="w-4 h-4" />
              Filter
            </button>
          )}
        </div>
        {/* Tab bar — hanya tampil untuk admin yang punya live entries */}
        {isAdmin && (
          <div className="flex rounded-xl overflow-hidden border border-cyan-900/40 bg-[#080d1f]">
            <button
              type="button"
              onClick={() => setActiveTab('ongoing')}
              className={`flex-1 py-2.5 text-sm font-bold flex items-center justify-center gap-2 transition-all border-r border-cyan-900/40 ${
                activeTab === 'ongoing'
                  ? 'bg-emerald-500/15 text-emerald-300 border-r-emerald-500/30'
                  : 'text-cyan-600 hover:text-cyan-400'
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${activeTab === 'ongoing' ? 'bg-emerald-400 animate-pulse' : 'bg-cyan-700'}`} />
              On Going
              {liveEntries.length > 0 && activeTab !== 'ongoing' && (
                <span className="text-[10px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 px-1.5 py-0.5 rounded-full font-black">
                  {liveEntries.length}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('history')}
              className={`flex-1 py-2.5 text-sm font-bold flex items-center justify-center gap-2 transition-all ${
                activeTab === 'history'
                  ? 'bg-cyan-500/15 text-cyan-300'
                  : 'text-cyan-600 hover:text-cyan-400'
              }`}
            >
              <FileText className="w-4 h-4" />
              History
            </button>
          </div>
        )}
        {(!isAdmin || activeTab === 'history') && showFilters && (
          <div className="bg-[#0b1229] border border-cyan-800/50 rounded-xl p-4 space-y-3">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              <div>
                <label className="text-[10px] text-cyan-500 font-bold uppercase tracking-widest mb-1.5 block">Nama Kapal</label>
                <div className="relative">
                  <select value={shipFilter} onChange={(event) => setShipFilter(event.target.value)} className="w-full appearance-none bg-[#070b19] border border-cyan-800/50 rounded-xl p-3 pl-10 text-sm text-cyan-50 focus:border-cyan-400 outline-none">
                    <option value="">Semua Kapal</option>
                    {shipOptions.map((shipName) => (
                      <option key={shipName} value={shipName}>{shipName}</option>
                    ))}
                  </select>
                  <Ship className="w-4 h-4 text-cyan-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                </div>
              </div>
              <div>
                <label className="text-[10px] text-cyan-500 font-bold uppercase tracking-widest mb-1.5 block">Shift</label>
                <div className="relative">
                  <select value={shiftFilter} onChange={(event) => setShiftFilter(event.target.value)} className="w-full appearance-none bg-[#070b19] border border-cyan-800/50 rounded-xl p-3 pl-10 text-sm text-cyan-50 focus:border-cyan-400 outline-none">
                    <option value="">Semua Shift</option>
                    {shiftOptions.map((shiftName) => (
                      <option key={shiftName} value={shiftName}>{shiftName}</option>
                    ))}
                  </select>
                  <Clock className="w-4 h-4 text-cyan-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                </div>
              </div>
              <div>
                <label className="text-[10px] text-cyan-500 font-bold uppercase tracking-widest mb-1.5 block">Dari Tanggal</label>
                <input type="date" value={startDateFilter} onChange={(event) => setStartDateFilter(event.target.value)} className="w-full bg-[#070b19] border border-cyan-800/50 rounded-xl p-3 text-sm text-cyan-50 focus:border-cyan-400 outline-none" />
              </div>
              <div>
                <label className="text-[10px] text-cyan-500 font-bold uppercase tracking-widest mb-1.5 block">Sampai Tanggal</label>
                <input type="date" value={endDateFilter} onChange={(event) => setEndDateFilter(event.target.value)} className="w-full bg-[#070b19] border border-cyan-800/50 rounded-xl p-3 text-sm text-cyan-50 focus:border-cyan-400 outline-none" />
              </div>
              <div className="flex flex-wrap items-end gap-2 lg:col-span-2">
                <button
                  type="button"
                  onClick={() => {
                    setShipFilter('');
                    setShiftFilter('');
                    setStartDateFilter('');
                    setEndDateFilter('');
                    // Reset juga membersihkan penanda riwayat, keluar dari select mode, dan collapse semua grup.
                    exitSelectMode();
                    setExpandedDateKeys(new Set());
                    setExpandedShipKeys(new Set());
                  }}
                  className="w-full sm:w-auto px-4 py-3 rounded-xl border border-cyan-700/60 text-cyan-300 hover:bg-cyan-900/30 transition-colors flex items-center justify-center gap-2 text-xs font-bold uppercase tracking-widest"
                >
                  <FilterX className="w-4 h-4" />
                  Reset
                </button>
                {isAdmin && (
                  selectMode ? (
                    <>
                      <button
                        type="button"
                        onClick={handleToggleSelectAllBulk}
                        disabled={selectableHistoryEntries.length === 0}
                        className="w-full sm:w-auto px-4 py-3 rounded-xl border border-cyan-700/60 text-cyan-200 hover:bg-cyan-900/30 disabled:opacity-50 disabled:hover:bg-transparent transition-colors flex items-center justify-center gap-2 text-xs font-bold uppercase tracking-widest"
                      >
                        {allSelectableSelected ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
                        {allSelectableSelected ? 'Unselect All' : 'Select All'}
                      </button>
                      <button
                        type="button"
                        onClick={handleConfirmBulkDelete}
                        disabled={selectedBulkCount === 0}
                        className="w-full sm:w-auto px-4 py-3 rounded-xl border border-rose-500/40 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20 disabled:opacity-50 disabled:hover:bg-rose-500/10 transition-colors flex items-center justify-center gap-2 text-xs font-bold uppercase tracking-widest"
                      >
                        <Trash2 className="w-4 h-4" />
                        Delete{selectedBulkCount > 0 ? ` (${selectedBulkCount})` : ''}
                      </button>
                      <button
                        type="button"
                        onClick={exitSelectMode}
                        className="w-full sm:w-auto px-4 py-3 rounded-xl border border-cyan-800/60 text-cyan-400 hover:bg-cyan-900/30 transition-colors flex items-center justify-center gap-2 text-xs font-bold uppercase tracking-widest"
                      >
                        Batal
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setSelectMode(true);
                        setSelectedHistoryId(null);
                      }}
                      className="w-full sm:w-auto px-4 py-3 rounded-xl border border-amber-400/50 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20 transition-colors flex items-center justify-center gap-2 text-xs font-bold uppercase tracking-widest"
                    >
                      <CheckSquare className="w-4 h-4" />
                      Select
                    </button>
                  )
                )}
              </div>
            </div>
          </div>
        )}
        {(!isAdmin || activeTab === 'history') && selectMode && (
          <div className="rounded-xl border border-amber-400/40 bg-amber-500/10 px-4 py-2.5 text-[11px] font-bold uppercase tracking-widest text-amber-200 flex flex-wrap items-center justify-between gap-2">
            <span>Mode Pilih Aktif — Klik kartu untuk menandai</span>
            <span className="text-amber-100">{selectedBulkCount} ditandai</span>
          </div>
        )}
        {/* Empty state: tab On Going */}
        {isAdmin && activeTab === 'ongoing' && liveEntries.length === 0 && (
          <div className="p-8 text-center border border-dashed border-emerald-900/50 rounded-xl">
            <CheckCircle2 className="w-10 h-10 text-emerald-900 mx-auto mb-2" />
            <p className="text-cyan-600 text-sm font-bold uppercase tracking-widest">Tidak Ada Patroli Aktif</p>
            <p className="text-xs text-cyan-700 mt-2">Belum ada sesi patroli yang sedang berlangsung saat ini.</p>
          </div>
        )}
        {/* Empty state: tab History */}
        {(!isAdmin || activeTab === 'history') && dateGroups.length === 0 && (
          <div className="p-8 text-center border border-dashed border-cyan-900/50 rounded-xl">
            <FileText className="w-10 h-10 text-cyan-900 mx-auto mb-2" />
            <p className="text-cyan-600 text-sm font-bold uppercase tracking-widest">{hasActiveFilter ? 'Riwayat Tidak Ditemukan' : 'Belum Ada Riwayat Shift'}</p>
            {hasActiveFilter && (
              <p className="text-xs text-cyan-700 mt-2">Ubah filter nama kapal atau rentang tanggal untuk melihat data lain.</p>
            )}
          </div>
        )}
        {/* ON GOING entries: tampil di tab 'ongoing' saja (admin). */}
        {isAdmin && activeTab === 'ongoing' && liveEntries.map((data) => {
          const isSelectedEntry = selectedHistoryEntry?.id === data.id;
          const bulkSelectableLive = selectMode;
          const cardClassName = (isSelectedEntry && !selectMode)
            ? 'border-emerald-400 ring-1 ring-emerald-400/30 shadow-[0_0_18px_rgba(16,185,129,0.18)] bg-emerald-500/10'
            : `border-emerald-700/60 bg-emerald-950/20 ${bulkSelectableLive ? 'opacity-50 cursor-not-allowed' : 'hover:border-emerald-500/60 hover:shadow-[0_0_22px_rgba(16,185,129,0.14)]'}`;
          const summary = data.summary || {};
          const totalCount = summary.total || 0;
          const amanCount = summary.aman || 0;
          const temuanCount = summary.temuan ?? data.issue ?? 0;
          const pendingCount = summary.pending ?? data.pending ?? 0;
          const completionCount = amanCount + temuanCount;
          const completionBoxClassName = isSelectedEntry
            ? 'bg-emerald-400 text-[#052e1d] border-emerald-300'
            : 'bg-emerald-500/10 text-emerald-200 border-emerald-700/60';

          return (
            <div
              key={data.id}
              onClick={() => handleEntryClick(data.id)}
              className={`border rounded-xl p-4 cursor-pointer transition-all ${cardClassName}`}
            >
              <div className="flex justify-between items-start mb-3">
                <div className="flex gap-3 min-w-0">
                  <div className={`w-16 aspect-square rounded-lg flex items-center justify-center border transition-colors shrink-0 ${completionBoxClassName}`}>
                    <p className="text-sm font-black leading-none tabular-nums">{completionCount}/{totalCount}</p>
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="font-bold text-cyan-50">{data.ship}</h3>
                      <span className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-black uppercase tracking-[0.18em] bg-emerald-400/15 text-emerald-200 border border-emerald-400/30">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-300 animate-pulse" />
                        ON GOING
                      </span>
                    </div>
                    <p className="text-sm flex items-center gap-1 mt-0.5 text-emerald-200/80"><CalendarDays className="w-3 h-3" /> {data.date || '-'}</p>
                  </div>
                </div>
                <div className="text-right">
                  <span className="inline-block px-2 py-1 rounded text-xs font-bold bg-emerald-500/10 text-emerald-200 border border-emerald-400/40">{data.shift}</span>
                  <p className="text-[10px] text-cyan-600 mt-1 flex items-center justify-end gap-1"><Clock className="w-3 h-3"/> {data.time}</p>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2 pt-3 border-t border-emerald-900/40">
                <div className="flex-1 p-2 rounded-lg border bg-emerald-950/20 border-emerald-800/30">
                  <p className="text-[10px] text-cyan-600 uppercase font-bold mb-0.5">Aman</p>
                  <p className="text-xs text-emerald-400 font-medium flex items-center gap-1"><CheckCircle2 className="w-3 h-3"/> {amanCount} Aman</p>
                </div>
                <div className="flex-1 p-2 rounded-lg border bg-emerald-950/20 border-emerald-800/30">
                  <p className="text-[10px] text-cyan-600 uppercase font-bold mb-0.5">Temuan</p>
                  {temuanCount > 0 ? <p className="text-xs text-yellow-400 font-medium flex items-center gap-1"><AlertTriangle className="w-3 h-3"/> {temuanCount} Temuan</p> : <p className="text-xs text-cyan-400 font-medium flex items-center gap-1"><Check className="w-3 h-3"/> Nihil</p>}
                </div>
                <div className="flex-1 p-2 rounded-lg border bg-emerald-950/20 border-emerald-800/30">
                  <p className="text-[10px] text-cyan-600 uppercase font-bold mb-0.5">Pending</p>
                  {pendingCount > 0 ? <p className="text-xs text-slate-300 font-medium flex items-center gap-1"><Clock className="w-3 h-3"/> {pendingCount} Titik</p> : <p className="text-xs text-cyan-400 font-medium flex items-center gap-1"><Check className="w-3 h-3"/> Nihil</p>}
                </div>
              </div>
            </div>
          );
        })}

        {/* Riwayat arsip: progressive disclosure — Tanggal → Kapal → Shift entries. Tampil di tab 'history' (atau untuk non-admin). */}
        {(!isAdmin || activeTab === 'history') && dateGroups.length > 0 && (
          <div className="rounded-xl border border-cyan-900/40 bg-[#080d1f] divide-y divide-cyan-900/40 overflow-hidden">
            {dateGroups.map((dateGroup) => {
              const isDateExpanded = expandedDateKeys.has(dateGroup.dateKey);
              const totalShifts = dateGroup.ships.reduce((acc, s) => acc + s.rows.length, 0);
              return (
                <div key={dateGroup.dateKey}>
                  {/* Level 1: Tanggal row */}
                  <button
                    type="button"
                    onClick={() => toggleDateExpanded(dateGroup.dateKey)}
                    className={`w-full flex items-center gap-3 pl-4 pr-4 py-4 text-left transition-colors ${isDateExpanded ? 'bg-cyan-900/15' : 'hover:bg-cyan-900/10'}`}
                    aria-expanded={isDateExpanded}
                  >
                    {isDateExpanded ? <ChevronDown className="w-5 h-5 text-cyan-400 shrink-0" /> : <ChevronRight className="w-5 h-5 text-cyan-500 shrink-0" />}
                    <CalendarDays className="w-5 h-5 text-cyan-400 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-base font-bold text-cyan-50 truncate">{dateGroup.dateLabel}</p>
                      <p className="text-xs text-cyan-500 uppercase tracking-wider font-bold mt-0.5">{totalShifts} shift · {dateGroup.ships.length} kapal</p>
                    </div>
                    <StatStrip summary={dateGroup.summary} />
                  </button>

                  {/* Level 2: Kapal rows (di dalam tanggal yang expanded) */}
                  {isDateExpanded && dateGroup.ships.map((shipGroup) => {
                    const isShipExpanded = expandedShipKeys.has(shipGroup.shipKey);
                    const shipMarkedCount = selectMode
                      ? shipGroup.rows.reduce((acc, r) => acc + (selectedIdsForBulk.has(r.id) ? 1 : 0), 0)
                      : 0;
                    return (
                      <div key={shipGroup.shipKey} className="border-t border-cyan-900/30 bg-[#070b1a]">
                        <button
                          type="button"
                          onClick={() => toggleShipExpanded(shipGroup.shipKey)}
                          className={`w-full flex items-center gap-3 pl-8 pr-4 py-3 text-left transition-colors ${isShipExpanded ? 'bg-cyan-900/10' : 'hover:bg-cyan-900/10'}`}
                          aria-expanded={isShipExpanded}
                        >
                          {isShipExpanded ? <ChevronDown className="w-4 h-4 text-cyan-400 shrink-0" /> : <ChevronRight className="w-4 h-4 text-cyan-500 shrink-0" />}
                          <Ship className="w-4 h-4 text-cyan-400 shrink-0" />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-bold text-cyan-100 truncate">{shipGroup.ship}</p>
                            <p className="text-xs text-cyan-500 truncate mt-0.5">{shipGroup.dateLabel} · {shipGroup.rows.length} shift{selectMode && shipMarkedCount > 0 ? ` · ${shipMarkedCount} ditandai` : ''}</p>
                          </div>
                          <StatStrip summary={shipGroup.summary} compact />
                        </button>

                        {/* Level 3: History entry rows (shift detail) */}
                        {isShipExpanded && shipGroup.rows.map((entry) => {
                          const isSelectedEntry = selectedHistoryEntry?.id === entry.id;
                          const isMarkedForBulk = selectMode && selectedIdsForBulk.has(entry.id);
                          const rowClassName = isMarkedForBulk
                            ? 'border-l-2 border-l-amber-400 bg-amber-500/10'
                            : (isSelectedEntry && !selectMode)
                              ? 'border-l-2 border-l-cyan-400 bg-[#0f1734]'
                              : 'border-l-2 border-l-transparent hover:bg-cyan-900/15';
                          const entrySummary = entry.summary || {};
                          const amanCount = entrySummary.aman || 0;
                          const temuanCount = entrySummary.temuan ?? entry.issue ?? 0;
                          const missedCount = entrySummary.missed ?? entry.missed ?? 0;
                          return (
                            <div
                              key={entry.id}
                              onClick={() => handleEntryClick(entry.id)}
                              className={`flex items-center gap-3 pl-14 pr-4 py-3 cursor-pointer transition-colors border-t border-cyan-900/30 ${rowClassName}`}
                            >
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-bold text-cyan-100 truncate">{entry.shift || 'Shift'}</p>
                                <p className="text-xs text-cyan-500 truncate flex items-center gap-1 mt-0.5"><Clock className="w-3.5 h-3.5"/> {entry.time || '-'}</p>
                              </div>
                              <StatStrip summary={{ aman: amanCount, temuan: temuanCount, missed: missedCount }} compact />
                              {selectMode ? (
                                <span
                                  className={`w-9 h-9 rounded-lg border flex items-center justify-center shrink-0 ${isMarkedForBulk ? 'border-amber-300 bg-amber-300 text-[#3a2a04]' : 'border-amber-400/40 bg-amber-500/10 text-amber-200'}`}
                                  aria-hidden="true"
                                >
                                  {isMarkedForBulk ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
                                </span>
                              ) : isAdmin ? (
                                <button
                                  type="button"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    handleDeleteHistoryEntry(entry.id);
                                  }}
                                  className="w-9 h-9 rounded-lg border border-rose-500/30 text-rose-400 hover:bg-rose-500 hover:text-white transition-colors flex items-center justify-center shrink-0"
                                  aria-label="Hapus riwayat patroli"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              ) : (
                                <ChevronRight className="w-5 h-5 text-cyan-600 shrink-0" />
                              )}
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Right Pane: Detail View */}
      <div className={`${showMobileDetail ? 'block' : 'hidden'} lg:block flex-1 bg-[#070b19] overflow-hidden relative`}>
        {renderRightPane()}
      </div>
    </div>
  );
}
