/*
Tujuan: Membuka kamera native perangkat (Android via Capacitor, atau browser via input capture) untuk foto patroli tanpa jalur impor galeri dan tanpa layar antara.
Caller: App shell melalui pendingPatrolCameraCapture dari AppContextRuntime.
Dependensi: React, lucide-react, AppContextRuntime, adapter native Capacitor, dan utilitas kompresi gambar.
Main Functions: Auto-trigger kamera native HP segera saat modal terbuka — tidak ada layar "Kamera siap" atau tombol yang harus ditekan terlebih dahulu. Mendukung auto-rotate dan landscape karena memakai kamera bawaan OS. Tidak ada jalur galeri.
Side Effects: Memicu permission kamera dan membuka kamera native via Capacitor API atau <input capture> browser.
*/

import React from 'react';
import { Camera, CameraOff, RefreshCcw, X } from 'lucide-react';
import { usePatrol } from '../../context/AppContextRuntime';
import { captureNativeCameraPhoto, isNativeRuntime } from '../../services/native/capacitorBridge';
import { readImageFileAsDataUrl } from '../../utils/images';

// Sumber foto full-res (≤2000px). Thumbnail diturunkan dari sini saat capture.
const PATROL_CAMERA_MAX_EDGE = 2000;
const PATROL_CAMERA_IMAGE_QUALITY = 0.80;

/**
 * Membuka kamera native perangkat di browser via <input type="file" capture>.
 * capture="environment"/"user" memastikan kamera bawaan terbuka, bukan galeri.
 * Auto-rotate dan landscape didukung penuh oleh OS.
 */
function pickWebNativeCameraDataUrl(cameraDirection = 'environment') {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.capture = cameraDirection;
  input.multiple = false;
  input.tabIndex = -1;
  input.setAttribute('aria-hidden', 'true');
  input.style.position = 'fixed';
  input.style.left = '-9999px';
  input.style.width = '1px';
  input.style.height = '1px';
  input.style.opacity = '0';
  input.style.pointerEvents = 'none';

  return new Promise((resolve) => {
    const cleanup = () => {
      input.onchange = null;
      input.oncancel = null;
      if (input.parentNode) input.parentNode.removeChild(input);
    };

    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) { cleanup(); resolve(null); return; }
      try {
        const dataUrl = await readImageFileAsDataUrl(file, PATROL_CAMERA_MAX_EDGE, PATROL_CAMERA_IMAGE_QUALITY);
        cleanup();
        resolve(dataUrl);
      } catch (error) {
        console.error('Gagal membaca foto dari kamera', error);
        cleanup();
        resolve(null);
      }
    };

    input.oncancel = () => { cleanup(); resolve(null); };

    document.body.appendChild(input);
    input.click();
  });
}

export default function PatrolCameraModal() {
  const {
    pendingPatrolCameraCapture,
    closePatrolCameraCapture,
    handlePatrolCameraCapture,
  } = usePatrol();

  const [cameraError, setCameraError] = React.useState('');
  const [isCapturing, setIsCapturing] = React.useState(false);
  const [cameraFacingMode, setCameraFacingMode] = React.useState('environment');

  const canUseNativeCapacitor = isNativeRuntime();
  const activeCameraLabel = cameraFacingMode === 'environment' ? 'Belakang' : 'Depan';
  const modalTitle = pendingPatrolCameraCapture?.intent === 'incident-progress'
    ? 'Foto Update Temuan'
    : pendingPatrolCameraCapture?.type === 'temuan'
      ? 'Foto Temuan'
      : 'Foto Aman';

  const triggerNativeCapacitorCapture = React.useCallback(async (facingMode) => {
    setIsCapturing(true);
    setCameraError('');
    try {
      const direction = facingMode === 'user' ? 'front' : 'rear';
      const dataUrl = await captureNativeCameraPhoto({ direction });
      if (!dataUrl) {
        setIsCapturing(false);
        setCameraError('Foto tidak diambil. Tekan tombol di bawah untuk coba lagi.');
        return;
      }
      await handlePatrolCameraCapture(dataUrl);
    } catch (error) {
      console.error('Gagal mengambil foto kamera native Android', error);
      setIsCapturing(false);
      setCameraError('Kamera tidak bisa mengambil foto. Periksa izin kamera Android.');
    }
  }, [handlePatrolCameraCapture]);

  const triggerWebCapture = React.useCallback(async (facingMode) => {
    setIsCapturing(true);
    setCameraError('');
    try {
      const dir = facingMode === 'user' ? 'user' : 'environment';
      const dataUrl = await pickWebNativeCameraDataUrl(dir);
      if (!dataUrl) {
        setIsCapturing(false);
        setCameraError('Foto tidak diambil. Tekan tombol di bawah untuk coba lagi.');
        return;
      }
      await handlePatrolCameraCapture(dataUrl);
    } catch (error) {
      console.error('Gagal mengambil foto kamera web', error);
      setIsCapturing(false);
      setCameraError('Kamera tidak bisa mengambil foto.');
    }
  }, [handlePatrolCameraCapture]);

  // Auto-trigger kamera native segera saat modal terbuka — tanpa perlu tekan tombol.
  // Bekerja untuk Capacitor (Android APK) dan browser mobile (Chrome Android).
  // Input.click() di dalam useEffect masih dalam window user-gesture browser (~1 detik).
  const autoTriggerRef = React.useRef(false);
  React.useEffect(() => {
    if (!pendingPatrolCameraCapture) {
      autoTriggerRef.current = false;
      return;
    }
    if (autoTriggerRef.current) return;
    autoTriggerRef.current = true;

    if (canUseNativeCapacitor) {
      triggerNativeCapacitorCapture('environment');
    } else {
      triggerWebCapture('environment');
    }
  }, [pendingPatrolCameraCapture, canUseNativeCapacitor, triggerNativeCapacitorCapture, triggerWebCapture]);

  // Reset state saat modal ditutup
  React.useEffect(() => {
    if (!pendingPatrolCameraCapture) {
      setCameraError('');
      setIsCapturing(false);
      setCameraFacingMode('environment');
    }
  }, [pendingPatrolCameraCapture]);

  const handleClose = React.useCallback(() => {
    closePatrolCameraCapture();
  }, [closePatrolCameraCapture]);

  const handleRetry = React.useCallback(() => {
    if (canUseNativeCapacitor) {
      triggerNativeCapacitorCapture(cameraFacingMode);
    } else {
      triggerWebCapture(cameraFacingMode);
    }
  }, [canUseNativeCapacitor, cameraFacingMode, triggerNativeCapacitorCapture, triggerWebCapture]);

  const handleSwitchCamera = React.useCallback(() => {
    const newMode = cameraFacingMode === 'environment' ? 'user' : 'environment';
    setCameraFacingMode(newMode);
    if (canUseNativeCapacitor) {
      triggerNativeCapacitorCapture(newMode);
    } else {
      triggerWebCapture(newMode);
    }
  }, [cameraFacingMode, canUseNativeCapacitor, triggerNativeCapacitorCapture, triggerWebCapture]);

  if (!pendingPatrolCameraCapture) return null;

  return (
    <div className="fixed inset-0 z-[110] bg-[#020617]">
      <div className="h-full flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-4 border-b border-cyan-900/50 bg-[#070b19]">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-cyan-500">Kamera Patroli</p>
            <h3 className="text-lg font-black text-white">{modalTitle}</h3>
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="w-10 h-10 rounded-xl border border-cyan-700/60 bg-[#0b1229] text-cyan-300 flex items-center justify-center"
            aria-label="Tutup kamera patroli"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 flex flex-col items-center justify-center p-6 gap-6">

          {/* Ikon status */}
          <div className="w-24 h-24 rounded-full bg-[#0b1229] border border-cyan-900/50 flex items-center justify-center">
            {cameraError
              ? <CameraOff className="w-10 h-10 text-rose-400" />
              : <Camera className="w-10 h-10 text-cyan-300 animate-pulse" />
            }
          </div>

          {/* Teks status */}
          <div className="text-center space-y-2 px-4">
            {cameraError ? (
              <>
                <p className="text-sm font-semibold text-rose-300">{cameraError}</p>
                <p className="text-xs text-cyan-500/70">Pilih kamera lalu tekan Coba Lagi</p>
              </>
            ) : (
              <>
                <p className="text-sm font-semibold text-cyan-200">
                  Membuka kamera {activeCameraLabel.toLowerCase()}...
                </p>
                <p className="text-xs text-cyan-500/70">
                  Kamera HP sedang dibuka — portrait &amp; landscape didukung
                </p>
              </>
            )}
          </div>

          {/* Tombol — hanya muncul saat error/dibatalkan */}
          <div className="w-full max-w-xs space-y-3">
            {cameraError && (
              <div className="grid grid-cols-[1fr_auto] gap-3">
                <button
                  type="button"
                  onClick={handleRetry}
                  disabled={isCapturing}
                  className="py-4 rounded-xl bg-cyan-600 text-white font-black uppercase tracking-widest text-xs flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  <Camera className="w-4 h-4" />
                  Coba Lagi
                </button>
                <button
                  type="button"
                  onClick={handleSwitchCamera}
                  disabled={isCapturing}
                  className="w-14 rounded-xl border border-cyan-700/60 bg-[#0b1229] text-cyan-300 flex items-center justify-center disabled:opacity-50"
                  aria-label="Ganti kamera depan atau belakang"
                  title={`Ganti ke kamera ${cameraFacingMode === 'environment' ? 'depan' : 'belakang'}`}
                >
                  <RefreshCcw className="w-4 h-4" />
                </button>
              </div>
            )}

            <button
              type="button"
              onClick={handleClose}
              className="w-full py-3 rounded-xl border border-cyan-900/70 text-cyan-300 font-bold uppercase tracking-widest text-xs bg-[#0b1229]"
            >
              Batal
            </button>
          </div>

          {/* Info kamera aktif */}
          <p className="text-[10px] text-cyan-600/50 uppercase tracking-widest">
            Kamera {activeCameraLabel} · Native HP
          </p>
        </div>
      </div>
    </div>
  );
}
