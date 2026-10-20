/*
Tujuan: Data dummy titik checkpoint berstatus UNSOLVE untuk simulasi di halaman patroli: saat
        diklik menampilkan informasi unsolve (temuan awal, catatan PIC Security, foto kondisi saat
        unsolve) beserta pilihan AMAN / TEMUAN.
Caller: PatrolPage (kartu contoh di mode normal; pilihan hanya toast), followUpStore & data/demoData
        (akun demo: titik "Pagar Dek Kiri" nyata dengan override ini → AMAN/TEMUAN seperti go live).
Side Effects: Tidak ada (konstanta).
*/

// Ilustrasi sederhana kondisi pagar dek berkarat (SVG inline, tanpa unduhan).
const DEMO_UNSOLVE_PHOTO_URL = `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1e3a5f"/><stop offset="1" stop-color="#0f172a"/></linearGradient></defs>
<rect width="640" height="360" fill="url(#sky)"/>
<rect y="250" width="640" height="110" fill="#334155"/>
<g stroke="#9a3412" stroke-width="10" stroke-linecap="round">
<line x1="40" y1="140" x2="600" y2="150"/><line x1="40" y1="195" x2="600" y2="200"/>
<line x1="80" y1="130" x2="80" y2="252"/><line x1="220" y1="134" x2="225" y2="252"/>
<line x1="360" y1="138" x2="350" y2="252"/><line x1="500" y1="142" x2="512" y2="252"/>
</g>
<g fill="#c2410c" opacity="0.8"><circle cx="230" cy="170" r="14"/><circle cx="355" cy="200" r="10"/><circle cx="505" cy="160" r="12"/></g>
<rect x="20" y="20" width="250" height="34" rx="8" fill="#0b1229" opacity="0.85"/>
<text x="34" y="43" font-family="sans-serif" font-size="16" fill="#fdba74">Kondisi saat Unsolve</text>
</svg>`)}`;

const minutesAgoIso = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();

// Akun demo: titik nyata di kapal demo yang memakai override Unsolve ini (lihat data/demoData.js).
export const DEMO_SHIP_ID = 'demo-ship-1';
export const DEMO_UNSOLVE_CHECKPOINT_NAME = 'Pagar Dek Kiri';

export const DEMO_UNSOLVE_CHECKPOINT = {
  item: { id: 'demo-unsolve-checkpoint', name: 'Pagar Dek Kiri (Contoh)' },
  definition: { id: 'demo-unsolve-checkpoint', name: 'Pagar Dek Kiri (Contoh)', type: 'main', desc: 'Titik contoh simulasi temuan Unsolve' },
  override: {
    referencePhotoUrl: DEMO_UNSOLVE_PHOTO_URL,
    updatedAt: minutesAgoIso(60 * 26),
    incidentId: 'demo-unsolve-incident',
    note: 'Pagar dek berkarat perlu penggantian total saat docking tahunan. Sudah dipasang rambu & tali pengaman sementara; kondisi ini diterima sampai jadwal docking.',
    actorName: 'PIC Security',
    temuan: { deskripsi: 'Pagar pengaman dek sisi kiri berkarat dan longgar di dua titik sambungan.', date: '10 Okt 2026', time: '21.15', reportedBy: 'Petugas Security' },
    followUpCount: 3,
  },
};
