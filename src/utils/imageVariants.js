/*
Tujuan: Membuat dan menyimpan beberapa resolusi foto (thumbnail 64px, hero 500px, full) dari satu data URL.
Caller: Handler upload foto patroli/insiden/galeri/progress di AppContextRuntime.
Dependensi: Canvas API browser dan image store IndexedDB.
Main Functions: saveImagePhotoSet (generate varian + simpan), deriveLocalVariantKey (turunkan key varian dari key dasar).
Side Effects: Memakai canvas 2D untuk downscale WebP dan menulis beberapa entri ke IndexedDB.
*/

import { saveImageVariantsToDB } from './imageStore';

export const HERO_VARIANT_MAX_EDGE = 500;
export const THUMB_VARIANT_MAX_EDGE = 64;
const VARIANT_QUALITY = 0.8;

function loadImage(source) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Gagal membaca gambar untuk varian.'));
    image.src = source;
  });
}

function downscaleToDataUrl(image, maxEdge, quality) {
  const longestSide = Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height, 1);
  const scale = Math.min(1, maxEdge / longestSide);
  const width = Math.max(1, Math.round((image.naturalWidth || image.width) * scale));
  const height = Math.max(1, Math.round((image.naturalHeight || image.height) * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext('2d', { alpha: false });
  if (!context) {
    throw new Error('Browser tidak mendukung pembuatan varian gambar.');
  }

  context.drawImage(image, 0, 0, width, height);
  return canvas.toDataURL('image/webp', quality);
}

/*
Membuat varian hero (500px) dan thumbnail (64px) dari data URL full yang sudah dikompres,
lalu menyimpan ketiganya ke IndexedDB. Mengembalikan { photoUrl, heroUrl, thumbUrl } berisi
key idb:// yang bisa diturunkan satu sama lain. Bila pembuatan varian gagal (mis. browser
tanpa canvas), hero/thumb otomatis fallback ke key foto penuh sehingga upload tetap jalan.
*/
export async function saveImagePhotoSet(fullDataUrl) {
  if (!fullDataUrl || typeof fullDataUrl !== 'string') return null;

  let hero = null;
  let thumb = null;
  try {
    const image = await loadImage(fullDataUrl);
    hero = downscaleToDataUrl(image, HERO_VARIANT_MAX_EDGE, VARIANT_QUALITY);
    thumb = downscaleToDataUrl(image, THUMB_VARIANT_MAX_EDGE, VARIANT_QUALITY);
  } catch (error) {
    // Fallback ini menjaga upload tetap jalan walau varian gagal dibuat — foto penuh
    // tetap tersimpan dan dipakai untuk semua ukuran tampilan.
    console.warn('Gagal membuat varian gambar, memakai foto penuh untuk semua ukuran.', error);
  }

  return saveImageVariantsToDB({ full: fullDataUrl, hero, thumb });
}
