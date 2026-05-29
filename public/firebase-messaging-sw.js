/*
 * Service worker FCM untuk web push SmartPatrol (browser/PWA, tanpa Capacitor).
 * Berjalan di background sehingga notifikasi tetap muncul walau tab/app ditutup.
 *
 * Catatan: firebaseConfig di sini adalah konfigurasi PUBLIK Firebase Web (apiKey dkk
 * memang dirancang untuk dibundel di klien) — bukan kredensial rahasia. Service worker
 * tidak bisa membaca import.meta.env, jadi nilainya ditulis langsung di sini.
 * Versi compat harus selaras dengan dependency "firebase" di package.json.
 */
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: 'AIzaSyD327bjyYQ8oakcO1ESZfhRYOF1KoV5-yQ',
  authDomain: 'smartpatrolnew.firebaseapp.com',
  projectId: 'smartpatrolnew',
  storageBucket: 'smartpatrolnew.firebasestorage.app',
  messagingSenderId: '956798120421',
  appId: '1:956798120421:web:48332b21980e09ac027f0c',
});

const messaging = firebase.messaging();

// Pesan dari server menyertakan webpush.notification sehingga browser menampilkannya otomatis.
// onBackgroundMessage hanya menampilkan manual untuk pesan data-only (jaga-jaga) agar tidak dobel.
messaging.onBackgroundMessage((payload) => {
  if (payload && payload.notification) return;
  const data = (payload && payload.data) || {};
  self.registration.showNotification(data.title || 'SmartPatrol', {
    body: data.body || '',
    icon: '/favicon-smartpatrol.svg',
    badge: '/favicon-smartpatrol.svg',
    tag: data.type || 'smartpatrol',
    data,
  });
});

// Klik notifikasi: fokuskan tab yang ada atau buka baru, dengan deep-link incidentId bila ada.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const incidentId = data.incidentId || data.FCM_MSG?.data?.incidentId || '';
  const targetUrl = incidentId ? `/?incidentId=${encodeURIComponent(incidentId)}` : '/';

  event.waitUntil((async () => {
    const allClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of allClients) {
      if ('focus' in client) {
        if ('navigate' in client) {
          try { await client.navigate(targetUrl); } catch (_) { /* abaikan */ }
        }
        return client.focus();
      }
    }
    if (clients.openWindow) return clients.openWindow(targetUrl);
    return undefined;
  })());
});
