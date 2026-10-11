/*
Tujuan: Menampilkan dan mengelola form CRUD armada beserta daftar checkpoint kapal.
Caller: Modal/form armada dari halaman manajemen kapal.
Dependensi: Context ships runtime, seed checkpoint default, ikon UI, dan AsyncImage.
Main Functions: Mengedit metadata kapal, checkpoint, foto kapal, dan menyimpan perubahan.
Side Effects: Mengubah draft armada di client sebelum disimpan ke state utama aplikasi.
*/

import React from 'react';
import { SHIP_STATUS_OPTIONS, useShips } from '../../context/AppContextRuntime';
import { DEFAULT_LOCATION_OPTIONS } from '../../data/defaultData';
import { ChevronDown, Camera, Trash2, Save, Plus, Map, Package, Weight, Hash } from 'lucide-react';
import AsyncImage from '../AsyncImage';

function usesSplitVoyageRoute(status) {
  return status === 'Operasional' || status === 'Situasional';
}

export default function ShipFormView({ isInline = false }) {
  const {
    showShipForm, setShowShipForm, shipFormData, setShipFormData,
    newCheckpoint, setNewCheckpoint, handleSaveShip,
    handleAddCheckpointToForm, handleRemoveCheckpointFromForm,
    handleShipFormPhotoUpload,
  } = useShips();

  if (!showShipForm) {
    if (isInline) return (
      <div className="h-full flex flex-col items-center justify-center text-cyan-800 p-8 text-center border-2 border-dashed border-cyan-900/30 rounded-3xl m-4">
        <div className="w-16 h-16 rounded-full bg-cyan-900/20 flex items-center justify-center mb-4">
          <Plus className="w-8 h-8 opacity-20" />
        </div>
        <p className="text-sm font-bold uppercase tracking-widest mb-1">Tambah Armada</p>
        <p className="text-xs opacity-60">Klik tombol "Tambah Armada" di sebelah kiri untuk mendaftarkan kapal baru ke dalam sistem.</p>
      </div>
    );
    return null;
  }

  return (
    <div className={`flex flex-col h-full bg-[#070b19] ${isInline ? 'border-l border-cyan-900/50' : 'fixed inset-0 z-[100] sm:max-w-md sm:mx-auto sm:border-x sm:border-cyan-900/50'}`}>
      <div className="p-4 border-b border-cyan-500/30 flex items-center gap-3 bg-[#0b1229] shrink-0 shadow-sm">
         {!isInline && (
           <button onClick={() => setShowShipForm(false)} className="p-2 bg-[#070b19] border border-cyan-800 text-cyan-300 rounded-full hover:bg-cyan-900/50 transition-colors" aria-label="Tutup form kapal"><ChevronDown className="w-5 h-5 rotate-90"/></button>
         )}
         <div><span className="text-[10px] text-cyan-500 uppercase tracking-widest font-bold">Registrasi</span><h3 className="font-bold text-xl text-cyan-50 line-clamp-1">Armada Baru</h3></div>
      </div>
      <div className="flex-1 overflow-y-auto p-5 space-y-6">
        <div className="space-y-4">
          <div className="flex flex-col items-center mb-6">
            {!shipFormData.photoUrl ? (
              <button onClick={handleShipFormPhotoUpload} className="w-28 h-28 rounded-2xl border-2 border-dashed border-cyan-500/50 bg-[#070b19] flex flex-col items-center justify-center text-cyan-500 hover:text-cyan-300 hover:border-cyan-400 transition-colors shadow-sm">
                <Camera className="w-7 h-7 mb-2"/>
                <span className="text-[10px] font-bold tracking-widest">FOTO KAPAL</span>
              </button>
            ) : (
              <div className="relative w-full max-w-[180px] h-28 rounded-2xl overflow-hidden border border-cyan-500/60 shadow-md">
                <AsyncImage src={shipFormData.photoUrl} alt="Foto kapal" className="w-full h-full object-cover" />
                <button onClick={() => setShipFormData({ ...shipFormData, photoUrl: null })} className="absolute bottom-0 inset-x-0 bg-rose-500/90 py-1.5 text-[9px] text-white font-bold tracking-widest hover:bg-rose-600 transition-colors">HAPUS FOTO</button>
              </div>
            )}
          </div>
          <div><label className="text-[10px] font-mono text-cyan-400 mb-1.5 block uppercase tracking-widest pl-1">Nama Kapal</label><input type="text" value={shipFormData.name} onChange={e => setShipFormData({...shipFormData, name: e.target.value})} placeholder="Contoh: MT GATOTKACA" className="w-full bg-[#0b1229] border border-cyan-800/50 rounded-xl p-3.5 text-sm text-cyan-50 focus:border-cyan-400 outline-none shadow-sm" /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="text-[10px] font-mono text-cyan-400 mb-1.5 block uppercase tracking-widest pl-1">Tipe Kapal</label><select value={shipFormData.type} onChange={e => setShipFormData({...shipFormData, type: e.target.value})} className="w-full bg-[#0b1229] border border-cyan-800/50 rounded-xl p-3.5 text-sm text-cyan-50 focus:border-cyan-400 outline-none appearance-none shadow-sm"><option>Oil Tanker</option><option>Chemical Tanker</option><option>Gas Carrier</option><option>Bulk Carrier</option></select></div>
            <div><label className="text-[10px] font-mono text-cyan-400 mb-1.5 block uppercase tracking-widest pl-1">Status</label><select value={shipFormData.status} onChange={e => setShipFormData({...shipFormData, status: e.target.value, routeDischarge: e.target.value === 'Non Operasional' ? '' : shipFormData.routeDischarge})} className="w-full bg-[#0b1229] border border-cyan-800/50 rounded-xl p-3.5 text-sm text-cyan-50 focus:border-cyan-400 outline-none appearance-none shadow-sm">{SHIP_STATUS_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}</select></div>
          </div>
          <div><label className="text-[10px] font-mono text-cyan-400 mb-1.5 block uppercase tracking-widest pl-1 flex items-center gap-1"><Hash className="w-3 h-3"/> IMO Number</label><input type="text" value={shipFormData.imoNumber} onChange={e => setShipFormData({...shipFormData, imoNumber: e.target.value})} placeholder="Contoh: 9387421" className="w-full bg-[#0b1229] border border-cyan-800/50 rounded-xl p-3.5 text-sm text-cyan-50 focus:border-cyan-400 outline-none shadow-sm" /></div>
          {usesSplitVoyageRoute(shipFormData.status) ? (
            <div className="grid grid-cols-2 gap-3">
              <div><label className="text-[10px] font-mono text-cyan-400 mb-1.5 block uppercase tracking-widest pl-1 flex items-center gap-1"><Map className="w-3 h-3"/> Loading</label><input type="text" value={shipFormData.routeLoading} onChange={e => setShipFormData({...shipFormData, routeLoading: e.target.value})} placeholder="Contoh: Jakarta" className="w-full bg-[#0b1229] border border-cyan-800/50 rounded-xl p-3.5 text-sm text-cyan-50 focus:border-cyan-400 outline-none shadow-sm" /></div>
              <div><label className="text-[10px] font-mono text-cyan-400 mb-1.5 block uppercase tracking-widest pl-1 flex items-center gap-1"><Map className="w-3 h-3"/> Discharge</label><input type="text" value={shipFormData.routeDischarge} onChange={e => setShipFormData({...shipFormData, routeDischarge: e.target.value})} placeholder="Contoh: Dumai" className="w-full bg-[#0b1229] border border-cyan-800/50 rounded-xl p-3.5 text-sm text-cyan-50 focus:border-cyan-400 outline-none shadow-sm" /></div>
            </div>
          ) : (
            <div><label className="text-[10px] font-mono text-cyan-400 mb-1.5 block uppercase tracking-widest pl-1 flex items-center gap-1"><Map className="w-3 h-3"/> Lokasi / Keterangan</label><input type="text" value={shipFormData.routeLoading} onChange={e => setShipFormData({...shipFormData, routeLoading: e.target.value, routeDischarge: ''})} placeholder="Contoh: Docking / Non Operasional" className="w-full bg-[#0b1229] border border-cyan-800/50 rounded-xl p-3.5 text-sm text-cyan-50 focus:border-cyan-400 outline-none shadow-sm" /></div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div><label className="text-[10px] font-mono text-cyan-400 mb-1.5 block uppercase tracking-widest pl-1 flex items-center gap-1"><Package className="w-3 h-3"/> Jenis Muatan</label><input type="text" value={shipFormData.cargoType} onChange={e => setShipFormData({...shipFormData, cargoType: e.target.value})} placeholder="Crude Oil" className="w-full bg-[#0b1229] border border-cyan-800/50 rounded-xl p-3.5 text-sm text-cyan-50 focus:border-cyan-400 outline-none shadow-sm" /></div>
            <div><label className="text-[10px] font-mono text-cyan-400 mb-1.5 block uppercase tracking-widest pl-1 flex items-center gap-1"><Weight className="w-3 h-3"/> Jumlah</label><input type="text" value={shipFormData.cargoAmount} onChange={e => setShipFormData({...shipFormData, cargoAmount: e.target.value})} placeholder="30,000 MT" className="w-full bg-[#0b1229] border border-cyan-800/50 rounded-xl p-3.5 text-sm text-cyan-50 focus:border-cyan-400 outline-none shadow-sm" /></div>
          </div>
        </div>
        <div className="pt-2 border-t border-cyan-900/30">
          <h4 className="text-xs font-bold text-cyan-400 uppercase tracking-widest mb-3 pb-2">Daftar TITIK Periksa</h4>
          <p className="text-[11px] text-cyan-500 mb-3">
            {DEFAULT_LOCATION_OPTIONS.length} titik default armada dibuat otomatis saat armada baru dibuat, lalu admin tetap bisa menambah atau menghapus titik sesuai kebutuhan armada. Setelah armada disimpan, lengkapi tag NFC, foto kondisi awal, dan sub checkpoint tiap titik di tab TITIK.
          </p>
          <div className="flex gap-2 mb-3">
            <input type="text" value={newCheckpoint} onChange={e => setNewCheckpoint(e.target.value)} onKeyPress={e => e.key === 'Enter' && handleAddCheckpointToForm()} placeholder="Nama Titik Baru..." className="flex-1 bg-[#0b1229] border border-cyan-800/50 rounded-xl p-3 text-sm text-cyan-50 focus:border-cyan-400 outline-none shadow-sm" />
            <button onClick={handleAddCheckpointToForm} className="px-4 bg-cyan-600 hover:bg-cyan-500 text-white rounded-xl transition-colors shadow-[0_0_10px_rgba(6,182,212,0.3)]"><Plus className="w-5 h-5"/></button>
          </div>
          <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
            {shipFormData.customCheckpoints.map((cp, idx) => (
              <div key={idx} className="flex justify-between items-center p-3 bg-[#0b1229] border border-cyan-800/60 rounded-xl shadow-sm">
                <span className="text-sm font-bold text-cyan-100 flex items-center gap-2">
                  <span className="text-[9px] text-cyan-600 font-mono border border-cyan-800 px-1.5 py-0.5 rounded">TITIK {String(idx+1).padStart(2,'0')}</span>
                  {cp.name}
                  {cp.isDefault && <span className="text-[9px] uppercase tracking-widest text-emerald-300 border border-emerald-500/40 px-1.5 py-0.5 rounded">Default</span>}
                </span>
                <button onClick={() => handleRemoveCheckpointFromForm(idx)} className="p-1.5 rounded-lg transition-colors text-rose-500/70 hover:text-rose-400 hover:bg-rose-500/10" aria-label="Hapus titik periksa"><Trash2 className="w-4 h-4"/></button>
              </div>
            ))}
            {shipFormData.customCheckpoints.length === 0 && <p className="text-xs text-rose-400 text-center py-3 italic border border-dashed border-rose-900/50 rounded-xl">Belum ada titik periksa.</p>}
          </div>
        </div>
      </div>
      <div className="p-4 bg-[#0b1229] border-t border-cyan-900/50 shrink-0 pb-safe flex gap-3">
        {!isInline && (
          <button onClick={() => setShowShipForm(false)} className="flex-1 py-4 rounded-xl font-black tracking-widest uppercase text-xs border border-cyan-800 text-cyan-300 hover:bg-cyan-900/30 transition-colors">Cancel</button>
        )}
        <button onClick={handleSaveShip} disabled={!shipFormData.name} className="flex-1 py-4 rounded-xl font-black tracking-widest uppercase text-xs bg-cyan-600 hover:bg-cyan-500 text-white disabled:opacity-50 transition-all flex items-center justify-center gap-2 shadow-[0_0_15px_rgba(6,182,212,0.3)]"><Save className="w-4 h-4" /> Simpan Data</button>
      </div>
    </div>
  );
}
