/*
Tujuan: Membaca UID tag NFC untuk pendaftaran titik checkpoint.
Caller: Tab TITIK di ShipsPage (form titik checkpoint).
Dependensi: Web NFC (NDEFReader) — tersedia di Chrome Android (HTTPS). Android WebView
        (aplikasi Capacitor) belum mendukung Web NFC, jadi di sana admin memasukkan ID tag manual.
Main Functions: isNfcScanSupported, startNfcTagScan.
Side Effects: Mengaktifkan pembaca NFC perangkat sampai tag terbaca, dibatalkan, atau timeout.
*/

export function isNfcScanSupported() {
  return typeof window !== 'undefined' && 'NDEFReader' in window;
}

/*
Mulai scan sekali. Mengembalikan fungsi stop(). onTag menerima serialNumber tag pertama
yang terbaca; onError menerima Error (izin ditolak, NFC mati, timeout).
*/
export function startNfcTagScan({ onTag, onError, timeoutMs = 30000 } = {}) {
  if (!isNfcScanSupported()) {
    onError?.(new Error('Scan NFC belum didukung di perangkat/browser ini.'));
    return () => {};
  }

  const controller = new AbortController();
  let finished = false;
  const finish = () => {
    if (finished) return false;
    finished = true;
    clearTimeout(timerId);
    controller.abort();
    return true;
  };
  const timerId = setTimeout(() => {
    if (finish()) onError?.(new Error('Tidak ada tag NFC terbaca. Tempelkan tag ke bagian belakang HP lalu coba lagi.'));
  }, timeoutMs);

  try {
    const reader = new window.NDEFReader();
    reader.onreading = (event) => {
      if (!finish()) return;
      const serialNumber = String(event?.serialNumber || '');
      if (serialNumber) {
        onTag?.(serialNumber);
      } else {
        onError?.(new Error('Tag terbaca tetapi tidak memiliki ID.'));
      }
    };
    reader.onreadingerror = () => {
      if (finish()) onError?.(new Error('Tag NFC tidak bisa dibaca. Coba tempelkan ulang.'));
    };
    reader.scan({ signal: controller.signal }).catch((error) => {
      if (error?.name === 'AbortError') return;
      if (finish()) {
        onError?.(new Error(error?.name === 'NotAllowedError'
          ? 'Izin NFC ditolak. Izinkan NFC untuk situs ini lalu coba lagi.'
          : 'NFC tidak aktif atau tidak tersedia. Nyalakan NFC di pengaturan HP.'));
      }
    });
  } catch (error) {
    if (finish()) onError?.(error instanceof Error ? error : new Error('Gagal memulai scan NFC.'));
  }

  return () => { finish(); };
}
