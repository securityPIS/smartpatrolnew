/*
Tujuan: Menampilkan detail patroli live atau histori beserta roster petugas shift.
Caller: PatrolPage dan HistoryPage saat user membuka detail info patroli.
Dependensi: Patrol context, data kapal/cuaca, AsyncImage, dan TimeAuditSummaryCard.
Main Functions: Merangkum checkpoint, cuaca, roster petugas, dan progres per shift.
Side Effects: Mengarahkan user kembali ke patroli live saat detail dibuka penuh.
*/

import React from 'react';
import { ACCESS_ROLES, useHistory, usePatrol, useShips, useUI, useUsers, useWeather } from '../../context/AppContextRuntime';
import {
  Ship, MapPin, ExternalLink, CalendarDays, Thermometer, Wind, User,
  CheckCircle2, AlertTriangle, CircleOff, Check, ArrowRight, Clock
} from 'lucide-react';
import AsyncImage from '../AsyncImage';
import { TimeAuditSummaryCard } from '../TimeAuditStatus';

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function createGuardNameKey(name) {
  return String(name || '').trim().toLowerCase();
}

function buildGuardScoreMaps(checkpoints = []) {
  return checkpoints.reduce((accumulator, checkpoint) => {
    if (checkpoint.status !== 'completed') return accumulator;

    if (checkpoint.completedByUserId) {
      accumulator.byId.set(
        checkpoint.completedByUserId,
        (accumulator.byId.get(checkpoint.completedByUserId) || 0) + 1,
      );
    }

    const guardNameKey = createGuardNameKey(checkpoint.completedBy);
    if (guardNameKey) {
      accumulator.byName.set(
        guardNameKey,
        (accumulator.byName.get(guardNameKey) || 0) + 1,
      );
    }

    return accumulator;
  }, { byId: new Map(), byName: new Map() });
}

function getCompletionPercentage(summary = {}) {
  const completed = Number(summary.completed) || 0;
  const total = Number(summary.total) || 0;

  if (total <= 0) return 0;

  return Math.round((completed / total) * 100);
}

function getCheckpointSortTimestamp(checkpoint) {
  const timestamp = (
    Number.isFinite(checkpoint?.occurredAtTrustedMs)
      ? checkpoint.occurredAtTrustedMs
      : new Date(
        checkpoint?.occurredAtTrustedIso
        || checkpoint?.completedAt
        || checkpoint?.updatedAt
        || checkpoint?.createdAt
        || 0,
      ).getTime()
  );

  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function getLatestCompletedCheckpoint(checkpoints = []) {
  return checkpoints.reduce((latestCheckpoint, checkpoint) => {
    if (checkpoint?.status !== 'completed') return latestCheckpoint;
    if (!latestCheckpoint) return checkpoint;

    return getCheckpointSortTimestamp(checkpoint) >= getCheckpointSortTimestamp(latestCheckpoint)
      ? checkpoint
      : latestCheckpoint;
  }, null);
}

export default function HistoryDetailView({ isInline = false, entryData = null, onSummaryCardClick = null, hideTimeAudit = false, customTimeBadge = null, crewBadge = null }) {
  const { selectedHistoryEntry } = useHistory();
  const { operationalShip, operationalShipName } = useShips();
  const { weatherInfo, weatherLoading, getWeatherDetail } = useWeather();
  const { checkpoints, setPatrolTab } = usePatrol();
  const { usersData } = useUsers();
  const { setCurrentPage } = useUI();

  const entry = entryData || selectedHistoryEntry;

  if (!entry) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-8 text-center text-cyan-800">
        <div className="w-16 h-16 rounded-full bg-cyan-900/20 flex items-center justify-center mb-4">
          <CalendarDays className="w-8 h-8 opacity-20" />
        </div>
        <h3 className="text-lg font-bold text-cyan-700 mb-2 font-mono uppercase tracking-widest">Detail Riwayat</h3>
        <p className="max-w-xs text-sm">Pilih salah satu jadwal riwayat di sebelah kiri untuk melihat ringkasan hasil patroli.</p>
      </div>
    );
  }

  // Derived values (Logic moved from PatrolPage)
  const checkpointEntries = React.useMemo(
    () => ensureArray(entry?.checkpoints).length > 0 ? ensureArray(entry?.checkpoints) : ensureArray(checkpoints),
    [checkpoints, entry?.checkpoints],
  );
  const safeSummary = React.useMemo(() => {
    const entrySummary = entry?.summary;
    if (entrySummary && typeof entrySummary === 'object') return entrySummary;
    const aman = checkpointEntries.filter((checkpoint) => checkpoint?.status === 'completed' && checkpoint?.resultType === 'aman').length;
    const temuan = checkpointEntries.filter((checkpoint) => checkpoint?.status === 'completed' && checkpoint?.resultType === 'temuan').length;
    const missed = checkpointEntries.filter((checkpoint) => checkpoint?.status === 'missed' || checkpoint?.resultType === 'missed').length;
    const pending = checkpointEntries.filter((checkpoint) => checkpoint?.status === 'pending').length;
    return {
      aman,
      temuan,
      missed,
      pending,
      completed: checkpointEntries.filter((checkpoint) => checkpoint?.status === 'completed').length,
      total: checkpointEntries.length,
    };
  }, [checkpointEntries, entry?.summary]);
  const latestCompletedCheckpoint = React.useMemo(
    () => getLatestCompletedCheckpoint(checkpointEntries),
    [checkpointEntries],
  );
  const displayShip = entry.shipSnapshot || operationalShip;
  const displayShipName = entry.ship || operationalShipName;
  const displayDate = entry.date;
  const displayShiftLabel = entry.shift;
  const displayShiftTime = entry.time;
  const isLiveEntry = Boolean(entry.isLive);
  const displayMapLocation = latestCompletedCheckpoint?.gpsSnapshot
    || latestCompletedCheckpoint?.shipSnapshot
    || displayShip;
  const displayWeather = (
    latestCompletedCheckpoint?.weatherSnapshot
    && typeof latestCompletedCheckpoint.weatherSnapshot === 'object'
  )
    ? latestCompletedCheckpoint.weatherSnapshot
    : (entry?.weatherSnapshot && typeof entry.weatherSnapshot === 'object')
      ? entry.weatherSnapshot
      : (weatherInfo && typeof weatherInfo === 'object' ? weatherInfo : null);
  const displayWeatherLoading = isLiveEntry && !latestCompletedCheckpoint?.weatherSnapshot && !entry.weatherSnapshot && weatherLoading;

  const summaryCards = [
    { type: 'aman', count: safeSummary.aman || 0 },
    { type: 'temuan', count: safeSummary.temuan || entry.issue || 0 },
    isLiveEntry
      ? { type: 'pending', count: safeSummary.pending ?? entry.pending ?? 0 }
      : { type: 'missed', count: safeSummary.missed || entry.missed || 0 },
  ];
  const completionPercentage = getCompletionPercentage(safeSummary);
  const completedAuditRecords = React.useMemo(
    () => checkpointEntries.filter((checkpoint) => checkpoint.status === 'completed'),
    [checkpointEntries],
  );

  const displayCrew = React.useMemo(() => {
    const scoreMaps = buildGuardScoreMaps(checkpointEntries);
    const baseCrew = ensureArray(entry?.crewSnapshot).length > 0
      ? ensureArray(entry?.crewSnapshot)
      : ensureArray(usersData).filter(u => u.shipAssigned === displayShipName && u.status === 'active');

    return baseCrew
      .filter(user => user.role === ACCESS_ROLES.PETUGAS)
      .map((user) => ({
        ...user,
        score: typeof user.score === 'number'
          ? user.score
          : (scoreMaps.byId.get(user.id) || scoreMaps.byName.get(createGuardNameKey(user.name)) || 0),
      }));
  }, [checkpointEntries, displayShipName, entry?.crewSnapshot, usersData]);

  const getSummaryCardMeta = (type) => {
    switch(type) {
      case 'temuan': return { title: 'Temuan / Incident', icon: <AlertTriangle className="w-5 h-5 text-yellow-500"/>, cardClass: 'bg-yellow-950/20 border-yellow-500/30 text-yellow-400', countClass: 'text-yellow-400', labelClass: 'text-yellow-100/70', iconWrapClass: 'bg-yellow-500/10 border-yellow-500/20' };
      case 'missed': return { title: 'Missed Checkpoint', icon: <CircleOff className="w-5 h-5 text-rose-500"/>, cardClass: 'bg-rose-950/20 border-rose-500/30 text-rose-400', countClass: 'text-rose-400', labelClass: 'text-rose-100/70', iconWrapClass: 'bg-rose-500/10 border-rose-500/20' };
      case 'pending': return { title: 'Pending Checkpoint', icon: <Clock className="w-5 h-5 text-slate-400"/>, cardClass: 'summary-card-pending bg-slate-950/20 border-slate-500/30 text-slate-400', countClass: 'text-slate-400', labelClass: 'text-slate-100/70', iconWrapClass: 'bg-slate-500/10 border-slate-500/20' };
      default: return { title: 'Kondisi Aman', icon: <CheckCircle2 className="w-5 h-5 text-emerald-500"/>, cardClass: 'bg-emerald-950/20 border-emerald-500/30 text-emerald-400', countClass: 'text-emerald-400', labelClass: 'text-emerald-100/70', iconWrapClass: 'bg-emerald-500/10 border-emerald-500/20' };
    }
  };

  const handleOpenFullPatrol = () => {
    setCurrentPage('home');
    setPatrolTab('checkpoint');
  };

  return (
    <div className={`flex flex-col h-full bg-[#070b19] overflow-y-auto ${isInline ? '' : 'p-4'}`}>
      <div className="p-6 space-y-6 pt-2">
        <div className="flex justify-between items-start gap-3">
          <div>
            <p className="text-sm text-cyan-400 mb-1 flex items-center gap-1 font-medium"><Ship className="w-4 h-4" /> {isLiveEntry ? 'Info Shift Berjalan' : 'Laporan Riwayat'}</p>
            <h2 className="text-2xl font-bold text-white tracking-wide mb-1">{displayShipName}</h2>
            <div className="text-[11px] text-cyan-200 mt-1 flex items-center gap-2 flex-wrap bg-[#070b19]/50 inline-flex px-2 py-1 rounded-md border border-cyan-900">
              <span className="flex items-center gap-1"><CalendarDays className="w-3 h-3 text-cyan-400" /> {displayDate}</span>
              <span className="text-cyan-700">|</span>
              <span className="flex items-center gap-1 font-bold">{displayShiftLabel} ({displayShiftTime})</span>
            </div>
          </div>
          {!isInline && (
            <button 
              onClick={handleOpenFullPatrol}
              className="flex items-center gap-2 px-3 py-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white text-[11px] font-black uppercase tracking-widest transition-all shadow-lg active:scale-95"
            >
              Buka Patroli <ArrowRight className="w-4 h-4" />
            </button>
          )}
        </div>

        <div className="w-full h-44 rounded-2xl overflow-hidden border border-cyan-800/50 relative shadow-lg">
          <iframe width="100%" height="100%" frameBorder="0" scrolling="no" marginHeight="0" marginWidth="0" src={`https://maps.google.com/maps?q=${displayMapLocation?.lat || '-6.1021'},${displayMapLocation?.lng || '106.8833'}&hl=id&z=14&output=embed`} title="Map Location"></iframe>
        </div>

        <div className="bg-[#0b1229] rounded-2xl p-4 border border-cyan-800/50 flex items-center justify-between relative shadow-sm">
          {displayWeatherLoading ? (
            <p className="text-xs text-cyan-500 animate-pulse w-full text-center">Scanning Atmosphere...</p>
          ) : displayWeather ? (
            <>
              <div className="flex items-center gap-3">
                <div className="p-2 bg-cyan-900/20 rounded-xl">{getWeatherDetail(displayWeather.weathercode).icon}</div>
                <div className="flex flex-col">
                  <span className="text-[10px] text-cyan-500 font-medium uppercase tracking-wider">Kondisi</span>
                  <span className="text-sm font-bold text-cyan-50">{getWeatherDetail(displayWeather.weathercode).text}</span>
                </div>
              </div>
              <div className="flex items-center gap-4">
                <div className="flex flex-col items-end">
                  <span className="text-[10px] text-cyan-500 flex items-center gap-1 uppercase tracking-wider"><Thermometer className="w-3 h-3 text-rose-400" /> Temp</span>
                  <span className="text-sm font-bold text-cyan-50">{displayWeather.temperature}Â°C</span>
                </div>
                <div className="w-px h-6 bg-cyan-800"></div>
                <div className="flex flex-col items-start">
                  <span className="text-[10px] text-cyan-500 flex items-center gap-1 uppercase tracking-wider"><Wind className="w-3 h-3 text-emerald-400" /> Wind</span>
                  <span className="text-sm font-bold text-cyan-50">{displayWeather.windspeed} k/j</span>
                </div>
              </div>
            </>
          ) : (
            <p className="text-xs text-cyan-500 w-full text-center">Data cuaca tidak tersedia.</p>
          )}
        </div>

        {customTimeBadge ? customTimeBadge : (
          !hideTimeAudit && (
            <TimeAuditSummaryCard
              records={completedAuditRecords}
              title="Audit Timestamp Shift"
              fallbackTimestampKeys={['completedAt', 'updatedAt', 'createdAt']}
            />
          )
        )}

        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-[10px] font-bold text-cyan-400 uppercase tracking-widest pl-1">Patrol Summary</h3>
              <p className="text-xs text-cyan-600 mt-1 pl-1">Ringkasan hasil shift ini.</p>
            </div>
            <div className="text-right bg-[#0b1229] px-3 py-2 rounded-xl border border-cyan-800/50 shadow-sm">
              <p className="text-[10px] text-cyan-500 uppercase tracking-widest font-bold">Selesai</p>
              <p className="text-lg font-black text-cyan-50">{completionPercentage}%</p>
              <p className="text-[10px] text-cyan-600">{safeSummary.completed || 0}/{safeSummary.total || 0} titik</p>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3">
            {summaryCards.map((card) => {
              const meta = getSummaryCardMeta(card.type);
              const isClickable = typeof onSummaryCardClick === 'function';
              return (
                <div
                  key={card.type}
                  onClick={isClickable ? () => onSummaryCardClick(card.type) : undefined}
                  className={`border rounded-2xl p-4 shadow-sm transition-all ${meta.cardClass} ${isClickable ? 'cursor-pointer hover:-translate-y-0.5 hover:shadow-lg' : ''}`}
                >
                  <div className="flex items-center gap-4">
                    <p className={`text-3xl font-black min-w-8 ${meta.countClass}`}>{card.count}</p>
                    <p className={`text-sm font-bold flex-1 ${meta.labelClass}`}>{meta.title}</p>
                    <div className={`w-11 h-11 rounded-xl border flex items-center justify-center shrink-0 ${meta.iconWrapClass}`}>
                      {meta.icon}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="space-y-3 pb-8">
          <div className="flex items-center justify-between gap-2 mb-1 pl-1">
            <h3 className="text-[10px] font-bold text-cyan-400 uppercase tracking-widest">Petugas Jaga</h3>
            {crewBadge}
          </div>
          {displayCrew.length === 0 && (
            <p className="text-xs text-cyan-700 italic border border-dashed border-cyan-900/50 p-4 rounded-xl text-center">
              Belum ada data petugas jaga untuk shift ini.
            </p>
          )}
          {displayCrew.map((user) => {
            return (
              <div key={user.id} className="bg-[#0b1229] rounded-2xl p-3 border border-cyan-800/50 flex items-center justify-between shadow-sm">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-[#070b19] border border-cyan-700/50 overflow-hidden shrink-0">
                    {user.photoUrl ? <AsyncImage src={user.photoUrl} alt={user.name} className="w-full h-full object-cover" /> : <div className="w-full h-full flex items-center justify-center text-cyan-500"><User className="w-5 h-5" /></div>}
                  </div>
                  <div>
                    <p className="text-sm font-bold text-cyan-50">{user.name}</p>
                    <p className={`text-[10px] uppercase font-bold tracking-tight ${
                      user.shiftStatus === 'istirahat'
                        ? 'text-amber-300'
                        : user.shiftStatus === 'patroli'
                          ? 'text-emerald-300'
                          : 'text-cyan-500'
                    }`}>
                      {user.role}{user.shiftStatusLabel ? ` - ${user.shiftStatusLabel}` : ''}
                    </p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-lg font-black text-cyan-200">{user.score || 0}</p>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
