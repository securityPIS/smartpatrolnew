/*
Tujuan: Dataset dummy untuk mode demo (akun petugas & admin, satu kapal dengan titik checkpoint).
Caller: AppContextRuntime saat isDemoMode (pengganti data tersimpan / cloud).
Dependensi: createPosterDataUrl (gambar placeholder SVG inline).
Side Effects: Tidak ada; data hanya hidup di memori selama halaman terbuka.
*/

import { createPosterDataUrl } from './defaultData';

export const DEMO_SHIP_NAME = 'KM Demo Nusantara';

export function createDemoUsers() {
  return [
    {
      id: 'demo-admin', name: 'Admin Demo', role: 'ADMIN', type: 'INTERNAL', workerNumber: 'ADM-001',
      status: 'active', shipAssigned: null, email: 'admin.demo@smartpatrol.local', phone: '081200000001',
      authProvider: 'none',
    },
    {
      id: 'demo-petugas', name: 'Petugas Demo', role: 'PETUGAS', type: 'BUJP', workerNumber: 'PTG-001',
      status: 'active', shipAssigned: DEMO_SHIP_NAME, email: 'petugas.demo@smartpatrol.local', phone: '081200000002',
      authProvider: 'none',
    },
    {
      id: 'demo-petugas-2', name: 'Rekan Petugas Demo', role: 'PETUGAS', type: 'BUJP', workerNumber: 'PTG-002',
      status: 'active', shipAssigned: DEMO_SHIP_NAME, email: 'rekan.demo@smartpatrol.local', phone: '081200000003',
      authProvider: 'none',
    },
    {
      id: 'demo-pic', name: 'PIC Security Demo', role: 'PIC', type: 'INTERNAL', workerNumber: 'PIC-001',
      status: 'active', shipAssigned: DEMO_SHIP_NAME, email: 'pic.demo@smartpatrol.local', phone: '081200000004',
      authProvider: 'none',
    },
  ];
}

export function createDemoShips() {
  const photo = (title, index) => createPosterDataUrl(title, 'Foto kondisi awal (demo)', index);
  return [
    {
      id: 'demo-ship-1',
      name: DEMO_SHIP_NAME,
      type: 'Oil Tanker',
      imoNumber: '9000001',
      routeLoading: 'Balikpapan',
      routeDischarge: 'Tanjung Priok',
      cargoType: 'Crude Oil',
      cargoAmount: '30000 KL',
      status: 'Operasional',
      photoUrl: createPosterDataUrl('KM Demo', DEMO_SHIP_NAME, 2),
      sosRecipientShipIds: [],
      // Penugasan petugas ke kapal (dipakai rekonsiliasi shipAssigned).
      personnel: ['demo-petugas', 'demo-petugas-2'],
      customCheckpoints: [
        { id: 'cpdef-haluan', name: 'Haluan', type: 'main', isDefault: true, nfcTagId: 'DEMO-NFC-01', referencePhotoUrl: photo('Haluan', 0) },
        { id: 'cpdef-anjungan', name: 'Anjungan', type: 'main', isDefault: true, nfcTagId: 'DEMO-NFC-02', referencePhotoUrl: photo('Anjungan', 1) },
        { id: 'cpdef-ruang-mesin', name: 'Ruang Mesin', type: 'main', isDefault: true, nfcTagId: 'DEMO-NFC-03', referencePhotoUrl: photo('Ruang Mesin', 3) },
        { id: 'demo-panel-listrik', name: 'Panel Listrik Mesin', type: 'sub', parentId: 'cpdef-ruang-mesin', desc: 'Sub titik di Ruang Mesin', nfcTagId: 'DEMO-NFC-04', referencePhotoUrl: photo('Panel Listrik', 4) },
      ],
    },
  ];
}
