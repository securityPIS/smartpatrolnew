/*
Tujuan: Membaca tag NFC (UID + isi NDEF teks/URI) untuk pendaftaran titik checkpoint dan
        verifikasi kehadiran petugas saat patroli.
Caller: Tab TITIK di ShipsPage (daftarkan tag) dan PatrolPage (scan → pilih Aman/Temuan).
Dependensi: @capgo/capacitor-nfc (aplikasi Android/Capacitor) dan Web NFC / NDEFReader
        (Chrome Android via HTTPS). Platform lain tidak bisa scan.
Main Functions: getNfcSupport, subscribeNfcTags (scan terus-menerus), startNfcTagScan (sekali),
        decodeNdefRecord.
Side Effects: Mengaktifkan reader mode NFC perangkat selama ada pelanggan aktif. Hanya SATU
        pelanggan aktif sekaligus — pelanggan baru menghentikan yang lama.
*/

import { Capacitor } from '@capacitor/core';

const URI_PREFIXES = [
  '', 'http://www.', 'https://www.', 'http://', 'https://', 'tel:', 'mailto:',
  'ftp://anonymous:anonymous@', 'ftp://ftp.', 'ftps://', 'sftp://', 'smb://', 'nfs://', 'ftp://',
  'dav://', 'news:', 'telnet://', 'imap:', 'rtsp://', 'urn:', 'pop:', 'sip:', 'sips:', 'tftp:',
  'btspp://', 'btl2cap://', 'btgoep://', 'tcpobex://', 'irdaobex://', 'file://', 'urn:epc:id:',
  'urn:epc:tag:', 'urn:epc:pat:', 'urn:epc:raw:', 'urn:epc:', 'urn:nfc:',
];

let nfcModulePromise = null;
let activeSubscription = null;

function isNativeRuntime() {
  return Boolean(Capacitor?.isNativePlatform?.());
}

function hasWebNfc() {
  return typeof window !== 'undefined' && 'NDEFReader' in window;
}

function getNativeNfcModule() {
  if (!nfcModulePromise) {
    nfcModulePromise = import('@capgo/capacitor-nfc').catch((error) => {
      nfcModulePromise = null;
      throw error;
    });
  }
  return nfcModulePromise;
}

function bytesToHexId(bytes) {
  if (!Array.isArray(bytes) || bytes.length === 0) return '';
  return bytes.map(byte => (Number(byte) & 0xff).toString(16).padStart(2, '0')).join(':').toUpperCase();
}

function decodeBytes(bytes, encoding = 'utf-8') {
  try {
    return new TextDecoder(encoding).decode(Uint8Array.from(bytes, byte => Number(byte) & 0xff));
  } catch {
    return '';
  }
}

// Record NDEF (format plugin native: tnf + array byte) → string isi, atau '' bila bukan teks/URI.
export function decodeNdefRecord(record) {
  const tnf = Number(record?.tnf);
  const type = decodeBytes(record?.type || [], 'ascii');
  const payload = Array.isArray(record?.payload) ? record.payload : [];
  if (payload.length === 0) return '';

  if (tnf === 1 && type === 'T') {
    const status = Number(payload[0]) & 0xff;
    const languageLength = status & 0x3f;
    return decodeBytes(payload.slice(1 + languageLength), status & 0x80 ? 'utf-16' : 'utf-8').trim();
  }
  if (tnf === 1 && type === 'U') {
    return `${URI_PREFIXES[Number(payload[0]) & 0xff] || ''}${decodeBytes(payload.slice(1))}`.trim();
  }
  if (tnf === 2 && type.startsWith('text/')) {
    return decodeBytes(payload).trim();
  }
  return '';
}

function decodeWebNdefRecord(record) {
  try {
    if (record?.recordType === 'text') {
      return new TextDecoder(record.encoding || 'utf-8').decode(record.data).trim();
    }
    if (record?.recordType === 'url' || record?.recordType === 'absolute-url') {
      return new TextDecoder().decode(record.data).trim();
    }
    if (record?.recordType === 'mime' && String(record.mediaType || '').startsWith('text/')) {
      return new TextDecoder().decode(record.data).trim();
    }
  } catch {
    // abaikan record yang tidak bisa didekode
  }
  return '';
}

/*
Hasil: { supported, mode: 'native' | 'web' | null, enabled }. `enabled` false berarti perangkat
punya NFC tetapi sedang dimatikan (hanya terdeteksi di native).
*/
export async function getNfcSupport() {
  if (isNativeRuntime()) {
    try {
      const { CapacitorNfc } = await getNativeNfcModule();
      const { status } = await CapacitorNfc.getStatus();
      if (status === 'NO_NFC') return { supported: false, mode: null, enabled: false };
      return { supported: true, mode: 'native', enabled: status !== 'NFC_DISABLED' };
    } catch {
      return { supported: false, mode: null, enabled: false };
    }
  }
  if (hasWebNfc()) return { supported: true, mode: 'web', enabled: true };
  return { supported: false, mode: null, enabled: false };
}

export async function openNfcSettings() {
  if (!isNativeRuntime()) return;
  try {
    const { CapacitorNfc } = await getNativeNfcModule();
    await CapacitorNfc.showSettings();
  } catch {
    // perangkat tanpa layar pengaturan NFC
  }
}

function describeScanError(error) {
  const message = String(error?.message || error || '');
  if (error?.name === 'NotAllowedError') return 'Izin NFC ditolak. Izinkan NFC untuk situs ini lalu coba lagi.';
  if (/disabled|not enabled|turned off/i.test(message)) return 'NFC sedang mati. Nyalakan NFC di pengaturan HP.';
  return 'NFC tidak aktif atau tidak tersedia di perangkat ini.';
}

async function startNativeScan(subscription) {
  const { CapacitorNfc } = await getNativeNfcModule();
  const handle = await CapacitorNfc.addListener('nfcEvent', (event) => {
    const tag = event?.tag || {};
    subscription.emit({
      uid: bytesToHexId(tag.id),
      contents: (Array.isArray(tag.ndefMessage) ? tag.ndefMessage : []).map(decodeNdefRecord).filter(Boolean),
    });
  });
  subscription.cleanups.push(() => {
    handle?.remove?.();
    CapacitorNfc.stopScanning().catch(() => {});
  });
  if (subscription.stopped) return;
  await CapacitorNfc.startScanning({ invalidateAfterFirstRead: false, iosSessionType: 'ndef' });
}

async function startWebScan(subscription) {
  const controller = new AbortController();
  subscription.cleanups.push(() => controller.abort());
  const reader = new window.NDEFReader();
  reader.onreading = (event) => {
    subscription.emit({
      uid: String(event?.serialNumber || '').toUpperCase(),
      contents: Array.from(event?.message?.records || []).map(decodeWebNdefRecord).filter(Boolean),
    });
  };
  reader.onreadingerror = () => subscription.fail(new Error('Tag NFC tidak bisa dibaca. Tempelkan ulang tag ke HP.'), { fatal: false });
  await reader.scan({ signal: controller.signal });
}

/*
Scan terus-menerus sampai stop() dipanggil. onTag menerima { uid, contents: string[] }.
onError menerima Error; error fatal (izin ditolak, NFC mati) menghentikan scan.
*/
export function subscribeNfcTags({ onTag, onError } = {}) {
  activeSubscription?.stop();

  const subscription = {
    stopped: false,
    cleanups: [],
    emit(tag) {
      if (subscription.stopped) return;
      if (!tag.uid && tag.contents.length === 0) return;
      onTag?.(tag);
    },
    fail(error, { fatal = true } = {}) {
      if (subscription.stopped) return;
      if (fatal) subscription.stop();
      onError?.(error);
    },
    stop() {
      if (subscription.stopped) return;
      subscription.stopped = true;
      subscription.cleanups.splice(0).forEach((cleanup) => {
        try { cleanup(); } catch { /* abaikan */ }
      });
      if (activeSubscription === subscription) activeSubscription = null;
    },
  };
  activeSubscription = subscription;

  const start = isNativeRuntime() ? startNativeScan : (hasWebNfc() ? startWebScan : null);
  if (!start) {
    queueMicrotask(() => subscription.fail(new Error('Scan NFC belum didukung di perangkat/browser ini.')));
  } else {
    start(subscription).catch((error) => {
      if (error?.name === 'AbortError') return;
      subscription.fail(new Error(describeScanError(error)));
    });
  }

  return () => subscription.stop();
}

// Scan sekali (form pendaftaran tag di tab TITIK), dengan batas waktu.
export function startNfcTagScan({ onTag, onError, timeoutMs = 30000 } = {}) {
  let stop = () => {};
  const timerId = setTimeout(() => {
    stop();
    onError?.(new Error('Tidak ada tag NFC terbaca. Tempelkan tag ke bagian belakang HP lalu coba lagi.'));
  }, timeoutMs);
  stop = subscribeNfcTags({
    onTag: (tag) => {
      clearTimeout(timerId);
      stop();
      onTag?.(tag);
    },
    onError: (error) => {
      clearTimeout(timerId);
      stop();
      onError?.(error);
    },
  });
  return () => {
    clearTimeout(timerId);
    stop();
  };
}
