/*
Tujuan: Dataset dummy untuk mode demo: akun admin, PIC Security & petugas untuk tiga kapal (titik
        checkpoint main/sub + NFC), riwayat patroli shift sebelumnya, dan temuan dengan tindak lanjut
        PIC fungsi di berbagai status (Need Assign → Closed/Unsolve).
Caller: AppContextRuntime saat isDemoMode (pengganti data tersimpan / cloud; temuan juga di-seed ke
        followUpStore lewat seedDemoIncidentStates).
Dependensi: createPosterDataUrl (gambar placeholder SVG inline).
Main Functions: createDemoUsers, createDemoShips, createDemoPatrolHistory.
Side Effects: Tidak ada; data hanya hidup di memori selama halaman terbuka.
*/

import { createPosterDataUrl } from './defaultData';
import { DEMO_SHIP_ID, DEMO_UNSOLVE_CHECKPOINT_NAME } from '../components/incidentFollowUp/demoUnsolveCheckpoint';

export const DEMO_SHIP_NAME = 'KM Demo Nusantara';
export const DEMO_SHIP_2_ID = 'demo-ship-2';
export const DEMO_SHIP_2_NAME = 'MT Demo Samudra';
export const DEMO_SHIP_3_ID = 'demo-ship-3';
export const DEMO_SHIP_3_NAME = 'KM Demo Bahari';
// Titik DEMO_UNSOLVE_CHECKPOINT_NAME sudah berstatus Unsolve (override foto acuan di-seed followUpStore,
// temuan aslinya ada di riwayat patroli demo dengan id DEMO_UNSOLVE_INCIDENT_ID).
export const DEMO_UNSOLVE_INCIDENT_ID = 'demo-unsolve-incident';

const DEMO_USER_DEFAULTS = { status: 'active', authProvider: 'none' };

function demoUser(id, name, role, type, workerNumber, shipAssigned, emailName, phoneSuffix) {
  return {
    ...DEMO_USER_DEFAULTS, id, name, role, type, workerNumber, shipAssigned,
    email: `${emailName}@smartpatrol.local`, phone: `0812000000${phoneSuffix}`,
  };
}

export function createDemoUsers() {
  return [
    demoUser('demo-admin', 'Admin Demo', 'ADMIN', 'INTERNAL', 'ADM-001', null, 'admin.demo', '01'),
    // KM Demo Nusantara (kapal akun demo petugas).
    demoUser('demo-petugas', 'Petugas Demo', 'PETUGAS', 'BUJP', 'PTG-001', DEMO_SHIP_NAME, 'petugas.demo', '02'),
    demoUser('demo-petugas-2', 'Rekan Petugas Demo', 'PETUGAS', 'BUJP', 'PTG-002', DEMO_SHIP_NAME, 'rekan.demo', '03'),
    demoUser('demo-petugas-3', 'Andi Saputra', 'PETUGAS', 'BUJP', 'PTG-003', DEMO_SHIP_NAME, 'andi.demo', '05'),
    demoUser('demo-pic', 'PIC Security Demo', 'PIC', 'INTERNAL', 'PIC-001', DEMO_SHIP_NAME, 'pic.demo', '04'),
    // MT Demo Samudra.
    demoUser('demo-petugas-4', 'Bayu Firmansyah', 'PETUGAS', 'BUJP', 'PTG-004', DEMO_SHIP_2_NAME, 'bayu.demo', '06'),
    demoUser('demo-petugas-5', 'Citra Lestari', 'PETUGAS', 'BUJP', 'PTG-005', DEMO_SHIP_2_NAME, 'citra.demo', '07'),
    demoUser('demo-pic-2', 'Hendra Gunawan', 'PIC', 'INTERNAL', 'PIC-002', DEMO_SHIP_2_NAME, 'hendra.demo', '08'),
    // KM Demo Bahari.
    demoUser('demo-petugas-6', 'Dedi Kurniawan', 'PETUGAS', 'BUJP', 'PTG-006', DEMO_SHIP_3_NAME, 'dedi.demo', '09'),
    demoUser('demo-petugas-7', 'Eka Prasetyo', 'PETUGAS', 'BUJP', 'PTG-007', DEMO_SHIP_3_NAME, 'eka.demo', '10'),
    demoUser('demo-pic-3', 'Maya Anggraini', 'PIC', 'INTERNAL', 'PIC-003', DEMO_SHIP_3_NAME, 'maya.demo', '11'),
    // Petugas cadangan tanpa kapal (otomatis off-duty).
    demoUser('demo-petugas-8', 'Fajar Nugroho', 'PETUGAS', 'BUJP', 'PTG-008', null, 'fajar.demo', '12'),
  ];
}

const photo = (title, index) => createPosterDataUrl(title, 'Foto kondisi awal (demo)', index);

// Titik ber-NFC wajib punya foto acuan. Nama titik default (Haluan, Anjungan, ...) digabung dengan
// definisi bawaan saat normalisasi sehingga NFC & foto di sini mengisi titik default tersebut.
function checkpoint(id, name, nfcTagId, photoIndex, extra = {}) {
  return { id, name, type: 'main', nfcTagId, referencePhotoUrl: photo(name, photoIndex), ...extra };
}

function subCheckpoint(id, name, parentId, nfcTagId, photoIndex, desc) {
  return checkpoint(id, name, nfcTagId, photoIndex, { type: 'sub', parentId, desc });
}

export function createDemoShips() {
  return [
    {
      id: DEMO_SHIP_ID,
      name: DEMO_SHIP_NAME,
      type: 'Oil Tanker',
      imoNumber: '9000001',
      routeLoading: 'Balikpapan',
      routeDischarge: 'Tanjung Priok',
      cargoType: 'Crude Oil',
      cargoAmount: '30000 KL',
      status: 'Operasional',
      lat: -6.0985,
      lng: 106.8872,
      photoUrl: createPosterDataUrl('KM Demo', DEMO_SHIP_NAME, 2),
      sosRecipientShipIds: [DEMO_SHIP_2_ID],
      // Penugasan petugas ke kapal (dipakai rekonsiliasi shipAssigned).
      personnel: ['demo-petugas', 'demo-petugas-2', 'demo-petugas-3'],
      customCheckpoints: [
        checkpoint('cpdef-haluan', 'Haluan', 'DEMO-NFC-01', 0, { isDefault: true }),
        checkpoint('cpdef-anjungan', 'Anjungan', 'DEMO-NFC-02', 1, { isDefault: true }),
        checkpoint('cpdef-ruang-mesin', 'Ruang Mesin', 'DEMO-NFC-03', 3, { isDefault: true }),
        checkpoint('cpdef-sekoci', 'Sekoci', 'DEMO-NFC-06', 4, { isDefault: true }),
        checkpoint('cpdef-buritan', 'Buritan', 'DEMO-NFC-07', 0, { isDefault: true }),
        checkpoint('demo-pagar-dek-kiri', DEMO_UNSOLVE_CHECKPOINT_NAME, 'DEMO-NFC-05', 5, { desc: 'Pagar pengaman dek sisi kiri' }),
        subCheckpoint('demo-panel-listrik', 'Panel Listrik Mesin', 'cpdef-ruang-mesin', 'DEMO-NFC-04', 4, 'Sub titik di Ruang Mesin'),
        subCheckpoint('demo-generator-darurat', 'Generator Darurat', 'cpdef-ruang-mesin', 'DEMO-NFC-08', 2, 'Sub titik di Ruang Mesin'),
        subCheckpoint('demo-lampu-navigasi', 'Lampu Navigasi', 'cpdef-anjungan', 'DEMO-NFC-09', 1, 'Lampu navigasi sisi kanan & kiri'),
      ],
    },
    {
      id: DEMO_SHIP_2_ID,
      name: DEMO_SHIP_2_NAME,
      type: 'Product Tanker',
      imoNumber: '9000002',
      routeLoading: 'Cilacap',
      routeDischarge: 'Makassar',
      cargoType: 'Pertalite',
      cargoAmount: '18000 KL',
      status: 'Operasional',
      lat: -7.7296,
      lng: 109.0102,
      photoUrl: createPosterDataUrl('MT Demo', DEMO_SHIP_2_NAME, 1),
      sosRecipientShipIds: [DEMO_SHIP_ID],
      personnel: ['demo-petugas-4', 'demo-petugas-5'],
      customCheckpoints: [
        checkpoint('cpdef-haluan', 'Haluan', 'DEMO2-NFC-01', 1, { isDefault: true }),
        checkpoint('cpdef-anjungan', 'Anjungan', 'DEMO2-NFC-02', 3, { isDefault: true }),
        checkpoint('cpdef-ruang-pompa', 'Ruang Pompa', 'DEMO2-NFC-03', 4, { isDefault: true }),
        checkpoint('demo2-manifold', 'Manifold Kargo', 'DEMO2-NFC-04', 2, { desc: 'Area sambungan selang bongkar muat' }),
        checkpoint('demo2-gangway', 'Gangway', 'DEMO2-NFC-05', 0, { desc: 'Akses naik-turun kapal' }),
        subCheckpoint('demo2-pompa-kargo', 'Pompa Kargo', 'cpdef-ruang-pompa', 'DEMO2-NFC-06', 4, 'Sub titik di Ruang Pompa'),
        subCheckpoint('demo2-tangki-ballast', 'Tangki Ballast', 'demo2-manifold', 'DEMO2-NFC-07', 1, 'Katup & manhole tangki ballast'),
      ],
    },
    {
      id: DEMO_SHIP_3_ID,
      name: DEMO_SHIP_3_NAME,
      type: 'Tug Boat',
      imoNumber: '9000003',
      routeLoading: 'Dumai',
      routeDischarge: 'Batam',
      cargoType: 'Penundaan',
      cargoAmount: '-',
      status: 'Situasional',
      lat: 1.6847,
      lng: 101.4472,
      photoUrl: createPosterDataUrl('KM Demo', DEMO_SHIP_3_NAME, 4),
      sosRecipientShipIds: [],
      personnel: ['demo-petugas-6', 'demo-petugas-7'],
      customCheckpoints: [
        checkpoint('cpdef-haluan', 'Haluan', 'DEMO3-NFC-01', 3, { isDefault: true }),
        checkpoint('cpdef-ruang-mesin', 'Ruang Mesin', 'DEMO3-NFC-02', 0, { isDefault: true }),
        checkpoint('cpdef-gudang-logistik', 'Gudang Logistik', 'DEMO3-NFC-03', 2, { isDefault: true, desc: 'Penyimpanan APAR, P3K & suku cadang' }),
        checkpoint('demo3-pintu-buritan', 'Pintu Akses Buritan', 'DEMO3-NFC-04', 5, { desc: 'Pintu kedap air akses buritan' }),
        subCheckpoint('demo3-ruang-abk', 'Ruang ABK', 'cpdef-gudang-logistik', 'DEMO3-NFC-05', 1, 'Kabin awak kapal'),
      ],
    },
  ];
}

/*
Riwayat patroli dummy (shift sebelumnya, relatif terhadap shift berjalan). Titik yang tidak
disebut di `temuan`/`missed` otomatis dilapor AMAN oleh petugas kapal secara bergiliran.

Setiap temuan punya `followUp` (status tindak lanjut di followUpStore) — `entries` ditulis
sebagai [kind, jamSetelahTemuan, aktor, komentar, verdict?]. Aktor: 'security' (PIC Security
kapal), 'assignee' (PIC fungsi tindak lanjut), atau nama petugas. `progress` = Riwayat Update
petugas (incidentMeta) dalam jam setelah temuan.
*/
export function createDemoPatrolHistory() {
  return [
    {
      shipId: DEMO_SHIP_ID, daysAgo: 1, shiftId: 'shift-3-active', weather: { temperature: 27, windspeed: 14, weathercode: 61 },
      missed: ['Solar Panel'],
      temuan: [
        {
          // Need Assign: belum ada tindak lanjut.
          incidentId: 'demo-inc-lampu-navigasi', checkpointName: 'Lampu Navigasi', offsetMinutes: 140, reporterId: 'demo-petugas-2',
          kejadian: 'Lampu navigasi sisi kanan (starboard) mati saat dicek malam hari.',
          penyebab: 'Diduga bohlam putus atau konektor korosi.',
          tindakLanjut: 'Lapor Mualim jaga, pasang lampu cadangan portable.',
          progress: [[3, 'demo-petugas-2', 'Lampu portable sudah terpasang sementara, menunggu penggantian unit.']],
          followUp: null,
        },
      ],
    },
    {
      shipId: DEMO_SHIP_ID, daysAgo: 2, shiftId: 'shift-1-active', weather: { temperature: 30, windspeed: 10, weathercode: 1 },
      temuan: [
        {
          // In Progress: Approved · Need Review · Need Action.
          incidentId: 'demo-inc-oli-generator', checkpointName: 'Generator Darurat', offsetMinutes: 95, reporterId: 'demo-petugas',
          kejadian: 'Rembesan oli di bawah generator darurat, genangan ±30 cm.',
          penyebab: 'Gasket carter generator getas.',
          tindakLanjut: 'Pasang absorbent pad dan lapor KKM.',
          progress: [[5, 'demo-petugas', 'Genangan sudah dibersihkan, rembesan masih ada sedikit.']],
          followUp: {
            items: [
              {
                assigneeId: 'maritime-asset', status: 'approved', instruction: 'Ganti gasket carter generator darurat dan uji jalan 30 menit.',
                entries: [
                  ['assign', 1, 'security', 'Ganti gasket carter generator darurat dan uji jalan 30 menit.'],
                  ['update', 6, 'assignee', 'Gasket sudah diganti teknisi kapal, uji jalan normal tanpa rembesan.'],
                  ['review', 7, 'security', 'Sesuai, pekerjaan selesai.', 'approved'],
                ],
              },
              {
                assigneeId: 'hsse', status: 'need_review', instruction: 'Pastikan limbah oli & absorbent dibuang sesuai prosedur B3.',
                entries: [
                  ['assign', 1, 'security', 'Pastikan limbah oli & absorbent dibuang sesuai prosedur B3.'],
                  ['update', 9, 'assignee', 'Limbah sudah dimasukkan drum B3 berlabel, menunggu serah terima di pelabuhan.'],
                ],
              },
              {
                assigneeId: 'procurement', status: 'need_action', instruction: 'Sediakan stok gasket cadangan generator (2 set) di kapal.',
                entries: [['assign', 2, 'security', 'Sediakan stok gasket cadangan generator (2 set) di kapal.']],
              },
            ],
          },
        },
      ],
    },
    {
      shipId: DEMO_SHIP_ID, daysAgo: 3, shiftId: 'shift-2-active', weather: { temperature: 31, windspeed: 12, weathercode: 2 },
      missed: ['Radio Room'],
      temuan: [
        {
          // Need Verification: menunggu verifikasi petugas kapal (akun demo petugas bisa verifikasi).
          incidentId: 'demo-inc-tali-sekoci', checkpointName: 'Sekoci', offsetMinutes: 70, reporterId: 'demo-petugas-3',
          kejadian: 'Tali davit sekoci kanan aus dan serabut terurai di dua titik.',
          penyebab: 'Usia pakai tali melewati batas & paparan air laut.',
          tindakLanjut: 'Sekoci kanan diberi tanda tidak layak sementara.',
          progress: [[4, 'demo-petugas-3', 'Tanda "tidak layak pakai" sudah dipasang, sekoci kiri siaga.']],
          followUp: {
            items: [
              {
                assigneeId: 'fleet', status: 'approved', instruction: 'Ganti tali davit sekoci kanan dengan tali bersertifikat.',
                entries: [
                  ['assign', 1, 'security', 'Ganti tali davit sekoci kanan dengan tali bersertifikat.'],
                  ['update', 20, 'assignee', 'Rencana: tali baru dikirim via supply boat besok pagi.'],
                  ['review', 21, 'security', 'Rencana dikonfirmasi, lanjutkan pemasangan.', 'approved', true],
                  ['update', 40, 'assignee', 'Tali baru terpasang, sertifikat terlampir. Uji turun-naik sekoci OK.'],
                  ['review', 41, 'security', 'Sesuai, pekerjaan selesai.', 'approved'],
                ],
              },
            ],
          },
          verification: { requested: true, entries: [['request', 42, 'security', 'Mohon cek tali davit & uji turun-naik sekoci kanan.']] },
        },
      ],
    },
    {
      shipId: DEMO_SHIP_ID, daysAgo: 6, shiftId: 'shift-3-active', weather: { temperature: 26, windspeed: 18, weathercode: 63 },
      temuan: [
        {
          // Unsolve: pagar menunggu docking (override foto acuan titik di followUpStore).
          incidentId: DEMO_UNSOLVE_INCIDENT_ID, checkpointName: DEMO_UNSOLVE_CHECKPOINT_NAME, offsetMinutes: 195, reporterId: 'demo-petugas-2',
          kejadian: 'Pagar pengaman dek sisi kiri berkarat dan longgar di dua titik sambungan.',
          penyebab: 'Korosi akibat paparan air laut, sambungan las retak.',
          tindakLanjut: 'Pasang tali pengaman sementara & rambu dilarang bersandar.',
          followUp: {
            items: [
              {
                assigneeId: 'maritime-asset', status: 'approved', instruction: 'Survey kerusakan pagar dan ajukan perbaikan.',
                entries: [
                  ['assign', 2, 'security', 'Survey kerusakan pagar dan ajukan perbaikan.'],
                  ['update', 30, 'assignee', 'Pagar harus diganti total, hanya bisa saat docking tahunan.'],
                  ['review', 31, 'security', 'Diterima, tunggu jadwal docking.', 'approved'],
                ],
              },
              {
                assigneeId: 'hsse', status: 'approved', instruction: 'Pasang pengaman sementara di area pagar.',
                entries: [
                  ['assign', 2, 'security', 'Pasang pengaman sementara di area pagar.'],
                  ['update', 8, 'assignee', 'Tali pengaman & rambu sudah terpasang.'],
                  ['review', 9, 'security', 'Sesuai.', 'approved'],
                ],
              },
              {
                assigneeId: 'operasi-kapal', status: 'approved', instruction: 'Masukkan penggantian pagar ke daftar pekerjaan docking.',
                entries: [
                  ['assign', 3, 'security', 'Masukkan penggantian pagar ke daftar pekerjaan docking.'],
                  ['update', 26, 'assignee', 'Sudah masuk repair list docking (item #14).'],
                  ['review', 27, 'security', 'Sesuai.', 'approved'],
                ],
              },
            ],
          },
          unsolve: [33, 'security', 'Pagar dek berkarat perlu penggantian total saat docking tahunan. Sudah dipasang rambu & tali pengaman sementara; kondisi ini diterima sampai jadwal docking.'],
        },
      ],
    },
    {
      shipId: DEMO_SHIP_2_ID, daysAgo: 2, shiftId: 'shift-2-active', weather: { temperature: 32, windspeed: 8, weathercode: 1 },
      temuan: [
        {
          // Need Decision: semua tindak lanjut Approved, PIC Security memilih Unsolve / Need Verification.
          incidentId: 'demo-inc-flange-manifold', checkpointName: 'Manifold Kargo', offsetMinutes: 50, reporterId: 'demo-petugas-4',
          kejadian: 'Flange manifold kargo sisi kiri rembes saat persiapan bongkar.',
          penyebab: 'Baut flange kendur & gasket aus.',
          tindakLanjut: 'Bongkar ditunda, drip tray dipasang.',
          followUp: {
            items: [
              {
                assigneeId: 'operasi-kapal', status: 'approved', instruction: 'Ganti gasket & kencangkan baut flange sesuai torsi.',
                entries: [
                  ['assign', 1, 'security', 'Ganti gasket & kencangkan baut flange sesuai torsi.'],
                  ['update', 4, 'assignee', 'Gasket diganti, baut dikencangkan 450 Nm, uji tekan OK.'],
                  ['review', 5, 'security', 'Sesuai.', 'approved'],
                ],
              },
              {
                assigneeId: 'hsse', status: 'approved', instruction: 'Bersihkan tumpahan & catat sebagai near miss.',
                entries: [
                  ['assign', 1, 'security', 'Bersihkan tumpahan & catat sebagai near miss.'],
                  ['update', 3, 'assignee', 'Area sudah bersih, laporan near miss NM-118 dibuat.'],
                  ['review', 5, 'security', 'Sesuai.', 'approved'],
                ],
              },
            ],
          },
        },
      ],
    },
    {
      shipId: DEMO_SHIP_2_ID, daysAgo: 5, shiftId: 'shift-1-active', weather: { temperature: 29, windspeed: 11, weathercode: 3 },
      temuan: [
        {
          // Closed: verifikasi petugas sesuai.
          incidentId: 'demo-inc-jaring-gangway', checkpointName: 'Gangway', offsetMinutes: 40, reporterId: 'demo-petugas-5',
          kejadian: 'Jaring pengaman bawah gangway sobek ±1 meter.',
          penyebab: 'Tersangkut crane saat bongkar muat.',
          tindakLanjut: 'Akses gangway dibatasi satu orang bergantian.',
          followUp: {
            items: [
              {
                assigneeId: 'maritime-asset', status: 'done', instruction: 'Ganti jaring pengaman gangway.',
                entries: [
                  ['assign', 1, 'security', 'Ganti jaring pengaman gangway.'],
                  ['update', 7, 'assignee', 'Jaring baru sudah terpasang dan diikat di 8 titik.'],
                  ['review', 8, 'security', 'Sesuai.', 'approved'],
                ],
              },
            ],
          },
          verification: { entries: [['request', 9, 'security', 'Mohon cek jaring gangway baru.'], ['verify', 12, 'demo-petugas-4', 'Jaring sudah terpasang kencang, aman dilalui.', 'approved']] },
          closure: [12, 'demo-petugas-4', 'Jaring sudah terpasang kencang, aman dilalui.'],
        },
      ],
    },
    {
      shipId: DEMO_SHIP_3_ID, daysAgo: 2, shiftId: 'shift-3-active', weather: { temperature: 28, windspeed: 16, weathercode: 2 },
      missed: ['Kondisi personel'],
      temuan: [
        {
          // In Progress dengan revisi: satu tindak lanjut ditolak (Need Revision).
          incidentId: 'demo-inc-apar-gudang', checkpointName: 'Gudang Logistik', offsetMinutes: 120, reporterId: 'demo-petugas-6',
          kejadian: 'Dua APAR di gudang logistik melewati tanggal kedaluwarsa.',
          penyebab: 'Jadwal refill tidak terpantau.',
          tindakLanjut: 'APAR diberi tanda, pinjam APAR dari ruang mesin sementara.',
          progress: [[2, 'demo-petugas-6', 'APAR pengganti sementara sudah ditempatkan di gudang.']],
          followUp: {
            items: [
              {
                assigneeId: 'procurement', status: 'need_action', instruction: 'Refill/ganti 2 APAR dan lampirkan berita acara.',
                entries: [
                  ['assign', 1, 'security', 'Refill/ganti 2 APAR dan lampirkan berita acara.'],
                  ['update', 10, 'assignee', 'APAR sudah dipesan.'],
                  ['review', 11, 'security', 'Mohon lampirkan nomor PO & estimasi tiba.', 'rejected'],
                ],
              },
              {
                assigneeId: 'hsse', status: 'need_review', instruction: 'Perbarui jadwal inspeksi APAR bulanan.',
                entries: [
                  ['assign', 1, 'security', 'Perbarui jadwal inspeksi APAR bulanan.'],
                  ['update', 6, 'assignee', 'Checklist inspeksi APAR bulanan sudah diperbarui & ditempel.'],
                ],
              },
            ],
          },
        },
      ],
    },
    {
      shipId: DEMO_SHIP_3_ID, daysAgo: 4, shiftId: 'shift-2-active', weather: { temperature: 31, windspeed: 9, weathercode: 1 },
      temuan: [
        {
          // Verifikasi belum sesuai → menunggu keputusan PIC Security.
          incidentId: 'demo-inc-pintu-buritan', checkpointName: 'Pintu Akses Buritan', offsetMinutes: 85, reporterId: 'demo-petugas-7',
          kejadian: 'Kunci pintu kedap air akses buritan macet, pintu tidak bisa ditutup rapat.',
          penyebab: 'Engsel & tuas pengunci berkarat.',
          tindakLanjut: 'Pintu diikat sementara, dijaga saat sandar.',
          followUp: {
            items: [
              {
                assigneeId: 'fleet', status: 'approved', instruction: 'Perbaiki tuas pengunci & lumasi engsel pintu.',
                entries: [
                  ['assign', 1, 'security', 'Perbaiki tuas pengunci & lumasi engsel pintu.'],
                  ['update', 12, 'assignee', 'Engsel sudah dilumasi, tuas diluruskan.'],
                  ['review', 13, 'security', 'Sesuai.', 'approved'],
                ],
              },
            ],
          },
          verification: {
            awaitingSecurityDecision: true,
            entries: [
              ['request', 14, 'security', 'Mohon cek pintu bisa ditutup rapat.'],
              ['verify', 20, 'demo-petugas-7', 'Pintu masih seret, tuas belum mengunci penuh.', 'rejected'],
            ],
          },
        },
      ],
    },
  ];
}
