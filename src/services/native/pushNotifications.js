/*
Tujuan: Web push notification berbasis FCM untuk browser/PWA (tanpa Capacitor/Android).
Caller: AppContextRuntime setelah user operasional berhasil login (effect setupNativePushNotifications).
Dependensi: Firebase JS SDK (app + messaging), service worker /firebase-messaging-sw.js,
            VITE_FIREBASE_* & VITE_FCM_VAPID_KEY, tabel push_subscriptions via Supabase.
Main Functions: Minta izin notifikasi, daftarkan SW, ambil FCM token, simpan ke push_subscriptions,
                laporkan token via handlers.onToken; teardown hanya lepas listener (token
                dipertahankan untuk background push, dihapus caller saat logout).
Side Effects: Registrasi service worker, prompt izin notifikasi, tulis push_subscriptions.
*/

import { initializeApp, getApps } from 'firebase/app';
import { getMessaging, getToken, isSupported, onMessage } from 'firebase/messaging';
import { upsertPushSubscription } from '../backend/pushSubscriptions';

// Catatan foreground: saat tab aktif, FCM tidak menampilkan notifikasi sistem dan memanggil
// onMessage. Kita SENGAJA tidak menambahkan notifikasi ke inbox di sini karena Supabase
// Realtime (subscribe tabel notifications) sudah mengirim baris yang sama; menambah lagi
// akan terhitung sebagai notifikasi baru dan ter-persist ulang (duplikat). Web push berperan
// utama saat tab/app TIDAK aktif — itu ditangani service worker di background.

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || '',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || '',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || '',
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || '',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || '',
  appId: import.meta.env.VITE_FIREBASE_APP_ID || '',
};
const VAPID_KEY = import.meta.env.VITE_FCM_VAPID_KEY || '';

const NOOP = () => {};

function isPushConfigured() {
  return Boolean(firebaseConfig.apiKey && firebaseConfig.messagingSenderId && firebaseConfig.appId && VAPID_KEY);
}

function getFirebaseApp() {
  return getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
}

export async function setupNativePushNotifications(profile, handlers = {}) {
  try {
    if (typeof window === 'undefined') return NOOP;
    if (!('serviceWorker' in navigator) || !('Notification' in window) || !('PushManager' in window)) {
      return NOOP;
    }
    if (!isPushConfigured()) return NOOP;

    const userId = profile?.legacyUserId || '';
    if (!userId) return NOOP;

    if (!(await isSupported().catch(() => false))) return NOOP;

    const registration = await navigator.serviceWorker.register('/firebase-messaging-sw.js', { scope: '/' });

    let permission = Notification.permission;
    if (permission === 'default') {
      permission = await Notification.requestPermission();
    }
    if (permission !== 'granted') return NOOP;

    const messaging = getMessaging(getFirebaseApp());
    const token = await getToken(messaging, {
      vapidKey: VAPID_KEY,
      serviceWorkerRegistration: registration,
    }).catch((error) => {
      console.warn('Gagal mengambil FCM token', error);
      return '';
    });

    if (token) {
      await upsertPushSubscription({ userId, token, userAgent: navigator.userAgent }).catch((error) => {
        console.warn('Gagal menyimpan langganan push', error);
      });
      // Beritahu caller token aktif agar bisa dihapus saat logout eksplisit.
      try { handlers.onToken?.(token); } catch { /* abaikan */ }
    }

    // Subscribe foreground hanya untuk mencegah warning SDK & membuka peluang debug.
    // Tidak menambah ke inbox (lihat catatan di atas) — Realtime yang menangani.
    const unsubscribeForeground = onMessage(messaging, () => { /* in-app via Realtime */ });

    return () => {
      // Hanya lepas listener foreground. Token TIDAK dihapus di sini: penghapusan saat
      // setiap cleanup effect menyebabkan churn (baris push_subscriptions hilang) dan
      // melawan tujuan background push. Penghapusan token dilakukan caller saat logout.
      try { unsubscribeForeground?.(); } catch { /* abaikan */ }
    };
  } catch (error) {
    console.error('Setup web push (FCM) gagal', error);
    return NOOP;
  }
}
