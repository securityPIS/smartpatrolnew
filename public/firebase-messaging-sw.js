/*
 * Service worker FCM untuk web push SmartPatrol (browser/PWA, tanpa Capacitor).
 * Berjalan di background sehingga notifikasi tetap muncul walau tab/app ditutup.
 *
 * Catatan: firebaseConfig di sini adalah konfigurasi PUBLIK Firebase Web (apiKey dkk
 * memang dirancang untuk dibundel di klien) — bukan kredensial rahasia. Service worker
 * tidak bisa membaca import.meta.env, jadi nilainya ditulis langsung di sini.
 * Versi compat harus selaras dengan dependency "firebase" di package.json.
 *
 * Pesan dari server (send-push) menyertakan webpush.notification + webpush.fcm_options.link,
 * sehingga FCM SDK menampilkan notifikasi otomatis di background dan menangani klik
 * (membuka link deep-link incidentId). Karena itu kita TIDAK menambah listener
 * notificationclick sendiri agar tidak membuka tab dobel.
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

// Hanya dipakai untuk pesan data-only (tanpa notification payload) sebagai cadangan.
// Pesan normal kita selalu membawa webpush.notification → ditampilkan otomatis oleh SDK,
// sehingga handler ini early-return agar notifikasi tidak tampil dobel.
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
