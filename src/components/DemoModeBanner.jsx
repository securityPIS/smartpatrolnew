/*
Tujuan: Penanda di atas aplikasi bahwa sesi berjalan di mode demo (akun dummy, data tidak disimpan),
        beserta tombol keluar demo.
Caller: App shell (hanya saat isDemoMode).
Dependensi: services/demoMode, ikon lucide-react.
Side Effects: Tombol keluar memuat ulang aplikasi ke login normal.
*/

import React from 'react';
import { FlaskConical, LogOut } from 'lucide-react';
import { demoAccount, exitDemoMode, isDemoMode } from '../services/demoMode';

export default function DemoModeBanner() {
  if (!isDemoMode) return null;
  return (
    <div className="shrink-0 flex items-center gap-2 px-4 py-1.5 bg-fuchsia-600/90 text-white" role="status">
      <FlaskConical className="w-3.5 h-3.5 shrink-0" />
      <p className="flex-1 min-w-0 truncate">
        <span className="text-[10px] font-black uppercase tracking-widest">Mode Demo</span>
        <span className="text-[10px] opacity-90"> · {demoAccount?.label} · data dummy, tidak disimpan</span>
      </p>
      <button type="button" onClick={exitDemoMode} className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-white/40 hover:bg-white/15 transition-colors">
        <LogOut className="w-3 h-3" />
        <span className="text-[10px] font-bold uppercase tracking-wider">Keluar</span>
      </button>
    </div>
  );
}
