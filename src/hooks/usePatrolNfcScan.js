/*
Tujuan: Scan NFC terus-menerus di tab Checkpoint patroli; tag yang cocok dengan titik kapal
        operasional membuka pilihan Aman/Temuan untuk titik tersebut.
Caller: PatrolPage.
Dependensi: services/native/nfc, utils/shipCheckpoints.
Main Functions: usePatrolNfcScan → { support, scanState, notice, clearNotice }.
Side Effects: Reader mode NFC aktif selama `active` true dan halaman terlihat.
*/

import { useEffect, useRef, useState } from 'react';
import { getNfcSupport, subscribeNfcTags } from '../services/native/nfc';
import {
  createCheckpointNameKey, findCheckpointByNfcTag, findShipCheckpointByNfcTag, getScannedNfcKeys,
} from '../utils/shipCheckpoints';

const DUPLICATE_TAP_WINDOW_MS = 2500;

export function usePatrolNfcScan({ active, ship, ships, checkpoints, onCheckpointScanned, allowCompleted = false }) {
  const [support, setSupport] = useState({ supported: false, enabled: false, checked: false });
  const [scanState, setScanState] = useState('idle'); // idle | scanning | error
  const [notice, setNotice] = useState(null); // { tone: 'warning' | 'error', message }
  const [isPageVisible, setIsPageVisible] = useState(() => (
    typeof document === 'undefined' ? true : document.visibilityState !== 'hidden'
  ));
  const latestRef = useRef({});
  const lastTapRef = useRef({ key: '', at: 0 });
  latestRef.current = { ship, ships, checkpoints, onCheckpointScanned, allowCompleted };

  useEffect(() => {
    let cancelled = false;
    const refresh = () => getNfcSupport().then((nextSupport) => {
      if (!cancelled) setSupport({ ...nextSupport, checked: true });
    });
    refresh();
    const handleVisibility = () => {
      const visible = document.visibilityState !== 'hidden';
      setIsPageVisible(visible);
      // NFC bisa dinyalakan user lewat pengaturan lalu kembali ke aplikasi.
      if (visible) refresh();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, []);

  const shouldScan = Boolean(active && isPageVisible && support.supported && support.enabled);

  useEffect(() => {
    if (!shouldScan) {
      setScanState('idle');
      return undefined;
    }
    setScanState('scanning');
    const stop = subscribeNfcTags({
      onTag: (tag) => {
        const keys = getScannedNfcKeys(tag);
        const tapKey = keys.join('|');
        const now = Date.now();
        // Tag yang masih menempel bisa terbaca berulang; abaikan tap ganda yang berdekatan.
        if (tapKey === lastTapRef.current.key && now - lastTapRef.current.at < DUPLICATE_TAP_WINDOW_MS) return;
        lastTapRef.current = { key: tapKey, at: now };

        const { ship: currentShip, ships: allShips, checkpoints: liveCheckpoints, onCheckpointScanned: onScanned, allowCompleted: canRescanCompleted } = latestRef.current;
        const definition = findCheckpointByNfcTag(currentShip?.customCheckpoints, tag);
        if (!definition) {
          const owner = findShipCheckpointByNfcTag(allShips, tag);
          setNotice({
            tone: 'error',
            message: owner
              ? `Tag ini milik titik "${owner.checkpoint.name}" di ${owner.ship.name}, bukan kapal ${currentShip?.name || 'Anda'}.`
              : `Tag NFC tidak terdaftar${keys[0] ? ` (${keys[0]})` : ''}. Minta admin mendaftarkannya di menu Armada → TITIK.`,
          });
          return;
        }
        const nameKey = createCheckpointNameKey(definition.name);
        const liveItem = (Array.isArray(liveCheckpoints) ? liveCheckpoints : [])
          .find(item => !item?.isTemporaryShiftNode && createCheckpointNameKey(item?.name) === nameKey);
        if (!liveItem) {
          setNotice({ tone: 'error', message: `Titik "${definition.name}" belum tersedia di daftar patroli shift ini.` });
          return;
        }
        if (liveItem.status === 'completed' && !canRescanCompleted) {
          setNotice({ tone: 'warning', message: `Titik "${definition.name}" sudah dilaporkan shift ini.` });
          return;
        }
        setNotice(null);
        onScanned?.({ item: liveItem, definition, tagId: definition.nfcTagId });
      },
      onError: (error) => {
        setScanState('error');
        setNotice({ tone: 'error', message: error.message });
      },
    });
    return stop;
  }, [shouldScan]);

  return { support, scanState, notice, clearNotice: () => setNotice(null) };
}
