/*
Tujuan: Menyimpan dan memuat foto (termasuk varian thumbnail/hero) di IndexedDB lokal perangkat.
Caller: Handler upload foto di AppContextRuntime, util imageVariants, dan AsyncImage saat resolve key idb://.
Dependensi: IndexedDB browser.
Main Functions: saveImageToDB (simpan satu foto), saveImageVariantsToDB (simpan varian full/hero/thumb), loadImageFromDB (muat), deleteOldImagesFromDB (cleanup berbasis usia).
Side Effects: Membuka/menulis/menghapus object store IndexedDB 'smartpatrol-images'.
*/

const DB_NAME = 'smartpatrol-images';
const STORE_NAME = 'photos';

let dbPromise = null;

function openDB() {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB tidak tersedia di perangkat ini.'));
  }

  if (dbPromise) return dbPromise;
  
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    
    request.onsuccess = (event) => {
      resolve(event.target.result);
    };
    
    request.onerror = (event) => {
      dbPromise = null;
      reject(event.target.error);
    };
  });
  
  return dbPromise;
}

export async function saveImageToDB(dataUrl) {
  try {
    const db = await openDB();
    const key = `idb://img-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put(dataUrl, key);
    
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve(key);
      tx.onerror = () => reject(tx.error);
    });
  } catch (error) {
    console.error('Failed to save image to IndexedDB:', error);
    // Fallback ke data URL menjaga upload tetap bisa dipakai saat IndexedDB
    // diblokir browser/PWA, meski mode ini sebaiknya hanya jadi cadangan.
    return typeof dataUrl === 'string' && dataUrl.startsWith('data:')
      ? dataUrl
      : null;
  }
}

/*
Simpan beberapa varian satu foto (full/hero/thumb) sekaligus. Hero dan thumb disimpan di
bawah key turunan (`${base}@hero`, `${base}@thumb`) sehingga key varian bisa diturunkan dari
key foto penuh tanpa perlu disimpan terpisah. Mengembalikan { photoUrl, heroUrl, thumbUrl };
hero/thumb yang tidak tersedia otomatis fallback ke key foto penuh.
*/
export async function saveImageVariantsToDB({ full, hero, thumb }) {
  if (!full) return null;
  try {
    const db = await openDB();
    const baseKey = `idb://img-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const heroKey = `${baseKey}@hero`;
    const thumbKey = `${baseKey}@thumb`;
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put(full, baseKey);
    if (hero) store.put(hero, heroKey);
    if (thumb) store.put(thumb, thumbKey);

    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve({
        photoUrl: baseKey,
        heroUrl: hero ? heroKey : baseKey,
        thumbUrl: thumb ? thumbKey : baseKey,
      });
      tx.onerror = () => reject(tx.error);
    });
  } catch (error) {
    console.error('Failed to save image variants to IndexedDB:', error);
    // Fallback ke data URL menjaga upload tetap dipakai saat IndexedDB diblokir browser/PWA.
    // Varian yang gagal dibuat ikut memakai data URL penuh.
    const fallback = typeof full === 'string' && full.startsWith('data:') ? full : null;
    if (!fallback) return null;
    return {
      photoUrl: fallback,
      heroUrl: typeof hero === 'string' && hero.startsWith('data:') ? hero : fallback,
      thumbUrl: typeof thumb === 'string' && thumb.startsWith('data:') ? thumb : fallback,
    };
  }
}

export async function loadImageFromDB(key) {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(key);
    
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.error('Failed to load image from IndexedDB:', error);
    return null;
  }
}

export async function deleteOldImagesFromDB(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAllKeys();
    
    return new Promise((resolve, reject) => {
      request.onsuccess = () => {
        const keys = request.result || [];
        const now = Date.now();
        let deletedCount = 0;
        
        keys.forEach(key => {
          // Format: idb://img-1234567890123-abcde
          const match = key.match(/img-(\d+)-/);
          if (match && match[1]) {
            const timestamp = parseInt(match[1], 10);
            if (now - timestamp > maxAgeMs) {
              store.delete(key);
              deletedCount++;
            }
          }
        });
        
        tx.oncomplete = () => resolve(deletedCount);
        tx.onerror = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.error('Failed to cleanup IndexedDB:', error);
    return 0;
  }
}
