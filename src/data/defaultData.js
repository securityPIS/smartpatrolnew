/*
Tujuan: Menyediakan seed data dan daftar checkpoint wajib global SmartPatrol.
Caller: App context, form insiden, dan inisialisasi state awal aplikasi.
Dependensi: Utilitas sanitasi untuk generator ID.
Main Functions: Menetapkan checkpoint default, draft form, user seed, kapal seed, dan state awal.
Side Effects: Menjadi sumber baseline checklist patroli untuk semua kapal baru dan state lokal awal.
*/

import { makeId } from "../utils/sanitize";

export const APP_STORAGE_KEY = "smartpatrol.local.v1";
export const APP_STORAGE_VERSION = 1;
export const WEATHER_CACHE_KEY = "smartpatrol.weather.v1";
export const WEATHER_CACHE_TTL_MS = 30 * 60 * 1000;

export const DEFAULT_CURRENT_USER = "Budi Santoso";

export const DEFAULT_LOCATION_OPTIONS = [
  "Kondisi personel",
  "Cuaca",
  "Haluan",
  "Buritan",
  "Deck",
  "Sekoci",
  "Anjungan",
  "Radio Room",
  "Alat Navigasi",
  "Solar Panel",
  "Ruang Mesin",
  "Ruang Pompa",
  "Air Bersih",
  "Gudang Logistik",
  "Gudang Spare Part",
  "Alat Dapur",
  "Fasilitas Pendukung",
  "Obat-Obatan",
  "Tangga monyet",
];

export const USER_ROLE_OPTIONS = ["ADMIN", "PETUGAS", "PIC"];
export const AGENCY_OPTIONS = ["BUJP", "TNI", "POLRI", "INTERNAL"];
export const SHIP_TYPE_OPTIONS = ["Oil Tanker", "Chemical Tanker", "Gas Carrier", "Bulk Carrier"];
export const SHIP_STATUS_OPTIONS = ["UPP", "NON UPP"];

const PALETTES = [
  ["#0f172a", "#0ea5e9", "#67e8f9"],
  ["#111827", "#14b8a6", "#6ee7b7"],
  ["#1f2937", "#fb7185", "#fda4af"],
  ["#1e1b4b", "#8b5cf6", "#c4b5fd"],
  ["#0f172a", "#f59e0b", "#fcd34d"],
];

function encodeSvg(svg) {
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function getPalette(index = 0) {
  return PALETTES[index % PALETTES.length];
}

export function createPosterDataUrl(title, subtitle = "", paletteIndex = 0, square = false) {
  const [bg, primary, accent] = getPalette(paletteIndex);
  const width = square ? 420 : 960;
  const height = square ? 420 : 540;

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <defs>
        <linearGradient id="g" x1="0%" x2="100%" y1="0%" y2="100%">
          <stop offset="0%" stop-color="${bg}" />
          <stop offset="100%" stop-color="${primary}" />
        </linearGradient>
      </defs>
      <rect width="100%" height="100%" rx="36" fill="url(#g)" />
      <circle cx="${width - 90}" cy="90" r="82" fill="${accent}" fill-opacity="0.18" />
      <circle cx="88" cy="${height - 82}" r="64" fill="${accent}" fill-opacity="0.16" />
      <text x="52" y="${square ? 214 : 238}" fill="#f8fafc" font-size="${square ? 118 : 72}" font-family="Verdana, Geneva, sans-serif" font-weight="700">${title}</text>
      <text x="54" y="${square ? 292 : 312}" fill="#e0f2fe" fill-opacity="0.92" font-size="${square ? 32 : 28}" font-family="Verdana, Geneva, sans-serif">${subtitle}</text>
    </svg>
  `;

  return encodeSvg(svg);
}

export function getEmptyPatrolDraft(type = "aman") {
  return {
    type,
    kejadian: "",
    penyebab: "",
    tindakLanjut: "",
    photoUrl: "",
    heroUrl: "",
    thumbUrl: "",
    photoName: "",
  };
}

export function getEmptyIncidentDraft() {
  return {
    locType: "default",
    location: DEFAULT_LOCATION_OPTIONS[0],
    customLocation: "",
    penyebab: "",
    deskripsi: "",
    tindakLanjut: "",
    photoUrl: "",
    heroUrl: "",
    thumbUrl: "",
    photoName: "",
  };
}

export function getEmptyProgressDraft() {
  return {
    comment: "",
    photoUrl: "",
    heroUrl: "",
    thumbUrl: "",
    photoName: "",
  };
}

export function getEmptyUserDraft() {
  return {
    name: "",
    role: "PETUGAS",
    type: "BUJP",
    dob: "",
    email: "",
    password: "",
    phone: "",
    address: "",
    emergencyName: "",
    emergencyContact: "",
    emergencyRelation: "Orang Tua",
    officeAddress: "",
    photoUrl: "",
    photoName: "",
  };
}

export function getEmptyShipDraft() {
  return {
    name: "",
    type: "Oil Tanker",
    route: "",
    cargoType: "",
    cargoAmount: "",
    status: "UPP",
    lat: "-6.1021",
    lng: "106.8833",
    customCheckpoints: [],
    documents: [],
    photoUrl: "",
    photoName: "",
  };
}

export function createActivityEntry({ title, detail, tone = "info", actor = "Sistem" }) {
  return {
    id: makeId("log"),
    title,
    detail,
    tone,
    actor,
    createdAt: new Date().toISOString(),
  };
}

function createDefaultUsers() {
  return [
    {
      id: "u1",
      name: "Budi Santoso",
      role: "PETUGAS",
      type: "BUJP",
      status: "active",
      shipAssigned: "MT MENGGALA",
      email: "budi.santoso@smartpatrol.local",
      phone: "081234560001",
      dob: "1990-08-10",
      address: "Jakarta Utara",
      officeAddress: "Posko SmartPatrol Tanjung Priok",
      emergencyName: "Siti Santoso",
      emergencyContact: "081234560099",
      emergencyRelation: "Suami/Istri",
      hasCredential: true,
      credentialUpdatedAt: "2026-04-02T08:00:00.000Z",
      photoUrl: createPosterDataUrl("BS", "Budi Santoso", 0, true),
    },
    {
      id: "u2",
      name: "Sertu Agus",
      role: "PIC",
      type: "TNI",
      status: "active",
      shipAssigned: "MT MENGGALA",
      email: "ag@satgas.local",
      phone: "081234560002",
      dob: "1987-04-14",
      address: "Cilegon",
      officeAddress: "Pos Pengamanan Merak",
      emergencyName: "Fitri Agus",
      emergencyContact: "081234560088",
      emergencyRelation: "Suami/Istri",
      hasCredential: true,
      credentialUpdatedAt: "2026-04-01T11:00:00.000Z",
      photoUrl: createPosterDataUrl("SA", "Sertu Agus", 1, true),
    },
    {
      id: "u3",
      name: "Cipto Mangunkusumo",
      role: "PETUGAS",
      type: "BUJP",
      status: "active",
      shipAssigned: "MT MENGGALA",
      email: "cipto@smartpatrol.local",
      phone: "081234560003",
      dob: "1992-01-27",
      address: "Tanjung Priok",
      officeAddress: "Posko SmartPatrol Tanjung Priok",
      emergencyName: "Dewi Cipto",
      emergencyContact: "081234560077",
      emergencyRelation: "Saudara",
      hasCredential: true,
      credentialUpdatedAt: "2026-04-02T14:00:00.000Z",
      photoUrl: createPosterDataUrl("CM", "Cipto", 2, true),
    },
    {
      id: "u4",
      name: "Deni Setiawan",
      role: "PETUGAS",
      type: "BUJP",
      status: "off-duty",
      shipAssigned: null,
      email: "deni@smartpatrol.local",
      phone: "081234560004",
      dob: "1995-11-09",
      address: "Bekasi",
      officeAddress: "Gudang Logistik Pusat",
      emergencyName: "Ari Setiawan",
      emergencyContact: "081234560066",
      emergencyRelation: "Orang Tua",
      hasCredential: false,
      credentialUpdatedAt: "",
      photoUrl: createPosterDataUrl("DS", "Deni", 3, true),
    },
    {
      id: "u5",
      name: "Kapten Eko",
      role: "ADMIN",
      type: "INTERNAL",
      status: "off-duty",
      shipAssigned: null,
      email: "eko@smartpatrol.local",
      phone: "081234560005",
      dob: "1982-03-18",
      address: "Jakarta Barat",
      officeAddress: "HQ SmartPatrol",
      emergencyName: "Nina Eko",
      emergencyContact: "081234560055",
      emergencyRelation: "Suami/Istri",
      hasCredential: true,
      credentialUpdatedAt: "2026-03-30T09:00:00.000Z",
      photoUrl: createPosterDataUrl("KE", "Kapten Eko", 4, true),
    },
  ];
}

function createDefaultShips() {
  return [
    {
      id: "s1",
      name: "MT MENGGALA",
      type: "Oil Tanker",
      lat: "-6.1021",
      lng: "106.8833",
      status: "UPP",
      imoNumber: "9387421",
      route: "Jakarta - Singapore",
      cargoType: "Crude Oil",
      cargoAmount: "50,000 MT",
      photoUrl: createPosterDataUrl("MT MENGGALA", "Operasi patroli aktif", 0, false),
      personnel: ["u1", "u2", "u3"],
      personnelNextMonth: ["u1", "u4", "u5"],
      customCheckpoints: [
        { id: "scp-1", name: "Cuaca", desc: "Cek visibilitas dan gelombang." },
        { id: "scp-2", name: "Ruang Mesin", desc: "Pastikan suhu generator normal." },
      ],
      documents: [
        { id: "doc-1", title: "Sertifikat Keselamatan", docDate: "2026-01-12", desc: "Berlaku hingga 2027" },
        { id: "doc-2", title: "Izin Berlayar", docDate: "2026-02-03", desc: "Dikeluarkan Syahbandar" },
      ],
    },
    {
      id: "s2",
      name: "MT SRIWIJAYA",
      type: "Chemical Tanker",
      lat: "-5.9123",
      lng: "105.8122",
      status: "NON UPP",
      imoNumber: "9471208",
      route: "Merak - Bakauheni",
      cargoType: "Methanol",
      cargoAmount: "12,000 MT",
      photoUrl: createPosterDataUrl("MT SRIWIJAYA", "Armada siaga bulan depan", 1, false),
      personnel: [],
      personnelNextMonth: [],
      customCheckpoints: [{ id: "scp-3", name: "Pompa Kimia", desc: "Pastikan tidak ada kebocoran." }],
      documents: [],
    },
  ];
}

function createDefaultCheckpoints() {
  const checkpoints = DEFAULT_LOCATION_OPTIONS.map((name, index) => ({
    id: String(index + 1),
    name,
    status: "pending",
  }));

  checkpoints[0] = {
    ...checkpoints[0],
    status: "completed",
    completedBy: "Cipto Mangunkusumo",
    completedAt: "2026-04-03T05:15:00.000Z",
    resultType: "aman",
    photoUrl: createPosterDataUrl("CUACA", "Laut relatif cerah", 0, false),
    penyebab: "",
    kejadian: "Kondisi langit cerah dan gelombang terpantau stabil.",
    tindakLanjut: "Lanjut patroli rutin.",
  };

  checkpoints[1] = {
    ...checkpoints[1],
    status: "completed",
    completedBy: "Sertu Agus",
    completedAt: "2026-04-03T05:20:00.000Z",
    resultType: "temuan",
    photoUrl: createPosterDataUrl("HALUAN", "Temuan rantai jangkar", 4, false),
    penyebab: "Gesekan berlebih akibat cuaca buruk sebelumnya.",
    kejadian: "Karat parah pada rantai jangkar sisi kiri.",
    tindakLanjut: "Lapor Chief Officer dan jadwalkan pembersihan.",
  };

  return checkpoints;
}

function createDefaultActivityLog() {
  return [
    {
      id: "log-1",
      title: "Baseline lokal siap",
      detail: "Mode staging lokal aktif. Data akan disimpan di browser dan disinkronkan ke Supabase saat tersedia.",
      tone: "info",
      actor: "System",
      createdAt: "2026-04-03T01:00:00.000Z",
    },
    {
      id: "log-2",
      title: "Temuan haluan terdeteksi",
      detail: "Rantai jangkar kiri perlu tindak lanjut pemeriksaan lanjutan.",
      tone: "warning",
      actor: "Sertu Agus",
      createdAt: "2026-04-03T05:20:00.000Z",
    },
  ];
}

export function createDefaultAppState() {
  return {
    checkpoints: [],
    users: [],
    ships: [],
    incidents: [],
    incidentMeta: {},
    activityLog: [],
  };
}
