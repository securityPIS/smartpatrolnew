import React from 'react';
import { useIncidents, useShips } from '../context/AppContextRuntime';
import { AlertOctagon, PlusCircle, User, Search, Ship, CalendarDays, Filter, FilterX } from 'lucide-react';
import AsyncImage from '../components/AsyncImage';

import IncidentDetailView from '../components/views/IncidentDetailView';
import IncidentFormView from '../components/views/IncidentFormView';

function getIncidentStatus(incident, incidentMeta) {
  const metaStatus = incidentMeta[incident?.id]?.status;
  if (metaStatus) return metaStatus;
  if (incident?.isSOS) return incident.sosStatus === 'resolved' ? 'closed' : 'open';
  return 'open';
}

const IncidentsPage = React.memo(function IncidentsPage() {
  const { visibleIncidents, openIncidentModal, closeIncidentModal, setSelectedIncident, incidentMeta, selectedIncident, showIncidentModal } = useIncidents();
  const { operationalShipName } = useShips();
  const [statusFilter, setStatusFilter] = React.useState('open');
  const [showFilters, setShowFilters] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState('');
  const [shipFilter, setShipFilter] = React.useState('');
  const [startDateFilter, setStartDateFilter] = React.useState('');
  const [endDateFilter, setEndDateFilter] = React.useState('');

  const showRightPane = (selectedIncident && !selectedIncident.isPatrol) || showIncidentModal;
  const handleIncidentSelect = (incident) => {
    if (showIncidentModal) {
      closeIncidentModal();
    }
    setSelectedIncident(incident);
  };
  const incidentGroups = React.useMemo(() => {
    const open = [];
    const closed = [];

    visibleIncidents.forEach((incident) => {
      const status = getIncidentStatus(incident, incidentMeta);
      if (status === 'closed') {
        closed.push(incident);
        return;
      }

      open.push(incident);
    });

    return { open, closed };
  }, [incidentMeta, visibleIncidents]);
  const shipOptions = React.useMemo(() => (
    Array.from(new Set(visibleIncidents.map(incident => incident.shipName).filter(Boolean))).sort((left, right) => left.localeCompare(right))
  ), [visibleIncidents]);
  const filteredIncidentPool = React.useMemo(() => {
    const lookup = searchQuery.trim().toLowerCase();

    return visibleIncidents.filter((incident) => {
      const incidentDateKey = String(incident.createdAt || '').slice(0, 10) || '';
      const incidentShip = incident.shipName || operationalShipName || '';
      const searchableText = [
        incident.location,
        incident.deskripsi,
        incident.reportedBy,
        incidentShip,
      ].join(' ').toLowerCase();

      if (lookup && !searchableText.includes(lookup)) return false;
      if (shipFilter && incidentShip !== shipFilter) return false;
      if (startDateFilter && incidentDateKey && incidentDateKey < startDateFilter) return false;
      if (endDateFilter && incidentDateKey && incidentDateKey > endDateFilter) return false;
      return true;
    });
  }, [endDateFilter, operationalShipName, searchQuery, shipFilter, startDateFilter, visibleIncidents]);
  const hasActiveFilter = Boolean(searchQuery || shipFilter || startDateFilter || endDateFilter);
  const filteredIncidentIds = React.useMemo(() => new Set(filteredIncidentPool.map(incident => incident.id)), [filteredIncidentPool]);
  const filteredIncidents = React.useMemo(() => {
    const source = statusFilter === 'closed' ? incidentGroups.closed : incidentGroups.open;
    return source.filter(incident => filteredIncidentIds.has(incident.id));
  }, [filteredIncidentIds, incidentGroups.closed, incidentGroups.open, statusFilter]);

  React.useEffect(() => {
    if (!selectedIncident) return;
    if (selectedIncident.isSOS) return;
    if (visibleIncidents.some((incident) => incident.id === selectedIncident.id)) return;
    setSelectedIncident(null);
  }, [selectedIncident, setSelectedIncident, visibleIncidents]);

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left Pane: List */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 animate-in fade-in scrollbar-thin scrollbar-thumb-cyan-900/50">
        <div className="flex justify-between items-center mb-2">
           <h2 className="text-xl font-bold text-yellow-400 flex items-center gap-2 drop-shadow-[0_0_5px_rgba(250,204,21,0.5)]">
             <AlertOctagon className="w-5 h-5" /> Pelaporan Temuan
           </h2>
           <div className="flex items-center gap-2">
             <button
               type="button"
               onClick={() => setShowFilters(previousValue => !previousValue)}
               className={`px-3 py-1.5 rounded-lg border text-xs font-bold flex items-center gap-1 transition-all active:scale-95 ${
                 showFilters || hasActiveFilter
                   ? 'bg-cyan-500/10 text-cyan-200 border-cyan-400/50'
                   : 'bg-cyan-900/20 text-cyan-400 border-cyan-800/60 hover:bg-cyan-900/30'
               }`}
             >
               <Filter className="w-3.5 h-3.5" /> Filter
             </button>
             <button onClick={openIncidentModal} className="px-3 py-1.5 bg-yellow-500/20 text-yellow-400 border border-yellow-500/50 text-xs font-bold rounded-lg flex items-center gap-1 shadow-[0_0_10px_rgba(250,204,21,0.2)] hover:bg-yellow-500/30 transition-all active:scale-95">
               <PlusCircle className="w-3.5 h-3.5" /> Lapor Baru
             </button>
           </div>
        </div>
        <div className="flex items-center gap-2 rounded-2xl border border-cyan-900/50 bg-[#0b1229] p-1.5">
          <button
            type="button"
            onClick={() => setStatusFilter('open')}
            className={`flex-1 rounded-xl px-3 py-2 text-left transition-all ${statusFilter === 'open' ? 'bg-yellow-500/10 text-yellow-300 border border-yellow-500/40' : 'border border-transparent text-cyan-500 hover:text-cyan-300'}`}
          >
            <div className="flex items-center justify-between gap-3">
              <p className="text-[10px] font-black uppercase tracking-widest">Open</p>
              <p className="text-sm font-black">{incidentGroups.open.length}</p>
            </div>
          </button>
          <button
            type="button"
            onClick={() => setStatusFilter('closed')}
            className={`flex-1 rounded-xl px-3 py-2 text-left transition-all ${statusFilter === 'closed' ? 'bg-slate-800/80 text-slate-200 border border-slate-600' : 'border border-transparent text-cyan-500 hover:text-cyan-300'}`}
          >
            <div className="flex items-center justify-between gap-3">
              <p className="text-[10px] font-black uppercase tracking-widest">Closed</p>
              <p className="text-sm font-black">{incidentGroups.closed.length}</p>
            </div>
          </button>
        </div>

        {showFilters && (
          <div className="bg-[#0b1229] border border-cyan-800/50 rounded-2xl p-4 space-y-3">
            <div className="relative">
              <input
                type="text"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Cari lokasi, kapal, pelapor, atau deskripsi..."
                className="w-full bg-[#070b19] border border-cyan-800/50 rounded-xl py-3 pl-10 pr-4 text-sm text-cyan-50 focus:border-cyan-400 outline-none"
              />
              <Search className="w-4 h-4 text-cyan-500 absolute left-3 top-1/2 -translate-y-1/2" />
            </div>

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
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] text-cyan-500 font-bold uppercase tracking-widest mb-1.5 block">Dari Tanggal</label>
                  <div className="relative">
                    <input type="date" value={startDateFilter} onChange={(event) => setStartDateFilter(event.target.value)} className="w-full bg-[#070b19] border border-cyan-800/50 rounded-xl p-3 pl-10 text-sm text-cyan-50 focus:border-cyan-400 outline-none" />
                    <CalendarDays className="w-4 h-4 text-cyan-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  </div>
                </div>
                <div>
                  <label className="text-[10px] text-cyan-500 font-bold uppercase tracking-widest mb-1.5 block">Sampai Tanggal</label>
                  <div className="relative">
                    <input type="date" value={endDateFilter} onChange={(event) => setEndDateFilter(event.target.value)} className="w-full bg-[#070b19] border border-cyan-800/50 rounded-xl p-3 pl-10 text-sm text-cyan-50 focus:border-cyan-400 outline-none" />
                    <CalendarDays className="w-4 h-4 text-cyan-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  </div>
                </div>
              </div>
            </div>

            {hasActiveFilter && (
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery('');
                    setShipFilter('');
                    setStartDateFilter('');
                    setEndDateFilter('');
                  }}
                  className="px-4 py-2 rounded-xl border border-cyan-700/60 text-cyan-300 hover:bg-cyan-900/30 transition-colors flex items-center justify-center gap-2 text-xs font-bold uppercase tracking-widest"
                >
                  <FilterX className="w-4 h-4" />
                  Reset
                </button>
              </div>
            )}
          </div>
        )}
        
         {filteredIncidents.length === 0 ? (
            <div className="p-8 text-center border border-dashed border-cyan-900/50 rounded-xl">
              <AlertOctagon className="w-10 h-10 text-cyan-900 mx-auto mb-2" />
              <p className="text-cyan-600 text-sm font-bold uppercase tracking-widest">
                {hasActiveFilter ? 'Temuan Tidak Ditemukan' : (statusFilter === 'closed' ? 'Belum Ada Temuan Closed' : 'Belum Ada Temuan Open')}
              </p>
            </div>
         ) : (
            <div className="space-y-3">
              {filteredIncidents.map(inc => {
                 const isClosed = getIncidentStatus(inc, incidentMeta) === 'closed';
                 const isSelected = selectedIncident?.id === inc.id;
                 const isManualIncident = !inc.isSOS && !inc.isPatrol;
                 const accentClass = inc.isSOS ? 'bg-rose-500' : (inc.isPatrol ? 'bg-yellow-500' : 'bg-fuchsia-500');
                 const badgeClass = inc.isSOS
                   ? (isClosed ? 'border-rose-700 text-rose-300 bg-rose-950/40' : 'border-rose-500 text-rose-300 bg-rose-500/10')
                   : (isClosed ? 'border-slate-600 text-slate-400 bg-slate-800/50' : (isManualIncident ? 'border-fuchsia-500 text-fuchsia-300 bg-fuchsia-500/10' : 'border-yellow-500 text-yellow-300 bg-yellow-500/10'));
                 const cardClass = isSelected
                   ? (inc.isSOS ? 'border-rose-500 bg-rose-500/10 shadow-[0_0_15px_rgba(244,63,94,0.12)]' : (isManualIncident ? 'border-fuchsia-500 bg-fuchsia-500/10 shadow-[0_0_15px_rgba(217,70,239,0.12)]' : 'border-yellow-500 bg-yellow-500/10 shadow-[0_0_15px_rgba(250,204,21,0.1)]'))
                   : (isClosed ? (inc.isSOS ? 'bg-rose-950/20 border-rose-950/40' : 'bg-slate-900/40 border-slate-800') : (inc.isSOS ? 'bg-rose-950/10 border-rose-900/40 hover:border-rose-500/50' : (isManualIncident ? 'bg-fuchsia-950/10 border-fuchsia-900/40 hover:border-fuchsia-500/50' : 'bg-yellow-950/10 border-yellow-900/40 hover:border-yellow-500/50')));
                 const titleClass = isClosed
                   ? (inc.isSOS ? 'text-rose-300' : 'text-slate-400')
                   : (inc.isSOS ? 'text-rose-300' : (isSelected ? 'text-white' : (isManualIncident ? 'text-fuchsia-300' : 'text-yellow-300')));
                 const descriptionClass = isClosed
                   ? (inc.isSOS ? 'text-rose-100/70' : 'text-slate-500')
                   : (inc.isSOS ? 'text-rose-100/80' : (isManualIncident ? 'text-fuchsia-100/75' : 'text-yellow-100/75'));
                 
                 return (
                <div 
                  key={inc.id} 
                  onClick={() => handleIncidentSelect(inc)}
                  className={`p-4 border rounded-xl transition-all cursor-pointer group relative overflow-hidden flex gap-3 ${cardClass}`}
                >
                   <div className={`absolute left-0 top-0 bottom-0 w-1 ${isClosed && !inc.isSOS ? 'bg-slate-700' : accentClass}`}></div>
                   <div className="flex-1 ml-1 min-w-0 flex flex-col justify-between">
                      <div>
                         <div className="flex items-center gap-2 mb-2">
                           <h3 className={`font-bold text-lg leading-tight truncate ${titleClass}`}>{inc.location}</h3>
                           {isClosed ? (
                              <span className={`shrink-0 text-[8px] px-1.5 py-0.5 border rounded uppercase font-black tracking-widest ${badgeClass}`}>{inc.isSOS ? 'RESOLVED' : 'CLOSED'}</span>
                           ) : (
                              <span className={`shrink-0 text-[8px] px-1.5 py-0.5 border rounded uppercase font-black tracking-widest ${badgeClass} ${inc.isSOS ? '' : 'animate-pulse'}`}>{inc.isSOS ? 'SOS' : 'OPEN'}</span>
                           )}
                         </div>
                         <p className="text-[10px] uppercase tracking-widest font-bold text-cyan-600 mb-2">{inc.shipName || operationalShipName}</p>
                         <p className={`text-xs ${descriptionClass} incident-desc line-clamp-2 leading-relaxed mb-3`}>"{inc.deskripsi}"</p>
                      </div>
                      <div className={`mt-auto flex items-center gap-1.5 text-[10px] uppercase tracking-widest font-bold ${isClosed && !inc.isSOS ? 'text-slate-600' : 'text-cyan-600'}`}>
                         <User className="w-3 h-3 shrink-0"/> <span className="truncate">oleh <span className={isClosed && !inc.isSOS ? 'text-slate-500' : (inc.isSOS ? 'text-rose-300' : 'text-cyan-400')}>{inc.reportedBy}</span></span>
                      </div>
                   </div>
                   <div className="flex flex-col items-end justify-between shrink-0 gap-2">
                      {inc.photoUrl ? (
                         <div className={`w-20 h-20 rounded-lg overflow-hidden border shadow-sm ${isSelected ? (inc.isSOS ? 'border-rose-400' : (isManualIncident ? 'border-fuchsia-400' : 'border-yellow-400')) : (isClosed ? (inc.isSOS ? 'border-rose-900/40' : 'border-slate-700') : (inc.isSOS ? 'border-rose-700/50' : (isManualIncident ? 'border-fuchsia-700/50' : 'border-yellow-700/50')))}`}>
                            <AsyncImage src={inc.thumbUrl} fallbackSrc={inc.photoUrl} className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity" alt="Thumb"/>
                         </div>
                      ) : (
                         <div className="w-20 h-20"></div>
                      )}
                      <span className="shrink-0 whitespace-nowrap text-[9px] text-cyan-500 font-mono bg-[#070b19] px-2 py-1 rounded border border-cyan-900 inline-block mt-auto uppercase tracking-tighter">{inc.date} | {inc.time}</span>
                   </div>
                </div>
                );
              })}
            </div>
         )}
      </div>

      {/* Right Pane: Detail or Form */}
      <div className="hidden lg:block flex-1 border-l border-cyan-900/50 bg-[#070b19] shrink-0 overflow-hidden relative">
         {showIncidentModal && <IncidentFormView isInline={true} />}
         {(!showIncidentModal && selectedIncident) && <IncidentDetailView isInline={true} />}
         
         {!showRightPane && (
            <div className="h-full flex flex-col items-center justify-center p-8 text-center text-cyan-800">
               <div className="w-16 h-16 rounded-full bg-cyan-900/20 flex items-center justify-center mb-4">
                  <AlertOctagon className="w-8 h-8 opacity-20" />
               </div>
               <p className="text-sm font-bold uppercase tracking-widest mb-1">Detail Temuan</p>
               <p className="text-xs opacity-60">Pilih laporan temuan di sebelah kiri untuk melihat detail perkembangan, kronologi 5W1H, dan tindak lanjut.</p>
            </div>
         )}
      </div>
    </div>
  );
});


export default IncidentsPage;
