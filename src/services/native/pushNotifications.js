/*
Tujuan: Web push notification berbasis FCM untuk browser/PWA (tanpa Capacitor/Android).
Caller: AppContextRuntime setelah user operasional berhasil login (effect setupNativePushNotifications).
Dependensi: Firebase JS SDK (app + messaging), service worker /firebase-messaging-sw.js,
            VITE_FIREBASE_* & VITE_FCM_VAPID_KEY, tabel push_subscriptions via Supabase.
Main Functions: Minta izin notifikasi, daftarkan SW, ambil FCM token, simpan ke push_subscriptions,
                dengarkan pesan foreground; teardown: lepas listener & hapus token.
Side Effects: Registrasi service worker, prompt izin notifikasi, tulis/hapus push_subscriptions.
*/

import { initializeApp, getApps } from 'firebase/app';
import { getMessaging, getToken, isSupported, onMessage } from 'firebase/messaging';
import { removePushSubscription, upsertPushSubscription } from '../backend/pushSubscriptions';

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

function mapPushPayloadToNotification(incoming = {}) {
  const data = incoming.data || {};
  const fallback = incoming.notification || {};
  return {
    type: data.type || 'push',
    title: data.title || fallback.title || 'SmartPatrol',
    body: data.body || fallback.body || '',
    route: data.route || '',
    incidentId: data.incidentId || '',
    shipName: data.shipName || '',
    shiftKey: data.shiftKey || '',
    historyId: data.historyId || '',
    senderName: data.senderName || 'SmartPatrol',
    createdAt: data.createdAt || new Date().toISOString(),
  };
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
    }

    const unsubscribeForeground = onMessage(messaging, (incoming) => {
      handlers.onNotification?.(mapPushPayloadToNotification(incoming));
    });

    return () => {
      try { unsubscribeForeground?.(); } catch { /* abaikan */ }
      // Hapus token saat user berganti/logout agar device tidak menerima push milik akun lama.
      if (token) void removePushSubscription(token).catch(() => {});
    };
  } catch (error) {
    console.error('Setup web push (FCM) gagal', error);
    return NOOP;
  }
}
