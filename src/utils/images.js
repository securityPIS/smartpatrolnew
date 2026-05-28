/*
Tujuan: Kompresi gambar ke WebP dengan resize dan quality yang bisa diatur, termasuk pembuatan varian thumbnail + full untuk pipeline 2-storage.
Caller: PatrolCameraModal, PatrolFormView, IncidentFormView, dan komponen lain yang perlu upload foto.
Dependensi: Canvas API browser.
Main Functions: readImageFileAsDataUrl (resize + WebP), resizeDataUrlToWebp (re-encode dataURL), createPhotoVariants (thumb+full), readFileAsDataUrl (fallback baca mentah).
Side Effects: Memakai canvas 2D untuk kompresi WebP. Me-revoke objectURL setelah selesai.
*/

export async function readImageFileAsDataUrl(file, maxEdge = 1600, quality = 0.88) {
  if (!file || !file.type.startsWith("image/")) {
    throw new Error("File yang dipilih bukan gambar.");
  }

  const objectUrl = URL.createObjectURL(file);

  try {
    try {
      const image = await loadImage(objectUrl);
      const longestSide = Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height, 1);
      const scale = Math.min(1, maxEdge / longestSide);
      const width = Math.max(1, Math.round((image.naturalWidth || image.width) * scale));
      const height = Math.max(1, Math.round((image.naturalHeight || image.height) * scale));

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;

      const context = canvas.getContext("2d", { alpha: false });
      if (!context) {
        throw new Error("Browser tidak mendukung kompresi gambar.");
      }

      context.drawImage(image, 0, 0, width, height);
      return canvas.toDataURL("image/webp", quality);
    } catch (error) {
      // Fallback ini menjaga upload tetap jalan untuk format kamera tertentu
      // yang gagal dirender ulang lewat canvas/browser.
      console.warn("Kompresi gambar gagal, memakai file asli.", error);
      return readFileAsDataUrl(file);
    }
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

// Re-encode sebuah data URL gambar ke WebP pada ukuran maksimum tertentu.
// Dipakai untuk membuat varian (full/thumbnail) dari foto yang sudah ada di memori.
export async function resizeDataUrlToWebp(dataUrl, maxEdge = 2000, quality = 0.8) {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) {
    throw new Error("Sumber gambar tidak valid.");
  }

  const image = await loadImage(dataUrl);
  const longestSide = Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height, 1);
  const scale = Math.min(1, maxEdge / longestSide);
  const width = Math.max(1, Math.round((image.naturalWidth || image.width) * scale));
  const height = Math.max(1, Math.round((image.naturalHeight || image.height) * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d", { alpha: false });
  if (!context) {
    throw new Error("Browser tidak mendukung kompresi gambar.");
  }

  context.drawImage(image, 0, 0, width, height);
  return canvas.toDataURL("image/webp", quality);
}

// Bangun dua varian dari satu foto sumber: full (≤2000px, view R2) dan thumbnail
// (≤360px, ditampilkan inline lewat Supabase). Thumbnail diturunkan dari full agar
// hanya butuh satu decode tambahan.
export async function createPhotoVariants(sourceDataUrl, options = {}) {
  const {
    fullMaxEdge = 2000,
    fullQuality = 0.8,
    thumbMaxEdge = 360,
    thumbQuality = 0.5,
  } = options;

  const full = await resizeDataUrlToWebp(sourceDataUrl, fullMaxEdge, fullQuality);
  const thumb = await resizeDataUrlToWebp(full, thumbMaxEdge, thumbQuality);
  return { full, thumb };
}

function loadImage(source) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Gagal membaca gambar."));
    image.src = source;
  });
}

export function readFileAsDataUrl(file) {
  if (!file) {
    return Promise.reject(new Error("File tidak ditemukan."));
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Gagal membaca file."));
    reader.readAsDataURL(file);
  });
}