/*
Tujuan: Menyediakan outbox IndexedDB ringan untuk mutation SQL saat offline.
Caller: Adapter backend Supabase yang perlu menjamin aksi operasional tetap tercatat lokal.
Dependensi: IndexedDB browser dan handler mutation yang diregistrasikan adapter domain.
Main Functions: Enqueue mutation, register handler flush, retry batch kecil, dan eksponensial backoff.
Side Effects: Menulis IndexedDB `smartpatrol-sql/outbox_mutations`, memasang listener online, dan menghapus item saat flush sukses.
*/

import { isDemoMode } from '../demoMode';

const DB_NAME = 'smartpatrol-sql';
const DB_VERSION = 1;
const OUTBOX_STORE = 'outbox_mutations';
const CACHE_STORE = 'cache_snapshots';
const MAX_BATCH_SIZE = 8;
const BASE_RETRY_DELAY_MS = 2000;
const MAX_RETRY_DELAY_MS = 5 * 60 * 1000;

const handlers = new Map();
let dbPromise = null;
let workerStarted = false;
let flushInFlight = false;
let flushTimer = null;

function canUseIndexedDb() {
  return typeof indexedDB !== 'undefined';
}

function openDb() {
  if (!canUseIndexedDb()) {
    return Promise.reject(new Error('IndexedDB tidak tersedia.'));
  }
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
        const outbox = db.createObjectStore(OUTBOX_STORE, { keyPath: 'id' });
        outbox.createIndex('nextAttemptAt', 'nextAttemptAt', { unique: false });
        outbox.createIndex('queuedAt', 'queuedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(CACHE_STORE)) {
        db.createObjectStore(CACHE_STORE, { keyPath: 'key' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Gagal membuka IndexedDB outbox.'));
  });

  return dbPromise;
}

function runStoreTransaction(storeName, mode, callback) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    const result = callback(store);

    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error || new Error('Transaksi IndexedDB gagal.'));
    transaction.onabort = () => reject(transaction.error || new Error('Transaksi IndexedDB dibatalkan.'));
  }));
}

function createMutationId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `mutation-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function computeNextAttemptAt(attempts) {
  const delay = Math.min(MAX_RETRY_DELAY_MS, BASE_RETRY_DELAY_MS * (2 ** Math.max(0, attempts - 1)));
  return Date.now() + delay;
}

export function registerOutboxHandler(type, handler) {
  if (!type || typeof handler !== 'function') return;
  handlers.set(type, handler);
}

export async function enqueueOutboxMutation(mutation = {}) {
  const type = String(mutation.type || '').trim();
  // Mode demo: tidak ada antrean mutasi ke server.
  if (!type || isDemoMode) return null;

  const queuedAt = Date.now();
  const payload = {
    id: mutation.id || mutation.payload?.client_event_id || createMutationId(),
    type,
    payload: mutation.payload || {},
    queuedAt,
    attempts: Number.isFinite(mutation.attempts) ? mutation.attempts : 0,
    nextAttemptAt: queuedAt,
    lastError: '',
  };

  try {
    await runStoreTransaction(OUTBOX_STORE, 'readwrite', store => store.put(payload));
    scheduleOutboxFlush(250);
    return payload;
  } catch (error) {
    console.error('Gagal menyimpan mutation offline SmartPatrol SQL', error);
    return null;
  }
}

async function readDueMutations(nowMs = Date.now()) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(OUTBOX_STORE, 'readonly');
    const store = transaction.objectStore(OUTBOX_STORE);
    const request = store.getAll();

    request.onsuccess = () => {
      const rows = Array.isArray(request.result) ? request.result : [];
      resolve(rows
        .filter(row => Number(row.nextAttemptAt || 0) <= nowMs)
        .sort((a, b) => Number(a.queuedAt || 0) - Number(b.queuedAt || 0))
        .slice(0, MAX_BATCH_SIZE));
    };
    request.onerror = () => reject(request.error || new Error('Gagal membaca outbox.'));
  });
}

async function deleteMutation(id) {
  await runStoreTransaction(OUTBOX_STORE, 'readwrite', store => store.delete(id));
}

async function markMutationFailed(row, error) {
  const attempts = Number(row.attempts || 0) + 1;
  await runStoreTransaction(OUTBOX_STORE, 'readwrite', store => store.put({
    ...row,
    attempts,
    nextAttemptAt: computeNextAttemptAt(attempts),
    lastError: error?.message || 'Flush mutation gagal',
  }));
}

export async function flushOutboxMutations() {
  if (flushInFlight || !canUseIndexedDb()) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;

  flushInFlight = true;
  try {
    const rows = await readDueMutations();
    for (const row of rows) {
      const handler = handlers.get(row.type);
      if (!handler) continue;

      try {
        await handler(row.payload, { fromOutbox: true });
        await deleteMutation(row.id);
      } catch (error) {
        await markMutationFailed(row, error);
      }
    }
  } finally {
    flushInFlight = false;
  }
}

export function scheduleOutboxFlush(delayMs = 1000) {
  if (flushTimer) window.clearTimeout(flushTimer);
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    flushOutboxMutations().catch((error) => {
      console.warn('Flush outbox SmartPatrol SQL belum berhasil', error);
    });
  }, delayMs);
}

export function startSqlOutboxWorker() {
  if (workerStarted || typeof window === 'undefined') return;
  workerStarted = true;

  window.addEventListener('online', () => scheduleOutboxFlush(500));
  window.setInterval(() => scheduleOutboxFlush(0), 60 * 1000);
  scheduleOutboxFlush(1500);
}

export async function saveCacheSnapshot(key, payload) {
  if (!key || isDemoMode) return;
  await runStoreTransaction(CACHE_STORE, 'readwrite', store => store.put({
    key,
    payload,
    savedAt: Date.now(),
  }));
}

export async function loadCacheSnapshot(key) {
  if (!key || isDemoMode) return null;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(CACHE_STORE, 'readonly');
    const request = transaction.objectStore(CACHE_STORE).get(key);
    request.onsuccess = () => resolve(request.result?.payload ?? null);
    request.onerror = () => reject(request.error || new Error('Gagal membaca cache snapshot.'));
  });
}
