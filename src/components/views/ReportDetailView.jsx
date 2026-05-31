import React from 'react';
import { usePatrol, useReports, useWeather } from '../../context/AppContextRuntime';
import { ChevronDown, Trash2, AlertTriangle, CheckCircle2, MapPin, ExternalLink, Thermometer, Wind, Camera, Images, Calendar, User } from 'lucide-react';
import AsyncImage from '../AsyncImage';
import { TimeAuditRecordCard } from '../TimeAuditStatus';

function getReportGalleryItems(reportDetail) {
  const items = [];
  const seenUrls = new Set();

  const pushItem = (item, fallbackId) => {
    const photoUrl = item?.photoUrl;
    if (!photoUrl || seenUrls.has(photoUrl)) return;

    seenUrls.add(photoUrl);
    items.push({
      id: item?.id || fallbackId,
      photoUrl,
      author: item?.author || reportDetail?.completedBy || '-',
      time: item?.time || reportDetail?.time || '-',
      date: item?.date || reportDetail?.date || '',
    });
  };

  pushItem({
    id: `${reportDetail?.id || 'report'}-cover`,
    photoUrl: reportDetail?.photoUrl,
    author: reportDetail?.completedBy,
    time: reportDetail?.time,
    date: reportDetail?.date,
  }, `${reportDetail?.id || 'report'}-cover`);

  (reportDetail?.galleryPhotos || []).forEach((item, index) => {
    pushItem(item, `${reportDetail?.id || 'report'}-gallery-${index}`);
  });

  return items;
}

function normalizeReportCoordinate(value, digits = 6) {
  const numeric = typeof value === 'number'
    ? value
    : Number(String(value ?? '').replace(',', '.'));

  if (!Number.isFinite(numeric)) return null;
  return Number(numeric.toFixed(digits));
}

function normalizeReportCoordinatePair(latValue, lngValue, digits = 6) {
  const lat = normalizeReportCoordinate(latValue, digits);
  const lng = normalizeReportCoordinate(lngValue, digits);
  if (lat == null || lng == null) return null;
  if (Math.abs(lat) < 0.000001 && Math.abs(lng) < 0.000001) return null;
  return { lat, lng };
}

export default function ReportDetailView({ isInline = false }) {
  const { selectedReportDetail, setSelectedReportDetail, setPreviewPhoto } = useReports();
  const { handleDeleteReport, handleAddReportGalleryPhoto } = usePatrol();
  const { getWeatherDetail } = useWeather();

  if (!selectedReportDetail) {
    if (isInline) return (
      <div className="h-full flex flex-col items-center justify-center text-cyan-800 p-8 text-center border-2 border-dashed border-cyan-900/30 rounded-3xl m-4">
        <div className="w-16 h-16 rounded-full bg-cyan-900/20 flex items-center justify-center mb-4">
          <CheckCircle2 className="w-8 h-8 opacity-20" />
        </div>
        <p className="text-sm font-bold uppercase tracking-widest mb-1">Detail Laporan</p>
        <p className="text-xs opacity-60">Pilih salah satu histori laporan untuk melihat detail temuan, bukti visual, dan petugas pelapor.</p>
      </div>
    );
    return null;
  }

  const isMissed = selectedReportDetail.resultType === 'missed' || selectedReportDetail.status === 'missed';
  const isAman = selectedReportDetail.resultType === 'aman';
  const isReadOnly = Boolean(selectedReportDetail.readOnly);
  const headerToneClass = isMissed ? 'bg-rose-500/10 border-rose-500 text-rose-400' : selectedReportDetail.resultType === 'temuan' ? 'bg-yellow-500/10 border-yellow-500 text-yellow-400' : 'bg-emerald-500/10 border-emerald-500 text-emerald-400';
  const gpsSnapshot = selectedReportDetail.gpsSnapshot || null;
  const weatherSnapshot = selectedReportDetail.weatherSnapshot || null;
  const gpsCoordinate = normalizeReportCoordinatePair(gpsSnapshot?.lat, gpsSnapshot?.lng);
  const latitude = gpsCoordinate?.lat ?? null;
  const longitude = gpsCoordinate?.lng ?? null;
  const hasGpsSnapshot = Boolean(gpsCoordinate);
  const mapsQuery = hasGpsSnapshot ? `${latitude},${longitude}` : '';
  const mapsHref = hasGpsSnapshot ? `https://www.google.com/maps?q=${mapsQuery}` : '#';
  const gpsSourceLabel = gpsSnapshot?.source === 'device' ? 'GPS perangkat saat sync' : gpsSnapshot?.source === 'ship' ? 'Koordinat kapal saat sync' : 'Snapshot sync laporan';
  const galleryItems = React.useMemo(() => getReportGalleryItems(selectedReportDetail), [selectedReportDetail]);
  const canUploadGallery = selectedReportDetail.resultType === 'aman' && !isReadOnly;
  const syncDateLabel = selectedReportDetail.date || '-';
  const syncTimeLabel = selectedReportDetail.time || '-';
  const syncDateTimeLabel = `${syncDateLabel} ${syncTimeLabel} WIB`;

  return (
    <div className={`flex flex-col h-full bg-[#070b19] ${isInline ? 'border-l border-cyan-900/50' : 'fixed inset-0 z-[100] sm:max-w-md sm:mx-auto sm:border-x sm:border-cyan-900/50'}`}>
      {selectedReportDetail.photoUrl ? (
        <div className="w-full h-64 bg-[#0b1229] relative shrink-0 cursor-pointer group" onClick={() => setPreviewPhoto({url: selectedReportDetail.photoUrl, author: selectedReportDetail.completedBy, time: syncDateTimeLabel})}>
           <AsyncImage src={selectedReportDetail.heroUrl} fallbackSrc={selectedReportDetail.photoUrl} className="w-full h-full object-cover opacity-90 group-hover:opacity-100 transition-opacity" alt="Bukti" />
           <div className="absolute inset-0 bg-gradient-to-b from-[#070b19]/80 via-transparent to-[#070b19]"></div>
           {!isInline && (
             <button onClick={(e) => { e.stopPropagation(); setSelectedReportDetail(null); }} className="absolute top-4 left-4 p-2 bg-black/50 text-white rounded-full backdrop-blur-md border border-white/20 hover:bg-black/70 transition-colors z-10" aria-label="Tutup laporan"><ChevronDown className="w-6 h-6 rotate-90"/></button>
           )}
           {!isReadOnly && (
             <button onClick={(e) => { e.stopPropagation(); handleDeleteReport(selectedReportDetail.id); }} className="absolute top-4 right-4 p-2 bg-rose-500/80 text-white rounded-full backdrop-blur-md border border-rose-500/50 hover:bg-rose-600 transition-colors z-10" aria-label="Hapus laporan"><Trash2 className="w-5 h-5"/></button>
           )}
           {isAman ? (
             <div className="absolute bottom-4 left-4 z-10">
                <span className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 border border-emerald-500 rounded-lg font-bold bg-emerald-500/15 text-emerald-300 backdrop-blur-md shadow-lg"><CheckCircle2 className="w-3.5 h-3.5" /> Aman</span>
             </div>
           ) : (
             <>
               <div className="absolute bottom-4 right-4 bg-black/70 backdrop-blur-md px-3 py-1.5 rounded-lg text-xs text-white/90 text-right border border-cyan-900/50 z-10 shadow-lg"><p className="font-bold text-cyan-400">{selectedReportDetail.completedBy || '-'}</p><p className="text-[10px] text-cyan-100/70">{syncDateLabel}</p><p className="text-[10px] text-cyan-100/70">{syncTimeLabel} WIB</p></div>
               <div className="absolute bottom-4 left-4 right-36 z-10">
                  <span className={`text-[10px] px-2 py-1 border rounded font-bold mb-2 inline-block shadow-sm ${headerToneClass}`}>{isMissed ? 'MISSED' : selectedReportDetail.resultType === 'temuan' ? 'TEMUAN' : 'AMAN'}</span>
                  <span className="text-[10px] px-2 py-1 ml-2 border border-cyan-500/50 rounded font-bold text-cyan-400 bg-cyan-900/40 inline-block shadow-sm">{isReadOnly ? 'Riwayat Shift' : 'Laporan Titik'}</span>
                  <h2 className="text-2xl font-black text-white drop-shadow-md leading-tight line-clamp-2 mt-1">{selectedReportDetail.name}</h2>
                  <p className="text-[10px] text-cyan-100/80 mt-2 font-semibold tracking-wide">{syncDateTimeLabel}</p>
               </div>
             </>
           )}
        </div>
      ) : (
        <div className="p-4 border-b border-cyan-900/50 flex items-center justify-between gap-3 bg-[#0b1229] shrink-0 shadow-sm">
          <div className="flex items-center gap-3">
            {!isInline && (
              <button onClick={() => setSelectedReportDetail(null)} className="p-2 bg-[#070b19] border border-cyan-800 text-cyan-300 rounded-full hover:bg-cyan-900/50 transition-colors" aria-label="Tutup laporan"><ChevronDown className="w-5 h-5 rotate-90"/></button>
            )}
            <div>
              {isAman ? (
                <span className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 border border-emerald-500 rounded-lg font-bold bg-emerald-500/15 text-emerald-300"><CheckCircle2 className="w-3.5 h-3.5" /> Aman</span>
              ) : (
                <>
                  <span className="text-[10px] text-cyan-500 uppercase tracking-widest font-bold">{isReadOnly ? 'Riwayat Shift' : 'Laporan Titik'}</span>
                  <h3 className="font-bold text-xl text-cyan-50 line-clamp-1">{selectedReportDetail.name}</h3>
                  <p className="text-[10px] text-cyan-400/80 mt-1 font-semibold tracking-wide">{syncDateTimeLabel}</p>
                </>
              )}
            </div>
          </div>
          {!isReadOnly && (
            <button onClick={() => handleDeleteReport(selectedReportDetail.id)} className="p-2 bg-rose-500/10 text-rose-500 border border-rose-500/30 rounded-lg hover:bg-rose-500 hover:text-white transition-colors flex items-center gap-2" aria-label="Hapus laporan"><Trash2 className="w-4 h-4"/></button>
          )}
        </div>
      )}
      {isAman && (
        <div className="px-4 py-4 border-b border-cyan-900/50 bg-[#091022] shrink-0">
          <div className="flex items-center gap-3 overflow-x-auto scrollbar-thin scrollbar-thumb-cyan-900/50">
            {galleryItems.length === 0 ? (
              <div className="w-12 h-12 shrink-0 rounded-xl border border-dashed border-cyan-800/60 bg-[#0b1229] flex items-center justify-center text-cyan-700">
                <Images className="w-4 h-4" />
              </div>
            ) : galleryItems.map((item, index) => (
              <button
                key={item.id || `${item.photoUrl}-${index}`}
                type="button"
                onClick={() => setPreviewPhoto({ url: item.photoUrl, author: item.author, time: item.date ? `${item.date} ${item.time}` : item.time })}
                className="w-12 h-12 shrink-0 rounded-xl overflow-hidden border border-cyan-800/60 bg-[#0b1229] hover:border-cyan-500/60 transition-all group"
                aria-label={`Lihat foto patroli ${index + 1}`}
              >
                <AsyncImage src={item.thumbUrl} fallbackSrc={item.photoUrl} className="w-full h-full object-cover group-hover:scale-[1.04] transition-transform duration-300" alt={`Foto patroli ${index + 1}`} />
              </button>
            ))}
            {canUploadGallery && (
              <button
                type="button"
                onClick={() => handleAddReportGalleryPhoto(selectedReportDetail.id)}
                className="w-12 h-12 shrink-0 rounded-xl border border-dashed border-cyan-500/50 bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/20 hover:border-cyan-400 transition-all flex items-center justify-center"
                aria-label="Upload foto patroli tambahan"
              >
                <Camera className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      )}
      <div className="flex-1 overflow-y-auto p-5 space-y-6">
         {!isAman ? (
           <>
             <div className="grid grid-cols-2 gap-3">
               <div className="bg-[#0b1229] p-4 rounded-xl border border-cyan-900/50 shadow-sm"><p className="text-[10px] text-cyan-600 font-bold uppercase tracking-widest mb-1">{isMissed ? 'Status' : 'Inspektur'}</p><p className="text-sm font-bold text-cyan-50 truncate">{isMissed ? 'Missed Patrol' : (selectedReportDetail.completedBy || '-')}</p></div>
               <div className="bg-[#0b1229] p-4 rounded-xl border border-cyan-900/50 shadow-sm">
                 <p className="text-[10px] text-cyan-600 font-bold uppercase tracking-widest mb-1">{isReadOnly ? 'Shift' : 'Waktu Sync'}</p>
                 {isReadOnly && selectedReportDetail.date ? (
                   <p className="text-sm font-bold text-cyan-50">
                     <span className="block">{selectedReportDetail.date}</span>
                     <span className="block">{selectedReportDetail.time || '-'}</span>
                   </p>
                 ) : (
                   <p className="text-sm font-bold text-cyan-50">
                     <span className="block">{syncDateLabel}</span>
                     <span className="block">{syncTimeLabel} WIB</span>
                   </p>
                 )}
               </div>
             </div>
             <TimeAuditRecordCard
               record={selectedReportDetail}
               title="Audit Timestamp Laporan"
               fallbackTimestampKeys={['completedAt', 'updatedAt', 'createdAt']}
             />
           </>
         ) : null}
         {isMissed ? (
           <div className="bg-rose-950/20 p-4 rounded-xl border border-rose-900/30">
             <p className="text-[10px] text-rose-600 font-bold mb-1.5 flex items-center gap-1.5 uppercase tracking-widest"><AlertTriangle className="w-3 h-3" /> Keterangan</p>
             <p className="text-sm text-rose-50/90 leading-relaxed">{selectedReportDetail.kejadian || 'Titik ini tidak dipatroli pada shift tersebut.'}</p>
           </div>
         ) : selectedReportDetail.resultType === 'temuan' && (
           <div className="space-y-3">
             <div className="bg-yellow-950/20 p-4 rounded-xl border border-yellow-900/30"><p className="text-[10px] text-yellow-600 font-bold mb-1.5 flex items-center gap-1.5 uppercase tracking-widest"><AlertTriangle className="w-3 h-3" /> Deskripsi</p><p className="text-sm text-yellow-50/90 leading-relaxed">{selectedReportDetail.kejadian || '-'}</p></div>
             <div className="bg-yellow-950/20 p-4 rounded-xl border border-yellow-900/30"><p className="text-[10px] text-yellow-600 font-bold mb-1.5 flex items-center gap-1.5 uppercase tracking-widest"><AlertTriangle className="w-3 h-3" /> Penyebab</p><p className="text-sm text-yellow-50/90 leading-relaxed">{selectedReportDetail.penyebab || '-'}</p></div>
             <div className="bg-emerald-950/20 p-4 rounded-xl border border-emerald-900/30"><p className="text-[10px] text-emerald-600 font-bold mb-1.5 flex items-center gap-1.5 uppercase tracking-widest"><CheckCircle2 className="w-3 h-3" /> Tindak Lanjut</p><p className="text-sm text-emerald-50/90 leading-relaxed">{selectedReportDetail.tindakLanjut || '-'}</p></div>
           </div>
         )}
         {isAman && (
           <div className="space-y-3">
             <div className="bg-[#0b1229] p-4 rounded-xl border border-cyan-900/50 shadow-sm">
               <div className="flex items-center justify-between gap-3 mb-3">
                 <p className="text-[10px] text-cyan-600 font-bold uppercase tracking-widest">Titik Checkpoint</p>
                 <span className="text-[10px] px-2 py-1 border border-cyan-500/50 rounded font-bold text-cyan-400 bg-cyan-900/40 shrink-0">{isReadOnly ? 'Riwayat Shift' : 'Laporan Titik'}</span>
               </div>
               <h2 className="text-xl font-black text-cyan-50 leading-tight flex items-start gap-2">
                 <MapPin className="w-5 h-5 text-cyan-400 shrink-0 mt-0.5" />
                 <span className="line-clamp-2">{selectedReportDetail.name || '-'}</span>
               </h2>
               <div className="grid grid-cols-2 gap-3 mt-4 pt-4 border-t border-cyan-900/50">
                 <div className="min-w-0">
                   <p className="text-[10px] text-cyan-600 font-bold uppercase tracking-widest mb-1 flex items-center gap-1.5"><Calendar className="w-3 h-3" /> Tanggal</p>
                   <p className="text-sm font-bold text-cyan-50">{syncDateLabel}</p>
                   <p className="text-[10px] text-cyan-100/60 mt-0.5">{syncTimeLabel} WIB</p>
                 </div>
                 <div className="min-w-0">
                   <p className="text-[10px] text-cyan-600 font-bold uppercase tracking-widest mb-1 flex items-center gap-1.5"><User className="w-3 h-3" /> Petugas</p>
                   <p className="text-sm font-bold text-cyan-50 truncate">{selectedReportDetail.completedBy || '-'}</p>
                 </div>
               </div>
             </div>
             <div className="bg-[#0b1229] p-4 rounded-xl border border-cyan-900/50 shadow-sm">
               {hasGpsSnapshot ? (
                 <>
                   <div className="flex items-center justify-between gap-3 mb-3">
                     <div>
                       <p className="text-[10px] text-cyan-600 font-bold uppercase tracking-widest mb-1">GPS Lokasi</p>
                       <p className="text-sm font-bold text-cyan-50 flex items-center gap-1.5">
                         <MapPin className="w-4 h-4 text-cyan-400" />
                         {latitude}, {longitude}
                       </p>
                       <p className="text-[10px] text-cyan-600 mt-1">{gpsSourceLabel}</p>
                     </div>
                     <a
                       href={mapsHref}
                       target="_blank"
                       rel="noreferrer"
                       className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-cyan-700/60 text-cyan-300 text-[10px] font-bold uppercase tracking-widest hover:bg-cyan-900/30 transition-colors"
                     >
                       Maps <ExternalLink className="w-3.5 h-3.5" />
                     </a>
                   </div>
                   <div className="w-full h-36 rounded-xl overflow-hidden border border-cyan-800/50">
                     <iframe
                       width="100%"
                       height="100%"
                       frameBorder="0"
                       scrolling="no"
                       marginHeight="0"
                       marginWidth="0"
                       src={`https://maps.google.com/maps?q=${mapsQuery}&hl=id&z=14&output=embed`}
                       title="GPS Lokasi Patroli"
                     />
                   </div>
                 </>
               ) : (
                 <div className="rounded-xl border border-dashed border-cyan-800/50 p-4 text-center">
                   <p className="text-[10px] text-cyan-600 font-bold uppercase tracking-widest mb-1">GPS Lokasi</p>
                   <p className="text-sm text-cyan-200">Data GPS belum terekam saat sync laporan.</p>
                 </div>
               )}
             </div>

             <div className="bg-[#0b1229] rounded-xl p-4 border border-cyan-800/50 shadow-sm">
               {weatherSnapshot ? (
                 <div className="flex items-center justify-between gap-4">
                   <div className="flex items-center gap-3 min-w-0">
                     <div className="p-2 bg-cyan-900/20 rounded-xl shrink-0">
                       {getWeatherDetail(weatherSnapshot.weathercode).icon}
                     </div>
                     <div className="min-w-0">
                       <p className="text-[10px] text-cyan-500 font-bold uppercase tracking-widest">Kondisi</p>
                       <p className="text-sm font-bold text-cyan-50 truncate">{getWeatherDetail(weatherSnapshot.weathercode).text}</p>
                       <p className="text-[10px] text-cyan-600 mt-1">Snapshot cuaca saat sync laporan</p>
                     </div>
                   </div>
                   <div className="flex items-center gap-4 shrink-0">
                     <div className="text-right">
                       <p className="text-[10px] text-cyan-500 font-bold uppercase tracking-widest flex items-center justify-end gap-1">
                         <Thermometer className="w-3 h-3 text-rose-400" />
                         Temp
                       </p>
                       <p className="text-sm font-bold text-cyan-50">{weatherSnapshot.temperature}Â°C</p>
                     </div>
                     <div className="w-px h-7 bg-cyan-800" />
                     <div>
                       <p className="text-[10px] text-cyan-500 font-bold uppercase tracking-widest flex items-center gap-1">
                         <Wind className="w-3 h-3 text-emerald-400" />
                         Angin
                       </p>
                       <p className="text-sm font-bold text-cyan-50">{weatherSnapshot.windspeed} k/j</p>
                     </div>
                   </div>
                 </div>
               ) : (
                 <p className="text-xs text-cyan-500 text-center">Info cuaca belum terekam saat sync laporan.</p>
               )}
             </div>

             <div className="bg-emerald-950/20 p-4 rounded-xl border border-emerald-900/30">
               <p className="text-[10px] text-emerald-600 font-bold mb-1.5 flex items-center gap-1.5 uppercase tracking-widest"><CheckCircle2 className="w-3 h-3" /> Catatan</p>
               <p className="text-sm text-emerald-50/90 leading-relaxed">{selectedReportDetail.kejadian || 'Checkpoint dilaporkan dalam kondisi aman.'}</p>
             </div>
             <TimeAuditRecordCard
               record={selectedReportDetail}
               title="Audit Timestamp Laporan"
               fallbackTimestampKeys={['completedAt', 'updatedAt', 'createdAt']}
             />
           </div>
         )}
      </div>
    </div>
  );
}
