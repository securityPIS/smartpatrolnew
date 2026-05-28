/*
Tujuan: Menyediakan modal detail untuk user, laporan, dan preview foto lintas halaman.
Caller: AppShell saat state detail aktif dari menu settings, UsersPage mobile, laporan, atau preview media.
Dependensi: Context users/UI/reports, UserDetailView, ReportDetailView, dan AsyncImage.
Main Functions: Membuka detail user/profil sendiri, detail laporan, dan preview foto operasional.
Side Effects: Menampilkan overlay modal dan mengubah state preview saat foto ditutup.
*/

import React from 'react';
import { useReports, useUI, useUsers } from '../../context/AppContextRuntime';
import { getR2DownloadUrl, isR2FullPhotoEnabled } from '../../services/backend/r2Assets';
import UserDetailView from '../views/UserDetailView';
import ReportDetailView from '../views/ReportDetailView';
import AsyncImage from '../AsyncImage';

export function UserDetailModal() {
  const { selectedUser } = useUsers();
  const { currentPage } = useUI();
  const modalRef = React.useRef(null);
  if (!selectedUser) return null;

  const desktopVisibilityClass = currentPage === 'users' ? 'lg:hidden' : '';

  return (
    <div ref={modalRef} className={`fixed inset-0 z-[100] bg-[#070b19] ${desktopVisibilityClass} flex flex-col animate-in slide-in-from-right-4`}>
      <UserDetailView isInline={false} />
    </div>
  );
}

export function ReportDetailModal() {
  const { selectedReportDetail } = useReports();
  const modalRef = React.useRef(null);
  if (!selectedReportDetail) return null;

  return (
    <div ref={modalRef} className="fixed inset-0 z-[100] bg-[#070b19] lg:hidden flex flex-col animate-in slide-in-from-right-4">
      <ReportDetailView isInline={false} />
    </div>
  );
}

// Resolusi sumber foto preview: prioritas full lokal (offline) -> presigned GET R2 -> fallback thumbnail.
export function PhotoPreviewModal() {
  const { previewPhoto, setPreviewPhoto } = useReports();
  const { isOffline } = useUI();
  const modalRef = React.useRef(null);
  const [fullUrl, setFullUrl] = React.useState(null);
  const [resolving, setResolving] = React.useState(false);
  const [fallbackThumb, setFallbackThumb] = React.useState(false);

  const preview = typeof previewPhoto === 'object' && previewPhoto ? previewPhoto : null;
  const thumbUrl = typeof previewPhoto === 'string' ? previewPhoto : preview?.url || null;
  const fullObjectKey = preview?.fullObjectKey || null;
  const localFullUrl = typeof preview?.fullPhotoUrl === 'string' && preview.fullPhotoUrl.startsWith('idb://')
    ? preview.fullPhotoUrl
    : null;
  const shipId = preview?.shipId || null;

  React.useEffect(() => {
    let cancelled = false;
    setFullUrl(null);
    setFallbackThumb(false);
    setResolving(false);
    if (!previewPhoto) return undefined;

    // 1. Full-res lokal (varian masih di IndexedDB) — tampil walau offline.
    if (localFullUrl) {
      setFullUrl(localFullUrl);
      return undefined;
    }
    // 2. Full-res R2 via presigned GET (cek akses kapal di server).
    if (isR2FullPhotoEnabled && fullObjectKey && shipId && !isOffline) {
      setResolving(true);
      getR2DownloadUrl({ shipId, objectKey: fullObjectKey })
        .then((url) => {
          if (cancelled) return;
          if (url) setFullUrl(url);
          else setFallbackThumb(true);
        })
        .catch(() => { if (!cancelled) setFallbackThumb(true); })
        .finally(() => { if (!cancelled) setResolving(false); });
      return () => { cancelled = true; };
    }
    // 3. Tidak ada full yang bisa dibuka — pakai thumbnail.
    setFallbackThumb(true);
    return undefined;
  }, [previewPhoto, localFullUrl, fullObjectKey, shipId, isOffline]);

  if (!previewPhoto) return null;

  const displaySrc = fullUrl || thumbUrl;
  const showBadge = fallbackThumb && !fullUrl && Boolean(fullObjectKey || localFullUrl);

  return (
    <div ref={modalRef} className="fixed inset-0 z-[110] flex items-center justify-center bg-[#070b19]/95 p-4 animate-in fade-in" onClick={()=>setPreviewPhoto(null)}>
      <div className="relative">
        <AsyncImage src={displaySrc} alt="Zoom" className="w-full max-w-lg h-auto rounded-xl border border-cyan-700 shadow-[0_0_30px_rgba(6,182,212,0.2)]" />
        {resolving && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="px-3 py-1.5 rounded-lg bg-black/70 text-xs text-cyan-200 border border-cyan-900/50 animate-pulse">Memuat resolusi penuh…</div>
          </div>
        )}
        {showBadge && (
          <div className="absolute top-3 left-3 bg-black/70 backdrop-blur-md px-3 py-1.5 rounded-lg text-[10px] text-amber-200 border border-amber-900/50 max-w-[14rem] leading-snug">Foto resolusi penuh belum tersinkron / butuh koneksi.</div>
        )}
        {preview?.author && (
          <div className="absolute bottom-3 right-3 bg-black/70 backdrop-blur-md px-3 py-1.5 rounded-lg text-xs text-white/90 text-right border border-cyan-900/50"><p className="font-bold text-cyan-400">{preview.author}</p><p className="text-[10px] text-cyan-100/70">{preview.time}</p></div>
        )}
      </div>
    </div>
  );
}
