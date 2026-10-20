/*
Tujuan: Membuat SATU dokumen PDF per temuan: ringkasan 5W1H + daftar semua instruksi tindak lanjut.
Caller: FollowUpPanels (tombol PDF kecil di header section Tindak Lanjut).
Dependensi: jspdf (di-import dinamis agar tidak membebani bundle awal).
Main Functions: buildIncidentFollowUpPdfFileName, createIncidentFollowUpPdf, openIncidentFollowUpPdf.
Side Effects: Membuka PDF di tab/viewer baru, atau mengunduhnya bila pop-up diblokir.
*/

function sanitizeFileToken(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 40) || 'temuan';
}

export function buildIncidentFollowUpPdfFileName(incident) {
  return `Temuan-${sanitizeFileToken(incident?.location)}-TindakLanjut.pdf`;
}

async function loadImageAsDataUrl(url) {
  if (!url) return null;
  if (String(url).startsWith('data:image/')) return url;
  try {
    return await new Promise((resolve, reject) => {
      const image = new Image();
      image.crossOrigin = 'anonymous';
      image.onload = () => {
        try {
          const scale = Math.min(1, 1024 / Math.max(image.naturalWidth, image.naturalHeight));
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(image.naturalWidth * scale);
          canvas.height = Math.round(image.naturalHeight * scale);
          canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', 0.8));
        } catch (error) {
          reject(error);
        }
      };
      image.onerror = reject;
      image.src = url;
    });
  } catch {
    return null;
  }
}

function getImageSize(dataUrl) {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => resolve(null);
    image.src = dataUrl;
  });
}

// items: [{ sequence, assigneeLabel, instruction, statusLabel, photoUrl }] — semua tindak lanjut temuan.
export async function createIncidentFollowUpPdf({ incident, items = [], securityName, generatedAt }) {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 16;
  const contentWidth = pageWidth - margin * 2;
  let cursorY = margin;

  const ensureSpace = (height) => {
    if (cursorY + height <= pageHeight - margin) return;
    doc.addPage();
    cursorY = margin;
  };

  const writeField = (label, value) => {
    const lines = doc.splitTextToSize(String(value || '-'), contentWidth);
    ensureSpace(8 + lines.length * 5);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(90, 100, 120);
    doc.text(label.toUpperCase(), margin, cursorY);
    cursorY += 5;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(11);
    doc.setTextColor(20, 24, 36);
    doc.text(lines, margin, cursorY);
    cursorY += lines.length * 5 + 4;
  };

  const writeHeading = (title) => {
    ensureSpace(12);
    doc.setDrawColor(200, 205, 215);
    doc.line(margin, cursorY - 1, pageWidth - margin, cursorY - 1);
    cursorY += 5;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(11, 18, 41);
    doc.text(title, margin, cursorY);
    cursorY += 7;
  };

  const writeImage = async (title, url) => {
    const dataUrl = await loadImageAsDataUrl(url);
    if (!dataUrl) return;
    const size = await getImageSize(dataUrl);
    if (!size) return;
    const width = Math.min(contentWidth, 120);
    const height = Math.min(90, (size.height / size.width) * width);
    ensureSpace(height + 10);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(90, 100, 120);
    doc.text(title.toUpperCase(), margin, cursorY);
    cursorY += 3;
    try {
      doc.addImage(dataUrl, 'JPEG', margin, cursorY, (size.width / size.height) * height, height);
      cursorY += height + 6;
    } catch {
      cursorY += 3;
    }
  };

  doc.setFillColor(11, 18, 41);
  doc.rect(0, 0, pageWidth, 28, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.text('SMARTPATROL — TINDAK LANJUT TEMUAN', margin, 13);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(`${items.length} tindak lanjut · dibuat otomatis ${new Date(generatedAt || Date.now()).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}`, margin, 21);
  cursorY = 38;

  writeField('What — Deskripsi', incident?.deskripsi);
  writeField('Where — Lokasi & Kapal', `${incident?.location || '-'} · ${incident?.shipName || '-'}`);
  writeField('When — Waktu Kejadian', `${incident?.date || '-'} ${incident?.time || ''}`);
  writeField('Why — Penyebab', incident?.penyebab);
  writeField('Who — Pelapor', incident?.reportedBy);
  writeField('How — Tindak Lanjut Awal', incident?.tindakLanjut);
  await writeImage('Foto temuan', incident?.photoUrl);

  for (const item of items) {
    writeHeading(`Tindak Lanjut #${item.sequence}`);
    writeField('Ditugaskan kepada', item.assigneeLabel);
    writeField('Ditugaskan oleh', `PIC Security (${securityName || '-'})`);
    if (item.statusLabel) writeField('Status', item.statusLabel);
    writeField('Instruksi', item.instruction);
    await writeImage('Foto lampiran instruksi', item.photoUrl);
  }

  return doc;
}

export async function openIncidentFollowUpPdf(options) {
  const doc = await createIncidentFollowUpPdf(options);
  const fileName = buildIncidentFollowUpPdfFileName(options.incident);
  const blobUrl = doc.output('bloburl');
  const openedWindow = window.open(blobUrl, '_blank');
  if (!openedWindow) doc.save(fileName);
}
