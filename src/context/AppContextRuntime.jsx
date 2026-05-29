/*
Tujuan: Menjadi pusat state, flow bisnis, dan sinkronisasi SmartPatrol SQL.
Caller: Root app melalui AppProvider dan seluruh hook domain aplikasi.
Dependensi: Seed data, adapter backend Supabase/Postgres, trusted time, helper user management, utilitas sanitasi, IndexedDB image store, dan adapter native Capacitor.
Main Functions: Mengelola auth Supabase dengan fallback offline, onboarding approval, kapal, checkpoint patroli, incidents, history, SOS realtime in-app, cloud sync SQL, dedupe user operasional, dan retry sinkronisasi saat koneksi pulih.
Side Effects: Menulis state lokal/cloud SQL, memanggil Edge Function security/upload aset, menginisialisasi checklist kapal, dan memigrasikan data shift aktif.
*/

import React, { createContext, useContext, useState, useEffect, useMemo, useCallback, useDeferredValue, useRef } from 'react';
import {
  Sun, Cloud, CloudRain, Wind, Thermometer,
} from 'lucide-react';
import { createPosterDataUrl, DEFAULT_LOCATION_OPTIONS } from '../data/defaultData';
import { readFileAsDataUrl, readImageFileAsDataUrl } from '../utils/images';
import { sanitizeEmail, sanitizeMultilineText, sanitizePhone, sanitizeText, sanitizeUrl, isReportFieldValid } from '../utils/sanitize';
import { loadImageFromDB, saveImageToDB } from '../utils/imageStore';
import { checkStorageQuota } from '../utils/storageQuota';
import { assignUserToExclusiveShip, reconcileUserShipAssignments, removeUserFromShipAssignment, resolveExplicitOverride, shouldDeferPetugasFleetValidation } from '../utils/userManagement';
import {
  addNativeNetworkStatusListener,
  getNativeGeolocationPosition,
  getNativeNetworkStatus,
  isNativeRuntime,
} from '../services/native/capacitorBridge';
import { setupNativePushNotifications } from '../services/native/pushNotifications';
import { removePushSubscription } from '../services/backend/pushSubscriptions';
import {
  getFirebaseAuthErrorMessage,
  isFirebaseAuthEnabled,
  loginWithFirebaseEmail,
  logoutFirebaseUser,
  provisionFirebaseEmailUser,
  registerWithFirebaseEmail,
  subscribeToFirebaseAuthChanges,
} from '../services/backend/auth';
import {
  fetchCloudAppState,
  getNotificationCloudBaseId,
  isCloudSyncEnabled,
  isCloudWriteEnabled,
  markNotificationRecipientRead,
  persistNotificationRecords,
  publishCloudSyncSignal,
  saveCloudAppState,
  subscribeToCloudAppState,
  subscribeToCloudSyncSignal,
  uploadCloudDataUrlAsset,
} from '../services/backend/cloudState';
import {
  deletePatrolReport,
  savePatrolReport,
  subscribeToPatrolReports,
} from '../services/backend/patrolReports';
import {
  deleteIncidentReport,
  deleteSosAlert,
  saveIncidentReport,
  subscribeToIncidents,
} from '../services/backend/incidentReports';
import { subscribeToShiftHistoryEntries } from '../services/backend/shiftHistory';
import {
  approvePendingRegistration,
  createPendingRegistration,
  rejectPendingRegistration,
  resolveOperationalAccess,
  revokeOperationalUserAccess,
  subscribeToPendingRegistrations,
  syncOperationalUserAccess,
  uploadRegistrationPhotoAsset,
} from '../services/backend/access';
import {
  createTrustedTimestampRecord,
  getTrustedDate,
  getTrustedNowMs,
  getTimeTrustStatus,
  initializeTrustedTime,
} from '../services/time/trustedTime';
import {
  extractTimeAuditFields,
  markTimeAuditRecordReceived,
  normalizeTimeAuditRecord,
} from '../services/time/timeAudit';

// --- DATA MOCKUP ---
const ACCESS_ROLES = {
  ADMIN: 'ADMIN',
  PIC: 'PIC',
  PETUGAS: 'PETUGAS'
};

const ACCESS_ROLE_VALUES = Object.values(ACCESS_ROLES);
const AUTH_SESSION_KEY = 'smartpatrol.auth.local.v1';
const APP_TIME_ZONE = 'Asia/Jakarta';
const APP_TIME_ZONE_UTC_OFFSET_HOURS = 7;
const SHIFT_NOTIFICATION_DEBUG_KEY = 'smartpatrol.debug.shiftNotifications';
const CLOUD_SYNC_DEBUG_KEY = 'smartpatrol.debug.cloudSync';

/**
 * Gate Android-only: blok operasi kritis jika trusted time belum terverifikasi.
 * Hanya berlaku di native Android; web/PWA tidak terpengaruh.
 * @returns {null|string} null jika lolos, string pesan error jika diblok.
 */
function checkAndroidTrustedTimeGate() {
  if (!isNativeRuntime()) return null;
  const status = getTimeTrustStatus();
  if (status.trustLevel === 'unverified') {
    return 'Waktu perangkat belum terverifikasi. Aktifkan internet dan tunggu sinkronisasi sebelum melanjutkan.';
  }
  if (status.clockTamperDetected) {
    return 'Perubahan jam perangkat terdeteksi. Sinkronisasi ulang waktu diperlukan.';
  }
  return null;
}

function getDefaultPageForRole(role) {
  return role === ACCESS_ROLES.ADMIN || role === ACCESS_ROLES.PIC ? 'daily-report' : 'home';
}
const MINUTE_IN_MS = 60 * 1000;
const SHIFT_SEQUENCE = [
  {
    id: 'shift-1-active',
    label: 'Shift 1',
    startHour: 6,
    startMinute: 0,
    endHour: 12,
    endMinute: 0,
    timeRange: '06:00 - 12:00',
  },
  {
    id: 'shift-2-active',
    label: 'Shift 2',
    startHour: 12,
    startMinute: 0,
    endHour: 18,
    endMinute: 0,
    timeRange: '12:00 - 18:00',
  },
  {
    id: 'shift-3-active',
    label: 'Shift 3',
    startHour: 18,
    startMinute: 0,
    endHour: 6,
    endMinute: 0,
    crossesMidnight: true,
    timeRange: '18:00 - 06:00',
  },
];
const COMPAT_SHIFT_SEQUENCE = [
  {
    id: 'shift-pagi',
    label: 'Shift Pagi',
    startHour: 6,
    startMinute: 0,
    endHour: 10,
    endMinute: 0,
    compat: true,
    timeRange: '06:00 - 10:00',
  },
  {
    id: 'shift-siang',
    label: 'Shift Siang',
    startHour: 10,
    startMinute: 0,
    endHour: 14,
    endMinute: 0,
    compat: true,
    timeRange: '10:00 - 14:00',
  },
  {
    id: 'shift-sore',
    label: 'Shift Sore',
    startHour: 14,
    startMinute: 0,
    endHour: 18,
    endMinute: 0,
    compat: true,
    timeRange: '14:00 - 18:00',
  },
  {
    id: 'shift-malam',
    label: 'Shift Malam',
    startHour: 18,
    startMinute: 0,
    endHour: 6,
    endMinute: 0,
    crossesMidnight: true,
    compat: true,
    timeRange: '18:00 - 06:00',
  },
];
const LEGACY_SHIFT_SEQUENCE = [
  {
    id: 'shift-4',
    label: 'Shift 4',
    startHour: 0,
    startMinute: 0,
    endHour: 6,
    endMinute: 0,
    compat: true,
    legacy: true,
    timeRange: '00:00 - 06:00',
  },
  {
    id: 'shift-1',
    label: 'Shift 1',
    startHour: 6,
    startMinute: 0,
    endHour: 12,
    endMinute: 0,
    compat: true,
    legacy: true,
    timeRange: '06:00 - 12:00',
  },
  {
    id: 'shift-2',
    label: 'Shift 2',
    startHour: 12,
    startMinute: 0,
    endHour: 18,
    endMinute: 0,
    compat: true,
    legacy: true,
    timeRange: '12:00 - 18:00',
  },
  {
    id: 'shift-3',
    label: 'Shift 3',
    startHour: 18,
    startMinute: 0,
    endHour: 0,
    endMinute: 0,
    crossesMidnight: true,
    compat: true,
    legacy: true,
    timeRange: '18:00 - 00:00',
  },
];
const SHIFT_DEFINITION_MAP = [...SHIFT_SEQUENCE, ...COMPAT_SHIFT_SEQUENCE, ...LEGACY_SHIFT_SEQUENCE].reduce((accumulator, shift) => ({
  ...accumulator,
  [shift.id]: shift,
}), {});

const defaultLocationOptions = [...DEFAULT_LOCATION_OPTIONS];
const SHIP_STATUS_OPTIONS = ['Non Operasional', 'Operasional', 'Situasional'];

function createDefaultShipCheckpoints() {
  return defaultLocationOptions.map((name) => ({
    name,
    desc: '',
    isDefault: true,
  }));
}

function normalizeShipCheckpointDefinitions(checkpoints = []) {
  const normalizedCheckpoints = Array.isArray(checkpoints) ? checkpoints : [];
  const byName = new Map();

  normalizedCheckpoints.forEach((checkpoint) => {
    const safeName = sanitizeText(checkpoint?.name || '', 80);
    const key = createCheckpointNameKey(safeName);
    if (!key || byName.has(key)) return;
    byName.set(key, {
      name: safeName,
      desc: sanitizeMultilineText(checkpoint?.desc || '', 140),
      isDefault: Boolean(checkpoint?.isDefault),
    });
  });

  return Array.from(byName.values());
}

function initializeShipCheckpointDefinitions(checkpoints = []) {
  return normalizeShipCheckpointDefinitions([
    ...createDefaultShipCheckpoints(),
    ...(Array.isArray(checkpoints) ? checkpoints : []),
  ]);
}

function normalizeShipStatus(status) {
  const safeStatus = sanitizeText(status || '', 40);
  if (safeStatus === 'UPP') return 'Non Operasional';
  if (safeStatus === 'NON UPP') return 'Operasional';
  if (SHIP_STATUS_OPTIONS.includes(safeStatus)) return safeStatus;
  return 'Non Operasional';
}

function splitLegacyShipRoute(route) {
  const safeRoute = sanitizeText(route || '', 100);
  if (!safeRoute) {
    return { route: '', routeLoading: '', routeDischarge: '' };
  }

  const segments = safeRoute.split(/\s*-\s*/).map(part => sanitizeText(part, 100)).filter(Boolean);
  if (segments.length >= 2) {
    return {
      route: safeRoute,
      routeLoading: segments[0],
      routeDischarge: segments.slice(1).join(' - '),
    };
  }

  return {
    route: safeRoute,
    routeLoading: safeRoute,
    routeDischarge: '',
  };
}

function composeShipRoute(status, routeLoading, routeDischarge, fallbackRoute = '') {
  const normalizedStatus = normalizeShipStatus(status);
  const safeLoading = sanitizeText(routeLoading || '', 100);
  const safeDischarge = sanitizeText(routeDischarge || '', 100);
  const safeFallback = sanitizeText(fallbackRoute || '', 100);

  if (normalizedStatus === 'Non Operasional') {
    return safeLoading || safeFallback;
  }

  if (safeLoading && safeDischarge) return `${safeLoading} - ${safeDischarge}`;
  return safeLoading || safeDischarge || safeFallback;
}

function normalizeShipRouteFields(ship = {}) {
  const legacyRoute = splitLegacyShipRoute(ship?.route);
  const routeLoading = sanitizeText(ship?.routeLoading || legacyRoute.routeLoading || '', 100);
  const routeDischarge = sanitizeText(ship?.routeDischarge || legacyRoute.routeDischarge || '', 100);

  return {
    routeLoading,
    routeDischarge,
    route: composeShipRoute(ship?.status, routeLoading, routeDischarge, legacyRoute.route),
  };
}

function normalizeShipRecord(ship = {}) {
  const normalizedStatus = normalizeShipStatus(ship?.status);
  const routeFields = normalizeShipRouteFields({ ...ship, status: normalizedStatus });
  const sosRecipientShipIds = Array.from(new Set(
    (Array.isArray(ship?.sosRecipientShipIds) ? ship.sosRecipientShipIds : [])
      .map((shipId) => sanitizeText(shipId || '', 80))
      .filter(Boolean),
  ));

  return {
    ...ship,
    status: normalizedStatus,
    ...routeFields,
    imoNumber: sanitizeText(ship?.imoNumber || '', 20),
    documents: Array.isArray(ship?.documents)
      ? ship.documents.map(document => ({
        ...document,
        docDate: sanitizeText(document?.docDate || '', 20),
      }))
      : [],
    sosRecipientShipIds,
    defaultCheckpointsInitialized: true,
    // Pastikan checklist wajib selalu ada pada semua kapal, termasuk data lama yang sudah tersimpan.
    customCheckpoints: initializeShipCheckpointDefinitions(ship?.customCheckpoints),
  };
}

function normalizeShipsCollection(ships = []) {
  return (Array.isArray(ships) ? ships : []).map(ship => normalizeShipRecord(ship));
}

const defaultAuthForm = {
  name: '',
  email: '',
  password: '',
  confirmPassword: '',
  type: 'BUJP',
  workerNumber: '',
  phone: '',
  dob: '',
  address: '',
  officeAddress: '',
  emergencyName: '',
  emergencyContact: '',
  emergencyRelation: 'Orang Tua',
  photoUrl: null,
};
const defaultUserForm = { name: '', role: ACCESS_ROLES.PETUGAS, type: 'BUJP', workerNumber: '', dob: '', email: '', password: '', phone: '', address: '', emergencyName: '', emergencyContact: '', emergencyRelation: 'Orang Tua', officeAddress: '', photoUrl: null };
const defaultShipForm = { name: '', type: 'Oil Tanker', imoNumber: '', route: '', routeLoading: '', routeDischarge: '', cargoType: '', cargoAmount: '', status: 'Non Operasional', customCheckpoints: createDefaultShipCheckpoints(), photoUrl: null, sosRecipientShipIds: [] };
const defaultShipDocumentForm = { title: '', docDate: '', desc: '', fileUrl: null, fileName: '', mimeType: '' };
const defaultIncidentForm = { locType: 'default', location: '', customLocation: '', penyebab: '', deskripsi: '', tindakLanjut: '', photoUrl: null };

const createAuthFormState = (overrides = {}) => ({ ...defaultAuthForm, ...overrides });
const createUserFormState = () => ({ ...defaultUserForm });
const createShipFormState = () => ({
  ...defaultShipForm,
  customCheckpoints: createDefaultShipCheckpoints(),
});
const createShipDocumentState = () => ({ ...defaultShipDocumentForm });
const createIncidentFormState = () => ({ ...defaultIncidentForm });

function createUserAvatar(name, index = 0) {
  const initials = sanitizeText(name, 40).split(' ').filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase() || 'SP';
  return createPosterDataUrl(initials, name, index, true);
}

const initialCheckpoints = defaultLocationOptions.map((name, index) => ({ id: index + 1, name, status: 'pending' }));

// Data awal versi SQL sengaja kosong; admin pertama dibuat lewat script setup:admin.
let _mockUsersList = null;
function getMockUsersList() {
  if (_mockUsersList) return _mockUsersList;
  _mockUsersList = [];
  return _mockUsersList;
}

const seedUsersById = {};
const seedUsersByEmail = {};
function buildSeedLookups() {
  if (Object.keys(seedUsersById).length > 0) return;
  getMockUsersList().forEach(u => { seedUsersById[u.id] = u; if (u.email) seedUsersByEmail[u.email.toLowerCase()] = u; });
}

let _initialShipsData = null;
function getInitialShipsData() {
  if (_initialShipsData) return _initialShipsData;
  _initialShipsData = [];
  return _initialShipsData;
}

const APP_STORAGE_KEY = 'smartpatrol.secure.local.v2';
const LEGACY_APP_STORAGE_KEY = 'smartpatrol.legacy.local.v1';
const WEATHER_STORAGE_KEY = 'smartpatrol.weather.local.v2';
const LEGACY_WEATHER_STORAGE_KEY = 'smartpatrol.legacy.weather.v1';
const WEATHER_TTL_MS = 30 * 60 * 1000;

// --- MODULE-LEVEL CACHED FORMATTERS (avoids recreating Intl instances on every call) ---
const _jakartaDatePartsFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: APP_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

// --- SHALLOW EQUALITY HELPERS (replaces JSON.stringify comparisons) ---
function shallowEqualObjects(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every(key => a[key] === b[key]);
}

function arraysEqual(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  return a.every((val, i) => val === b[i]);
}

function ensureArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function ensureObject(value) {
  return value && typeof value === 'object' ? value : null;
}

function isNavigatorOnline() {
  if (typeof navigator === 'undefined') return true;
  return navigator.onLine !== false;
}

// --- UTILITY FUNCTIONS ---
function getJakartaDateParts(date = new Date()) {
  // Reuses module-level cached formatter — avoids recreating Intl instance on every call
  const parts = _jakartaDatePartsFormatter.formatToParts(date).reduce((accumulator, part) => {
    if (part.type !== 'literal') accumulator[part.type] = part.value;
    return accumulator;
  }, {});
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function toDateKey({ year, month, day }) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseDateKey(dateKey) {
  const [year, month, day] = String(dateKey || '').split('-').map(Number);
  return { year, month, day };
}

function formatDateLabel(dateKey) {
  const { year, month, day } = parseDateKey(dateKey);
  const safeDate = new Date(Date.UTC(year, Math.max(month - 1, 0), day, 12, 0, 0));
  return safeDate.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric', timeZone: APP_TIME_ZONE });
}

function formatHistoryDateKeyLabel(dateKey) {
  const match = String(dateKey || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return '';

  const [, yearToken, monthToken, dayToken] = match;
  const year = Number(yearToken);
  const month = Number(monthToken);
  const day = Number(dayToken);
  const safeDate = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));

  if (
    Number.isNaN(safeDate.getTime())
    || safeDate.getUTCFullYear() !== year
    || safeDate.getUTCMonth() !== month - 1
    || safeDate.getUTCDate() !== day
  ) {
    return '';
  }

  return formatDateLabel(`${yearToken}-${monthToken}-${dayToken}`);
}

function resolveHistoryDateLabel(entry = {}) {
  const explicitDate = sanitizeText(entry?.date || '', 80).trim();
  if (explicitDate && explicitDate !== '-' && explicitDate.toLowerCase() !== 'invalid date') return explicitDate;

  const dateKeyLabel = formatHistoryDateKeyLabel(entry?.dateKey);
  if (dateKeyLabel) return dateKeyLabel;

  const keyDateMatch = String(entry?.key || '').match(/(?:^|\|)(\d{4}-\d{2}-\d{2})(?=\|)/);
  const keyDateLabel = formatHistoryDateKeyLabel(keyDateMatch?.[1]);
  if (keyDateLabel) return keyDateLabel;

  const createdAtDate = entry?.createdAt ? new Date(entry.createdAt) : null;
  if (createdAtDate && !Number.isNaN(createdAtDate.getTime())) {
    return createdAtDate.toLocaleDateString('id-ID', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: APP_TIME_ZONE,
    });
  }

  return '-';
}

function normalizeHistoryEntryDate(entry = {}) {
  const dateLabel = resolveHistoryDateLabel(entry);

  return {
    ...entry,
    date: dateLabel,
    checkpoints: ensureArray(entry.checkpoints).map((checkpoint) => ({
      ...checkpoint,
      date: sanitizeText(checkpoint?.date || '', 80).trim() || dateLabel,
    })),
  };
}

function formatAppDate(value = new Date()) {
  const safeDate = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(safeDate.getTime())) return '';
  return safeDate.toLocaleDateString('id-ID', { timeZone: APP_TIME_ZONE });
}

function formatAppTime(value = new Date()) {
  const safeDate = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(safeDate.getTime())) return '';
  return safeDate.toLocaleTimeString('id-ID', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: APP_TIME_ZONE,
  });
}

function createJakartaDate(dateKey, hour = 0, minute = 0) {
  const { year, month, day } = parseDateKey(dateKey);
  return new Date(Date.UTC(
    year,
    Math.max(month - 1, 0),
    day,
    hour - APP_TIME_ZONE_UTC_OFFSET_HOURS,
    minute,
    0,
  ));
}

function getShiftStartMinutes(shift) {
  return ((shift?.startHour || 0) * 60) + (shift?.startMinute || 0);
}

function getShiftEndMinutes(shift) {
  return ((shift?.endHour || 0) * 60) + (shift?.endMinute || 0);
}

function isOvernightShift(shift) {
  if (!shift) return false;
  if (shift.crossesMidnight) return true;
  return getShiftEndMinutes(shift) <= getShiftStartMinutes(shift);
}

function getShiftDefinition(shiftId) {
  return SHIFT_DEFINITION_MAP[shiftId] || SHIFT_SEQUENCE[0];
}

function getCurrentShiftDefinitionByParts(parts) {
  const currentMinutes = (parts.hour * 60) + parts.minute;

  return SHIFT_SEQUENCE.find((shift) => {
    const startMinutes = getShiftStartMinutes(shift);
    const endMinutes = getShiftEndMinutes(shift);

    if (isOvernightShift(shift)) {
      return currentMinutes >= startMinutes || currentMinutes < endMinutes;
    }

    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }) || SHIFT_SEQUENCE[0];
}

function isLegacyShiftDefinition(shift) {
  return Boolean(shift?.legacy);
}

function isCompatShiftDefinition(shift) {
  return Boolean(shift?.compat || shift?.legacy);
}

function getCheckpointShiftTimestamp(checkpoint) {
  const candidates = [
    checkpoint?.completedAt,
    checkpoint?.updatedAt,
    checkpoint?.createdAt,
    checkpoint?.occurredAtTrustedIso,
  ];

  for (let index = 0; index < candidates.length; index += 1) {
    const timestamp = new Date(candidates[index] || '').getTime();
    if (!Number.isNaN(timestamp) && timestamp > 0) {
      return timestamp;
    }
  }

  const trustedMs = checkpoint?.occurredAtTrustedMs;
  if (Number.isFinite(trustedMs) && trustedMs > 0) {
    return trustedMs;
  }

  return null;
}

function getShiftScheduleTimes(meta) {
  const safeMeta = meta || getShiftMeta();
  const definition = getShiftDefinition(safeMeta.id);
  const startAt = createJakartaDate(
    safeMeta.dateKey,
    definition.startHour || 0,
    definition.startMinute || 0,
  );
  const endDateKey = isOvernightShift(definition)
    ? addDaysToDateKey(safeMeta.dateKey, 1)
    : safeMeta.dateKey;
  const endAt = createJakartaDate(
    endDateKey,
    definition.endHour || 0,
    definition.endMinute || 0,
  );

  return {
    definition,
    startAt,
    endAt,
    checkpointPendingAt: new Date(endAt.getTime() - (60 * MINUTE_IN_MS)),
    shiftEndingSoonAt: new Date(endAt.getTime() - (15 * MINUTE_IN_MS)),
  };
}

function shiftMetaFromParts(dateKey, shiftId) {
  const definition = getShiftDefinition(shiftId);
  return {
    id: definition.id,
    key: `${dateKey}|${definition.id}`,
    label: definition.label,
    timeRange: definition.timeRange,
    dateKey,
    dateLabel: formatDateLabel(dateKey),
  };
}

function getShiftMeta(date = getTrustedDate()) {
  const parts = getJakartaDateParts(date);
  const definition = getCurrentShiftDefinitionByParts(parts);
  const currentDateKey = toDateKey(parts);
  const currentMinutes = (parts.hour * 60) + parts.minute;
  const dateKey = isOvernightShift(definition) && currentMinutes < getShiftEndMinutes(definition)
    ? addDaysToDateKey(currentDateKey, -1)
    : currentDateKey;
  return shiftMetaFromParts(dateKey, definition.id);
}

function getShiftMetaFromKey(key) {
  const [dateKey, shiftId] = String(key || '').split('|');
  if (!dateKey || !shiftId) return null;
  return shiftMetaFromParts(dateKey, shiftId);
}

function getCanonicalShiftMeta(meta) {
  if (!meta) return null;
  const definition = getShiftDefinition(meta.id);
  if (!definition) return null;
  if (!isCompatShiftDefinition(definition)) return meta;

  const { startAt } = getShiftScheduleTimes(meta);
  return getShiftMeta(new Date(startAt.getTime() + 1000));
}

function getCanonicalShiftMetaFromKey(key) {
  return getCanonicalShiftMeta(getShiftMetaFromKey(key));
}

function getCanonicalShiftMetaForCheckpoint(checkpoint, fallbackMeta = null) {
  const checkpointTimestamp = getCheckpointShiftTimestamp(checkpoint);
  if (checkpointTimestamp) {
    return getShiftMeta(new Date(checkpointTimestamp));
  }

  const checkpointShiftMeta = getCanonicalShiftMetaFromKey(checkpoint?.shiftKey);
  if (checkpointShiftMeta) return checkpointShiftMeta;

  return getCanonicalShiftMeta(fallbackMeta);
}

function normalizeShiftKeyForCloudSync(shiftKey, fallbackMeta = getShiftMeta()) {
  const safeFallbackMeta = getCanonicalShiftMeta(fallbackMeta) || fallbackMeta || getShiftMeta();
  const persistedShiftMeta = getCanonicalShiftMetaFromKey(shiftKey);
  if (!persistedShiftMeta) return safeFallbackMeta.key;

  const persistedShiftStartAt = getShiftScheduleTimes(persistedShiftMeta).startAt.getTime();
  const fallbackShiftStartAt = getShiftScheduleTimes(safeFallbackMeta).startAt.getTime();

  if (persistedShiftStartAt > fallbackShiftStartAt) return safeFallbackMeta.key;
  return persistedShiftMeta.key;
}

function resolveLatestShiftKey(shiftKeys = [], fallbackMeta = getShiftMeta()) {
  const safeFallbackMeta = fallbackMeta || getShiftMeta();
  let latestShiftMeta = null;
  let latestShiftStartAt = Number.NEGATIVE_INFINITY;

  ensureArray(Array.isArray(shiftKeys) ? shiftKeys : [shiftKeys]).forEach((shiftKey) => {
    const normalizedShiftKey = normalizeShiftKeyForCloudSync(shiftKey, safeFallbackMeta);
    const candidateShiftMeta = getShiftMetaFromKey(normalizedShiftKey);
    if (!candidateShiftMeta) return;

    const candidateShiftStartAt = getShiftScheduleTimes(candidateShiftMeta).startAt.getTime();
    if (candidateShiftStartAt >= latestShiftStartAt) {
      latestShiftMeta = candidateShiftMeta;
      latestShiftStartAt = candidateShiftStartAt;
    }
  });

  // Jangan langsung meloncat ke fallback shift saat ini jika state lama
  // masih membawa shift yang belum direkonsiliasi ke riwayat.
  if (!latestShiftMeta) {
    latestShiftMeta = getShiftMetaFromKey(safeFallbackMeta.key) || safeFallbackMeta;
  }

  return latestShiftMeta?.key || safeFallbackMeta.key;
}

function addDaysToDateKey(dateKey, days) {
  const { year, month, day } = parseDateKey(dateKey);
  const safeDate = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0));
  return toDateKey({
    year: safeDate.getUTCFullYear(),
    month: safeDate.getUTCMonth() + 1,
    day: safeDate.getUTCDate(),
  });
}

function getNextShiftMeta(meta) {
  const safeMeta = getCanonicalShiftMeta(meta) || meta || getShiftMeta();
  const { endAt } = getShiftScheduleTimes(safeMeta);
  return getShiftMeta(new Date(endAt.getTime() + 1000));
}

function createCheckpointNameKey(name) {
  return sanitizeText(name || '', 120).trim().toLowerCase();
}

function createShipCheckpointId(ship, checkpointName, index) {
  const slug = sanitizeText(checkpointName || '', 120)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '') || `checkpoint-${index + 1}`;

  return `${ship?.id || ship?.name || 'ship'}::${slug}::${index + 1}`;
}

function createBaseCheckpointRecord(ship, checkpoint, index) {
  return {
    id: createShipCheckpointId(ship, checkpoint?.name, index),
    name: sanitizeText(checkpoint?.name || '', 80) || `Checkpoint ${index + 1}`,
    desc: sanitizeMultilineText(checkpoint?.desc || '', 140),
    status: 'pending',
    updatedAt: null,
    shipId: ship?.id || null,
    shipName: ship?.name || '',
  };
}

function createShipCheckpointCollection(ship) {
  if (!ship) return [];
  return ensureArray(ship.customCheckpoints).map((checkpoint, index) => (
    createBaseCheckpointRecord(ship, checkpoint, index)
  ));
}

function isTemporaryShiftCheckpoint(checkpoint) {
  return Boolean(checkpoint?.isTemporaryShiftNode);
}

// Laporan checkpoint yang sudah menghasilkan status final (completed/missed). Ini adalah
// data yang TIDAK boleh hilang saat rekonstruksi lintas-device: bila dibuang karena tidak
// cocok dengan definisi checkpoint kapal di device penerima, hasil patroli "aman" lenyap
// (temuan tetap tampak karena punya cadangan di tabel incidents).
function isResolvedResultCheckpoint(checkpoint) {
  return Boolean(
    checkpoint
    && (checkpoint.status === 'completed' || checkpoint.status === 'missed' || checkpoint.resultType === 'missed'),
  );
}

function getCheckpointScopedShiftKey(checkpoint) {
  return sanitizeText(checkpoint?.shiftKey || checkpoint?.createdInShiftKey || '', 160) || null;
}

function normalizeTemporaryShiftCheckpointForShip(checkpoint, ship, fallbackShiftKey = null) {
  const safeCheckpoint = ensureObject(checkpoint);
  if (!safeCheckpoint || !isTemporaryShiftCheckpoint(safeCheckpoint)) return null;

  const id = sanitizeText(String(safeCheckpoint.id || ''), 180);
  const name = sanitizeText(safeCheckpoint.name || safeCheckpoint.checkpointName || '', 80);
  if (!id || !name) return null;

  const shiftKey = getCheckpointScopedShiftKey(safeCheckpoint) || fallbackShiftKey || null;

  return {
    ...safeCheckpoint,
    id,
    name,
    desc: sanitizeMultilineText(
      safeCheckpoint.desc || 'Titik tambahan sementara untuk shift berjalan.',
      140,
    ),
    status: sanitizeText(safeCheckpoint.status || 'pending', 20) || 'pending',
    shipId: ship?.id || safeCheckpoint.shipId || null,
    shipName: ship?.name || safeCheckpoint.shipName || '',
    isTemporaryShiftNode: true,
    createdInShiftKey: getCheckpointScopedShiftKey({ createdInShiftKey: safeCheckpoint.createdInShiftKey })
      || shiftKey,
    shiftKey,
  };
}

function getShiftMetaForCheckpointScope(checkpoint, fallbackMeta = null) {
  const scopedShiftKey = getCheckpointScopedShiftKey(checkpoint);
  if (scopedShiftKey) {
    return getCanonicalShiftMetaFromKey(scopedShiftKey) || getShiftMetaFromKey(scopedShiftKey) || fallbackMeta;
  }

  return getCanonicalShiftMetaForCheckpoint(checkpoint, fallbackMeta);
}

function resetCheckpointForShift(checkpoint, options = {}) {
  const {
    updatedAt = getTrustedDate().toISOString(),
    shiftKey = null,
    pendingOrigin = 'shift-reset',
  } = options;
  return {
    id: checkpoint.id,
    name: checkpoint.name,
    desc: checkpoint.desc || '',
    status: 'pending',
    updatedAt,
    shiftKey,
    pendingOrigin,
    shipId: checkpoint.shipId || null,
    shipName: checkpoint.shipName || '',
  };
}

function createCheckpointGalleryPhotoRecord(photoUrl, options = {}) {
  const trustedTimestamp = options.trustedTimestamp || createTrustedTimestampRecord();
  const createdAt = options.createdAt || trustedTimestamp.occurredAtTrustedIso;
  return normalizeTimeAuditRecord({
    id: options.id || `checkpoint-gallery-${trustedTimestamp.occurredAtTrustedMs}-${Math.random().toString(36).slice(2, 8)}`,
    photoUrl,
    author: sanitizeText(options.author || '', 80) || '-',
    date: options.date || formatAppDate(new Date(createdAt)),
    time: options.time || formatAppTime(new Date(createdAt)),
    createdAt,
    ...trustedTimestamp,
  }, {
    fallbackTimestampKeys: ['createdAt'],
  });
}

function resetCheckpointCollection(checkpoints, options = {}) {
  return ensureArray(checkpoints)
    .filter(checkpoint => !checkpoint.isTemporaryShiftNode)
    .map(checkpoint => resetCheckpointForShift(checkpoint, options));
}

function shouldResetCheckpointForActiveShift(checkpoint, activeShiftKey) {
  if (!checkpoint || checkpoint.status === 'pending' || checkpoint.isTemporaryShiftNode) return false;
  if (!activeShiftKey) return false;

  const activeShiftMeta = getCanonicalShiftMetaFromKey(activeShiftKey) || getShiftMetaFromKey(activeShiftKey);
  if (!activeShiftMeta) return false;

  const checkpointShiftMeta = getCanonicalShiftMetaForCheckpoint(checkpoint, activeShiftMeta);
  const checkpointTimestamp = getCheckpointShiftTimestamp(checkpoint);
  const activeShiftStartTimestamp = getShiftScheduleTimes(activeShiftMeta).startAt.getTime();

  if (checkpointShiftMeta?.key && checkpointShiftMeta.key !== activeShiftMeta.key) {
    const checkpointShiftStartTimestamp = getShiftScheduleTimes(checkpointShiftMeta).startAt.getTime();
    return checkpointShiftStartTimestamp < activeShiftStartTimestamp;
  }

  if (Number.isNaN(checkpointTimestamp) || checkpointTimestamp <= 0) return false;

  return checkpointTimestamp < activeShiftStartTimestamp;
}

function getShiftResetTimestamp(activeShiftKey, fallbackTimestamp = getTrustedDate().toISOString()) {
  const activeShiftMeta = getShiftMetaFromKey(activeShiftKey);
  if (!activeShiftMeta) return fallbackTimestamp;
  return getShiftScheduleTimes(activeShiftMeta).startAt.toISOString();
}

function normalizeShipScopedCheckpoints(ship, checkpoints = [], activeShiftKey = null) {
  const baseCheckpoints = createShipCheckpointCollection(ship);
  const safeCheckpoints = ensureArray(checkpoints).filter(checkpoint => ensureObject(checkpoint));
  const checkpointsById = new Map(safeCheckpoints.map(checkpoint => [String(checkpoint.id), checkpoint]));
  const checkpointsByName = new Map(safeCheckpoints.map(checkpoint => [createCheckpointNameKey(checkpoint.name), checkpoint]));

  const normalizedBaseCheckpoints = baseCheckpoints.map((baseCheckpoint) => {
    const matchedCheckpoint = checkpointsById.get(String(baseCheckpoint.id))
      || checkpointsByName.get(createCheckpointNameKey(baseCheckpoint.name));

    if (!matchedCheckpoint) return baseCheckpoint;

    const normalizedCheckpoint = shouldResetCheckpointForActiveShift(matchedCheckpoint, activeShiftKey)
      ? resetCheckpointForShift(matchedCheckpoint, {
        shiftKey: activeShiftKey,
        updatedAt: getShiftResetTimestamp(activeShiftKey),
        pendingOrigin: 'shift-reset',
      })
      : matchedCheckpoint;

    return {
      ...baseCheckpoint,
      ...normalizedCheckpoint,
      id: baseCheckpoint.id,
      name: baseCheckpoint.name,
      desc: baseCheckpoint.desc,
      shipId: ship?.id || normalizedCheckpoint.shipId || null,
      shipName: ship?.name || normalizedCheckpoint.shipName || '',
    };
  });

  const baseCheckpointIds = new Set(normalizedBaseCheckpoints.map(checkpoint => String(checkpoint.id)));
  const baseCheckpointNameKeys = new Set(normalizedBaseCheckpoints.map(checkpoint => createCheckpointNameKey(checkpoint.name)));
  const temporaryCheckpoints = safeCheckpoints
    .filter(checkpoint => isTemporaryShiftCheckpoint(checkpoint))
    .map(checkpoint => normalizeTemporaryShiftCheckpointForShip(checkpoint, ship, activeShiftKey))
    .filter(Boolean)
    .filter(checkpoint => (
      !baseCheckpointIds.has(String(checkpoint.id))
      && !baseCheckpointNameKeys.has(createCheckpointNameKey(checkpoint.name))
    ));

  // Laporan completed/missed yang tidak punya padanan di definisi checkpoint kapal device
  // ini (mis. definisi berbeda urutan/nama, atau belum tersinkron) JANGAN dibuang. Jalur
  // realtime (mergePatrolReportDocumentsIntoCheckpoints) sudah mempertahankan laporan
  // semacam ini; jalur snapshot penuh harus konsisten agar hasil patroli tidak lenyap di
  // device lain.
  const orphanResultCheckpoints = safeCheckpoints
    .filter(checkpoint => !isTemporaryShiftCheckpoint(checkpoint))
    .filter(isResolvedResultCheckpoint)
    .filter(checkpoint => (
      !baseCheckpointIds.has(String(checkpoint.id))
      && !baseCheckpointNameKeys.has(createCheckpointNameKey(checkpoint.name))
    ))
    // Orphan dari shift lampau (relatif activeShiftKey) bukan milik tampilan live —
    // biarkan jalur migrate yang memindahkannya ke history, jangan tahan di sini.
    .filter(checkpoint => !shouldResetCheckpointForActiveShift(checkpoint, activeShiftKey))
    .map(checkpoint => ({
      ...checkpoint,
      shipId: ship?.id || checkpoint.shipId || null,
      shipName: ship?.name || checkpoint.shipName || '',
    }));

  // Titik tambahan shift tidak ada di definisi kapal, jadi harus disambung
  // kembali setelah normalisasi agar tidak hilang saat submit/snapshot cloud.
  return [...normalizedBaseCheckpoints, ...temporaryCheckpoints, ...orphanResultCheckpoints];
}

function createCheckpointsByShipState(ships = [], savedCheckpointsByShip = {}, legacyCheckpoints = null, activeShiftKey = null) {
  const savedState = savedCheckpointsByShip && typeof savedCheckpointsByShip === 'object'
    ? savedCheckpointsByShip
    : {};
  const fallbackShip = ships[0] || null;

  return ships.reduce((collection, ship) => {
    const savedForShip = Array.isArray(savedState[ship.id])
      ? savedState[ship.id]
      : Array.isArray(savedState[ship.name])
        ? savedState[ship.name]
        : fallbackShip?.id === ship.id && Array.isArray(legacyCheckpoints)
          ? legacyCheckpoints
          : [];

    collection[ship.id] = normalizeShipScopedCheckpoints(ship, savedForShip, activeShiftKey);
    return collection;
  }, {});
}

function createHistoryEntryKey(ship, shiftMeta) {
  const shipToken = sanitizeText(ship?.id || ship?.name || 'ship', 120)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '') || 'ship';

  return `${shipToken}|${shiftMeta.key}`;
}

function createPatrolIncidentId(checkpoint) {
  const existingIncidentId = sanitizeText(checkpoint?.incidentId || '', 200).trim();
  if (existingIncidentId) return existingIncidentId;

  const checkpointToken = sanitizeText(checkpoint?.id || 'checkpoint', 120)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '') || 'checkpoint';

  const completedToken = sanitizeText(checkpoint?.completedAt || '', 120)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

  return completedToken ? `p-${checkpointToken}-${completedToken}` : `p-${checkpoint.id}`;
}

function getIncidentDateLabel(value) {
  if (!value) return formatAppDate();
  const parsedDate = new Date(value);
  if (Number.isNaN(parsedDate.getTime())) return String(value);
  return formatAppDate(parsedDate);
}

function getIncidentSortTimestamp(incident) {
  const directTimestamp = (
    Number.isFinite(incident?.occurredAtTrustedMs)
      ? incident.occurredAtTrustedMs
      : new Date(
        incident?.occurredAtTrustedIso
        || incident?.completedAt
        || incident?.createdAt
        || incident?.reportedAt
        || '',
      ).getTime()
  );

  if (!Number.isNaN(directTimestamp) && directTimestamp > 0) {
    return directTimestamp;
  }

  if (typeof incident?.id === 'number') {
    return incident.id;
  }

  return 0;
}

function createPatrolIncidentRecord(checkpoint, options = {}) {
  const {
    fallbackShipName = '',
    fallbackDate = '',
    readOnly = false,
  } = options;

  return normalizeTimeAuditRecord({
    id: createPatrolIncidentId(checkpoint),
    date: checkpoint?.date || getIncidentDateLabel(checkpoint?.completedAt || fallbackDate),
    time: checkpoint?.time || '-',
    location: checkpoint?.name || '-',
    shipName: checkpoint?.shipName || fallbackShipName || '',
    deskripsi: checkpoint?.kejadian || '',
    penyebab: checkpoint?.penyebab || '',
    tindakLanjut: checkpoint?.tindakLanjut || '',
    reportedBy: checkpoint?.completedBy || '-',
    photoUrl: checkpoint?.photoUrl || null,
    isPatrol: true,
    readOnly: readOnly || Boolean(checkpoint?.readOnly),
    completedAt: checkpoint?.completedAt || null,
    checkpointId: checkpoint?.id || null,
    shiftKey: checkpoint?.shiftKey || null,
    shipId: checkpoint?.shipId || null,
    gpsSnapshot: checkpoint?.gpsSnapshot || null,
    shipSnapshot: checkpoint?.shipSnapshot || null,
    ...extractTimeAuditFields(checkpoint),
  }, {
    fallbackTimestampKeys: ['completedAt', 'updatedAt', 'createdAt'],
  });
}

function formatSOSCoordinate(value) {
  const numeric = typeof value === 'number'
    ? value
    : Number(String(value ?? '').replace(',', '.'));

  if (!Number.isFinite(numeric)) return '-';
  return numeric.toFixed(6);
}

function createSOSIncidentRecord(sos) {
  if (!sos) return null;

  const shipName = sanitizeText(sos.shipName || '', 80) || 'Tidak diketahui';
  const senderName = sanitizeText(sos.senderName || '', 80) || 'Petugas';
  const triggeredAt = sos.triggeredAt || sos.createdAt || null;
  const resolvedAt = sos.resolvedAt || null;
  const confirmedCount = Array.isArray(sos.confirmedBy) ? sos.confirmedBy.length : 0;
  const targetShipNames = Array.from(new Set([
    shipName,
    ...((Array.isArray(sos.targetShipNames) ? sos.targetShipNames : [])
      .map((name) => sanitizeText(name || '', 80))
      .filter(Boolean)),
  ]));
  const formattedLat = formatSOSCoordinate(sos.lat);
  const formattedLng = formatSOSCoordinate(sos.lng);
  const isResolved = sanitizeText(sos.status || '', 20).toLowerCase() === 'resolved';
  const resolutionLabel = isResolved
    ? `SOS telah ditangani oleh ${sanitizeText(sos.resolvedBy || '', 80) || 'Sistem'}${resolvedAt ? ` pada ${getIncidentDateLabel(resolvedAt)} ${formatAppTime(new Date(resolvedAt))}` : ''}.`
    : `Menunggu tindak lanjut darurat${confirmedCount > 0 ? ` dan sudah dikonfirmasi ${confirmedCount} petugas` : ''}.`;

  return normalizeTimeAuditRecord({
    id: sos.id,
    date: getIncidentDateLabel(triggeredAt),
    time: triggeredAt ? formatAppTime(new Date(triggeredAt)) : '-',
    reportedAt: triggeredAt,
    triggeredAt,
    source: 'sos',
    location: 'SOS Darurat',
    shipName,
    deskripsi: `Sinyal SOS dikirim oleh ${senderName} dari kapal ${shipName}.${formattedLat !== '-' && formattedLng !== '-' ? ` Koordinat terakhir ${formattedLat}, ${formattedLng}.` : ' Koordinat terakhir belum tersedia.'}`,
    penyebab: 'Tombol SOS diaktifkan untuk meminta bantuan darurat di lapangan.',
    tindakLanjut: resolutionLabel,
    reportedBy: senderName,
    photoUrl: null,
    isSOS: true,
    readOnly: true,
    createdAt: triggeredAt,
    sosStatus: isResolved ? 'resolved' : 'active',
    senderUserId: sos.senderUserId || null,
    targetUserIds: Array.isArray(sos.targetUserIds) ? sos.targetUserIds : [],
    senderAcknowledgedAt: sos.senderAcknowledgedAt || null,
    senderAcknowledgedBy: sos.senderAcknowledgedBy || null,
    targetShipNames,
    lat: sos.lat ?? null,
    lng: sos.lng ?? null,
    ...extractTimeAuditFields(sos),
  }, {
    fallbackTimestampKeys: ['triggeredAt', 'createdAt'],
  });
}

function createMissedCheckpoint(checkpoint, shiftMeta) {
  const { endAt } = getShiftScheduleTimes(shiftMeta);
  return {
    id: checkpoint.id,
    name: checkpoint.name,
    status: 'missed',
    resultType: 'missed',
    completedBy: '-',
    time: formatAppTime(endAt) || '-',
    shipName: checkpoint.shipName || '',
    photoUrl: null,
    penyebab: '',
    kejadian: 'Titik ini tidak dipatroli pada shift dan tanggal tersebut.',
    tindakLanjut: 'Masuk status missed pada akhir shift.',
  };
}

function summarizePatrolCheckpoints(checkpoints) {
  // Hitung pending vs missed secara eksplisit:
  //  - pending: checkpoint belum dipatroli pada shift live yang sedang berjalan.
  //  - missed : checkpoint yang sudah dikunci sebagai missed (umumnya saat shift wrap-up).
  // Catatan: kartu UI memilih label "Pending Checkpoint" untuk shift live dan
  // "Missed Checkpoint" untuk history; angka dasarnya tetap dipisah di sini.
  return ensureArray(checkpoints).reduce((acc, checkpoint) => {
    acc.total += 1;
    if (checkpoint.status === 'completed') {
      acc.completed += 1;
      if (checkpoint.resultType === 'aman') acc.aman += 1;
      if (checkpoint.resultType === 'temuan') acc.temuan += 1;
    }
    if (checkpoint.status === 'missed' || checkpoint.resultType === 'missed') {
      acc.missed += 1;
    }
    if (checkpoint.status === 'pending') {
      acc.pending += 1;
    }
    return acc;
  }, { aman: 0, temuan: 0, missed: 0, pending: 0, completed: 0, total: 0 });
}

function createGuardNameKey(name) {
  return sanitizeText(name || '', 80).trim().toLowerCase();
}

function buildGuardScoreMaps(checkpoints = []) {
  return checkpoints.reduce((accumulator, checkpoint) => {
    if (checkpoint.status !== 'completed') return accumulator;

    if (checkpoint.completedByUserId) {
      accumulator.byId.set(
        checkpoint.completedByUserId,
        (accumulator.byId.get(checkpoint.completedByUserId) || 0) + 1,
      );
    }

    const guardNameKey = createGuardNameKey(checkpoint.completedBy);
    if (guardNameKey) {
      accumulator.byName.set(
        guardNameKey,
        (accumulator.byName.get(guardNameKey) || 0) + 1,
      );
    }

    return accumulator;
  }, { byId: new Map(), byName: new Map() });
}

const SHIFT_GUARD_STATUS = Object.freeze({
  PATROLI: 'patroli',
  ISTIRAHAT: 'istirahat',
});

function createShiftStatusRecordKey(shipId, shiftKey) {
  const safeShipId = sanitizeText(String(shipId || ''), 120).trim();
  const safeShiftKey = sanitizeText(String(shiftKey || ''), 160).trim();
  if (!safeShipId || !safeShiftKey) return '';
  return `${safeShipId}|${safeShiftKey}`;
}

function normalizeShiftGuardStatusValue(value) {
  const normalizedValue = sanitizeText(String(value || ''), 40).trim().toLowerCase();
  return normalizedValue === SHIFT_GUARD_STATUS.ISTIRAHAT
    ? SHIFT_GUARD_STATUS.ISTIRAHAT
    : SHIFT_GUARD_STATUS.PATROLI;
}

function normalizeShiftStatusItems(items = []) {
  const seenItemKeys = new Set();

  return ensureArray(items).reduce((normalizedItems, item) => {
    const userId = sanitizeText(String(item?.userId || ''), 120).trim();
    const name = sanitizeText(item?.name || '', 120).trim();
    const itemKey = userId || createGuardNameKey(name);
    if (!itemKey || seenItemKeys.has(itemKey)) return normalizedItems;

    seenItemKeys.add(itemKey);
    normalizedItems.push({
      userId: userId || null,
      name,
      role: ACCESS_ROLES.PETUGAS,
      status: normalizeShiftGuardStatusValue(item?.status),
    });

    return normalizedItems;
  }, []);
}

function normalizeShiftStatusRecord(record = {}) {
  if (!record || typeof record !== 'object') return null;

  const shipId = sanitizeText(String(record.shipId || ''), 120).trim();
  const shiftKey = sanitizeText(String(record.shiftKey || ''), 160).trim();
  const recordKey = createShiftStatusRecordKey(shipId, shiftKey);
  if (!recordKey) return null;

  const filledAtTrustedIso = sanitizeText(record.filledAtTrustedIso || record.updatedAt || '', 80).trim() || null;
  const filledAtTrustedMs = Number.isFinite(record.filledAtTrustedMs)
    ? record.filledAtTrustedMs
    : new Date(filledAtTrustedIso || '').getTime();

  return {
    key: recordKey,
    shipId,
    shipName: sanitizeText(record.shipName || '', 120).trim() || null,
    shiftKey,
    filledByUserId: sanitizeText(String(record.filledByUserId || ''), 120).trim() || null,
    filledByName: sanitizeText(record.filledByName || '', 120).trim() || null,
    filledAtTrustedIso,
    filledAtTrustedMs: Number.isFinite(filledAtTrustedMs) ? filledAtTrustedMs : null,
    filledAtClientMs: Number.isFinite(record.filledAtClientMs) ? record.filledAtClientMs : null,
    timeTrustLevel: sanitizeText(record.timeTrustLevel || '', 40).trim() || null,
    clockTamperDetected: Boolean(record.clockTamperDetected),
    items: normalizeShiftStatusItems(record.items),
    updatedAt: filledAtTrustedIso,
  };
}

function getShiftStatusRecordTimestamp(record) {
  if (!record) return 0;
  if (Number.isFinite(record.filledAtTrustedMs)) return record.filledAtTrustedMs;

  const parsedTimestamp = new Date(record.filledAtTrustedIso || record.updatedAt || '').getTime();
  return Number.isNaN(parsedTimestamp) ? 0 : parsedTimestamp;
}

function mergeShiftStatusRecord(baseRecord, nextRecord) {
  if (!baseRecord) return nextRecord;
  if (!nextRecord) return baseRecord;

  const baseTimestamp = getShiftStatusRecordTimestamp(baseRecord);
  const nextTimestamp = getShiftStatusRecordTimestamp(nextRecord);
  const shouldUseNext = (
    Number.isNaN(baseTimestamp)
    || (!Number.isNaN(nextTimestamp) && nextTimestamp >= baseTimestamp)
  );
  const preferredRecord = shouldUseNext ? nextRecord : baseRecord;
  const fallbackRecord = shouldUseNext ? baseRecord : nextRecord;

  return {
    ...fallbackRecord,
    ...preferredRecord,
    key: preferredRecord.key || fallbackRecord.key,
    shipId: preferredRecord.shipId || fallbackRecord.shipId,
    shiftKey: preferredRecord.shiftKey || fallbackRecord.shiftKey,
    items: preferredRecord.items?.length ? preferredRecord.items : (fallbackRecord.items || []),
  };
}

function mergeShiftStatusRecords(baseRecords = {}, nextRecords = {}) {
  const mergedRecords = new Map();

  [
    ...Object.values(baseRecords || {}),
    ...Object.values(nextRecords || {}),
  ].forEach((record) => {
    const normalizedRecord = normalizeShiftStatusRecord(record);
    if (!normalizedRecord) return;

    const existingRecord = mergedRecords.get(normalizedRecord.key);
    mergedRecords.set(
      normalizedRecord.key,
      existingRecord ? mergeShiftStatusRecord(existingRecord, normalizedRecord) : normalizedRecord,
    );
  });

  return Object.fromEntries(mergedRecords.entries());
}

function getShiftStatusRecordForShipShift(records = {}, shipId, shiftKey) {
  const recordKey = createShiftStatusRecordKey(shipId, shiftKey);
  if (!recordKey) return null;
  return normalizeShiftStatusRecord(records?.[recordKey]);
}

function hasFilledShiftStatusRecord(record) {
  const normalizedRecord = normalizeShiftStatusRecord(record);
  if (!normalizedRecord) return false;

  return Boolean(
    normalizedRecord.filledByUserId
    || normalizedRecord.filledByName
    || normalizedRecord.items.length > 0
  );
}

function retainShiftStatusRecordsForShift(records = {}, shiftKey = null) {
  if (!shiftKey) return {};

  return Object.values(records || {}).reduce((collection, record) => {
    const normalizedRecord = normalizeShiftStatusRecord(record);
    if (!normalizedRecord || normalizedRecord.shiftKey !== shiftKey) return collection;

    collection[normalizedRecord.key] = normalizedRecord;
    return collection;
  }, {});
}

// Hydrate-safe pruning: drop hanya record yang lebih tua dari maxAgeMs.
// Tidak comparing ke currentShiftKey karena di Android cold start key tsb
// belum reliable (trusted-time anchor masih async). Lookup tetap exact-match
// di getShiftStatusRecordForShipShift, jadi records "shift lain" yang masih
// segar aman di-keep — cuma muncul di UI kalau key-nya match.
function pruneStaleShiftStatusRecords(records = {}, { maxAgeMs = 7 * 24 * 60 * 60 * 1000 } = {}) {
  const cutoffMs = Date.now() - maxAgeMs;

  return Object.values(records || {}).reduce((collection, record) => {
    const normalizedRecord = normalizeShiftStatusRecord(record);
    if (!normalizedRecord) return collection;

    const recordTimestamp = getShiftStatusRecordTimestamp(normalizedRecord);
    // Keep record kalau timestamp tidak diketahui (0) — defensive fallback.
    if (recordTimestamp > 0 && recordTimestamp < cutoffMs) return collection;

    collection[normalizedRecord.key] = normalizedRecord;
    return collection;
  }, {});
}

function buildGuardShiftSnapshot(users, shipName, checkpoints = [], shiftStatusRecord = null) {
  const scoreMaps = buildGuardScoreMaps(checkpoints);
  const normalizedShiftStatusRecord = normalizeShiftStatusRecord(shiftStatusRecord);
  const statusByUserId = new Map();
  const statusByName = new Map();

  normalizedShiftStatusRecord?.items?.forEach((item) => {
    if (item.userId) statusByUserId.set(item.userId, item.status);

    const guardNameKey = createGuardNameKey(item.name);
    if (guardNameKey) statusByName.set(guardNameKey, item.status);
  });

  return ensureArray(users)
    .filter(user => user.shipAssigned === shipName && user.status === 'active' && user.role === ACCESS_ROLES.PETUGAS)
    .map((user) => {
      const shiftStatus = statusByUserId.get(user.id) || statusByName.get(createGuardNameKey(user.name)) || null;

      return {
        id: user.id,
        name: user.name,
        role: user.role,
        photoUrl: user.photoUrl || null,
        score: scoreMaps.byId.get(user.id) || scoreMaps.byName.get(createGuardNameKey(user.name)) || 0,
        shiftStatus,
        shiftStatusLabel: shiftStatus === SHIFT_GUARD_STATUS.ISTIRAHAT
          ? 'ISTIRAHAT'
          : shiftStatus === SHIFT_GUARD_STATUS.PATROLI
            ? 'PATROLI'
            : null,
      };
    });
}

function buildHistoryEntry({ shiftMeta, checkpoints, ship, users, weatherInfo, shiftStatusRecords = {} }) {
  const historyKey = createHistoryEntryKey(ship, shiftMeta);
  const historyId = `history-${historyKey}`;
  const { endAt } = getShiftScheduleTimes(shiftMeta);
  const shiftStatusRecord = getShiftStatusRecordForShipShift(shiftStatusRecords, ship?.id, shiftMeta.key);
  const snapshotCheckpoints = checkpoints.map(checkpoint => (
    checkpoint.status === 'completed'
      ? { ...checkpoint, readOnly: true, historyId, date: shiftMeta.dateLabel }
      : { ...createMissedCheckpoint(checkpoint, shiftMeta), readOnly: true, historyId, date: shiftMeta.dateLabel, shipName: ship?.name || checkpoint.shipName || '' }
  ));
  const summary = summarizePatrolCheckpoints(snapshotCheckpoints);
  const shipName = ship?.name || 'Belum Ada Kapal';

  return {
    id: historyId,
    key: historyKey,
    date: shiftMeta.dateLabel,
    dateKey: shiftMeta.dateKey,
    shift: shiftMeta.label,
    shiftId: shiftMeta.id,
    time: shiftMeta.timeRange,
    ship: shipName,
    shipSnapshot: ship ? { id: ship.id, name: ship.name, lat: ship.lat, lng: ship.lng } : null,
    crewSnapshot: buildGuardShiftSnapshot(users, shipName, snapshotCheckpoints, shiftStatusRecord),
    weatherSnapshot: weatherInfo ? { ...weatherInfo } : null,
    checkpoints: snapshotCheckpoints,
    summary,
    points: summary.total,
    issue: summary.temuan,
    missed: summary.missed,
    createdAt: endAt.toISOString(),
  };
}

function normalizeSnapshotCoordinate(value, digits = 6) {
  const numeric = typeof value === 'number'
    ? value
    : Number(String(value ?? '').replace(',', '.'));

  if (!Number.isFinite(numeric)) return null;
  return Number(numeric.toFixed(digits));
}

function normalizeSnapshotCoordinatePair(latValue, lngValue, digits = 6) {
  const lat = normalizeSnapshotCoordinate(latValue, digits);
  const lng = normalizeSnapshotCoordinate(lngValue, digits);
  if (lat == null || lng == null) return null;

  // Koordinat 0,0 adalah fallback error umum dari GPS/perangkat, bukan lokasi patroli valid.
  if (Math.abs(lat) < 0.000001 && Math.abs(lng) < 0.000001) return null;

  return { lat, lng };
}

function createShipLocationSnapshot(ship) {
  if (!ship) return null;

  const coordinatePair = normalizeSnapshotCoordinatePair(ship.lat, ship.lng);

  return {
    id: ship.id || null,
    name: ship.name || '',
    lat: coordinatePair?.lat ?? null,
    lng: coordinatePair?.lng ?? null,
  };
}

const PATROL_SUBMIT_GEOLOCATION_TIMEOUT_MS = 5000;
const PATROL_SUBMIT_GEOLOCATION_MAX_AGE_MS = 30000;

function createGeolocationRequestOptions(options = {}) {
  return {
    enableHighAccuracy: options.enableHighAccuracy !== false,
    timeout: Number.isFinite(options.timeout) ? options.timeout : 8000,
    maximumAge: Number.isFinite(options.maximumAge) ? options.maximumAge : 0,
  };
}

async function requestCurrentGeolocation(options = {}) {
  const geolocationOptions = createGeolocationRequestOptions(options);

  try {
    const nativePosition = await getNativeGeolocationPosition(geolocationOptions);
    if (nativePosition?.coords) {
      const coordinatePair = normalizeSnapshotCoordinatePair(
        nativePosition.coords.latitude,
        nativePosition.coords.longitude,
      );
      if (!coordinatePair) return null;

      return {
        ...coordinatePair,
        accuracy: Number.isFinite(nativePosition.coords.accuracy)
          ? Math.round(nativePosition.coords.accuracy)
          : null,
      };
    }
  } catch (error) {
    console.warn('GPS native patroli tidak tersedia, memakai fallback Web Geolocation', error);
  }

  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    return null;
  }

  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const coordinatePair = normalizeSnapshotCoordinatePair(
          position.coords.latitude,
          position.coords.longitude,
        );
        if (!coordinatePair) {
          resolve(null);
          return;
        }

        resolve({
          ...coordinatePair,
          accuracy: Number.isFinite(position.coords.accuracy)
            ? Math.round(position.coords.accuracy)
            : null,
        });
      },
      (error) => {
        console.warn('GPS patroli tidak tersedia saat sync laporan', error);
        resolve(null);
      },
      geolocationOptions,
    );
  });
}

function createFallbackWeatherSnapshot(fallbackWeather, gpsSnapshot) {
  const safeFallbackWeather = ensureObject(fallbackWeather);
  if (!safeFallbackWeather || gpsSnapshot?.lat == null || gpsSnapshot?.lng == null) return null;

  return {
    ...safeFallbackWeather,
    capturedAt: gpsSnapshot.capturedAt,
    source: `${gpsSnapshot.source || 'cache'}-cache`,
    lat: gpsSnapshot.lat,
    lng: gpsSnapshot.lng,
  };
}

function buildLiveHistoryEntry({ shiftMeta, checkpoints, ship, users, shiftStatusRecord = null }) {
  if (!shiftMeta?.key || !ship) return null;

  const shipName = ship?.name || 'Belum Ada Kapal';
  const liveEntryKey = `live-${ship?.id || shipName}-${shiftMeta.key}`;
  const shipSnapshot = createShipLocationSnapshot(ship);
  const liveCheckpoints = ensureArray(checkpoints)
    .filter(checkpoint => ensureObject(checkpoint))
    .map(checkpoint => ({
      ...checkpoint,
      date: shiftMeta.dateLabel,
      shipName: checkpoint.shipName || shipName,
      shipSnapshot: checkpoint.shipSnapshot || shipSnapshot,
    }));
  const summary = summarizePatrolCheckpoints(liveCheckpoints);

  return {
    id: liveEntryKey,
    key: liveEntryKey,
    date: shiftMeta.dateLabel,
    dateKey: shiftMeta.dateKey,
    shift: shiftMeta.label,
    shiftId: shiftMeta.id,
    time: shiftMeta.timeRange,
    ship: shipName,
    shipSnapshot,
    crewSnapshot: buildGuardShiftSnapshot(users, shipName, liveCheckpoints, shiftStatusRecord),
    weatherSnapshot: null,
    checkpoints: liveCheckpoints,
    summary,
    points: summary.total,
    issue: summary.temuan,
    missed: summary.missed,
    pending: summary.pending,
    createdAt: getTrustedDate().toISOString(),
    isLive: true,
    readOnly: true,
  };
}

function normalizeCheckpointRecordForShip(baseCheckpoint, checkpoint, ship, shiftKey = checkpoint?.shiftKey || null) {
  if (!checkpoint) return { ...baseCheckpoint };

  return {
    ...baseCheckpoint,
    ...checkpoint,
    id: baseCheckpoint.id,
    name: baseCheckpoint.name,
    desc: baseCheckpoint.desc,
    shipId: ship?.id || checkpoint?.shipId || null,
    shipName: ship?.name || checkpoint?.shipName || '',
    shiftKey,
  };
}

function migrateCheckpointStateToCurrentShift({
  ships = [],
  checkpointsByShip = {},
  historyEntries = [],
  shiftStatusRecords = {},
  users = [],
  currentShiftMeta = getShiftMeta(),
}) {
  const safeCurrentShiftMeta = getCanonicalShiftMeta(currentShiftMeta) || currentShiftMeta || getShiftMeta();
  const currentShiftStartAt = getShiftScheduleTimes(safeCurrentShiftMeta).startAt.getTime();
  let nextHistoryEntries = sortHistoryEntries(historyEntries);
  let didMigrate = false;

  const nextCheckpointsByShip = ensureArray(ships).reduce((collection, ship) => {
    const baseCheckpoints = createShipCheckpointCollection(ship);
    const savedCheckpoints = ensureArray(checkpointsByShip?.[ship.id]).filter(checkpoint => ensureObject(checkpoint));
    const checkpointsById = new Map(savedCheckpoints.map(checkpoint => [String(checkpoint.id), checkpoint]));
    const checkpointsByName = new Map(savedCheckpoints.map(checkpoint => [createCheckpointNameKey(checkpoint.name), checkpoint]));
    const matchedCheckpoints = baseCheckpoints.map((baseCheckpoint) => (
      checkpointsById.get(String(baseCheckpoint.id))
      || checkpointsByName.get(createCheckpointNameKey(baseCheckpoint.name))
      || null
    ));
    const temporaryCheckpoints = savedCheckpoints
      .filter(checkpoint => isTemporaryShiftCheckpoint(checkpoint))
      .map(checkpoint => normalizeTemporaryShiftCheckpointForShip(checkpoint, ship, null))
      .filter(Boolean);
    const baseCheckpointIdSet = new Set(baseCheckpoints.map(baseCheckpoint => String(baseCheckpoint.id)));
    const baseCheckpointNameKeySet = new Set(baseCheckpoints.map(baseCheckpoint => createCheckpointNameKey(baseCheckpoint.name)));
    const pastShiftGroups = new Map();
    const currentShiftCheckpoints = new Map();
    const currentTemporaryCheckpoints = [];
    const currentOrphanCheckpoints = [];

    matchedCheckpoints.forEach((matchedCheckpoint, index) => {
      if (!matchedCheckpoint || matchedCheckpoint.status !== 'completed' || matchedCheckpoint.isTemporaryShiftNode) return;

      const baseCheckpoint = baseCheckpoints[index];
      const canonicalShiftMeta = getCanonicalShiftMetaForCheckpoint(matchedCheckpoint, safeCurrentShiftMeta);
      if (!canonicalShiftMeta) return;

      const canonicalShiftStartAt = getShiftScheduleTimes(canonicalShiftMeta).startAt.getTime();
      const normalizedCheckpoint = normalizeCheckpointRecordForShip(
        baseCheckpoint,
        matchedCheckpoint,
        ship,
        canonicalShiftMeta.key,
      );

      if (canonicalShiftStartAt < currentShiftStartAt) {
        const shiftGroup = pastShiftGroups.get(canonicalShiftMeta.key) || new Map();
        shiftGroup.set(String(baseCheckpoint.id), normalizedCheckpoint);
        pastShiftGroups.set(canonicalShiftMeta.key, shiftGroup);
        didMigrate = true;
        return;
      }

      const normalizedCurrentCheckpoint = canonicalShiftStartAt > currentShiftStartAt
        ? {
          ...normalizedCheckpoint,
          shiftKey: safeCurrentShiftMeta.key,
        }
        : normalizedCheckpoint;

      if (matchedCheckpoint.shiftKey !== normalizedCurrentCheckpoint.shiftKey) {
        didMigrate = true;
      }

      currentShiftCheckpoints.set(String(baseCheckpoint.id), normalizedCurrentCheckpoint);
    });

    temporaryCheckpoints.forEach((temporaryCheckpoint) => {
      const canonicalShiftMeta = getShiftMetaForCheckpointScope(temporaryCheckpoint, safeCurrentShiftMeta);
      if (!canonicalShiftMeta) return;

      const canonicalShiftStartAt = getShiftScheduleTimes(canonicalShiftMeta).startAt.getTime();
      const normalizedTemporaryCheckpoint = normalizeTemporaryShiftCheckpointForShip(
        {
          ...temporaryCheckpoint,
          shiftKey: canonicalShiftMeta.key,
          createdInShiftKey: temporaryCheckpoint.createdInShiftKey || canonicalShiftMeta.key,
        },
        ship,
        canonicalShiftMeta.key,
      );

      if (!normalizedTemporaryCheckpoint) return;

      if (canonicalShiftStartAt < currentShiftStartAt) {
        const shiftGroup = pastShiftGroups.get(canonicalShiftMeta.key) || new Map();
        shiftGroup.set(String(normalizedTemporaryCheckpoint.id), normalizedTemporaryCheckpoint);
        pastShiftGroups.set(canonicalShiftMeta.key, shiftGroup);
        didMigrate = true;
        return;
      }

      const normalizedCurrentTemporaryCheckpoint = canonicalShiftStartAt > currentShiftStartAt
        ? {
          ...normalizedTemporaryCheckpoint,
          shiftKey: safeCurrentShiftMeta.key,
          createdInShiftKey: safeCurrentShiftMeta.key,
        }
        : normalizedTemporaryCheckpoint;

      if (
        temporaryCheckpoint.shiftKey !== normalizedCurrentTemporaryCheckpoint.shiftKey
        || temporaryCheckpoint.shipId !== normalizedCurrentTemporaryCheckpoint.shipId
        || temporaryCheckpoint.shipName !== normalizedCurrentTemporaryCheckpoint.shipName
      ) {
        didMigrate = true;
      }

      currentTemporaryCheckpoints.push(normalizedCurrentTemporaryCheckpoint);
    });

    // Laporan completed/missed yang tak punya padanan di definisi checkpoint kapal (orphan)
    // tetap dipertahankan: bila shift-nya lampau dipindah ke history, bila shift berjalan
    // disambung ke daftar live. Tanpa ini, hasil patroli "aman" lintas-device hilang.
    savedCheckpoints.forEach((savedCheckpoint) => {
      if (isTemporaryShiftCheckpoint(savedCheckpoint)) return;
      if (!isResolvedResultCheckpoint(savedCheckpoint)) return;
      if (
        baseCheckpointIdSet.has(String(savedCheckpoint.id))
        || baseCheckpointNameKeySet.has(createCheckpointNameKey(savedCheckpoint.name))
      ) return;

      const normalizedOrphan = {
        ...savedCheckpoint,
        shipId: ship?.id || savedCheckpoint.shipId || null,
        shipName: ship?.name || savedCheckpoint.shipName || '',
      };
      const canonicalShiftMeta = getCanonicalShiftMetaForCheckpoint(savedCheckpoint, safeCurrentShiftMeta);
      if (!canonicalShiftMeta) {
        currentOrphanCheckpoints.push(normalizedOrphan);
        return;
      }

      const canonicalShiftStartAt = getShiftScheduleTimes(canonicalShiftMeta).startAt.getTime();
      if (canonicalShiftStartAt < currentShiftStartAt) {
        const shiftGroup = pastShiftGroups.get(canonicalShiftMeta.key) || new Map();
        shiftGroup.set(String(normalizedOrphan.id), { ...normalizedOrphan, shiftKey: canonicalShiftMeta.key });
        pastShiftGroups.set(canonicalShiftMeta.key, shiftGroup);
        didMigrate = true;
        return;
      }

      currentOrphanCheckpoints.push({
        ...normalizedOrphan,
        shiftKey: canonicalShiftStartAt > currentShiftStartAt ? safeCurrentShiftMeta.key : (savedCheckpoint.shiftKey || canonicalShiftMeta.key),
      });
    });

    pastShiftGroups.forEach((shiftGroup, shiftKey) => {
      const shiftMeta = getShiftMetaFromKey(shiftKey);
      if (!shiftMeta) return;

      const baseCheckpointIds = new Set(baseCheckpoints.map(baseCheckpoint => String(baseCheckpoint.id)));
      const historyCheckpoints = [
        ...baseCheckpoints.map((baseCheckpoint) => (
          shiftGroup.get(String(baseCheckpoint.id)) || { ...baseCheckpoint }
        )),
        ...Array.from(shiftGroup.entries())
          .filter(([checkpointId]) => !baseCheckpointIds.has(String(checkpointId)))
          .map(([, checkpoint]) => checkpoint),
      ];

      nextHistoryEntries = mergeHistoryEntries(nextHistoryEntries, [
        buildHistoryEntry({
          shiftMeta,
          checkpoints: historyCheckpoints,
          ship,
          shiftStatusRecords,
          users,
          weatherInfo: null,
        }),
      ]);
    });

    const normalizedBaseCheckpoints = baseCheckpoints.map((baseCheckpoint, index) => {
      const currentShiftCheckpoint = currentShiftCheckpoints.get(String(baseCheckpoint.id));
      if (currentShiftCheckpoint) return currentShiftCheckpoint;

      const matchedCheckpoint = matchedCheckpoints[index];
      if (matchedCheckpoint && matchedCheckpoint.status === 'pending' && !matchedCheckpoint.isTemporaryShiftNode) {
        const normalizedPendingCheckpoint = normalizeCheckpointRecordForShip(
          baseCheckpoint,
          matchedCheckpoint,
          ship,
          safeCurrentShiftMeta.key,
        );

        if (matchedCheckpoint.shiftKey !== normalizedPendingCheckpoint.shiftKey) {
          didMigrate = true;
        }

        return normalizedPendingCheckpoint;
      }

      return { ...baseCheckpoint };
    });

    collection[ship.id] = [...normalizedBaseCheckpoints, ...currentTemporaryCheckpoints, ...currentOrphanCheckpoints];

    return collection;
  }, {});

  return {
    activeShiftKey: safeCurrentShiftMeta.key,
    checkpointsByShip: nextCheckpointsByShip,
    historyEntries: sortHistoryEntries(nextHistoryEntries),
    shiftStatusRecords: pruneStaleShiftStatusRecords(shiftStatusRecords),
    migrated: didMigrate,
  };
}

async function fetchWeatherSnapshotForCoordinates(gpsSnapshot, fallbackWeather = null) {
  if (gpsSnapshot?.lat == null || gpsSnapshot?.lng == null) return null;
  if (!isNavigatorOnline()) {
    return createFallbackWeatherSnapshot(fallbackWeather, gpsSnapshot);
  }

  try {
    const response = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${gpsSnapshot.lat}&longitude=${gpsSnapshot.lng}&current_weather=true`);
    if (!response.ok) return createFallbackWeatherSnapshot(fallbackWeather, gpsSnapshot);

    const payload = await response.json();
    if (!payload?.current_weather) return createFallbackWeatherSnapshot(fallbackWeather, gpsSnapshot);

    return {
      ...payload.current_weather,
      capturedAt: gpsSnapshot.capturedAt,
      source: gpsSnapshot.source,
      lat: gpsSnapshot.lat,
      lng: gpsSnapshot.lng,
    };
  } catch (error) {
    console.error('Gagal mengambil snapshot cuaca patroli', error);
    return createFallbackWeatherSnapshot(fallbackWeather, gpsSnapshot);
  }
}

async function capturePatrolEnvironmentSnapshot(ship, capturedAt = getTrustedDate().toISOString(), options = {}) {
  const { fallbackWeather = null, geolocationOptions = {}, skipWeatherFetch = false } = options;
  const shipSnapshot = createShipLocationSnapshot(ship);
  const deviceLocation = await requestCurrentGeolocation(geolocationOptions);

  const gpsSnapshot = deviceLocation
    ? {
      ...deviceLocation,
      source: 'device',
      capturedAt,
    }
    : (shipSnapshot?.lat != null && shipSnapshot?.lng != null)
      ? {
        lat: shipSnapshot.lat,
        lng: shipSnapshot.lng,
        accuracy: null,
        source: 'ship',
        capturedAt,
      }
      : null;

  const weatherSnapshot = skipWeatherFetch
    ? createFallbackWeatherSnapshot(fallbackWeather, gpsSnapshot)
    : await fetchWeatherSnapshotForCoordinates(gpsSnapshot, fallbackWeather);

  return {
    shipSnapshot,
    gpsSnapshot,
    weatherSnapshot,
  };
}

function sortHistoryEntries(entries) {
  return ensureArray(entries)
    .filter(entry => ensureObject(entry))
    .sort((left, right) => {
      const leftTimestamp = new Date(left.createdAt || '').getTime();
      const rightTimestamp = new Date(right.createdAt || '').getTime();

      if (!Number.isNaN(leftTimestamp) && !Number.isNaN(rightTimestamp) && leftTimestamp !== rightTimestamp) {
        return rightTimestamp - leftTimestamp;
      }

      const leftDateKey = String(left.dateKey || '');
      const rightDateKey = String(right.dateKey || '');
      if (leftDateKey !== rightDateKey) return rightDateKey.localeCompare(leftDateKey);
      return String(right.shift || '').localeCompare(String(left.shift || ''));
    });
}

function mergeCrewSnapshots(baseCrew = [], nextCrew = []) {
  return mergeEntitiesById(baseCrew, nextCrew, {
    getId: (item) => item?.id || item?.name,
    merge: (baseItem, nextItem) => ({ ...baseItem, ...nextItem }),
  });
}

function mergeHistoryEntryRecord(baseEntry, nextEntry) {
  if (!baseEntry) return nextEntry;
  if (!nextEntry) return baseEntry;

  const baseTimestamp = new Date(baseEntry?.createdAt || '').getTime();
  const nextTimestamp = new Date(nextEntry?.createdAt || '').getTime();
  const shouldUseNext = (
    Number.isNaN(baseTimestamp)
    || (!Number.isNaN(nextTimestamp) && nextTimestamp >= baseTimestamp)
  );
  const preferredEntry = shouldUseNext ? nextEntry : baseEntry;
  const fallbackEntry = shouldUseNext ? baseEntry : nextEntry;
  const mergedDateSource = {
    ...fallbackEntry,
    ...preferredEntry,
    date: preferredEntry?.date || fallbackEntry?.date || '',
    dateKey: preferredEntry?.dateKey || fallbackEntry?.dateKey || '',
    key: preferredEntry?.key || fallbackEntry?.key || '',
    createdAt: preferredEntry?.createdAt || fallbackEntry?.createdAt || '',
  };
  const mergedDate = resolveHistoryDateLabel(mergedDateSource);
  const mergedCheckpoints = mergeCheckpointsCollection(
    baseEntry?.checkpoints || [],
    nextEntry?.checkpoints || [],
  ).map((checkpoint) => ({
    ...checkpoint,
    readOnly: true,
    historyId: preferredEntry?.id || fallbackEntry?.id || checkpoint?.historyId || null,
    date: sanitizeText(checkpoint?.date || '', 80).trim() || mergedDate,
  }));
  const mergedSummary = summarizePatrolCheckpoints(mergedCheckpoints);

  return {
    ...fallbackEntry,
    ...preferredEntry,
    id: preferredEntry?.id || fallbackEntry?.id,
    key: preferredEntry?.key || fallbackEntry?.key,
    date: mergedDate,
    dateKey: preferredEntry?.dateKey || fallbackEntry?.dateKey || '',
    crewSnapshot: mergeCrewSnapshots(
      baseEntry?.crewSnapshot || [],
      nextEntry?.crewSnapshot || [],
    ),
    checkpoints: mergedCheckpoints,
    summary: mergedSummary,
    points: mergedSummary.total,
    issue: mergedSummary.temuan,
    missed: mergedSummary.missed,
  };
}

function mergeHistoryEntries(previousEntries, nextEntries) {
  const merged = new Map();

  [...ensureArray(previousEntries), ...ensureArray(nextEntries)].forEach((entry) => {
    const mergeKey = entry?.key || entry?.id;
    if (!mergeKey) return;

    const existingEntry = merged.get(mergeKey);
    merged.set(mergeKey, existingEntry ? mergeHistoryEntryRecord(existingEntry, entry) : entry);
  });

  return sortHistoryEntries(Array.from(merged.values()));
}

function getCheckpointMergeKey(checkpoint) {
  return String(checkpoint?.id || createCheckpointNameKey(checkpoint?.name) || '');
}

function getCheckpointPriority(checkpoint) {
  if (checkpoint?.status === 'completed') return 3;
  if (checkpoint?.status === 'missed' || checkpoint?.resultType === 'missed') return 2;
  if (checkpoint?.status === 'pending') return 1;
  return 0;
}

function getCheckpointVerificationPriority(checkpoint) {
  const auditFields = extractTimeAuditFields(checkpoint || {});

  if (Number.isFinite(auditFields.receivedAtServerMs) || auditFields.verificationStatus === 'verified') {
    return 3;
  }

  if (auditFields.verificationStatus === 'needs-review') return 2;
  if (auditFields.verificationStatus === 'pending-sync') return 1;
  return 0;
}

function getCheckpointEffectiveTimestamp(checkpoint) {
  const directTimestamp = (
    Number.isFinite(checkpoint?.occurredAtTrustedMs)
      ? checkpoint.occurredAtTrustedMs
      : new Date(
        checkpoint?.occurredAtTrustedIso
        || checkpoint?.updatedAt
        || checkpoint?.completedAt
        || checkpoint?.createdAt
        || '',
      ).getTime()
  );

  if (!Number.isNaN(directTimestamp) && directTimestamp > 0) return directTimestamp;
  return getCheckpointPriority(checkpoint);
}

function getCheckpointShiftStartTimestamp(checkpoint) {
  const shiftMeta = getShiftMetaFromKey(checkpoint?.shiftKey);
  if (!shiftMeta) return null;

  const shiftStartTimestamp = getShiftScheduleTimes(shiftMeta).startAt.getTime();
  return Number.isNaN(shiftStartTimestamp) ? null : shiftStartTimestamp;
}

function getCheckpointPendingOrigin(checkpoint) {
  return typeof checkpoint?.pendingOrigin === 'string'
    ? checkpoint.pendingOrigin
    : null;
}

function getCheckpointMediaTimestamp(checkpoint) {
  if (!checkpoint || typeof checkpoint !== 'object') return null;

  const trustedTimestamp = Number(checkpoint.occurredAtTrustedMs);
  if (Number.isFinite(trustedTimestamp) && trustedTimestamp > 0) {
    return trustedTimestamp;
  }

  const parsedTimestamp = new Date(
    checkpoint.occurredAtTrustedIso
    || checkpoint.completedAt
    || checkpoint.updatedAt
    || checkpoint.createdAt
    || '',
  ).getTime();

  return Number.isNaN(parsedTimestamp) || parsedTimestamp <= 0
    ? null
    : parsedTimestamp;
}

function isCheckpointResetRecord(checkpoint) {
  return checkpoint?.status === 'pending'
    && ['manual-reset', 'shift-reset'].includes(getCheckpointPendingOrigin(checkpoint));
}

function isSameCheckpointMediaRevision(leftCheckpoint, rightCheckpoint) {
  if (!leftCheckpoint || !rightCheckpoint) return false;

  const leftShiftKey = String(leftCheckpoint.shiftKey || '');
  const rightShiftKey = String(rightCheckpoint.shiftKey || '');
  if (leftShiftKey && rightShiftKey && leftShiftKey !== rightShiftKey) return false;

  const leftResultType = String(leftCheckpoint.resultType || '');
  const rightResultType = String(rightCheckpoint.resultType || '');
  if (leftResultType && rightResultType && leftResultType !== rightResultType) return false;

  const leftIncidentId = String(leftCheckpoint.incidentId || '');
  const rightIncidentId = String(rightCheckpoint.incidentId || '');
  if (leftIncidentId && rightIncidentId && leftIncidentId !== rightIncidentId) return false;

  const leftTimestamp = getCheckpointMediaTimestamp(leftCheckpoint);
  const rightTimestamp = getCheckpointMediaTimestamp(rightCheckpoint);
  if (leftTimestamp !== null && rightTimestamp !== null) {
    return leftTimestamp === rightTimestamp;
  }

  const leftCompletedAt = String(leftCheckpoint.completedAt || leftCheckpoint.occurredAtTrustedIso || '');
  const rightCompletedAt = String(rightCheckpoint.completedAt || rightCheckpoint.occurredAtTrustedIso || '');
  return Boolean(leftCompletedAt && rightCompletedAt && leftCompletedAt === rightCompletedAt);
}

function mergeCheckpointGalleryPhotoRecord(basePhoto = {}, nextPhoto = {}) {
  const baseTimestamp = getCheckpointMediaTimestamp(basePhoto);
  const nextTimestamp = getCheckpointMediaTimestamp(nextPhoto);
  const shouldUseNext = (nextTimestamp || 0) >= (baseTimestamp || 0);
  const preferredPhoto = shouldUseNext ? nextPhoto : basePhoto;
  const fallbackPhoto = shouldUseNext ? basePhoto : nextPhoto;

  return {
    ...fallbackPhoto,
    ...preferredPhoto,
    id: preferredPhoto.id || fallbackPhoto.id,
    photoUrl: resolveMergedAssetUrl(preferredPhoto.photoUrl, fallbackPhoto.photoUrl),
    author: preferredPhoto.author || fallbackPhoto.author || '',
  };
}

function mergeCheckpointGalleryPhotos(baseGallery = [], nextGallery = []) {
  return mergeEntitiesById(baseGallery, nextGallery, {
    getId: (item) => item?.id || item?.createdAt || item?.photoUrl,
    merge: mergeCheckpointGalleryPhotoRecord,
  });
}

function shouldKeepFallbackCheckpointMedia(preferredCheckpoint, fallbackCheckpoint) {
  if (isCheckpointResetRecord(preferredCheckpoint)) return false;
  return isSameCheckpointMediaRevision(preferredCheckpoint, fallbackCheckpoint);
}

function resolveMergedCheckpointPhotoUrl(preferredCheckpoint, fallbackCheckpoint) {
  const preferredPhotoUrl = typeof preferredCheckpoint?.photoUrl === 'string'
    ? preferredCheckpoint.photoUrl
    : '';
  const fallbackPhotoUrl = typeof fallbackCheckpoint?.photoUrl === 'string'
    ? fallbackCheckpoint.photoUrl
    : '';

  if (preferredPhotoUrl) {
    return isSameCheckpointMediaRevision(preferredCheckpoint, fallbackCheckpoint)
      ? resolveMergedAssetUrl(preferredPhotoUrl, fallbackPhotoUrl)
      : preferredPhotoUrl;
  }

  if (shouldKeepFallbackCheckpointMedia(preferredCheckpoint, fallbackCheckpoint)) {
    return fallbackPhotoUrl || null;
  }

  return null;
}

function resolveMergedCheckpointGalleryPhotos(preferredCheckpoint, fallbackCheckpoint) {
  const preferredGallery = ensureArray(preferredCheckpoint?.galleryPhotos);
  const fallbackGallery = ensureArray(fallbackCheckpoint?.galleryPhotos);

  if (preferredGallery.length > 0) {
    return isSameCheckpointMediaRevision(preferredCheckpoint, fallbackCheckpoint)
      ? mergeCheckpointGalleryPhotos(fallbackGallery, preferredGallery)
      : preferredGallery;
  }

  if (shouldKeepFallbackCheckpointMedia(preferredCheckpoint, fallbackCheckpoint)) {
    return fallbackGallery;
  }

  return [];
}

function finalizeMergedCheckpointRecord(preferredCheckpoint, fallbackCheckpoint, mergedCheckpoint) {
  const nextCheckpoint = {
    ...mergedCheckpoint,
    photoUrl: resolveMergedCheckpointPhotoUrl(preferredCheckpoint, fallbackCheckpoint),
    galleryPhotos: resolveMergedCheckpointGalleryPhotos(preferredCheckpoint, fallbackCheckpoint),
  };

  if (!isCheckpointResetRecord(preferredCheckpoint)) {
    return nextCheckpoint;
  }

  return {
    ...nextCheckpoint,
    completedBy: '',
    completedByUserId: null,
    date: '',
    time: '',
    completedAt: null,
    incidentId: null,
    resultType: null,
    photoUrl: null,
    galleryPhotos: [],
    mediaStatus: 'none',
    kejadian: '',
    penyebab: '',
    tindakLanjut: '',
    occurredAtTrustedMs: null,
    occurredAtTrustedIso: null,
    receivedAtServerMs: null,
    timeTrustLevel: null,
    verificationStatus: null,
    offlineSessionId: null,
    offlineSessionInterrupted: false,
    clockTamperDetected: false,
  };
}

function mergeCheckpointRecord(baseCheckpoint, nextCheckpoint) {
  if (!baseCheckpoint) return nextCheckpoint;
  if (!nextCheckpoint) return baseCheckpoint;

  const baseTimestamp = getCheckpointEffectiveTimestamp(baseCheckpoint);
  const nextTimestamp = getCheckpointEffectiveTimestamp(nextCheckpoint);
  const basePriority = getCheckpointPriority(baseCheckpoint);
  const nextPriority = getCheckpointPriority(nextCheckpoint);
  const baseVerificationPriority = getCheckpointVerificationPriority(baseCheckpoint);
  const nextVerificationPriority = getCheckpointVerificationPriority(nextCheckpoint);
  const baseShiftStartTimestamp = getCheckpointShiftStartTimestamp(baseCheckpoint);
  const nextShiftStartTimestamp = getCheckpointShiftStartTimestamp(nextCheckpoint);

  if (
    Number.isFinite(baseShiftStartTimestamp)
    && Number.isFinite(nextShiftStartTimestamp)
    && baseShiftStartTimestamp !== nextShiftStartTimestamp
  ) {
    const preferredCheckpoint = nextShiftStartTimestamp > baseShiftStartTimestamp
      ? nextCheckpoint
      : baseCheckpoint;
    const fallbackCheckpoint = preferredCheckpoint === nextCheckpoint
      ? baseCheckpoint
      : nextCheckpoint;

    return finalizeMergedCheckpointRecord(preferredCheckpoint, fallbackCheckpoint, {
      ...fallbackCheckpoint,
      ...preferredCheckpoint,
      id: preferredCheckpoint.id || fallbackCheckpoint.id,
      name: preferredCheckpoint.name || fallbackCheckpoint.name,
    });
  }

  const baseIsPending = baseCheckpoint?.status === 'pending';
  const nextIsPending = nextCheckpoint?.status === 'pending';
  if (baseIsPending !== nextIsPending) {
    const pendingCheckpoint = baseIsPending ? baseCheckpoint : nextCheckpoint;
    const nonPendingCheckpoint = baseIsPending ? nextCheckpoint : baseCheckpoint;
    const pendingOrigin = getCheckpointPendingOrigin(pendingCheckpoint);
    const pendingTimestamp = getCheckpointEffectiveTimestamp(pendingCheckpoint);
    const nonPendingTimestamp = getCheckpointEffectiveTimestamp(nonPendingCheckpoint);
    const pendingShiftKey = String(pendingCheckpoint?.shiftKey || '');
    const nonPendingShiftKey = String(nonPendingCheckpoint?.shiftKey || '');
    const isSameShiftKey = Boolean(
      pendingShiftKey
      && nonPendingShiftKey
      && pendingShiftKey === nonPendingShiftKey
    );
    const shouldPreferPendingManualReset = (
      pendingOrigin === 'manual-reset'
      && pendingTimestamp >= nonPendingTimestamp
    );

    if (isSameShiftKey && !shouldPreferPendingManualReset) {
      return finalizeMergedCheckpointRecord(nonPendingCheckpoint, pendingCheckpoint, {
        ...pendingCheckpoint,
        ...nonPendingCheckpoint,
        id: nonPendingCheckpoint.id || pendingCheckpoint.id,
        name: nonPendingCheckpoint.name || pendingCheckpoint.name,
      });
    }
  }

  const shouldUseNext = (
    nextTimestamp > baseTimestamp
    || (
      nextTimestamp === baseTimestamp
      && (
        nextPriority > basePriority
        || (
          nextPriority === basePriority
          && nextVerificationPriority >= baseVerificationPriority
        )
      )
    )
  );

  const preferredCheckpoint = shouldUseNext ? nextCheckpoint : baseCheckpoint;
  const fallbackCheckpoint = shouldUseNext ? baseCheckpoint : nextCheckpoint;

  return finalizeMergedCheckpointRecord(preferredCheckpoint, fallbackCheckpoint, {
    ...fallbackCheckpoint,
    ...preferredCheckpoint,
    id: preferredCheckpoint.id || fallbackCheckpoint.id,
    name: preferredCheckpoint.name || fallbackCheckpoint.name,
  });
}

function mergeCheckpointsCollection(baseCheckpoints = [], nextCheckpoints = []) {
  const merged = new Map();

  [...baseCheckpoints, ...nextCheckpoints].forEach((checkpoint) => {
    const mergeKey = getCheckpointMergeKey(checkpoint);
    if (!mergeKey) return;
    const existingCheckpoint = merged.get(mergeKey);
    merged.set(mergeKey, mergeCheckpointRecord(existingCheckpoint, checkpoint));
  });

  return Array.from(merged.values());
}

function getAssetUrlPriority(url) {
  if (typeof url !== 'string' || !url) return 0;
  if (url.startsWith('https://')) return 4;
  if (url.startsWith('data:image/')) return 3;
  if (url.startsWith('idb://')) return 2;
  return 1;
}

function isPortableInlineAssetUrl(url) {
  return typeof url === 'string' && url.startsWith('data:image/svg+xml');
}

function isLocalOnlyAssetUrl(url) {
  return typeof url === 'string'
    && (
      url.startsWith('idb://')
      || (url.startsWith('data:image/') && !isPortableInlineAssetUrl(url))
    );
}

function collectLocalOnlyAssetUrls(stateSnapshot = {}) {
  const urls = new Set();
  const pushUrl = (url) => {
    if (isLocalOnlyAssetUrl(url)) {
      urls.add(url);
    }
  };

  Object.values(stateSnapshot.checkpointsByShip || {}).forEach((shipCheckpoints) => {
    ensureArray(shipCheckpoints).forEach((checkpoint) => {
      pushUrl(checkpoint?.photoUrl);
      ensureArray(checkpoint?.galleryPhotos).forEach((galleryPhoto) => pushUrl(galleryPhoto?.photoUrl));
    });
  });

  ensureArray(stateSnapshot.shipsData).forEach((ship) => pushUrl(ship?.photoUrl));
  ensureArray(stateSnapshot.usersData).forEach((user) => pushUrl(user?.photoUrl));
  ensureArray(stateSnapshot.incidentsData).forEach((incident) => pushUrl(incident?.photoUrl));

  Object.values(stateSnapshot.incidentMeta || {}).forEach((meta) => {
    ensureArray(meta?.documentation).forEach((item) => pushUrl(item?.photoUrl));
    ensureArray(meta?.progress).forEach((item) => pushUrl(item?.photoUrl));
  });

  ensureArray(stateSnapshot.historyEntries).forEach((entry) => {
    ensureArray(entry?.crewSnapshot).forEach((crew) => pushUrl(crew?.photoUrl));
    ensureArray(entry?.checkpoints).forEach((checkpoint) => {
      pushUrl(checkpoint?.photoUrl);
      ensureArray(checkpoint?.galleryPhotos).forEach((galleryPhoto) => pushUrl(galleryPhoto?.photoUrl));
    });
  });

  return Array.from(urls);
}

function resolveMergedAssetUrl(preferredUrl, fallbackUrl) {
  const safePreferredUrl = typeof preferredUrl === 'string' ? preferredUrl : '';
  const safeFallbackUrl = typeof fallbackUrl === 'string' ? fallbackUrl : '';
  const preferredPriority = getAssetUrlPriority(safePreferredUrl);
  const fallbackPriority = getAssetUrlPriority(safeFallbackUrl);

  // Prioritaskan URL aset yang bisa dipakai lintas-device agar snapshot cloud
  // tidak diturunkan lagi menjadi idb:// lokal milik perangkat lain.
  if (fallbackPriority > preferredPriority) {
    return safeFallbackUrl || safePreferredUrl || null;
  }

  return safePreferredUrl || safeFallbackUrl || null;
}

function mergeProgressItems(baseProgress = [], nextProgress = []) {
  return mergeEntitiesById(baseProgress, nextProgress, {
    getId: (item) => item?.id || item?.createdAt || item?.comment,
    merge: (baseItem, nextItem) => {
      const baseTimestamp = new Date(baseItem?.createdAt || '').getTime();
      const nextTimestamp = new Date(nextItem?.createdAt || '').getTime();
      const preferred = nextTimestamp >= baseTimestamp ? nextItem : baseItem;
      const fallback = nextTimestamp >= baseTimestamp ? baseItem : nextItem;
      return {
        ...fallback,
        ...preferred,
        comment: preferred.comment || fallback.comment || '',
        photoUrl: resolveMergedAssetUrl(preferred.photoUrl, fallback.photoUrl),
        author: preferred.author || fallback.author || '',
      };
    },
  });
}

function mergeDocumentationItems(baseDocumentation = [], nextDocumentation = []) {
  return mergeEntitiesById(baseDocumentation, nextDocumentation, {
    getId: (item) => item?.id || item?.createdAt || item?.photoUrl,
    merge: (baseItem, nextItem) => {
      const baseTimestamp = new Date(baseItem?.createdAt || '').getTime();
      const nextTimestamp = new Date(nextItem?.createdAt || '').getTime();
      const preferred = nextTimestamp >= baseTimestamp ? nextItem : baseItem;
      const fallback = nextTimestamp >= baseTimestamp ? baseItem : nextItem;
      return {
        ...fallback,
        ...preferred,
        photoUrl: resolveMergedAssetUrl(preferred.photoUrl, fallback.photoUrl),
        author: preferred.author || fallback.author || '',
      };
    },
  }).sort((left, right) => {
    const leftTimestamp = new Date(left?.createdAt || '').getTime();
    const rightTimestamp = new Date(right?.createdAt || '').getTime();
    return rightTimestamp - leftTimestamp;
  });
}

function getCheckpointContextShipKey(checkpoint) {
  return String(checkpoint?.shipId || checkpoint?.shipName || '');
}

function getCheckpointContextHistoryKey(checkpoint) {
  return String(checkpoint?.historyId || '');
}

function isCheckpointReadOnlyContext(checkpoint) {
  return Boolean(checkpoint?.readOnly || checkpoint?.historyId);
}

function isCheckpointContextCompatible(sourceCheckpoint, candidateCheckpoint) {
  if (!sourceCheckpoint || !candidateCheckpoint) return false;

  const sourceShipKey = getCheckpointContextShipKey(sourceCheckpoint);
  const candidateShipKey = getCheckpointContextShipKey(candidateCheckpoint);
  if (sourceShipKey && candidateShipKey && sourceShipKey !== candidateShipKey) {
    return false;
  }

  const sourceHistoryKey = getCheckpointContextHistoryKey(sourceCheckpoint);
  const candidateHistoryKey = getCheckpointContextHistoryKey(candidateCheckpoint);
  if (sourceHistoryKey || candidateHistoryKey) {
    return Boolean(sourceHistoryKey && sourceHistoryKey === candidateHistoryKey);
  }

  if (isCheckpointReadOnlyContext(sourceCheckpoint) !== isCheckpointReadOnlyContext(candidateCheckpoint)) {
    return false;
  }

  const sourceShiftKey = String(sourceCheckpoint?.shiftKey || '');
  const candidateShiftKey = String(candidateCheckpoint?.shiftKey || '');
  if (sourceShiftKey && candidateShiftKey && sourceShiftKey !== candidateShiftKey) {
    return false;
  }

  const sourceDateKey = String(sourceCheckpoint?.date || '');
  const candidateDateKey = String(candidateCheckpoint?.date || '');
  if (sourceDateKey && candidateDateKey && sourceDateKey !== candidateDateKey) {
    return false;
  }

  return true;
}

function resolveCanonicalCheckpointRecord(checkpoint, checkpointsByShip = {}, historyEntries = []) {
  if (!checkpoint) return null;

  const mergeKey = getCheckpointMergeKey(checkpoint);
  if (!mergeKey) return checkpoint;

  let bestCheckpoint = checkpoint;

  Object.values(checkpointsByShip || {}).forEach((shipCheckpoints) => {
    ensureArray(shipCheckpoints).forEach((candidateCheckpoint) => {
      if (getCheckpointMergeKey(candidateCheckpoint) !== mergeKey) return;
      if (!isCheckpointContextCompatible(checkpoint, candidateCheckpoint)) return;
      bestCheckpoint = mergeCheckpointRecord(bestCheckpoint, candidateCheckpoint);
    });
  });

  ensureArray(historyEntries).forEach((entry) => {
    ensureArray(entry?.checkpoints).forEach((candidateCheckpoint) => {
      if (getCheckpointMergeKey(candidateCheckpoint) !== mergeKey) return;
      if (!isCheckpointContextCompatible(checkpoint, candidateCheckpoint)) return;
      bestCheckpoint = mergeCheckpointRecord(bestCheckpoint, candidateCheckpoint);
    });
  });

  return bestCheckpoint;
}

function getNotificationMergeKey(notification) {
  return String(notification?.dedupeKey || notification?.id || '');
}

function getNotificationTimestamp(notification) {
  const timestamp = new Date(notification?.createdAt || '').getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function mergeNotificationRecord(baseNotification, nextNotification) {
  if (!baseNotification) return nextNotification;
  if (!nextNotification) return baseNotification;

  const shouldUseNext = getNotificationTimestamp(nextNotification) >= getNotificationTimestamp(baseNotification);
  const preferredNotification = shouldUseNext ? nextNotification : baseNotification;
  const fallbackNotification = shouldUseNext ? baseNotification : nextNotification;
  const mergedTargetUserIds = Array.from(new Set([
    ...(Array.isArray(baseNotification?.targetUserIds) ? baseNotification.targetUserIds : []),
    ...(Array.isArray(nextNotification?.targetUserIds) ? nextNotification.targetUserIds : []),
  ]));

  return {
    ...fallbackNotification,
    ...preferredNotification,
    id: preferredNotification.id || fallbackNotification.id || createNotificationId(),
    dedupeKey: preferredNotification.dedupeKey || fallbackNotification.dedupeKey || '',
    targetUserIds: mergedTargetUserIds,
    readByUserIds: Array.from(new Set([
      ...(Array.isArray(baseNotification?.readByUserIds) ? baseNotification.readByUserIds : []),
      ...(Array.isArray(nextNotification?.readByUserIds) ? nextNotification.readByUserIds : []),
    ])).filter(userId => mergedTargetUserIds.includes(userId)),
  };
}

function mergeNotificationsCollection(baseNotifications = [], nextNotifications = []) {
  const merged = new Map();

  [...baseNotifications, ...nextNotifications].forEach((notification) => {
    const mergeKey = getNotificationMergeKey(notification);
    if (!mergeKey) return;
    const existingNotification = merged.get(mergeKey);
    merged.set(mergeKey, mergeNotificationRecord(existingNotification, notification));
  });

  return sortNotifications(Array.from(merged.values()));
}

function mergeEntitiesById(baseItems = [], nextItems = [], options = {}) {
  const {
    getId = (item) => item?.id,
    merge = (baseItem, nextItem) => ({ ...baseItem, ...nextItem }),
  } = options;
  const merged = new Map();

  [...baseItems, ...nextItems].forEach((item) => {
    const itemId = getId(item);
    if (!itemId) return;
    const existingItem = merged.get(itemId);
    merged.set(itemId, existingItem ? merge(existingItem, item) : item);
  });

  return Array.from(merged.values());
}

function getEntityMergeTimestamp(item) {
  if (!item || typeof item !== 'object') return 0;

  return (
    resolveExternalTimestampMs(item.updatedAtTrustedMs)
    || resolveExternalTimestampMs(item.updatedAtClientMs)
    || resolveExternalTimestampMs(item.updatedAt)
    || resolveExternalTimestampMs(item.createdAt)
    || 0
  );
}

function mergeVersionedEntity(baseItem = {}, nextItem = {}) {
  const baseTimestamp = getEntityMergeTimestamp(baseItem);
  const nextTimestamp = getEntityMergeTimestamp(nextItem);

  if (nextTimestamp >= baseTimestamp) {
    return { ...baseItem, ...nextItem };
  }

  return { ...nextItem, ...baseItem };
}

function createLocalEntityUpdateMeta() {
  const trustedNowMs = getTrustedNowMs();
  const fallbackNowMs = Date.now();
  const resolvedNowMs = Number.isFinite(trustedNowMs) ? trustedNowMs : fallbackNowMs;

  return {
    updatedAt: new Date(resolvedNowMs).toISOString(),
    updatedAtClientMs: fallbackNowMs,
    updatedAtTrustedMs: resolvedNowMs,
  };
}

function mergeIncidentMetaCollection(baseMeta = {}, nextMeta = {}) {
  const mergedMeta = { ...(baseMeta || {}) };

  Object.entries(nextMeta || {}).forEach(([incidentId, nextValue]) => {
    const baseValue = mergedMeta[incidentId] || {};
    mergedMeta[incidentId] = {
      ...baseValue,
      ...nextValue,
      status: nextValue?.status || baseValue.status || null,
      infoOverrides: {
        ...(baseValue.infoOverrides || {}),
        ...(nextValue?.infoOverrides || {}),
      },
      documentation: mergeDocumentationItems(baseValue.documentation || [], nextValue?.documentation || []),
      progress: mergeProgressItems(baseValue.progress || [], nextValue?.progress || []),
    };
  });

  return mergedMeta;
}

function mergeIncidentsCollection(baseIncidents = [], nextIncidents = []) {
  return mergeEntitiesById(baseIncidents, nextIncidents, {
    merge: (baseIncident, nextIncident) => (
      getIncidentSortTimestamp(nextIncident) >= getIncidentSortTimestamp(baseIncident)
        ? { ...baseIncident, ...nextIncident }
        : { ...nextIncident, ...baseIncident }
    ),
  }).sort((left, right) => getIncidentSortTimestamp(right) - getIncidentSortTimestamp(left));
}

function createDeletedRecordsState(deletedRecords = {}) {
  const sourceRecords = deletedRecords && typeof deletedRecords === 'object' ? deletedRecords : {};
  return {
    historyEntries: { ...(sourceRecords.historyEntries || {}) },
    incidents: { ...(sourceRecords.incidents || {}) },
    ships: { ...(sourceRecords.ships || {}) },
    users: { ...(sourceRecords.users || {}) },
  };
}

function markDeletedRecord(previousDeletedRecords, groupKey, recordId, deletedAt = new Date().toISOString()) {
  const nextDeletedRecords = createDeletedRecordsState(previousDeletedRecords);
  if (!recordId || !Object.prototype.hasOwnProperty.call(nextDeletedRecords, groupKey)) {
    return nextDeletedRecords;
  }

  nextDeletedRecords[groupKey][recordId] = deletedAt;
  return nextDeletedRecords;
}

function mergeDeletedRecordGroup(baseGroup = {}, nextGroup = {}) {
  const mergedGroup = { ...(baseGroup || {}) };

  Object.entries(nextGroup || {}).forEach(([recordId, deletedAt]) => {
    if (!recordId || !deletedAt) return;

    const baseTimestamp = new Date(mergedGroup[recordId] || '').getTime();
    const nextTimestamp = new Date(deletedAt || '').getTime();

    if (Number.isNaN(baseTimestamp) || nextTimestamp >= baseTimestamp) {
      mergedGroup[recordId] = deletedAt;
    }
  });

  return mergedGroup;
}

function mergeDeletedRecords(baseDeletedRecords = {}, nextDeletedRecords = {}) {
  const baseState = createDeletedRecordsState(baseDeletedRecords);
  const nextState = createDeletedRecordsState(nextDeletedRecords);

  return {
    historyEntries: mergeDeletedRecordGroup(baseState.historyEntries, nextState.historyEntries),
    incidents: mergeDeletedRecordGroup(baseState.incidents, nextState.incidents),
    ships: mergeDeletedRecordGroup(baseState.ships, nextState.ships),
    users: mergeDeletedRecordGroup(baseState.users, nextState.users),
  };
}

function omitDeletedEntities(items = [], deletedRecords = {}) {
  return items.filter((item) => !deletedRecords[item?.id]);
}

function remapUserIdFromMap(userId, userIdMap = new Map()) {
  const safeUserId = String(userId || '').trim();
  if (!safeUserId) return '';
  return userIdMap.get(safeUserId) || safeUserId;
}

function remapUserIdListFromMap(userIds = [], userIdMap = new Map()) {
  return Array.from(new Set(
    ensureArray(userIds)
      .map(userId => remapUserIdFromMap(userId, userIdMap))
      .filter(Boolean),
  ));
}

function remapPersonnelSchedulesFromMap(schedules = {}, userIdMap = new Map()) {
  const nextSchedules = {};
  Object.entries(schedules || {}).forEach(([userId, schedule]) => {
    const mappedUserId = remapUserIdFromMap(userId, userIdMap);
    if (!mappedUserId) return;
    nextSchedules[mappedUserId] = {
      ...(nextSchedules[mappedUserId] || {}),
      ...(schedule && typeof schedule === 'object' ? schedule : {}),
    };
  });
  return nextSchedules;
}

function remapShipPersonnelUserIds(ships = [], userIdMap = new Map()) {
  if (!(userIdMap instanceof Map) || userIdMap.size === 0) return ships;
  const hasChangedMapping = Array.from(userIdMap.entries()).some(([fromUserId, toUserId]) => (
    String(fromUserId) !== String(toUserId)
  ));
  if (!hasChangedMapping) return ships;

  let changed = false;
  const remappedShips = ensureArray(ships).map((ship) => {
    if (!ship || typeof ship !== 'object') return ship;
    const personnel = remapUserIdListFromMap(ship.personnel, userIdMap);
    const personnelNextMonth = remapUserIdListFromMap(ship.personnelNextMonth, userIdMap);
    const personnelSchedules = remapPersonnelSchedulesFromMap(ship.personnelSchedules, userIdMap);
    const nextShip = {
      ...ship,
      personnel,
      personnelNextMonth,
      personnelSchedules,
    };

    if (serializeSharedStateSnapshot(nextShip) !== serializeSharedStateSnapshot(ship)) {
      changed = true;
    }

    return nextShip;
  });

  return changed ? remappedShips : ships;
}

function pruneShipPersonnelAssignments(ships = [], users = []) {
  const activeUserIds = new Set(users.map(user => user.id).filter(Boolean));
  return ships.map((ship) => ({
    ...ship,
    personnel: Array.isArray(ship?.personnel)
      ? Array.from(new Set(ship.personnel.filter(userId => activeUserIds.has(userId))))
      : [],
    personnelNextMonth: Array.isArray(ship?.personnelNextMonth)
      ? Array.from(new Set(ship.personnelNextMonth.filter(userId => activeUserIds.has(userId))))
      : [],
    personnelSchedules: Object.fromEntries(
      Object.entries(ship?.personnelSchedules || {})
        .filter(([userId]) => activeUserIds.has(userId)),
    ),
  }));
}

function getSOSRecordTimestamp(sos) {
  const directTimestamp = (
    Number.isFinite(sos?.resolvedAtClientMs)
      ? sos.resolvedAtClientMs
      : Number.isFinite(sos?.updatedAtClientMs)
        ? sos.updatedAtClientMs
        : Number.isFinite(sos?.senderAcknowledgedAtClientMs)
          ? sos.senderAcknowledgedAtClientMs
          : Number.isFinite(sos?.occurredAtTrustedMs)
            ? sos.occurredAtTrustedMs
            : Number.isFinite(sos?.createdAtClientMs)
              ? sos.createdAtClientMs
              : new Date(
                sos?.resolvedAt
                || sos?.updatedAt
                || sos?.senderAcknowledgedAt
                || sos?.triggeredAt
                || sos?.createdAt
                || sos?.occurredAtTrustedIso
                || '',
              ).getTime()
  );

  if (!Number.isNaN(directTimestamp) && directTimestamp > 0) {
    return directTimestamp;
  }

  if (typeof sos?.id === 'number') {
    return sos.id;
  }

  return 0;
}

function mergeSOSRecordArrays(...collections) {
  return Array.from(new Set(
    collections
      .flatMap((collection) => (Array.isArray(collection) ? collection : []))
      .filter(Boolean),
  ));
}

function mergeSOSRecords(baseSOS = {}, nextSOS = {}) {
  const nextIsNewer = getSOSRecordTimestamp(nextSOS) >= getSOSRecordTimestamp(baseSOS);
  const newerSOS = nextIsNewer ? nextSOS : baseSOS;
  const olderSOS = nextIsNewer ? baseSOS : nextSOS;

  return {
    ...olderSOS,
    ...newerSOS,
    confirmedBy: mergeSOSRecordArrays(baseSOS.confirmedBy, nextSOS.confirmedBy),
    targetUserIds: mergeSOSRecordArrays(baseSOS.targetUserIds, nextSOS.targetUserIds),
    targetShipIds: mergeSOSRecordArrays(baseSOS.targetShipIds, nextSOS.targetShipIds),
    targetShipNames: mergeSOSRecordArrays(baseSOS.targetShipNames, nextSOS.targetShipNames),
  };
}

function mergeSOSHistoryCollection(baseHistory = [], nextHistory = []) {
  return mergeEntitiesById(baseHistory, nextHistory, {
    merge: (baseSOS, nextSOS) => mergeSOSRecords(baseSOS, nextSOS),
  }).sort((left, right) => getSOSRecordTimestamp(right) - getSOSRecordTimestamp(left));
}

function upsertSOSHistoryEntry(previousHistory = [], nextSOS) {
  return mergeSOSHistoryCollection(previousHistory, nextSOS ? [nextSOS] : []);
}

function resolveLatestActiveSOSAlert(sosEntries = []) {
  return sosEntries.find((entry) => sanitizeText(entry?.status || '', 20).toLowerCase() !== 'resolved') || null;
}

function mergeSharedStateSnapshots(baseState = {}, nextState = {}) {
  const deletedRecords = mergeDeletedRecords(baseState.deletedRecords || {}, nextState.deletedRecords || {});
  const resolvedActiveShiftKey = nextState.activeShiftKey || baseState.activeShiftKey || null;
  const baseUsers = normalizeUsersCollection(baseState.usersData || []);
  const nextUsers = normalizeUsersCollection(nextState.usersData || []);
  const mergedUsersByIdRaw = omitDeletedEntities(mergeEntitiesById(baseUsers, nextUsers, {
    merge: (baseUser, nextUser) => mergeVersionedEntity(baseUser, nextUser),
  }), deletedRecords.users);
  const baseShips = normalizeShipsCollection(baseState.shipsData || []);
  const nextShips = normalizeShipsCollection(nextState.shipsData || []);
  const mergedShipsRaw = omitDeletedEntities(mergeEntitiesById(baseShips, nextShips, {
    merge: (baseShip, nextShip) => mergeVersionedEntity(baseShip, nextShip),
  }), deletedRecords.ships);
  const dedupedUserState = deduplicateUsersByOperationalIdentity(mergedUsersByIdRaw, {
    ships: mergedShipsRaw,
  });
  const remappedShipsRaw = remapShipPersonnelUserIds(
    mergedShipsRaw,
    dedupedUserState.userIdMap,
  );
  const mergedShips = pruneShipPersonnelAssignments(
    remappedShipsRaw,
    dedupedUserState.users,
  );
  // Source of truth: ship.personnel. PETUGAS yang sudah dipindah tapi shipAssigned stale dibereskan di sini.
  const mergedUsers = reconcileUserShipAssignments(dedupedUserState.users, mergedShips);
  const shipIds = Array.from(new Set([
    ...Object.keys(baseState.checkpointsByShip || {}),
    ...Object.keys(nextState.checkpointsByShip || {}),
    ...mergedShips.map(ship => ship.id).filter(Boolean),
  ])).filter(shipId => !deletedRecords.ships[shipId]);

  const checkpointsByShip = shipIds.reduce((collection, shipId) => {
    const baseCheckpoints = Array.isArray(baseState.checkpointsByShip?.[shipId]) ? baseState.checkpointsByShip[shipId] : [];
    const nextCheckpoints = Array.isArray(nextState.checkpointsByShip?.[shipId]) ? nextState.checkpointsByShip[shipId] : [];
    collection[shipId] = mergeCheckpointsCollection(baseCheckpoints, nextCheckpoints);
    return collection;
  }, {});
  const mergedSOSHistory = mergeSOSHistoryCollection(
    [
      ...(Array.isArray(baseState.sosHistory) ? baseState.sosHistory : []),
      baseState.activeSOSAlert,
    ].filter(Boolean),
    [
      ...(Array.isArray(nextState.sosHistory) ? nextState.sosHistory : []),
      nextState.activeSOSAlert,
    ].filter(Boolean),
  );
  const mergedShiftStatusRecords = mergeShiftStatusRecords(
    baseState.shiftStatusRecords || {},
    nextState.shiftStatusRecords || {},
  );

  return createSharedStateSnapshot({
    activeShiftKey: resolvedActiveShiftKey,
    checkpointsByShip,
    deletedRecords,
    historyEntries: omitDeletedEntities(
      mergeHistoryEntries(baseState.historyEntries || [], nextState.historyEntries || []),
      deletedRecords.historyEntries,
    ),
    incidentMeta: mergeIncidentMetaCollection(baseState.incidentMeta || {}, nextState.incidentMeta || {}),
    incidentsData: omitDeletedEntities(
      mergeIncidentsCollection(baseState.incidentsData || [], nextState.incidentsData || []),
      deletedRecords.incidents,
    ),
    notifications: mergeNotificationsCollection(baseState.notifications || [], nextState.notifications || []),
    shipsData: mergedShips,
    usersData: mergedUsers,
    shiftStatusRecords: pruneStaleShiftStatusRecords(mergedShiftStatusRecords),
    activeSOSAlert: resolveLatestActiveSOSAlert(mergedSOSHistory),
    sosHistory: mergedSOSHistory,
  });
}

function createNotificationId() {
  return `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createNotificationRecord(notification) {
  return {
    id: createNotificationId(),
    type: notification.type || 'general',
    title: notification.title || 'Notifikasi Sistem',
    message: notification.message || '',
    senderName: notification.senderName || 'Sistem',
    senderRole: notification.senderRole || 'SYSTEM',
    targetUserIds: Array.isArray(notification.targetUserIds) ? notification.targetUserIds : [],
    route: notification.route || 'history/list',
    routeParams: notification.routeParams || {},
    shipName: notification.shipName || '',
    shiftKey: notification.shiftKey || '',
    incidentId: notification.incidentId || '',
    historyId: notification.historyId || '',
    dedupeKey: notification.dedupeKey || '',
    readByUserIds: Array.isArray(notification.readByUserIds) ? notification.readByUserIds : [],
    createdAt: notification.createdAt || new Date().toISOString(),
  };
}

function normalizeNotificationRoute(notification = {}) {
  const route = sanitizeText(notification.route || '', 100);
  const type = sanitizeText(notification.type || '', 80);

  if (route === 'patrol/live' || route === 'patrol') return 'patrol/checkpoint';
  if (route === 'history' || route === 'history/list') return 'history/list';
  if (route === 'daily-report' && type === 'shift_wrap_up') return 'history/list';
  if (!route && type === 'checkpoint_pending') return 'patrol/checkpoint';
  if (!route && type === 'checkpoint_pending_summary') return 'history/list';
  if (!route && type === 'shift_wrap_up') return 'history/list';
  if (!route && (type === 'incident_created' || type === 'incident_progress_updated')) return 'incidents/detail';
  return route || 'history/list';
}

function getShiftHistoryGroupKey(entry = {}) {
  return [
    sanitizeText(entry.dateKey || entry.date || '', 80),
    sanitizeText(entry.shiftId || entry.shift || '', 80),
  ].filter(Boolean).join('|') || sanitizeText(entry.key || '', 160);
}

function buildShiftSummaryNotificationMessage(entries = [], firstEntry = {}) {
  const shiftLabel = sanitizeText(firstEntry.shift || 'Shift', 80).toUpperCase();
  const timeRange = sanitizeText(firstEntry.time || firstEntry.shiftMeta?.timeRange || '', 80);
  const lines = [`SUMMARY LAPORAN ${shiftLabel}${timeRange ? ` (${timeRange})` : ''}`];

  ensureArray(entries).forEach((entry) => {
    lines.push(
      `Kapal: ${entry.ship || 'Kapal'}`,
      `Aman: ${entry.summary?.aman || 0} | Temuan: ${entry.summary?.temuan || 0} | Missed: ${entry.summary?.missed || 0}`,
      '',
    );
  });

  return lines.join('\n').trim();
}

function sortNotifications(notifications) {
  return ensureArray(notifications)
    .filter(notification => ensureObject(notification))
    .sort((left, right) => new Date(right.createdAt || '').getTime() - new Date(left.createdAt || '').getTime());
}

function isShiftNotificationDebugEnabled() {
  try {
    return window.localStorage.getItem(SHIFT_NOTIFICATION_DEBUG_KEY) === '1';
  } catch {
    return false;
  }
}

function isShiftNotificationType(type) {
  return (
    type === 'shift_started'
    || type === 'shift_ending_soon'
    || type === 'checkpoint_pending'
    || type === 'checkpoint_pending_summary'
    || type === 'shift_wrap_up'
  );
}

function logShiftNotificationDebug(event, payload) {
  if (!isShiftNotificationDebugEnabled()) return;
  console.info(`[SmartPatrol][shift-notif] ${event}`, payload);
}

function isCloudSyncDebugEnabled() {
  try {
    return window.localStorage.getItem(CLOUD_SYNC_DEBUG_KEY) === '1';
  } catch {
    return false;
  }
}

function logCloudSyncDebug(event, payload) {
  if (!isCloudSyncDebugEnabled()) return;
  let serializedPayload = '';
  try {
    serializedPayload = payload ? ` ${JSON.stringify(payload)}` : '';
  } catch {
    serializedPayload = ' [unserializable]';
  }
  console.info(`[SmartPatrol][cloud-sync] ${event}${serializedPayload}`);
}

function loadAuthSession() { try { const raw = window.localStorage.getItem(AUTH_SESSION_KEY); if (!raw) return null; const parsed = JSON.parse(raw); return typeof parsed?.userId === 'string' ? parsed.userId : null; } catch { return null; } }
function saveAuthSession(userId) { try { if (!userId) { window.localStorage.removeItem(AUTH_SESSION_KEY); return; } window.localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify({ userId, savedAt: new Date().toISOString() })); } catch (error) { console.error('Gagal menyimpan sesi login', error); } }
function createFallbackEmail(name, index = 0) { const slug = sanitizeText(name, 80).toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/(^[.]+|[.]+$)/g, '') || `user.${index + 1}`; return `${slug}@smartpatrol.local`; }
function normalizeUserRole(user) {
  const raw = sanitizeText(user?.role || '', 20).toUpperCase();
  if (ACCESS_ROLE_VALUES.includes(raw)) return raw;
  return ACCESS_ROLES.PETUGAS;
}

function normalizeUserRecord(user, index = 0) {
  const safeName = sanitizeText(user?.name || '', 80) || `User ${index + 1}`;
  const safeEmail = sanitizeEmail(user?.email || '') || sanitizeEmail(seedUsersById[user?.id]?.email || seedUsersByEmail[sanitizeEmail(user?.email || '')]?.email || createFallbackEmail(safeName, index));
  const seedUser = seedUsersById[user?.id] || seedUsersByEmail[safeEmail];
  const role = normalizeUserRole({ ...seedUser, ...user, name: safeName });
  // Hormati nilai shipAssigned/status yang sengaja dikosongkan admin (unassign) — jangan fallback ke seed.
  const shipAssignedSource = resolveExplicitOverride(user, seedUser, 'shipAssigned', '');
  const shipAssigned = sanitizeText(shipAssignedSource || '', 80) || null;
  const firebaseUid = sanitizeText(user?.firebaseUid || seedUser?.firebaseUid || '', 160) || '';
  const authProvider = firebaseUid
    ? 'supabase'
    : sanitizeText(user?.authProvider || seedUser?.authProvider || 'none', 20).toLowerCase();
  const fallbackStatus = role === ACCESS_ROLES.PETUGAS ? (shipAssigned ? 'active' : 'off-duty') : 'active';
  const statusSource = resolveExplicitOverride(user, seedUser, 'status', '');
  const status = sanitizeText(statusSource || fallbackStatus, 20).toLowerCase() || fallbackStatus;
  return {
    ...seedUser,
    ...user,
    id: user?.id || seedUser?.id || `u${Date.now()}${index}`,
    name: safeName,
    role,
    type: sanitizeText(user?.type || seedUser?.type || 'BUJP', 20) || 'BUJP',
    workerNumber: sanitizeText(user?.workerNumber || seedUser?.workerNumber || '', 40),
    status: role === ACCESS_ROLES.PETUGAS && !shipAssigned && status !== 'disabled' ? 'off-duty' : status,
    shipAssigned,
    email: safeEmail,
    password: '',
    hasCredential: false,
    passwordSalt: '',
    passwordHash: '',
    authProvider,
    firebaseUid: firebaseUid || null,
    phone: sanitizePhone(user?.phone || seedUser?.phone || ''),
    dob: sanitizeText(user?.dob || seedUser?.dob || '', 20),
    address: sanitizeMultilineText(user?.address || seedUser?.address || '', 180),
    emergencyName: sanitizeText(user?.emergencyName || seedUser?.emergencyName || '', 80),
    emergencyContact: sanitizePhone(user?.emergencyContact || seedUser?.emergencyContact || ''),
    emergencyRelation: sanitizeText(user?.emergencyRelation || seedUser?.emergencyRelation || 'Orang Tua', 40) || 'Orang Tua',
    officeAddress: sanitizeMultilineText(user?.officeAddress || seedUser?.officeAddress || '', 180),
    photoUrl: sanitizeUrl(user?.photoUrl || seedUser?.photoUrl || '') || createUserAvatar(safeName, index),
  };
}

function normalizeUsersCollection(users) {
  const sourceUsers = Array.isArray(users) ? users : [];
  const normalized = sourceUsers.map((user, index) => normalizeUserRecord(user, index));
  return normalized;
}

function getUserOperationalIdentityKeys(user = {}) {
  const firebaseUid = getUserIdentityFirebaseUid(user);
  const email = getUserIdentityEmail(user);
  return [
    firebaseUid ? `firebase:${firebaseUid}` : '',
    email ? `email:${email}` : '',
  ].filter(Boolean);
}

function getShipReferencedUserIds(ships = []) {
  const referencedUserIds = new Set();
  ensureArray(ships).forEach((ship) => {
    ensureArray(ship?.personnel).forEach((userId) => {
      if (userId) referencedUserIds.add(String(userId));
    });
    ensureArray(ship?.personnelNextMonth).forEach((userId) => {
      if (userId) referencedUserIds.add(String(userId));
    });
    Object.keys(ship?.personnelSchedules || {}).forEach((userId) => {
      if (userId) referencedUserIds.add(String(userId));
    });
  });
  return referencedUserIds;
}

function getUserDedupeScore(user = {}, referencedUserIds = new Set()) {
  const id = String(user?.id || '');
  let score = 0;

  if (referencedUserIds.has(id)) score += 1000;
  if (/^u\d+$/i.test(id)) score += 120;
  if (id && id !== getUserIdentityFirebaseUid(user)) score += 40;
  if (user?.status === 'active') score += 30;
  if (user?.shipAssigned) score += 25;
  if (getUserIdentityFirebaseUid(user)) score += 20;
  if (getUserIdentityEmail(user)) score += 10;
  if (getEntityMergeTimestamp(user) > 0) score += 5;

  return score;
}

function mergeDuplicateUserRecords(baseUser, nextUser, referencedUserIds = new Set(), index = 0) {
  const baseScore = getUserDedupeScore(baseUser, referencedUserIds);
  const nextScore = getUserDedupeScore(nextUser, referencedUserIds);
  const canonicalUser = nextScore > baseScore ? nextUser : baseUser;
  const fallbackUser = canonicalUser === nextUser ? baseUser : nextUser;
  const versionedUser = mergeVersionedEntity(baseUser, nextUser);

  return normalizeUserRecord({
    ...versionedUser,
    id: canonicalUser?.id || fallbackUser?.id || versionedUser?.id,
    email: getUserIdentityEmail(versionedUser)
      || getUserIdentityEmail(canonicalUser)
      || getUserIdentityEmail(fallbackUser),
    firebaseUid: getUserIdentityFirebaseUid(versionedUser)
      || getUserIdentityFirebaseUid(canonicalUser)
      || getUserIdentityFirebaseUid(fallbackUser)
      || null,
    authProvider: (
      getUserIdentityFirebaseUid(versionedUser)
      || getUserIdentityFirebaseUid(canonicalUser)
      || getUserIdentityFirebaseUid(fallbackUser)
    )
      ? 'supabase'
      : (versionedUser?.authProvider || canonicalUser?.authProvider || fallbackUser?.authProvider || 'none'),
    photoUrl: resolveMergedAssetUrl(
      versionedUser?.photoUrl,
      resolveMergedAssetUrl(canonicalUser?.photoUrl, fallbackUser?.photoUrl),
    ),
  }, index);
}

function deduplicateUsersByOperationalIdentity(users = [], options = {}) {
  const referencedUserIds = getShipReferencedUserIds(options.ships || []);
  const sourceUsers = Array.isArray(users) ? users : [];
  const normalizedUsers = sourceUsers.filter(user => user && typeof user === 'object');
  const usersByCanonicalIndex = [];
  const identityIndex = new Map();
  const idIndex = new Map();
  const userIdMap = new Map();
  let changed = normalizedUsers.length !== sourceUsers.length;

  normalizedUsers.forEach((user, sourceIndex) => {
    const keys = getUserOperationalIdentityKeys(user);
    const matchingIndexes = [
      idIndex.get(String(user.id || '')),
      ...keys.map(key => identityIndex.get(key)),
    ].filter(Number.isInteger);
    const canonicalIndex = matchingIndexes.length > 0 ? matchingIndexes[0] : -1;

    if (canonicalIndex < 0) {
      usersByCanonicalIndex.push(user);
      const nextIndex = usersByCanonicalIndex.length - 1;
      if (user.id) idIndex.set(String(user.id), nextIndex);
      keys.forEach(key => identityIndex.set(key, nextIndex));
      return;
    }

    changed = true;
    const previousUser = usersByCanonicalIndex[canonicalIndex];
    const mergedUser = mergeDuplicateUserRecords(previousUser, user, referencedUserIds, canonicalIndex);
    usersByCanonicalIndex[canonicalIndex] = mergedUser;

    [previousUser?.id, user?.id].filter(Boolean).forEach((userId) => {
      userIdMap.set(String(userId), String(mergedUser.id));
      idIndex.set(String(userId), canonicalIndex);
    });
    getUserOperationalIdentityKeys(mergedUser).forEach(key => identityIndex.set(key, canonicalIndex));

    if (sourceIndex !== canonicalIndex || String(user?.id || '') !== String(mergedUser.id || '')) {
      userIdMap.set(String(user.id), String(mergedUser.id));
    }
  });

  if (!changed) {
    return {
      users: normalizedUsers,
      userIdMap: new Map(),
      changed: false,
    };
  }

  const dedupedUsers = usersByCanonicalIndex.map((user, index) => normalizeUserRecord(user, index));
  dedupedUsers.forEach((user) => {
    if (user?.id && !userIdMap.has(String(user.id))) {
      userIdMap.set(String(user.id), String(user.id));
    }
  });

  return {
    users: dedupedUsers,
    userIdMap,
    changed,
  };
}

function getUserIdentityEmail(user) {
  return sanitizeEmail(user?.email || '');
}

function getUserIdentityFirebaseUid(user) {
  return sanitizeText(user?.firebaseUid || '', 160) || '';
}

function resolvePreferredUserRecord(users = [], options = {}) {
  const safeUsers = ensureArray(users).filter(user => ensureObject(user));
  if (safeUsers.length === 0) return null;

  const sessionUserId = sanitizeText(options.sessionUserId || '', 160) || '';
  const firebaseAuthEmail = getUserIdentityEmail({ email: options.firebaseAuthEmail });
  const firebaseAuthUid = getUserIdentityFirebaseUid({ firebaseUid: options.firebaseAuthUid });
  const sessionUser = sessionUserId
    ? safeUsers.find((user) => String(user?.id) === sessionUserId) || null
    : null;
  const sessionEmail = getUserIdentityEmail(sessionUser);
  const sessionFirebaseUid = getUserIdentityFirebaseUid(sessionUser);
  const hasIdentityContext = Boolean(
    sessionUserId
    || sessionEmail
    || sessionFirebaseUid
    || firebaseAuthEmail
    || firebaseAuthUid
  );

  let bestUser = sessionUser;
  let bestScore = sessionUser ? 1 : -1;

  safeUsers.forEach((user) => {
    const userEmail = getUserIdentityEmail(user);
    const userFirebaseUid = getUserIdentityFirebaseUid(user);
    const hasIdentityMatch = Boolean(
      (sessionUserId && String(user?.id) === sessionUserId)
      || (firebaseAuthUid && userFirebaseUid && userFirebaseUid === firebaseAuthUid)
      || (firebaseAuthEmail && userEmail && userEmail === firebaseAuthEmail)
      || (sessionEmail && userEmail && userEmail === sessionEmail)
      || (sessionFirebaseUid && userFirebaseUid && userFirebaseUid === sessionFirebaseUid)
    );

    if (hasIdentityContext && !hasIdentityMatch) return;

    let score = 0;
    if (sessionUserId && String(user?.id) === sessionUserId) score += 12;
    if (firebaseAuthUid && userFirebaseUid && userFirebaseUid === firebaseAuthUid) score += 120;
    if (firebaseAuthEmail && userEmail && userEmail === firebaseAuthEmail) score += 90;
    if (sessionEmail && userEmail && userEmail === sessionEmail) score += 18;
    if (sessionFirebaseUid && userFirebaseUid && userFirebaseUid === sessionFirebaseUid) score += 18;
    if (user?.status === 'active') score += 24;
    if (user?.shipAssigned) score += 24;
    if (userFirebaseUid) score += 6;
    if (user?.authProvider === 'supabase' || user?.authProvider === 'firebase') score += 4;

    if (score > bestScore) {
      bestUser = user;
      bestScore = score;
    }
  });

  if (hasIdentityContext) {
    return bestUser || sessionUser || null;
  }

  return bestUser || safeUsers[0] || null;
}

function resolveAssignedShipForUser(user, ships = []) {
  if (!user || user.role === ACCESS_ROLES.ADMIN) return null;
  if (user.status !== 'active') return null;

  const safeShipAssigned = sanitizeText(user.shipAssigned || '', 80);
  if (!safeShipAssigned) return null;

  const matchingShips = ensureArray(ships).filter((ship) => ship?.name === safeShipAssigned);
  if (matchingShips.length === 0) return null;

  return matchingShips.find((ship) => (
    Array.isArray(ship?.personnel) && ship.personnel.includes(user.id)
  )) || matchingShips[0] || null;
}

function isFirebaseManagedUser(user) {
  return Boolean(user?.authProvider === 'supabase' || user?.authProvider === 'firebase' || user?.firebaseUid);
}

function canUserAccessApplication(user) {
  if (!user) return false;
  if (user.role !== ACCESS_ROLES.PETUGAS) return true;
  return Boolean(user.shipAssigned && user.status === 'active');
}

function buildOperationalUserRecordFromAccess({
  access = {},
  profile = {},
  authUser = null,
  existingUser = null,
  users = [],
} = {}) {
  const safeEmail = sanitizeEmail(
    access.email
    || profile.email
    || authUser?.email
    || existingUser?.email
    || '',
  );
  const safeName = sanitizeText(
    profile.name
    || access.name
    || authUser?.displayName
    || existingUser?.name
    || safeEmail.split('@')[0]
    || 'Personil Operasional',
    80,
  ) || 'Personil Operasional';
  const nextUserId = existingUser?.id || profile.id || access.legacyUserId || access.uid || authUser?.uid || `u${Date.now()}`;
  const resolvedUpdatedAtMs = Math.max(
    ...[
      resolveExternalTimestampMs(existingUser?.updatedAtTrustedMs),
      resolveExternalTimestampMs(existingUser?.updatedAtClientMs),
      resolveExternalTimestampMs(existingUser?.updatedAt),
      resolveExternalTimestampMs(access.updatedAt),
      resolveExternalTimestampMs(access.reviewedAt),
      resolveExternalTimestampMs(access.approvedAt),
      resolveExternalTimestampMs(profile.updatedAt),
    ].filter(Number.isFinite),
  );
  const resolvedUpdatedAtIso = Number.isFinite(resolvedUpdatedAtMs)
    ? new Date(resolvedUpdatedAtMs).toISOString()
    : (existingUser?.updatedAt || null);

  return normalizeUserRecord({
    ...(existingUser || {}),
    id: nextUserId,
    name: safeName,
    role: access.role || profile.role || existingUser?.role || ACCESS_ROLES.PETUGAS,
    type: profile.type || access.type || existingUser?.type || 'BUJP',
    workerNumber: profile.workerNumber || access.workerNumber || existingUser?.workerNumber || '',
    status: access.status || profile.status || existingUser?.status || 'off-duty',
    shipAssigned: access.shipAssigned || profile.shipAssigned || existingUser?.shipAssigned || null,
    email: safeEmail,
    phone: sanitizePhone(profile.phone || authUser?.phoneNumber || existingUser?.phone || ''),
    photoUrl: sanitizeUrl(profile.photoUrl || authUser?.photoURL || existingUser?.photoUrl || '') || createUserAvatar(safeName, users.length),
    authProvider: 'supabase',
    firebaseUid: authUser?.uid || access.uid || existingUser?.firebaseUid || null,
    updatedAt: resolvedUpdatedAtIso || existingUser?.updatedAt || null,
    updatedAtClientMs: Number.isFinite(resolvedUpdatedAtMs)
      ? resolvedUpdatedAtMs
      : (Number.isFinite(existingUser?.updatedAtClientMs) ? existingUser.updatedAtClientMs : null),
    updatedAtTrustedMs: Number.isFinite(resolvedUpdatedAtMs)
      ? resolvedUpdatedAtMs
      : (Number.isFinite(existingUser?.updatedAtTrustedMs) ? existingUser.updatedAtTrustedMs : null),
    hasCredential: false,
    passwordSalt: '',
    passwordHash: '',
  }, users.length);
}

function upsertOperationalUserRecord(users = [], payload = {}) {
  const safeUsers = Array.isArray(users) ? users : [];
  const access = payload?.access || {};
  const authUser = payload?.authUser || null;
  const profile = payload?.profile || {};
  const targetUser = safeUsers.find((user) => (
    (access.legacyUserId && String(user?.id) === String(access.legacyUserId))
    || (authUser?.uid && String(user?.firebaseUid || '') === String(authUser.uid))
    || (access.email && sanitizeEmail(user?.email || '') === sanitizeEmail(access.email))
  )) || null;
  const nextRecord = buildOperationalUserRecordFromAccess({
    access,
    profile,
    authUser,
    existingUser: targetUser,
    users: safeUsers,
  });

  if (!targetUser) {
    return [...safeUsers, nextRecord];
  }

  return safeUsers.map((user, index) => (
    user.id !== targetUser.id
      ? user
      : normalizeUserRecord({
        ...user,
        ...nextRecord,
        id: targetUser.id,
      }, index)
  ));
}

function readStorageSnapshot(primaryKey, legacyKey = '') {
  const keys = [primaryKey, legacyKey].filter(Boolean);
  for (const key of keys) {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw) return raw;
    } catch {
      return null;
    }
  }
  return null;
}

function createPersistedUserSnapshot(user, sessionUserId = null) {
  const isSessionUser = Boolean(sessionUserId && String(user?.id) === String(sessionUserId));
  return {
    id: user?.id || null,
    name: sanitizeText(user?.name || '', 80) || 'User',
    role: normalizeUserRole(user),
    type: sanitizeText(user?.type || 'BUJP', 20) || 'BUJP',
    workerNumber: sanitizeText(user?.workerNumber || '', 40),
    status: sanitizeText(user?.status || '', 20) || 'off-duty',
    shipAssigned: sanitizeText(user?.shipAssigned || '', 80) || null,
    email: sanitizeEmail(user?.email || ''),
    phone: sanitizePhone(user?.phone || ''),
    photoUrl: sanitizeUrl(user?.photoUrl || '') || '',
    authProvider: sanitizeText(user?.authProvider || 'none', 20).toLowerCase(),
    firebaseUid: sanitizeText(user?.firebaseUid || '', 160) || null,
    updatedAt: sanitizeText(user?.updatedAt || '', 80) || null,
    updatedAtClientMs: Number.isFinite(user?.updatedAtClientMs) ? user.updatedAtClientMs : null,
    updatedAtTrustedMs: Number.isFinite(user?.updatedAtTrustedMs) ? user.updatedAtTrustedMs : null,
    ...(isSessionUser
      ? {
        dob: sanitizeText(user?.dob || '', 20),
        address: sanitizeMultilineText(user?.address || '', 180),
        officeAddress: sanitizeMultilineText(user?.officeAddress || '', 180),
        emergencyName: sanitizeText(user?.emergencyName || '', 80),
        emergencyContact: sanitizePhone(user?.emergencyContact || ''),
        emergencyRelation: sanitizeText(user?.emergencyRelation || '', 40) || 'Orang Tua',
      }
      : {}),
  };
}

function sanitizeStateForLocalPersistence(data, options = {}) {
  const sessionUserId = sanitizeText(options.sessionUserId || '', 160) || null;
  return {
    ...data,
    usersData: Array.isArray(data?.usersData)
      ? data.usersData.map((user) => createPersistedUserSnapshot(user, sessionUserId))
      : [],
  };
}

function loadPersistedState() {
  try {
    const raw = readStorageSnapshot(APP_STORAGE_KEY, LEGACY_APP_STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    if (parsed?.version !== 1 || !parsed?.data || typeof parsed.data !== 'object') {
      return null;
    }

    const normalizedData = normalizeSharedStateTimeAudit(parsed.data);
    return {
      ...parsed.data,
      ...normalizedData,
    };
  } catch {
    return null;
  }
}
function savePersistedState(data, options = {}) {
  try {
    const persistedData = sanitizeStateForLocalPersistence(data, options);
    window.localStorage.setItem(APP_STORAGE_KEY, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), data: persistedData }));
    window.localStorage.removeItem(LEGACY_APP_STORAGE_KEY);
    checkStorageQuota();
  } catch (error) {
    console.error('Gagal menyimpan data lokal', error);
  }
}
function loadWeatherCache() { try { const raw = readStorageSnapshot(WEATHER_STORAGE_KEY, LEGACY_WEATHER_STORAGE_KEY); if (!raw) return null; const parsed = JSON.parse(raw); if (!parsed?.savedAt || !parsed?.data) return null; if (Date.now() - new Date(parsed.savedAt).getTime() > WEATHER_TTL_MS) return null; return parsed.data; } catch { return null; } }
function saveWeatherCache(data) { try { window.localStorage.setItem(WEATHER_STORAGE_KEY, JSON.stringify({ savedAt: new Date().toISOString(), data })); window.localStorage.removeItem(LEGACY_WEATHER_STORAGE_KEY); } catch (error) { console.error('Gagal menyimpan cache cuaca', error); } }
function sanitizeCloudAssetSegment(value, fallback = 'asset') {
  return sanitizeText(String(value || ''), 120)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/(^-|-$)/g, '') || fallback;
}

function createCloudAssetPath(...segments) {
  return ['state-assets', ...segments]
    .map((segment, index) => sanitizeCloudAssetSegment(segment, `part-${index + 1}`))
    .join('/');
}

function getIncidentMediaItemKey(item = {}, fallback = '') {
  return sanitizeText(
    item?.id || item?.createdAt || item?.comment || item?.photoUrl || fallback || '',
    180,
  ).trim();
}

const CLOUD_SYNC_DEBOUNCE_MS = 300;
const URGENT_CLOUD_SYNC_DEBOUNCE_MS = 0;

// Fast-path synchronous: strip local-only asset URLs dan compact records
// tanpa overhead ratusan Promise seperti prepareSharedStateForCloudSync.
function stripLocalAssetUrlSync(url) {
  if (typeof url !== 'string' || !url) return url || null;
  if (isLocalOnlyAssetUrl(url)) return null;
  return url;
}

function prepareStateForUrgentCloudSync(stateSnapshot) {
  const bounded = fitSharedStateToCloudBudget(stateSnapshot);

  const compactCheckpoint = (cp) => compactCheckpointRecordForCloudSync({
    ...cp,
    photoUrl: stripLocalAssetUrlSync(cp?.photoUrl),
    galleryPhotos: ensureArray(cp?.galleryPhotos).map((gp) => compactMediaAuditRecordForCloudSync({
      ...gp,
      photoUrl: stripLocalAssetUrlSync(gp?.photoUrl),
    })),
  });

  return fitSharedStateToCloudBudget({
    activeShiftKey: bounded.activeShiftKey,
    checkpointsByShip: Object.fromEntries(
      Object.entries(bounded.checkpointsByShip || {}).map(([shipId, cps]) => [
        shipId,
        (cps || []).map(compactCheckpoint),
      ]),
    ),
    deletedRecords: bounded.deletedRecords,
    historyEntries: (bounded.historyEntries || []).map((entry) => compactHistoryEntryForCloudSync({
      ...entry,
      checkpoints: (entry.checkpoints || []).map(compactCheckpoint),
      crewSnapshot: (entry.crewSnapshot || []).map((c) => ({
        ...c,
        photoUrl: stripLocalAssetUrlSync(c?.photoUrl),
      })),
    })),
    incidentMeta: Object.fromEntries(
      Object.entries(bounded.incidentMeta || {}).map(([id, meta]) => [
        id,
        {
          ...meta,
          documentation: (meta?.documentation || []).map((d) => compactMediaAuditRecordForCloudSync({
            ...d,
            photoUrl: stripLocalAssetUrlSync(d?.photoUrl),
          })),
          progress: (meta?.progress || []).map((p) => compactMediaAuditRecordForCloudSync({
            ...p,
            photoUrl: stripLocalAssetUrlSync(p?.photoUrl),
          })),
        },
      ]),
    ),
    incidentsData: (bounded.incidentsData || []).map((i) => compactIncidentRecordForCloudSync({
      ...i,
      photoUrl: stripLocalAssetUrlSync(i?.photoUrl),
    })),
    notifications: bounded.notifications || [],
    shipsData: (bounded.shipsData || []).map((s) => ({
      ...s,
      photoUrl: stripLocalAssetUrlSync(s?.photoUrl),
    })),
    usersData: (bounded.usersData || []).map((u) => ({
      ...u,
      photoUrl: stripLocalAssetUrlSync(u?.photoUrl),
    })),
    shiftStatusRecords: bounded.shiftStatusRecords || {},
    activeSOSAlert: bounded.activeSOSAlert || null,
    sosHistory: bounded.sosHistory || [],
  });
}

function createSharedStateSnapshot({
  activeShiftKey,
  checkpointsByShip,
  deletedRecords,
  historyEntries,
  incidentMeta,
  incidentsData,
  notifications,
  shipsData,
  usersData,
  shiftStatusRecords,
  activeSOSAlert,
  sosHistory,
}) {
  return {
    checkpointsByShip,
    shipsData,
    usersData,
    incidentsData,
    incidentMeta,
    historyEntries,
    deletedRecords: createDeletedRecordsState(deletedRecords),
    activeShiftKey,
    notifications,
    shiftStatusRecords: shiftStatusRecords && typeof shiftStatusRecords === 'object' ? shiftStatusRecords : {},
    activeSOSAlert,
    sosHistory,
  };
}

const CLOUD_SYNC_HISTORY_LIMIT_PER_SHIP = 12;
const CLOUD_SYNC_HISTORY_LIMIT_TOTAL = 24;
const CLOUD_SYNC_NOTIFICATION_LIMIT = 120;
const CLOUD_SYNC_SOS_HISTORY_LIMIT = 40;
const CLOUD_SYNC_INCIDENT_MEDIA_LIMIT = 12;
const CLOUD_SYNC_SOFT_PAYLOAD_LIMIT_BYTES = 700 * 1024;
const CLOUD_SYNC_TRIM_PROFILES = [
  {
    historyLimitPerShip: 8,
    historyLimitTotal: 16,
    notificationLimit: 80,
    sosHistoryLimit: 24,
    incidentMediaLimit: 10,
  },
  {
    historyLimitPerShip: 4,
    historyLimitTotal: 8,
    notificationLimit: 40,
    sosHistoryLimit: 16,
    incidentMediaLimit: 6,
  },
  {
    historyLimitPerShip: 2,
    historyLimitTotal: 4,
    notificationLimit: 20,
    sosHistoryLimit: 8,
    incidentMediaLimit: 4,
  },
  {
    historyLimitPerShip: 0,
    historyLimitTotal: 0,
    notificationLimit: 12,
    sosHistoryLimit: 4,
    incidentMediaLimit: 2,
  },
];

function getComparableRecordTimestamp(record = {}) {
  return resolveExternalTimestampMs(
    record?.updatedAt
    || record?.createdAt
    || record?.completedAt
    || record?.triggeredAt
    || record?.resolvedAt,
  ) || 0;
}

function limitRecentRecords(records = [], limit = 0) {
  const normalizedRecords = ensureArray(records);
  if (!Number.isFinite(limit) || limit <= 0) return [];
  if (normalizedRecords.length <= limit) return normalizedRecords;

  const keepIndexes = new Set(
    normalizedRecords
      .map((record, index) => ({ index, timestamp: getComparableRecordTimestamp(record) }))
      .sort((left, right) => (
        right.timestamp - left.timestamp
        || right.index - left.index
      ))
      .slice(0, limit)
      .map(({ index }) => index),
  );

  return normalizedRecords.filter((_, index) => keepIndexes.has(index));
}

function limitIncidentMetaForCloudSync(incidentMeta = {}, mediaLimit = CLOUD_SYNC_INCIDENT_MEDIA_LIMIT) {
  return Object.fromEntries(
    Object.entries(incidentMeta || {}).map(([incidentId, meta]) => ([
      incidentId,
      {
        ...meta,
        documentation: limitRecentRecords(meta?.documentation || [], mediaLimit),
        progress: limitRecentRecords(meta?.progress || [], mediaLimit),
      },
    ])),
  );
}

function limitHistoryEntriesForCloudSync(entries = [], options = {}) {
  const perShipLimit = Number.isFinite(options?.historyLimitPerShip)
    ? options.historyLimitPerShip
    : CLOUD_SYNC_HISTORY_LIMIT_PER_SHIP;
  const totalLimit = Number.isFinite(options?.historyLimitTotal)
    ? options.historyLimitTotal
    : CLOUD_SYNC_HISTORY_LIMIT_TOTAL;
  if (perShipLimit <= 0 || totalLimit <= 0) return [];

  const groupedEntries = new Map();

  sortHistoryEntries(entries).forEach((entry) => {
    const shipKey = String(entry?.shipId || entry?.ship || 'unknown');
    const shipEntries = groupedEntries.get(shipKey) || [];
    if (shipEntries.length >= perShipLimit) return;
    shipEntries.push(entry);
    groupedEntries.set(shipKey, shipEntries);
  });

  return sortHistoryEntries(Array.from(groupedEntries.values()).flat())
    .slice(0, totalLimit);
}

function limitNotificationsForCloudSync(notifications = [], limit = CLOUD_SYNC_NOTIFICATION_LIMIT) {
  if (!Number.isFinite(limit) || limit <= 0) return [];
  return sortNotifications(notifications).slice(0, limit);
}

function createCloudSyncStateSnapshot(stateSnapshot = {}, options = {}) {
  const historyLimitPerShip = Number.isFinite(options?.historyLimitPerShip)
    ? options.historyLimitPerShip
    : CLOUD_SYNC_HISTORY_LIMIT_PER_SHIP;
  const historyLimitTotal = Number.isFinite(options?.historyLimitTotal)
    ? options.historyLimitTotal
    : CLOUD_SYNC_HISTORY_LIMIT_TOTAL;
  const notificationLimit = Number.isFinite(options?.notificationLimit)
    ? options.notificationLimit
    : CLOUD_SYNC_NOTIFICATION_LIMIT;
  const sosHistoryLimit = Number.isFinite(options?.sosHistoryLimit)
    ? options.sosHistoryLimit
    : CLOUD_SYNC_SOS_HISTORY_LIMIT;
  const incidentMediaLimit = Number.isFinite(options?.incidentMediaLimit)
    ? options.incidentMediaLimit
    : CLOUD_SYNC_INCIDENT_MEDIA_LIMIT;

  return createSharedStateSnapshot({
    activeShiftKey: stateSnapshot.activeShiftKey,
    checkpointsByShip: stateSnapshot.checkpointsByShip,
    deletedRecords: stateSnapshot.deletedRecords,
    historyEntries: limitHistoryEntriesForCloudSync(stateSnapshot.historyEntries || [], {
      historyLimitPerShip,
      historyLimitTotal,
    }),
    incidentMeta: limitIncidentMetaForCloudSync(stateSnapshot.incidentMeta, incidentMediaLimit),
    incidentsData: stateSnapshot.incidentsData,
    notifications: limitNotificationsForCloudSync(stateSnapshot.notifications || [], notificationLimit),
    shipsData: stateSnapshot.shipsData,
    usersData: stateSnapshot.usersData,
    shiftStatusRecords: pruneStaleShiftStatusRecords(stateSnapshot.shiftStatusRecords),
    activeSOSAlert: stateSnapshot.activeSOSAlert || null,
    sosHistory: limitRecentRecords(stateSnapshot.sosHistory || [], sosHistoryLimit),
  });
}

function mapAuditableRecord(record, mapper, options = {}) {
  if (!record || typeof record !== 'object') return record;
  return mapper(record, options);
}

function mapAuditableRecordList(records = [], mapper, options = {}) {
  return Array.isArray(records)
    ? records.map((record) => mapAuditableRecord(record, mapper, options))
    : [];
}

function mapCheckpointAuditRecord(checkpoint, mapper) {
  if (!checkpoint || typeof checkpoint !== 'object') return checkpoint;

  return {
    ...mapAuditableRecord(checkpoint, mapper, {
      fallbackTimestampKeys: ['completedAt', 'updatedAt', 'createdAt'],
    }),
    galleryPhotos: mapAuditableRecordList(checkpoint.galleryPhotos || [], mapper, {
      fallbackTimestampKeys: ['createdAt'],
    }),
  };
}

function mapIncidentMetaAuditCollection(incidentMeta = {}, mapper) {
  return Object.fromEntries(
    Object.entries(incidentMeta || {}).map(([incidentId, meta]) => ([
      incidentId,
      {
        ...meta,
        documentation: mapAuditableRecordList(meta?.documentation || [], mapper, {
          fallbackTimestampKeys: ['createdAt'],
        }),
        progress: mapAuditableRecordList(meta?.progress || [], mapper, {
          fallbackTimestampKeys: ['createdAt'],
        }),
      },
    ])),
  );
}

function mapSharedStateTimeAudit(stateSnapshot = {}, mapper) {
  const snapshot = stateSnapshot && typeof stateSnapshot === 'object' ? stateSnapshot : {};

  return createSharedStateSnapshot({
    activeShiftKey: snapshot.activeShiftKey,
    checkpointsByShip: Object.fromEntries(
      Object.entries(snapshot.checkpointsByShip || {}).map(([shipId, shipCheckpoints]) => ([
        shipId,
        mapAuditableRecordList(shipCheckpoints || [], (record) => mapCheckpointAuditRecord(record, mapper)),
      ])),
    ),
    deletedRecords: snapshot.deletedRecords,
    historyEntries: mapAuditableRecordList(snapshot.historyEntries || [], (entry) => ({
      ...entry,
      checkpoints: mapAuditableRecordList(entry?.checkpoints || [], (record) => mapCheckpointAuditRecord(record, mapper)),
      crewSnapshot: Array.isArray(entry?.crewSnapshot) ? entry.crewSnapshot : [],
    })),
    incidentMeta: mapIncidentMetaAuditCollection(snapshot.incidentMeta, mapper),
    incidentsData: mapAuditableRecordList(snapshot.incidentsData || [], mapper, {
      fallbackTimestampKeys: ['completedAt', 'createdAt'],
    }),
    notifications: snapshot.notifications || [],
    shipsData: snapshot.shipsData || [],
    usersData: snapshot.usersData || [],
    shiftStatusRecords: pruneStaleShiftStatusRecords(snapshot.shiftStatusRecords),
    activeSOSAlert: mapAuditableRecord(snapshot.activeSOSAlert, mapper, {
      fallbackTimestampKeys: ['triggeredAt', 'createdAt'],
    }),
    sosHistory: mapAuditableRecordList(snapshot.sosHistory || [], mapper, {
      fallbackTimestampKeys: ['triggeredAt', 'createdAt'],
    }),
  });
}

function normalizeSharedStateTimeAudit(stateSnapshot = {}) {
  return mapSharedStateTimeAudit(stateSnapshot, (record, options) => normalizeTimeAuditRecord(record, options));
}

function markSharedStateTimeAuditReceived(stateSnapshot = {}, receivedAtServerMs) {
  if (!Number.isFinite(receivedAtServerMs)) {
    return normalizeSharedStateTimeAudit(stateSnapshot);
  }

  return mapSharedStateTimeAudit(
    normalizeSharedStateTimeAudit(stateSnapshot),
    (record, options) => markTimeAuditRecordReceived(record, receivedAtServerMs, options),
  );
}

function resolveExternalTimestampMs(value) {
  if (Number.isFinite(value)) return value;

  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isNaN(timestamp) ? null : timestamp;
  }

  if (typeof value?.toMillis === 'function') {
    const timestamp = value.toMillis();
    return Number.isNaN(timestamp) ? null : timestamp;
  }

  if (typeof value === 'string' && value.trim()) {
    const timestamp = new Date(value).getTime();
    return Number.isNaN(timestamp) ? null : timestamp;
  }

  return null;
}

function serializeSharedStateSnapshot(snapshot) {
  try {
    return JSON.stringify(snapshot);
  } catch {
    return '';
  }
}

function measureSharedStateSnapshotBytes(snapshot) {
  const serializedSnapshot = serializeSharedStateSnapshot(snapshot);
  if (!serializedSnapshot) return 0;

  try {
    return new TextEncoder().encode(serializedSnapshot).length;
  } catch {
    return serializedSnapshot.length;
  }
}

function fitSharedStateToCloudBudget(stateSnapshot = {}) {
  const baseSnapshot = createCloudSyncStateSnapshot(stateSnapshot);
  const baseSizeBytes = measureSharedStateSnapshotBytes(baseSnapshot);
  if (baseSizeBytes <= CLOUD_SYNC_SOFT_PAYLOAD_LIMIT_BYTES) {
    return baseSnapshot;
  }

  let bestSnapshot = baseSnapshot;
  let bestSizeBytes = baseSizeBytes;

  for (const trimProfile of CLOUD_SYNC_TRIM_PROFILES) {
    const candidateSnapshot = createCloudSyncStateSnapshot(stateSnapshot, trimProfile);
    const candidateSizeBytes = measureSharedStateSnapshotBytes(candidateSnapshot);

    if (candidateSizeBytes < bestSizeBytes) {
      bestSnapshot = candidateSnapshot;
      bestSizeBytes = candidateSizeBytes;
    }

    if (candidateSizeBytes <= CLOUD_SYNC_SOFT_PAYLOAD_LIMIT_BYTES) {
      logCloudSyncDebug('payload-trimmed', {
        beforeBytes: baseSizeBytes,
        afterBytes: candidateSizeBytes,
        trimProfile,
      });
      return candidateSnapshot;
    }
  }

  console.warn('Payload cloud masih besar setelah trim agresif.', {
    beforeBytes: baseSizeBytes,
    afterBytes: bestSizeBytes,
  });
  return bestSnapshot;
}

function compactTimeAuditFieldsForCloudSync(record = {}) {
  const auditFields = extractTimeAuditFields(record);

  return {
    occurredAtTrustedMs: auditFields.occurredAtTrustedMs,
    receivedAtServerMs: auditFields.receivedAtServerMs,
    timeTrustLevel: auditFields.timeTrustLevel,
    verificationStatus: auditFields.verificationStatus,
    clockTamperDetected: auditFields.clockTamperDetected,
  };
}

function compactShipSnapshotForCloudSync(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;

  const lat = normalizeSnapshotCoordinate(snapshot.lat);
  const lng = normalizeSnapshotCoordinate(snapshot.lng);
  const id = sanitizeText(snapshot.id || '', 120) || null;
  const name = sanitizeText(snapshot.name || '', 80) || '';

  if (!id && !name && lat == null && lng == null) return null;

  return {
    id,
    name,
    lat,
    lng,
  };
}

function compactGpsSnapshotForCloudSync(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;

  const lat = normalizeSnapshotCoordinate(snapshot.lat);
  const lng = normalizeSnapshotCoordinate(snapshot.lng);
  const source = sanitizeText(snapshot.source || '', 40) || null;

  if (lat == null && lng == null && !source) return null;

  return {
    lat,
    lng,
    source,
  };
}

function compactWeatherSnapshotForCloudSync(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;

  const weathercode = Number.isFinite(Number(snapshot.weathercode))
    ? Number(snapshot.weathercode)
    : null;
  const temperature = Number.isFinite(Number(snapshot.temperature))
    ? Number(Number(snapshot.temperature).toFixed(1))
    : null;
  const windspeed = Number.isFinite(Number(snapshot.windspeed))
    ? Number(Number(snapshot.windspeed).toFixed(1))
    : null;

  if (weathercode == null && temperature == null && windspeed == null) return null;

  return {
    weathercode,
    temperature,
    windspeed,
  };
}

function compactMediaAuditRecordForCloudSync(record = {}) {
  if (!record || typeof record !== 'object') return record;

  const {
    occurredAtTrustedIso: _occurredAtTrustedIso,
    occurredAtClientMs: _occurredAtClientMs,
    offlineSessionId: _offlineSessionId,
    offlineSessionInterrupted: _offlineSessionInterrupted,
    anchorSyncedAtMs: _anchorSyncedAtMs,
    ...restRecord
  } = record;

  return {
    ...restRecord,
    ...compactTimeAuditFieldsForCloudSync(record),
  };
}

function compactCheckpointRecordForCloudSync(record = {}) {
  if (!record || typeof record !== 'object') return record;

  const compactedRecord = compactMediaAuditRecordForCloudSync(record);

  return {
    ...compactedRecord,
    shipSnapshot: compactShipSnapshotForCloudSync(record.shipSnapshot),
    gpsSnapshot: compactGpsSnapshotForCloudSync(record.gpsSnapshot),
    weatherSnapshot: compactWeatherSnapshotForCloudSync(record.weatherSnapshot),
    galleryPhotos: Array.isArray(record.galleryPhotos) ? record.galleryPhotos : [],
  };
}

// Petakan hasil savePatrolReport menjadi status sinkronisasi untuk umpan balik UI.
// 'ok' = tertulis ke patrol_reports; 'offline' = diantrekan, akan dikirim saat online;
// 'blocked' = server menolak (RLS/constraint/auth) sehingga laporan TIDAK akan terlihat
// di device lain sampai akarnya diperbaiki.
function toPatrolSyncStatus(result) {
  if (!result || result.synced || result.unchanged) return { syncStatus: 'ok' };
  if (result.offline) return { syncStatus: 'offline' };
  if (result.syncError) return { syncStatus: 'blocked', error: result.syncError };
  if (result.pendingOfflineSync) return { syncStatus: 'offline' };
  return { syncStatus: 'ok' };
}

function createPatrolReportDomainRecord(checkpoint = {}, options = {}) {
  if (!checkpoint || typeof checkpoint !== 'object') return null;

  const checkpointId = sanitizeText(checkpoint.checkpointId || checkpoint.id || '', 160);
  const shipId = sanitizeText(checkpoint.shipId || '', 160);
  const shipName = sanitizeText(checkpoint.shipName || '', 100);
  const shiftKey = sanitizeText(checkpoint.shiftKey || '', 160);
  if (!checkpointId || !shipId || !shipName || !shiftKey) return null;

  const photoUrl = typeof options.photoUrl === 'string'
    ? options.photoUrl
    : typeof checkpoint.photoUrl === 'string'
      ? checkpoint.photoUrl
      : null;
  const galleryPhotos = Array.isArray(options.galleryPhotos)
    ? options.galleryPhotos
    : ensureArray(checkpoint.galleryPhotos);
  const hasReadyMedia = Boolean(photoUrl)
    || galleryPhotos.some((galleryPhoto) => Boolean(galleryPhoto?.photoUrl));
  const mediaStatus = sanitizeText(options.mediaStatus || '', 20)
    || (hasReadyMedia ? 'ready' : 'none');
  const normalizedCheckpoint = compactCheckpointRecordForCloudSync({
    ...checkpoint,
    id: checkpointId,
    checkpointId,
    checkpointName: sanitizeText(checkpoint.checkpointName || checkpoint.name || '', 100),
    shipId,
    shipName,
    shiftKey,
    photoUrl,
    galleryPhotos,
  });
  const normalizedGalleryPhotos = ensureArray(normalizedCheckpoint.galleryPhotos).map((galleryPhoto) => (
    compactMediaAuditRecordForCloudSync({
      ...galleryPhoto,
      photoUrl: typeof galleryPhoto?.photoUrl === 'string' ? galleryPhoto.photoUrl : null,
    })
  ));

  return {
    checkpointId,
    checkpointName: sanitizeText(checkpoint.checkpointName || checkpoint.name || '', 100),
    id: checkpointId,
    name: sanitizeText(checkpoint.name || checkpoint.checkpointName || '', 100),
    desc: sanitizeText(checkpoint.desc || '', 240),
    shipId,
    shipName,
    shiftKey,
    status: sanitizeText(checkpoint.status || 'pending', 20) || 'pending',
    pendingOrigin: sanitizeText(checkpoint.pendingOrigin || '', 40) || null,
    isTemporaryShiftNode: Boolean(checkpoint.isTemporaryShiftNode),
    createdInShiftKey: sanitizeText(checkpoint.createdInShiftKey || '', 160) || null,
    incidentId: sanitizeText(checkpoint.incidentId || '', 180) || null,
    completedBy: sanitizeText(checkpoint.completedBy || '', 100) || '',
    completedByUserId: sanitizeText(checkpoint.completedByUserId || '', 160) || null,
    date: sanitizeText(checkpoint.date || '', 40) || '',
    time: sanitizeText(checkpoint.time || '', 20) || '',
    completedAt: typeof checkpoint.completedAt === 'string' ? checkpoint.completedAt : null,
    updatedAt: typeof checkpoint.updatedAt === 'string' ? checkpoint.updatedAt : null,
    resultType: sanitizeText(checkpoint.resultType || '', 20) || null,
    photoUrl,
    galleryPhotos: normalizedGalleryPhotos,
    mediaStatus,
    kejadian: sanitizeMultilineText(checkpoint.kejadian || '', 320),
    penyebab: sanitizeMultilineText(checkpoint.penyebab || '', 280),
    tindakLanjut: sanitizeMultilineText(checkpoint.tindakLanjut || '', 280),
    shipSnapshot: normalizedCheckpoint.shipSnapshot || null,
    gpsSnapshot: normalizedCheckpoint.gpsSnapshot || null,
    weatherSnapshot: normalizedCheckpoint.weatherSnapshot || null,
    ...compactTimeAuditFieldsForCloudSync(checkpoint),
  };
}

function createPatrolReportMediaKey(report = {}) {
  const shiftKey = sanitizeText(report.shiftKey || '', 160);
  const shipId = sanitizeText(report.shipId || '', 160);
  const checkpointId = sanitizeText(report.checkpointId || report.id || report.firestoreId || '', 160);
  return shiftKey && shipId && checkpointId
    ? `${shiftKey}|${shipId}|${checkpointId}`
    : '';
}

function createCheckpointFromPatrolReportDocument(report = {}) {
  const checkpointId = sanitizeText(report.checkpointId || report.id || report.firestoreId || '', 160);
  const shipId = sanitizeText(report.shipId || '', 160);
  const shipName = sanitizeText(report.shipName || '', 100);
  const shiftKey = sanitizeText(report.shiftKey || '', 160);
  if (!checkpointId || !shipId || !shipName || !shiftKey) return null;

  return normalizeTimeAuditRecord({
    ...report,
    id: checkpointId,
    name: sanitizeText(report.name || report.checkpointName || '', 100),
    shipId,
    shipName,
    shiftKey,
    photoUrl: typeof report.photoUrl === 'string' ? report.photoUrl : null,
    galleryPhotos: ensureArray(report.galleryPhotos),
  }, {
    fallbackTimestampKeys: ['completedAt', 'updatedAt', 'createdAt'],
  });
}

function mergePatrolReportDocumentsIntoCheckpoints(previousState = {}, reportDocuments = []) {
  if (!Array.isArray(reportDocuments) || reportDocuments.length === 0) return previousState;

  let didChange = false;
  const nextState = { ...(previousState || {}) };

  reportDocuments.forEach((reportDocument) => {
    const checkpointReport = createCheckpointFromPatrolReportDocument(reportDocument);
    if (!checkpointReport?.shipId || !checkpointReport.id) return;

    const currentShipCheckpoints = ensureArray(nextState[checkpointReport.shipId]);
    const checkpointIndex = currentShipCheckpoints.findIndex((checkpoint) => (
      String(checkpoint?.id) === String(checkpointReport.id)
      || createCheckpointNameKey(checkpoint?.name) === createCheckpointNameKey(checkpointReport.name)
    ));
    const nextShipCheckpoints = [...currentShipCheckpoints];

    if (checkpointIndex >= 0) {
      const mergedCheckpoint = mergeCheckpointRecord(nextShipCheckpoints[checkpointIndex], checkpointReport);
      if (serializeSharedStateSnapshot(mergedCheckpoint) === serializeSharedStateSnapshot(nextShipCheckpoints[checkpointIndex])) {
        return;
      }
      nextShipCheckpoints[checkpointIndex] = mergedCheckpoint;
    } else if (checkpointReport.status === 'completed' || checkpointReport.isTemporaryShiftNode) {
      nextShipCheckpoints.push(checkpointReport);
    } else {
      return;
    }

    nextState[checkpointReport.shipId] = nextShipCheckpoints;
    didChange = true;
  });

  return didChange ? nextState : previousState;
}

function compactIncidentRecordForCloudSync(record = {}) {
  if (!record || typeof record !== 'object') return record;

  const compactedRecord = compactMediaAuditRecordForCloudSync(record);

  return {
    ...compactedRecord,
    shipSnapshot: compactShipSnapshotForCloudSync(record.shipSnapshot),
    gpsSnapshot: compactGpsSnapshotForCloudSync(record.gpsSnapshot),
    weatherSnapshot: compactWeatherSnapshotForCloudSync(record.weatherSnapshot),
  };
}

function removeUndefinedFields(record = {}) {
  return Object.fromEntries(
    Object.entries(record || {}).filter(([, value]) => value !== undefined),
  );
}

function normalizeIncidentInfoOverrides(infoOverrides = {}) {
  if (!infoOverrides || typeof infoOverrides !== 'object' || Array.isArray(infoOverrides)) return {};

  const normalizedInfo = {};
  if (Object.prototype.hasOwnProperty.call(infoOverrides, 'deskripsi')) {
    normalizedInfo.deskripsi = sanitizeMultilineText(infoOverrides.deskripsi || '', 320);
  }
  if (Object.prototype.hasOwnProperty.call(infoOverrides, 'penyebab')) {
    normalizedInfo.penyebab = sanitizeMultilineText(infoOverrides.penyebab || '', 240);
  }
  if (Object.prototype.hasOwnProperty.call(infoOverrides, 'tindakLanjut')) {
    normalizedInfo.tindakLanjut = sanitizeMultilineText(infoOverrides.tindakLanjut || '', 240);
  }

  return normalizedInfo;
}

function compactIncidentMetaForDomainSync(meta = {}) {
  if (!meta || typeof meta !== 'object') return {};

  const normalizedMeta = {};
  const status = sanitizeText(meta.status || '', 30);
  const infoOverrides = normalizeIncidentInfoOverrides(meta.infoOverrides || {});
  const documentation = mergeDocumentationItems(
    [],
    ensureArray(meta.documentation).map((item) => compactMediaAuditRecordForCloudSync({
      ...item,
      photoUrl: stripLocalAssetUrlSync(item?.photoUrl),
    })),
  );
  const progress = mergeProgressItems(
    [],
    ensureArray(meta.progress).map((item) => compactMediaAuditRecordForCloudSync({
      ...item,
      photoUrl: stripLocalAssetUrlSync(item?.photoUrl),
    })),
  );

  if (status) normalizedMeta.status = status;
  if (Object.keys(infoOverrides).length > 0) normalizedMeta.infoOverrides = infoOverrides;
  if (documentation.length > 0) normalizedMeta.documentation = documentation;
  if (progress.length > 0) normalizedMeta.progress = progress;
  if (meta.deleted === true) normalizedMeta.deleted = true;

  return normalizedMeta;
}

function createIncidentDomainSyncRecord(incident = {}, meta = {}, options = {}) {
  if (!incident || typeof incident !== 'object') return null;

  const incidentId = sanitizeText(
    options.incidentId || incident.id || incident.incidentId || incident.firestoreId || '',
    180,
  ).trim();
  if (!incidentId) return null;

  const compactMeta = compactIncidentMetaForDomainSync(meta);
  const infoOverrides = compactMeta.infoOverrides || {};
  const updatedAt = sanitizeText(
    options.updatedAt
      || meta.updatedAt
      || incident.updatedAt
      || incident.createdAt
      || incident.completedAt
      || '',
    80,
  ) || null;
  const status = sanitizeText(compactMeta.status || incident.status || 'open', 30) || 'open';

  return removeUndefinedFields(compactIncidentRecordForCloudSync({
    ...incident,
    ...infoOverrides,
    id: incidentId,
    incidentId,
    location: sanitizeText(incident.location || incident.name || incident.checkpointName || '', 120),
    shipName: sanitizeText(incident.shipName || options.shipName || '', 100),
    status,
    updatedAt,
    updatedBy: sanitizeText(options.updatedBy || incident.updatedBy || '', 100) || null,
    documentation: compactMeta.documentation,
    progress: compactMeta.progress,
    infoOverrides: compactMeta.infoOverrides,
    deleted: compactMeta.deleted === true ? true : undefined,
  }));
}

function extractIncidentMetaFromDomainDocument(document = {}) {
  if (!document || typeof document !== 'object') return null;

  const incidentId = sanitizeText(document.id || document.incidentId || document.firestoreId || '', 180).trim();
  if (!incidentId) return null;

  const embeddedMeta = document.incidentMeta && typeof document.incidentMeta === 'object' && !Array.isArray(document.incidentMeta)
    ? document.incidentMeta
    : {};
  const meta = compactIncidentMetaForDomainSync({
    status: document.status || embeddedMeta.status,
    infoOverrides: document.infoOverrides || embeddedMeta.infoOverrides,
    documentation: document.documentation || embeddedMeta.documentation,
    progress: document.progress || embeddedMeta.progress,
    deleted: document.deleted === true || embeddedMeta.deleted === true,
  });

  return Object.keys(meta).length > 0 ? { incidentId, meta } : null;
}

function stripIncidentDomainMetaFields(document = {}) {
  const {
    documentation: _documentation,
    progress: _progress,
    infoOverrides: _infoOverrides,
    incidentMeta: _incidentMeta,
    deleted: _deleted,
    ...incidentFields
  } = document || {};

  return incidentFields;
}

function splitIncidentDomainDocuments(documents = []) {
  return ensureArray(documents).reduce((collection, document) => {
    const incidentId = sanitizeText(document?.id || document?.incidentId || document?.firestoreId || '', 180).trim();
    if (!incidentId) return collection;

    collection.incidents.push(stripIncidentDomainMetaFields({
      ...document,
      id: incidentId,
    }));

    const extractedMeta = extractIncidentMetaFromDomainDocument({
      ...document,
      id: incidentId,
    });
    if (extractedMeta) {
      collection.incidentMeta[extractedMeta.incidentId] = extractedMeta.meta;
    }

    return collection;
  }, { incidents: [], incidentMeta: {} });
}

function compactHistoryEntryForCloudSync(entry = {}) {
  if (!entry || typeof entry !== 'object') return entry;

  return {
    ...entry,
    shipSnapshot: compactShipSnapshotForCloudSync(entry.shipSnapshot),
    weatherSnapshot: compactWeatherSnapshotForCloudSync(entry.weatherSnapshot),
  };
}

function compactSOSRecordForCloudSignal(sos = {}) {
  if (!sos || typeof sos !== 'object') return null;

  return {
    id: sanitizeText(sos.id || '', 120) || null,
    senderUserId: sanitizeText(sos.senderUserId || '', 120) || null,
    senderName: sanitizeText(sos.senderName || '', 80) || '',
    senderRole: sanitizeText(sos.senderRole || '', 40) || '',
    shipName: sanitizeText(sos.shipName || '', 80) || '',
    lat: normalizeSnapshotCoordinate(sos.lat),
    lng: normalizeSnapshotCoordinate(sos.lng),
    triggeredAt: typeof sos.triggeredAt === 'string' ? sos.triggeredAt : null,
    createdAt: typeof sos.createdAt === 'string' ? sos.createdAt : null,
    updatedAt: typeof sos.updatedAt === 'string' ? sos.updatedAt : null,
    senderAcknowledgedAt: typeof sos.senderAcknowledgedAt === 'string' ? sos.senderAcknowledgedAt : null,
    senderAcknowledgedBy: sanitizeText(sos.senderAcknowledgedBy || '', 120) || null,
    resolvedAt: typeof sos.resolvedAt === 'string' ? sos.resolvedAt : null,
    resolvedBy: sanitizeText(sos.resolvedBy || '', 80) || '',
    status: sanitizeText(sos.status || '', 20) || 'active',
    confirmedBy: mergeSOSRecordArrays(sos.confirmedBy),
    targetUserIds: mergeSOSRecordArrays(sos.targetUserIds),
    targetShipIds: mergeSOSRecordArrays(sos.targetShipIds),
    targetShipNames: mergeSOSRecordArrays(sos.targetShipNames),
    ...compactTimeAuditFieldsForCloudSync(sos),
  };
}

function createCloudSyncSignalPayload(options = {}) {
  const clientUpdatedAt = Number.isFinite(options.clientUpdatedAt)
    ? options.clientUpdatedAt
    : Date.now();
  const reason = sanitizeText(options.reason || 'state-sync', 60) || 'state-sync';
  const priority = sanitizeText(options.priority || 'normal', 20) || 'normal';
  const actorUserId = sanitizeText(options.actorUserId || '', 120) || '';
  const shipName = sanitizeText(options.shipName || '', 80) || '';
  const instanceId = sanitizeText(options.instanceId || '', 120) || '';

  return {
    revision: `${reason}-${clientUpdatedAt}-${Math.random().toString(36).slice(2, 8)}`,
    reason,
    priority,
    clientUpdatedAt,
    actorUserId,
    shipName,
    instanceId,
    activeSOSAlert: compactSOSRecordForCloudSignal(options.activeSOSAlert),
  };
}

async function pickLocalImage(options = {}) {
  const { cameraOnly = false, cameraFacing = 'environment' } = options;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.multiple = false;
  input.tabIndex = -1;
  input.setAttribute('aria-hidden', 'true');
  input.style.position = 'fixed';
  input.style.left = '-9999px';
  input.style.width = '1px';
  input.style.height = '1px';
  input.style.opacity = '0';
  input.style.pointerEvents = 'none';
  if (cameraOnly) {
    input.capture = cameraFacing;
    input.setAttribute('capture', cameraFacing);
  }

  return new Promise((resolve) => {
    const cleanup = () => {
      input.onchange = null;
      input.oncancel = null;
      if (input.parentNode) {
        input.parentNode.removeChild(input);
      }
    };

    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) {
        cleanup();
        resolve(null);
        return;
      }
      try {
        const dataUrl = await readImageFileAsDataUrl(file);
        cleanup();
        resolve(dataUrl);
      } catch (error) {
        console.error(error);
        cleanup();
        resolve(null);
      }
    };
    input.oncancel = () => {
      cleanup();
      resolve(null);
    };

    document.body.appendChild(input);
    input.click();
  });
}

async function pickLocalFile(accept = '.pdf,.doc,.docx,.xls,.xlsx,image/*') {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = accept;
  input.multiple = false;
  input.tabIndex = -1;
  input.setAttribute('aria-hidden', 'true');
  input.style.position = 'fixed';
  input.style.left = '-9999px';
  input.style.width = '1px';
  input.style.height = '1px';
  input.style.opacity = '0';
  input.style.pointerEvents = 'none';
  return new Promise((resolve) => {
    const cleanup = () => {
      input.onchange = null;
      input.oncancel = null;
      if (input.parentNode) {
        input.parentNode.removeChild(input);
      }
    };

    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) {
        cleanup();
        resolve(null);
        return;
      }
      try {
        const dataUrl = await readFileAsDataUrl(file);
        cleanup();
        resolve({
          dataUrl,
          name: file.name,
          type: file.type,
        });
      } catch (error) {
        console.error(error);
        cleanup();
        resolve(null);
      }
    };
    input.oncancel = () => {
      cleanup();
      resolve(null);
    };

    document.body.appendChild(input);
    input.click();
  });
}

function createSeedHistoryEntries() {
  const ship = getInitialShipsData()[0];
  const firstShiftCheckpoints = createShipCheckpointCollection(ship).map(checkpoint => ({ ...checkpoint }));
  const secondShiftCheckpoints = createShipCheckpointCollection(ship).map(checkpoint => ({ ...checkpoint }));

  if (firstShiftCheckpoints[0]) {
    firstShiftCheckpoints[0] = {
      ...firstShiftCheckpoints[0],
      status: 'completed',
      completedBy: 'Cipto Mangunkusumo',
      completedByUserId: 'u3',
      time: '08:15',
      shipName: ship.name,
      photoUrl: createPosterDataUrl('CUACA', 'Kondisi aman', 0, false),
      resultType: 'aman',
      kejadian: 'Visibilitas baik dan gelombang stabil.',
      penyebab: '',
      tindakLanjut: 'Lanjut patroli rutin.',
    };
  }

  if (firstShiftCheckpoints[1]) {
    firstShiftCheckpoints[1] = {
      ...firstShiftCheckpoints[1],
      status: 'completed',
      completedBy: 'Sertu Agus',
      completedByUserId: 'u2',
      time: '08:40',
      shipName: ship.name,
      photoUrl: createPosterDataUrl('MESIN', 'Perlu tindak lanjut', 4, false),
      resultType: 'temuan',
      kejadian: 'Suhu generator naik di atas ambang normal.',
      penyebab: 'Sirkulasi udara ruang mesin terhambat.',
      tindakLanjut: 'Lapor Chief Engineer dan buka ventilasi tambahan.',
    };
  }

  if (secondShiftCheckpoints[1]) {
    secondShiftCheckpoints[1] = {
      ...secondShiftCheckpoints[1],
      status: 'completed',
      completedBy: 'Cipto Mangunkusumo',
      completedByUserId: 'u3',
      time: '05:10',
      shipName: ship.name,
      photoUrl: createPosterDataUrl('MESIN', 'Inspeksi selesai', 0, false),
      resultType: 'aman',
      kejadian: 'Ruang mesin aman dan peralatan beroperasi normal.',
      penyebab: '',
      tindakLanjut: 'Lanjut patroli rutin.',
    };
  }

  return sortHistoryEntries([
    buildHistoryEntry({
      shiftMeta: shiftMetaFromParts('2026-04-02', 'shift-1-active'),
      checkpoints: firstShiftCheckpoints,
      ship,
      users: getMockUsersList(),
      weatherInfo: { temperature: 30, windspeed: 12, weathercode: 1 },
    }),
    buildHistoryEntry({
      shiftMeta: shiftMetaFromParts('2026-04-01', 'shift-3-active'),
      checkpoints: secondShiftCheckpoints,
      ship,
      users: getMockUsersList(),
      weatherInfo: { temperature: 28, windspeed: 9, weathercode: 3 },
    }),
  ]);
}

const persistedState = loadPersistedState();

// --- CONTEXT ---
const AppContext = createContext(null);
const UIContext = createContext(null);
const AuthContext = createContext(null);
const RoleContext = createContext(null);
const PatrolContext = createContext(null);
const ShipContext = createContext(null);
const IncidentContext = createContext(null);
const UserManagementContext = createContext(null);
const ReportContext = createContext(null);
const WeatherContext = createContext(null);
const HistoryContext = createContext(null);
const NotificationContext = createContext(null);
const SOSContext = createContext(null);

function useRequiredContext(context, name) {
  const value = useContext(context);
  if (value === null) {
    throw new Error(`${name} must be used within AppProvider`);
  }
  return value;
}

export const useApp = () => useRequiredContext(AppContext, 'useApp');
export const useUI = () => useRequiredContext(UIContext, 'useUI');
export const useAuth = () => useRequiredContext(AuthContext, 'useAuth');
export const useRole = () => useRequiredContext(RoleContext, 'useRole');
export const usePatrol = () => useRequiredContext(PatrolContext, 'usePatrol');
export const useShips = () => useRequiredContext(ShipContext, 'useShips');
export const useIncidents = () => useRequiredContext(IncidentContext, 'useIncidents');
export const useUsers = () => useRequiredContext(UserManagementContext, 'useUsers');
export const useReports = () => useRequiredContext(ReportContext, 'useReports');
export const useWeather = () => useRequiredContext(WeatherContext, 'useWeather');
export const useHistory = () => useRequiredContext(HistoryContext, 'useHistory');
export const useNotifications = () => useRequiredContext(NotificationContext, 'useNotifications');
export const useSOS = () => useRequiredContext(SOSContext, 'useSOS');
export { ACCESS_ROLES, defaultLocationOptions, SHIP_STATUS_OPTIONS };

export function AppProvider({ children }) {
  const initialCurrentShiftMeta = getShiftMeta(getTrustedDate());
  const initialShipsRawCollection = normalizeShipsCollection(persistedState?.shipsData || getInitialShipsData());
  const initialUserDedupeState = deduplicateUsersByOperationalIdentity(
    normalizeUsersCollection(persistedState?.usersData || getMockUsersList()),
    { ships: initialShipsRawCollection },
  );
  const initialShipsCollection = remapShipPersonnelUserIds(
    initialShipsRawCollection,
    initialUserDedupeState.userIdMap,
  );
  const initialUsersCollection = reconcileUserShipAssignments(
    initialUserDedupeState.users,
    initialShipsCollection,
  );
  const initialRawCheckpointsByShip = createCheckpointsByShipState(
    initialShipsCollection,
    persistedState?.checkpointsByShip,
    persistedState?.checkpoints,
    null,
  );
  const initialShiftState = migrateCheckpointStateToCurrentShift({
    ships: initialShipsCollection,
    checkpointsByShip: initialRawCheckpointsByShip,
    historyEntries: sortHistoryEntries(persistedState?.historyEntries || createSeedHistoryEntries()),
    shiftStatusRecords: persistedState?.shiftStatusRecords || {},
    users: initialUsersCollection,
    currentShiftMeta: initialCurrentShiftMeta,
  });

  // Theme & connectivity
  const [currentPage, setCurrentPage] = useState('home');
  const [theme, setTheme] = useState(() => persistedState?.theme || 'dark');
  const [isOffline, setIsOffline] = useState(() => !isNavigatorOnline());
  const [showSettingsDropdown, setShowSettingsDropdown] = useState(false);
  const [showNotificationsDropdown, setShowNotificationsDropdown] = useState(false);
  const [notificationReturnPage, setNotificationReturnPage] = useState('home');
  const [confirmDialog, setConfirmDialog] = useState(null);

  useEffect(() => {
    const handleOnline = () => setIsOffline(false);
    const handleOffline = () => setIsOffline(true);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    let cancelled = false;
    let removeNativeListener = null;

    getNativeNetworkStatus()
      .then((status) => {
        if (!cancelled && status) setIsOffline(!status.connected);
      })
      .catch((error) => {
        console.warn('Status network native tidak bisa dibaca', error);
      });

    addNativeNetworkStatusListener((status) => {
      setIsOffline(!status.connected);
    })
      .then((removeListener) => {
        if (cancelled) {
          removeListener?.();
          return;
        }
        removeNativeListener = removeListener;
      })
      .catch((error) => {
        console.warn('Listener network native gagal dipasang', error);
      });

    return () => {
      cancelled = true;
      removeNativeListener?.();
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  useEffect(() => initializeTrustedTime(), []);

  useEffect(() => {
    if (theme === 'light') {
      document.documentElement.classList.add('pertamina-light');
    } else {
      document.documentElement.classList.remove('pertamina-light');
    }
  }, [theme]);

  // Auth
  const [sessionUserId, setSessionUserId] = useState(() => loadAuthSession());
  const [firebaseAuthUser, setFirebaseAuthUser] = useState(null);
  const firebaseAuthUserRef = useRef(null);
  const [firebaseAuthReady, setFirebaseAuthReady] = useState(() => !isFirebaseAuthEnabled);
  const [authAccessState, setAuthAccessState] = useState(null);
  const [authAccessBusy, setAuthAccessBusy] = useState(false);
  const [authMode, setAuthMode] = useState('login');
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState('');
  const [authNotice, setAuthNotice] = useState('');
  const [authForm, setAuthForm] = useState(() => createAuthFormState());

  // Core data
  const [activeShiftKey, setActiveShiftKey] = useState(() => initialShiftState.activeShiftKey);
  const [checkpointsByShip, setCheckpointsByShip] = useState(() => initialShiftState.checkpointsByShip);
  const [shipsData, setShipsData] = useState(() => initialShipsCollection);
  const [usersData, setUsersData] = useState(() => initialUsersCollection);
  const [incidentsData, setIncidentsData] = useState(() => persistedState?.incidentsData || []);
  const [historyEntries, setHistoryEntries] = useState(() => initialShiftState.historyEntries);
  const [shiftStatusRecords, setShiftStatusRecords] = useState(() => initialShiftState.shiftStatusRecords || {});
  const [notifications, setNotifications] = useState(() => sortNotifications(persistedState?.notifications || []));
  const [selectedHistoryId, setSelectedHistoryId] = useState(null);
  // Pakai getTrustedDate().getTime() bukan getTrustedNowMs() langsung — di Android
  // cold start, getTrustedNowMs() return null sebelum anchor server sync, dan
  // new Date(null) === new Date(0) === 1970-01-01 → currentShiftMeta jadi shift
  // di 1970 → lookup record selalu miss → badge "STATUS SHIFT WAJIB DIISI" terus
  // muncul. getTrustedDate() sudah handle fallback ke device time, jadi selalu
  // return Date valid dan .getTime() selalu finite.
  const [shiftClock, setShiftClock] = useState(() => getTrustedDate().getTime());
  const [activeSOSAlert, setActiveSOSAlert] = useState(() => persistedState?.activeSOSAlert || null);
  const [sosHistory, setSosHistory] = useState(() => persistedState?.sosHistory || []);
  const [pendingRegistrations, setPendingRegistrations] = useState([]);
  const hasAppliedRoleLandingRef = useRef(false);
  const publicRegistrationFlowRef = useRef(false);
  // Tracking deterministik: UID Supabase yang sudah selesai di-resolve accessnya.
  // String kosong = belum settle; string UID = sudah selesai.
  const [authAccessResolvedUid, setAuthAccessResolvedUid] = useState('');
  // Fallback offline: UID yang masih boleh akses lokal walau callable gagal.
  const [authAccessOfflineUid, setAuthAccessOfflineUid] = useState('');
  // Pemicu re-resolve akses. Dinaikkan saat resolusi gagal jaringan & koneksi pulih,
  // agar authAccessState (sumber shipAssigned/status) sembuh sendiri tanpa refresh manual.
  const [authAccessResolveNonce, setAuthAccessResolveNonce] = useState(0);
  const authAccessRetryRef = useRef({ attempts: 0, timer: null });

  // Crew migration effect
  useEffect(() => {
    if (shipsData.length === 0) return;
    const todayStr = getTrustedDate().toISOString().split('T')[0];
    let shipsChanged = false;
    let usersToUpdate = [];
    const updatedShips = shipsData.map(ship => {
      let newPersonnel = [...(ship.personnel || [])];
      let newNextMonth = [...(ship.personnelNextMonth || [])];
      let newSchedules = { ...(ship.personnelSchedules || {}) };
      let shipModified = false;

      newNextMonth.forEach(uId => {
        const schedule = newSchedules[uId];
        if (schedule && schedule.startDate && schedule.startDate <= todayStr) {
          if (!newPersonnel.includes(uId)) newPersonnel.push(uId);
          newNextMonth = newNextMonth.filter(id => id !== uId);
          usersToUpdate.push({ userId: uId, shipAssigned: ship.name, status: 'active' });
          shipModified = true; shipsChanged = true;
        }
      });

      [...newPersonnel].forEach(uId => {
        const schedule = newSchedules[uId];
        if (schedule && schedule.startDate && schedule.startDate > todayStr) {
          if (!newNextMonth.includes(uId)) newNextMonth.push(uId);
          newPersonnel = newPersonnel.filter(id => id !== uId);
          usersToUpdate.push({ userId: uId, shipAssigned: null, status: 'off-duty' });
          shipModified = true; shipsChanged = true;
        }
      });

      if (shipModified) return { ...ship, personnel: newPersonnel, personnelNextMonth: newNextMonth, personnelSchedules: newSchedules };
      return ship;
    });
    if (shipsChanged) {
      setShipsData(updatedShips);
      setUsersData(prev => prev.map(u => {
        const update = usersToUpdate.find(x => x.userId === u.id);
        if (update) return { ...u, shipAssigned: update.shipAssigned, status: update.status };
        return u;
      }));
    }
  }, []);

  // Reconciliation guard untuk data cloud yang nyangkut: petugas dengan shipAssigned ke kapal yang
  // tidak lagi memuat mereka di personnel. mergeSharedStateSnapshots sudah membersihkan, tapi
  // effect ini berjaga untuk path mutasi lokal lain (mis. setShipsData via handler langsung).
  useEffect(() => {
    if (shipsData.length === 0 || usersData.length === 0) return;
    const dedupedUserState = deduplicateUsersByOperationalIdentity(usersData, {
      ships: shipsData,
    });
    const remappedShips = remapShipPersonnelUserIds(shipsData, dedupedUserState.userIdMap);
    const reconciled = reconcileUserShipAssignments(dedupedUserState.users, remappedShips);
    if (remappedShips !== shipsData) {
      setShipsData(remappedShips);
    }
    if (!dedupedUserState.changed && reconciled === dedupedUserState.users) return;
    setUsersData(reconciled);
  }, [shipsData, usersData]);

  // UI states
  const [activeForms, setActiveForms] = useState({});
  const [pendingPatrolCameraCapture, setPendingPatrolCameraCapture] = useState(null);
  const [previewPhoto, setPreviewPhoto] = useState(null);
  const [selectedReportDetail, setSelectedReportDetail] = useState(null);
  const [newCustomNode, setNewCustomNode] = useState('');
  const [showIncidentModal, setShowIncidentModal] = useState(false);
  const [incidentForm, setIncidentForm] = useState(() => createIncidentFormState());
  const [activeShipId, setActiveShipId] = useState(null);
  const [shipDetailTab, setShipDetailTab] = useState('info');
  const [scheduleMonth, setScheduleMonth] = useState('current');
  const [showAssignPopup, setShowAssignPopup] = useState(false);
  const [assignPopupData, setAssignPopupData] = useState(null);
  const [isEditingShipInfo, setIsEditingShipInfo] = useState(false);
  const [editShipInfoData, setEditShipInfoData] = useState({});
  const [showShipForm, setShowShipForm] = useState(false);
  const [shipFormData, setShipFormData] = useState(() => createShipFormState());
  const [newCheckpoint, setNewCheckpoint] = useState('');
  const [newShipCp, setNewShipCp] = useState({ name: '', desc: '' });
  const [showShipDocForm, setShowShipDocForm] = useState(false);
  const [newShipDoc, setNewShipDoc] = useState(() => createShipDocumentState());
  const [weatherInfo, setWeatherInfo] = useState(() => loadWeatherCache());
  const [weatherLoading, setWeatherLoading] = useState(() => !loadWeatherCache());
  const [submittingPatrolId, setSubmittingPatrolId] = useState(null);
  const [selectedIncident, setSelectedIncident] = useState(null);
  const [incidentMeta, setIncidentMeta] = useState(() => persistedState?.incidentMeta || {});
  const [deletedRecords, setDeletedRecords] = useState(() => createDeletedRecordsState(persistedState?.deletedRecords));
  const [newProgress, setNewProgress] = useState({ comment: '', photoUrl: null });
  const [showUserForm, setShowUserForm] = useState(false);
  const [userFormData, setUserFormData] = useState(() => createUserFormState());
  const [userFormError, setUserFormError] = useState('');
  const [userFormNotice, setUserFormNotice] = useState('');
  const [selectedUser, setSelectedUser] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [patrolTab, setPatrolTab] = useState('checkpoint');
  const [showShiftStatusModal, setShowShiftStatusModal] = useState(false);
  const [cloudSyncBootstrapped, setCloudSyncBootstrapped] = useState(() => !isCloudSyncEnabled);
  const appInstanceIdRef = useRef(`cloud-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const previousUsersDataRef = useRef(usersData);
  const lastSharedStateRef = useRef('');
  const lastCloudSharedStateRef = useRef('');
  const latestCloudSharedStateRef = useRef(null);
  const lastCloudClientUpdatedAtRef = useRef(0);
  const lastCloudSignalRevisionRef = useRef('');
  const cloudAssetCacheRef = useRef(new Map());
  const cloudAssetUploadInFlightRef = useRef(new Map());
  const localAssetAvailabilityRef = useRef(new Map());
  const previousOfflineStateRef = useRef(isOffline);
  const isOfflineRef = useRef(isOffline);
  const cloudSyncPriorityRef = useRef('normal');
  const cloudSyncPriorityVersionRef = useRef(0);
  const cloudSaveQueueRef = useRef(Promise.resolve());
  const cloudFetchInFlightRef = useRef(false);
  const cloudSignalRefreshTimerRef = useRef(null);
  const patrolReportDomainWriteCacheRef = useRef(new Map());
  const patrolReportDomainUploadInFlightRef = useRef(new Set());
  const patrolReportLocalMediaRef = useRef(new Map());
  const incidentDomainUploadInFlightRef = useRef(new Set());
  const pendingShiftStatusRecordsRef = useRef(new Map());
  const localSharedStateRef = useRef(null);
  const activeSOSAlertRef = useRef(activeSOSAlert);
  const sosHistoryRef = useRef(sosHistory);
  const [cloudSyncKick, setCloudSyncKick] = useState(0);
  const requestCloudSync = useCallback((priority = 'normal') => {
    if (priority === 'urgent') {
      cloudSyncPriorityRef.current = 'urgent';
      cloudSyncPriorityVersionRef.current += 1;
    }

    setCloudSyncKick((previousValue) => previousValue + 1);
  }, []);
  const showTrustedTimeGateDialog = useCallback(() => {
    const gateMessage = checkAndroidTrustedTimeGate();
    if (!gateMessage) return false;

    setConfirmDialog({
      title: 'Waktu Belum Terverifikasi',
      message: gateMessage,
      confirmText: 'MENGERTI',
      isAlert: true,
      onConfirm: () => { },
    });
    return true;
  }, []);

  // SOS Hooks moved to resolve TDZ

  // Computed values
  const deferredSearchQuery = useDeferredValue(searchQuery);
  // Phase 5.1: Stabilize currentShiftMeta to prevent cascading global re-renders
  const rawShiftMeta = getShiftMeta(new Date(shiftClock));
  const currentShiftMetaRef = useRef(rawShiftMeta);
  if (currentShiftMetaRef.current.key !== rawShiftMeta.key) {
    currentShiftMetaRef.current = rawShiftMeta;
  }
  const currentShiftMeta = currentShiftMetaRef.current;
  const currentShiftSchedule = useMemo(() => getShiftScheduleTimes(currentShiftMeta), [currentShiftMeta]);
  const sessionUserRecord = useMemo(() => usersData.find(user => user.id === sessionUserId) || null, [usersData, sessionUserId]);
  const firebaseAuthEmail = sanitizeEmail(firebaseAuthUser?.email || '');
  const firebaseAuthUid = sanitizeText(firebaseAuthUser?.uid || '', 160) || '';
  const authAccessStatus = sanitizeText(authAccessState?.status || '', 20).toLowerCase() || 'anonymous';
  const authAccessEnabled = Boolean(authAccessState?.access?.enabled);
  const currentUserRecord = useMemo(() => {
    if (isFirebaseAuthEnabled) {
      if (!firebaseAuthReady) return null;
      const offlineSessionUser = isOffline && sessionUserId && sessionUserRecord
        ? sessionUserRecord
        : null;
      if (!firebaseAuthUser || !firebaseAuthEmail) return offlineSessionUser;
      const isOfflineAccessFallback = Boolean(
        isOffline
        && sessionUserId
        && authAccessOfflineUid
        && authAccessOfflineUid === firebaseAuthUid,
      );
      if (!authAccessEnabled && !isOfflineAccessFallback) {
        // Hanya kolapskan ke null bila server SUDAH menjawab definitif untuk UID ini
        // (akses memang nonaktif). Bila resolusi sedang gagal jaringan / menunggu retry
        // (belum definitif), pertahankan record terakhir yang diketahui agar
        // operationalShip & checkpoint tidak hilang saat koneksi baru pulih.
        const isAccessResolutionDefinitive = authAccessResolvedUid === firebaseAuthUid;
        if (isAccessResolutionDefinitive) return offlineSessionUser;
        return resolvePreferredUserRecord(usersData, {
          sessionUserId,
          firebaseAuthEmail,
          firebaseAuthUid,
        }) || sessionUserRecord || offlineSessionUser;
      }

      const matchedUser = resolvePreferredUserRecord(usersData, {
        sessionUserId,
        firebaseAuthEmail,
        firebaseAuthUid,
      }) || sessionUserRecord || null;

      if (!authAccessState?.access) return matchedUser;

      return buildOperationalUserRecordFromAccess({
        access: authAccessState.access,
        profile: authAccessState.profile,
        authUser: firebaseAuthUser,
        existingUser: matchedUser,
        users: usersData,
      });
    }
    return resolvePreferredUserRecord(usersData, {
      sessionUserId,
      firebaseAuthUid: sessionUserRecord?.firebaseUid || '',
      firebaseAuthEmail: sessionUserRecord?.email || '',
    }) || sessionUserRecord;
  }, [authAccessEnabled, authAccessOfflineUid, authAccessResolvedUid, authAccessState, firebaseAuthEmail, firebaseAuthReady, firebaseAuthUid, firebaseAuthUser, isOffline, sessionUserId, sessionUserRecord, usersData]);
  const effectiveSessionUser = isFirebaseAuthEnabled
    ? currentUserRecord
    : (currentUserRecord || sessionUserRecord || null);
  const currentUser = effectiveSessionUser?.name || '';
  const currentUserRole = effectiveSessionUser?.role || ACCESS_ROLES.PETUGAS;
  const nativePushProfile = useMemo(() => {
    if (!currentUserRecord || !firebaseAuthUid) return null;
    return {
      legacyUserId: currentUserRecord.id || '',
      role: currentUserRecord.role || '',
      shipAssigned: currentUserRecord.shipAssigned || '',
      displayName: currentUserRecord.name || currentUser || '',
    };
  }, [
    currentUser,
    currentUserRecord?.id,
    currentUserRecord?.name,
    currentUserRecord?.role,
    currentUserRecord?.shipAssigned,
    firebaseAuthUid,
  ]);
  const isAdmin = currentUserRole === ACCESS_ROLES.ADMIN;
  const isPic = currentUserRole === ACCESS_ROLES.PIC;
  const isPetugas = currentUserRole === ACCESS_ROLES.PETUGAS;
  const currentUserId = effectiveSessionUser?.id || null;
  const hasOperationalCloudAccess = useMemo(() => {
    if (!isCloudSyncEnabled) return true;
    if (!isFirebaseAuthEnabled) return Boolean(sessionUserId);
    return Boolean(
      (firebaseAuthUser && authAccessEnabled)
      || (firebaseAuthUser && authAccessOfflineUid === firebaseAuthUid && sessionUserId)
      || (isOffline && sessionUserId && sessionUserRecord)
    );
  }, [authAccessEnabled, authAccessOfflineUid, firebaseAuthUid, firebaseAuthUser, isOffline, sessionUserId, sessionUserRecord]);
  const emitCloudSyncSignal = useCallback((options = {}) => {
    if (!isCloudSyncEnabled || !isCloudWriteEnabled || !hasOperationalCloudAccess || isOffline) {
      return Promise.resolve(null);
    }

    const signalPayload = createCloudSyncSignalPayload({
      ...options,
      actorUserId: options.actorUserId || currentUserId || '',
      instanceId: appInstanceIdRef.current,
    });

    return publishCloudSyncSignal(signalPayload)
      .catch((error) => {
        console.warn('Gagal memancarkan sinyal sinkronisasi cloud', error);
        return null;
      });
  }, [currentUserId, hasOperationalCloudAccess, isOffline]);
  const getSOSRecipientUserIds = useCallback((shipName) => {
    const safeShipName = sanitizeText(shipName || '', 80);
    if (!safeShipName) return [];

    const sourceShip = shipsData.find((ship) => ship.name === safeShipName) || null;
    const recipientShipNames = new Set([safeShipName]);

    (sourceShip?.sosRecipientShipIds || []).forEach((shipId) => {
      const linkedShip = shipsData.find((ship) => ship.id === shipId);
      if (linkedShip?.name) recipientShipNames.add(linkedShip.name);
    });

    return Array.from(new Set(
      usersData
        .filter((user) => {
          if (user.role === ACCESS_ROLES.ADMIN || user.role === ACCESS_ROLES.PIC) return true;
          if (!recipientShipNames.has(user.shipAssigned)) return false;
          if (user.role === ACCESS_ROLES.PETUGAS) return user.status === 'active';
          return false;
        })
        .map((user) => user.id)
        .filter(Boolean),
    ));
  }, [shipsData, usersData]);

  useEffect(() => {
    const landingUser = effectiveSessionUser;

    if (!landingUser) {
      hasAppliedRoleLandingRef.current = false;
      return;
    }

    if (hasAppliedRoleLandingRef.current) return;

    const landingPage = getDefaultPageForRole(landingUser.role);
    setCurrentPage(landingPage);
    setNotificationReturnPage(landingPage);
    hasAppliedRoleLandingRef.current = true;
  }, [effectiveSessionUser]);

  const handleSOSTrigger = useCallback((lat, lng) => {
    if (!currentUserRecord) return;
    if (showTrustedTimeGateDialog()) return;
    const trustedTimestamp = createTrustedTimestampRecord();
    const eventTimestampIso = trustedTimestamp.occurredAtTrustedIso;
    const senderShipName = sanitizeText(currentUserRecord.shipAssigned || '', 80) || 'Tidak diketahui';
    const sourceShip = shipsData.find((ship) => ship.name === senderShipName) || null;
    const targetShipIds = Array.from(new Set([
      sourceShip?.id || null,
      ...((sourceShip?.sosRecipientShipIds || []).filter(Boolean)),
    ].filter(Boolean)));
    const targetShipNames = targetShipIds
      .map((shipId) => shipsData.find((ship) => ship.id === shipId)?.name || '')
      .filter(Boolean);
    const targetUserIds = getSOSRecipientUserIds(senderShipName)
      .filter((userId) => userId !== currentUserRecord.id);
    const rawSOS = {
      id: `sos-${trustedTimestamp.occurredAtTrustedMs}-${Math.random().toString(36).slice(2, 8)}`,
      senderUserId: currentUserRecord.id || 'unknown',
      senderName: currentUserRecord.name || 'Unknown',
      senderRole: currentUserRecord.role || 'petugas',
      shipName: senderShipName,
      lat: lat !== undefined ? lat : null,
      lng: lng !== undefined ? lng : null,
      triggeredAt: eventTimestampIso,
      createdAt: eventTimestampIso,
      updatedAt: eventTimestampIso,
      targetUserIds,
      targetShipIds,
      targetShipNames,
      confirmedBy: [],
      status: 'active',
      ...trustedTimestamp,
    };

    // Default broad notification implementation
    const rawNotif = {
      id: `notif-sos-${trustedTimestamp.occurredAtTrustedMs}-${Math.random().toString(36).slice(2, 6)}`,
      type: 'sos',
      title: '🚨 DARURAT SOS',
      message: `Tanda darurat dikirim oleh ${currentUserRecord.name || 'Seseorang'} dari ${senderShipName}.`,
      senderName: currentUserRecord.name || 'Unknown',
      senderRole: currentUserRecord.role || 'petugas',
      targetUserIds,
      readByUserIds: [],
      route: 'incidents/detail',
      routeParams: { incidentId: rawSOS.id },
      incidentId: rawSOS.id,
      shipName: senderShipName,
      createdAt: eventTimestampIso,
      timeTrustLevel: trustedTimestamp.timeTrustLevel,
      clockTamperDetected: trustedTimestamp.clockTamperDetected,
    };

    // Spread is sufficient — SOS and notification objects are flat (no nested Date/Map/circular refs)
    const newSOS = { ...rawSOS };
    const notification = { ...rawNotif };
    const nextSOSIncident = createSOSIncidentRecord(newSOS);

    setActiveSOSAlert(newSOS);
    setSosHistory((previousHistory) => upsertSOSHistoryEntry(previousHistory, newSOS));
    setNotifications(prev => [notification, ...prev]);
    setSelectedHistoryId(null);
    setSelectedReportDetail(null);
    setShowIncidentModal(false);
    setCurrentPage('incidents');
    if (nextSOSIncident) {
      setSelectedIncident(nextSOSIncident);
    }
    void emitCloudSyncSignal({
      reason: 'sos-active',
      priority: 'urgent',
      clientUpdatedAt: Date.now(),
      activeSOSAlert: newSOS,
      shipName: senderShipName,
    });
    requestCloudSync('urgent');
  }, [currentUserRecord, emitCloudSyncSignal, getSOSRecipientUserIds, requestCloudSync, shipsData, showTrustedTimeGateDialog]);

  const resolveSOSActionTarget = useCallback((targetSOS = null) => {
    const targetId = typeof targetSOS === 'string'
      ? targetSOS
      : targetSOS?.id || activeSOSAlert?.id || null;

    if (!targetId) return null;
    if (activeSOSAlert?.id === targetId) return activeSOSAlert;
    return sosHistory.find((entry) => entry.id === targetId) || (typeof targetSOS === 'object' ? targetSOS : null);
  }, [activeSOSAlert, sosHistory]);

  const handleSOSConfirm = useCallback((targetSOS = null) => {
    const actionableSOS = resolveSOSActionTarget(targetSOS);
    if (!actionableSOS || !currentUserId) return;
    if (Array.isArray(actionableSOS.targetUserIds) && !actionableSOS.targetUserIds.includes(currentUserId)) return;
    if (showTrustedTimeGateDialog()) return;

    const trustedTimestamp = createTrustedTimestampRecord();
    const updatedSOS = {
      ...actionableSOS,
      confirmedBy: [...new Set([...(actionableSOS.confirmedBy || []), currentUserId])],
      updatedAt: trustedTimestamp.occurredAtTrustedIso,
      updatedAtClientMs: trustedTimestamp.occurredAtClientMs,
      updatedTimeTrustLevel: trustedTimestamp.timeTrustLevel,
      updatedClockTamperDetected: trustedTimestamp.clockTamperDetected,
    };

    setActiveSOSAlert((previousAlert) => (
      previousAlert?.id === updatedSOS.id ? updatedSOS : previousAlert
    ));
    setSosHistory((previousHistory) => upsertSOSHistoryEntry(previousHistory, updatedSOS));
    void emitCloudSyncSignal({
      reason: 'sos-confirmed',
      priority: 'urgent',
      clientUpdatedAt: Date.now(),
      activeSOSAlert: updatedSOS,
      shipName: updatedSOS.shipName,
    });
    requestCloudSync('urgent');
  }, [currentUserId, emitCloudSyncSignal, requestCloudSync, resolveSOSActionTarget, showTrustedTimeGateDialog]);

  const handleSOSAcknowledgeSelf = useCallback((targetSOS = null) => {
    const actionableSOS = resolveSOSActionTarget(targetSOS);
    if (!actionableSOS || !currentUserId) return;
    if (actionableSOS.senderUserId !== currentUserId) return;
    if (showTrustedTimeGateDialog()) return;

    const trustedTimestamp = createTrustedTimestampRecord();
    const updatedSOS = {
      ...actionableSOS,
      senderAcknowledgedAt: trustedTimestamp.occurredAtTrustedIso,
      senderAcknowledgedBy: currentUserId,
      senderAcknowledgedAtClientMs: trustedTimestamp.occurredAtClientMs,
      senderAcknowledgedTimeTrustLevel: trustedTimestamp.timeTrustLevel,
      senderAcknowledgedClockTamperDetected: trustedTimestamp.clockTamperDetected,
      updatedAt: trustedTimestamp.occurredAtTrustedIso,
      updatedAtClientMs: trustedTimestamp.occurredAtClientMs,
      updatedTimeTrustLevel: trustedTimestamp.timeTrustLevel,
      updatedClockTamperDetected: trustedTimestamp.clockTamperDetected,
    };

    setActiveSOSAlert((previousAlert) => (
      previousAlert?.id === updatedSOS.id ? updatedSOS : previousAlert
    ));
    setSosHistory((previousHistory) => upsertSOSHistoryEntry(previousHistory, updatedSOS));
    void emitCloudSyncSignal({
      reason: 'sos-acknowledged',
      priority: 'urgent',
      clientUpdatedAt: Date.now(),
      activeSOSAlert: updatedSOS,
      shipName: updatedSOS.shipName,
    });
    requestCloudSync('urgent');
  }, [currentUserId, emitCloudSyncSignal, requestCloudSync, resolveSOSActionTarget, showTrustedTimeGateDialog]);

  const handleSOSDismiss = useCallback((targetSOS = null) => {
    const actionableSOS = resolveSOSActionTarget(targetSOS);
    if (!actionableSOS) return;
    if (showTrustedTimeGateDialog()) return;
    const trustedTimestamp = createTrustedTimestampRecord();

    const updatedSOS = {
      ...actionableSOS,
      status: 'resolved',
      resolvedAt: trustedTimestamp.occurredAtTrustedIso,
      resolvedBy: currentUserRecord?.name || 'Sistem',
      resolvedAtClientMs: trustedTimestamp.occurredAtClientMs,
      resolvedTimeTrustLevel: trustedTimestamp.timeTrustLevel,
      resolvedClockTamperDetected: trustedTimestamp.clockTamperDetected,
      updatedAt: trustedTimestamp.occurredAtTrustedIso,
      updatedAtClientMs: trustedTimestamp.occurredAtClientMs,
      updatedTimeTrustLevel: trustedTimestamp.timeTrustLevel,
      updatedClockTamperDetected: trustedTimestamp.clockTamperDetected,
    };

    setActiveSOSAlert((previousAlert) => (
      previousAlert?.id === updatedSOS.id ? null : previousAlert
    ));
    setSosHistory((previousHistory) => upsertSOSHistoryEntry(previousHistory, updatedSOS));
    void emitCloudSyncSignal({
      reason: 'sos-resolved',
      priority: 'urgent',
      clientUpdatedAt: Date.now(),
      activeSOSAlert: updatedSOS,
      shipName: updatedSOS.shipName,
    });
    requestCloudSync('urgent');
  }, [currentUserRecord, emitCloudSyncSignal, requestCloudSync, resolveSOSActionTarget, showTrustedTimeGateDialog]);

  const assignedShipForCurrentUser = useMemo(() => {
    return resolveAssignedShipForUser(currentUserRecord, shipsData);
  }, [currentUserRecord, shipsData]);
  const isWaitingForAssignedFleetSync = useMemo(() => shouldDeferPetugasFleetValidation({
    isCloudSyncEnabled,
    cloudSyncBootstrapped,
    isOffline,
    user: currentUserRecord,
    assignedShip: assignedShipForCurrentUser,
  }), [assignedShipForCurrentUser, cloudSyncBootstrapped, currentUserRecord, isOffline]);
  const operationalShip = useMemo(() => {
    if (currentUserRecord?.role === ACCESS_ROLES.ADMIN) return null;
    if (shipsData.length === 0) return null;
    if (isPetugas) return assignedShipForCurrentUser;
    if (currentUserRecord?.shipAssigned) {
      return shipsData.find(ship => ship.name === currentUserRecord.shipAssigned) || assignedShipForCurrentUser || shipsData[0];
    }
    return assignedShipForCurrentUser || shipsData[0];
  }, [assignedShipForCurrentUser, currentUserRecord?.role, currentUserRecord?.shipAssigned, isPetugas, shipsData]);
  const operationalShipName = currentUserRecord?.role === ACCESS_ROLES.ADMIN
    ? null
    : (operationalShip?.name || (isPetugas ? null : currentUserRecord?.shipAssigned || shipsData[0]?.name || null));
  const patrolReportSubscriptionTargets = useMemo(() => {
    if (!currentUserRecord || !currentShiftMeta?.key) return [];
    if (isAdmin) {
      return ensureArray(shipsData)
        .filter(ship => ensureObject(ship) && ship.id)
        .map(ship => ({ shipId: ship.id, shipName: '' }));
    }

    const assignedShip = operationalShip || assignedShipForCurrentUser;
    return assignedShip?.id && assignedShip?.name
      ? [{ shipId: assignedShip.id, shipName: assignedShip.name }]
      : [];
  }, [assignedShipForCurrentUser, currentShiftMeta?.key, currentUserRecord, isAdmin, operationalShip, shipsData]);
  const activeOperationalGuards = useMemo(
    () => ensureArray(usersData).filter(user => (
      user.shipAssigned === operationalShipName
      && user.status === 'active'
      && user.role === ACCESS_ROLES.PETUGAS
    )),
    [operationalShipName, usersData],
  );
  const currentShiftStatusRecord = useMemo(
    () => getShiftStatusRecordForShipShift(shiftStatusRecords, operationalShip?.id, currentShiftMeta.key),
    [currentShiftMeta.key, operationalShip?.id, shiftStatusRecords],
  );
  const checkpoints = useMemo(() => {
    if (!operationalShip?.id) return [];
    return ensureArray(checkpointsByShip[operationalShip.id]).filter(checkpoint => ensureObject(checkpoint));
  }, [checkpointsByShip, operationalShip?.id]);
  const adminLiveHistoryEntries = useMemo(() => {
    if (!isAdmin || !currentUserRecord || !currentShiftMeta?.key) return [];

    return ensureArray(shipsData)
      .filter(ship => ensureObject(ship) && (ship.id || ship.name))
      .map((ship) => {
        const shipCheckpoints = ensureArray(checkpointsByShip?.[ship.id]).filter(checkpoint => ensureObject(checkpoint));
        const shipShiftStatusRecord = getShiftStatusRecordForShipShift(shiftStatusRecords, ship.id, currentShiftMeta.key);
        const liveEntry = buildLiveHistoryEntry({
          shiftMeta: currentShiftMeta,
          checkpoints: shipCheckpoints,
          ship,
          users: usersData,
          shiftStatusRecord: shipShiftStatusRecord,
        });

        if (!liveEntry) return null;

        const hasOngoingPatrol = liveEntry.crewSnapshot.length > 0
          || ensureArray(shipShiftStatusRecord?.items).length > 0
          || liveEntry.summary.completed > 0;

        return hasOngoingPatrol ? liveEntry : null;
      })
      .filter(Boolean)
      .sort((left, right) => (
        (Number(right?.summary?.completed) || 0) - (Number(left?.summary?.completed) || 0)
        || String(left?.ship || '').localeCompare(String(right?.ship || ''))
      ));
  }, [checkpointsByShip, currentShiftMeta, currentUserRecord, isAdmin, shiftStatusRecords, shipsData, usersData]);
  const visibleHistoryEntries = useMemo(() => {
    if (!currentUserRecord) return [];
    const safeHistoryEntries = ensureArray(historyEntries)
      .filter(entry => ensureObject(entry))
      .map(normalizeHistoryEntryDate);
    const safeAdminLiveHistoryEntries = ensureArray(adminLiveHistoryEntries)
      .filter(entry => ensureObject(entry))
      .map(normalizeHistoryEntryDate);
    if (isAdmin) return [...safeAdminLiveHistoryEntries, ...safeHistoryEntries];
    if (isPic) return safeHistoryEntries;
    if (!assignedShipForCurrentUser) return [];
    return safeHistoryEntries.filter(entry => (
      entry.shipSnapshot?.id === assignedShipForCurrentUser.id
      || entry.ship === assignedShipForCurrentUser.name
    ));
  }, [adminLiveHistoryEntries, assignedShipForCurrentUser, currentUserRecord, historyEntries, isAdmin, isPic]);
  const selectedHistoryEntry = useMemo(() => visibleHistoryEntries.find(entry => entry.id === selectedHistoryId) || null, [visibleHistoryEntries, selectedHistoryId]);
  const notificationRecipientIds = useMemo(() => Array.from(new Set([
    currentUserId,
    firebaseAuthUid,
  ].filter(Boolean))), [currentUserId, firebaseAuthUid]);
  const notificationReadIdentityIds = notificationRecipientIds;
  const notificationWriteIdentityId = currentUserId || firebaseAuthUid || '';
  const visibleNotifications = useMemo(() => {
    if (notificationRecipientIds.length === 0) return [];
    return ensureArray(notifications).filter((notification) => (
      ensureObject(notification)
      && Array.isArray(notification.targetUserIds)
      && notification.targetUserIds.some((targetUserId) => notificationRecipientIds.includes(targetUserId))
    ));
  }, [notificationRecipientIds, notifications]);
  const unreadNotificationCount = useMemo(() => {
    if (notificationReadIdentityIds.length === 0) return 0;
    return visibleNotifications.filter((notification) => !(
      Array.isArray(notification?.readByUserIds) ? notification.readByUserIds : []
    ).some((readIdentity) => notificationReadIdentityIds.includes(readIdentity))).length;
  }, [notificationReadIdentityIds, visibleNotifications]);
  const filteredCheckpoints = useMemo(() => {
    const safeLookup = String(deferredSearchQuery || '').toLowerCase();
    return checkpoints.filter(checkpoint => String(checkpoint?.name || '').toLowerCase().includes(safeLookup));
  }, [checkpoints, deferredSearchQuery]);
  const incidentLocationOptions = useMemo(() => {
    const checkpointDefinitions = (
      operationalShip?.customCheckpoints?.length
        ? operationalShip.customCheckpoints
        : assignedShipForCurrentUser?.customCheckpoints?.length
          ? assignedShipForCurrentUser.customCheckpoints
          : shipsData.find((ship) => Array.isArray(ship.customCheckpoints) && ship.customCheckpoints.length > 0)?.customCheckpoints || []
    );

    return Array.from(new Set(
      checkpointDefinitions
        .map((checkpoint) => sanitizeText(checkpoint?.name || '', 80))
        .filter(Boolean),
    ));
  }, [assignedShipForCurrentUser, operationalShip, shipsData]);
  const completedCount = useMemo(() => checkpoints.filter(checkpoint => checkpoint?.status === 'completed').length, [checkpoints]);
  const totalCount = checkpoints.length;
  const progressPercentage = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;
  const activePatrolId = useMemo(() => Object.keys(ensureObject(activeForms) || {})[0], [activeForms]);
  const activePatrolState = useMemo(() => activePatrolId ? activeForms[activePatrolId] : null, [activeForms, activePatrolId]);
  const activePatrolItem = useMemo(() => activePatrolId ? checkpoints.find(c => String(c.id) === String(activePatrolId)) : null, [activePatrolId, checkpoints]);
  const canPatrolCurrentShip = Boolean(currentUserRecord && operationalShip && (isPic || (isPetugas && assignedShipForCurrentUser?.id === operationalShip.id)));
  const isShiftStatusRequired = Boolean(
    canPatrolCurrentShip
    && operationalShip?.id
    && !selectedHistoryEntry
    && activeOperationalGuards.length > 0
  );
  const isCurrentShiftStatusCompleted = !isShiftStatusRequired || hasFilledShiftStatusRecord(currentShiftStatusRecord);
  const canAddTemporaryPatrolNode = Boolean(isPetugas && canPatrolCurrentShip && operationalShip && !selectedHistoryEntry);
  const shouldForcePatrolCameraCapture = true;

  const canManageIncident = useCallback((incident) => {
    if (!currentUserRecord || !incident) return false;
    if (isAdmin || isPic) return true;
    if (!isPetugas) return false;
    return Boolean(assignedShipForCurrentUser && incident.shipName === assignedShipForCurrentUser.name);
  }, [assignedShipForCurrentUser, currentUserRecord, isAdmin, isPic, isPetugas]);
  const canCloseIncident = useCallback((incident) => Boolean(currentUserRecord && incident && (isAdmin || isPic)), [currentUserRecord, isAdmin, isPic]);
  const getCanonicalCheckpointRecord = useCallback((checkpoint) => (
    resolveCanonicalCheckpointRecord(checkpoint, checkpointsByShip, historyEntries)
  ), [checkpointsByShip, historyEntries]);
  const sharedState = useMemo(() => normalizeSharedStateTimeAudit(createSharedStateSnapshot({
    activeShiftKey,
    checkpointsByShip,
    deletedRecords,
    historyEntries,
    incidentMeta,
    incidentsData,
    notifications,
    shipsData,
    usersData,
    shiftStatusRecords,
    activeSOSAlert,
    sosHistory,
  })), [
    activeShiftKey,
    checkpointsByShip,
    deletedRecords,
    historyEntries,
    incidentMeta,
    incidentsData,
    notifications,
    shipsData,
    usersData,
    shiftStatusRecords,
    activeSOSAlert,
    sosHistory,
  ]);
  useEffect(() => {
    localSharedStateRef.current = sharedState;
  }, [sharedState]);
  useEffect(() => {
    activeSOSAlertRef.current = activeSOSAlert;
  }, [activeSOSAlert]);
  useEffect(() => {
    sosHistoryRef.current = sosHistory;
  }, [sosHistory]);
  const hasUploadableLocalAssets = useCallback(async (stateSnapshot) => {
    const candidateUrls = collectLocalOnlyAssetUrls(stateSnapshot);

    for (const photoUrl of candidateUrls) {
      if (photoUrl.startsWith('data:image/')) {
        return true;
      }

      const cachedAvailability = localAssetAvailabilityRef.current.get(photoUrl);
      if (cachedAvailability === true) {
        return true;
      }

      if (cachedAvailability === false) {
        continue;
      }

      try {
        const dataUrl = await loadImageFromDB(photoUrl);
        const isAvailable = Boolean(dataUrl);
        localAssetAvailabilityRef.current.set(photoUrl, isAvailable);
        if (isAvailable) {
          return true;
        }
      } catch {
        localAssetAvailabilityRef.current.set(photoUrl, false);
      }
    }

    return false;
  }, []);
  useEffect(() => {
    const wasOffline = previousOfflineStateRef.current;

    if (isOffline) {
      previousOfflineStateRef.current = true;
      return () => { };
    }

    if (!wasOffline) return () => { };

    if (
      !isCloudSyncEnabled
      || !isCloudWriteEnabled
      || !hasOperationalCloudAccess
      || !cloudSyncBootstrapped
    ) {
      return () => { };
    }

    const pendingState = createCloudSyncStateSnapshot(mergeSharedStateSnapshots(
      latestCloudSharedStateRef.current || {},
      createSharedStateSnapshot({
        ...(localSharedStateRef.current || sharedState),
        activeShiftKey: currentShiftMeta.key,
      }),
    ));
    const serializedPendingState = serializeSharedStateSnapshot(pendingState);
    const hasPendingLocalAssets = collectLocalOnlyAssetUrls(pendingState).length > 0;

    if (!serializedPendingState || (serializedPendingState === lastCloudSharedStateRef.current && !hasPendingLocalAssets)) {
      previousOfflineStateRef.current = false;
      return () => { };
    }

    if (!hasPendingLocalAssets) {
      previousOfflineStateRef.current = false;
      requestCloudSync('urgent');
      return () => { };
    }

    let cancelled = false;

    // Saat reconnect, pilih sync normal bila ada aset lokal agar foto idb://
    // di-upload ke Storage, bukan ikut ter-strip oleh fast-path urgent.
    hasUploadableLocalAssets(pendingState)
      .then((hasSyncableLocalAssets) => {
        if (cancelled) return;
        previousOfflineStateRef.current = false;
        requestCloudSync(hasSyncableLocalAssets ? 'normal' : 'urgent');
      })
      .catch(() => {
        if (!cancelled) {
          previousOfflineStateRef.current = false;
          requestCloudSync('normal');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    cloudSyncBootstrapped,
    currentShiftMeta.key,
    hasOperationalCloudAccess,
    hasUploadableLocalAssets,
    isOffline,
    requestCloudSync,
    sharedState,
  ]);
  // Batch pool: maksimal N upload gambar concurrent
  async function processConcurrentBatch(items, maxConcurrent = 3) {
    if (items.length === 0) return [];
    const results = [];
    let index = 0;

    async function worker() {
      while (index < items.length) {
        const currentIndex = index++;
        try {
          results[currentIndex] = await items[currentIndex]();
        } catch (error) {
          results[currentIndex] = null;
        }
      }
    }

    const workers = Array.from({ length: Math.min(maxConcurrent, items.length) }, () => worker());
    await Promise.all(workers);
    return results;
  }

  // Antrian retry upload gambar yang gagal — dicek periodik
  const failedUploadQueueRef = useRef([]);
  const failedUploadRetryTimerRef = useRef(null);
  const RETRY_QUEUE_INTERVAL_MS = 30000; // 30 detik

  const processFailedUploadQueue = useCallback(async () => {
    const queue = failedUploadQueueRef.current;
    if (queue.length === 0) return;

    const currentQueue = [...queue];
    failedUploadQueueRef.current = [];

    for (const item of currentQueue) {
      // Cek apakah item masih valid (belum terupload sukses di sesi sebelumnya)
      if (cloudAssetCacheRef.current.has(item.photoUrl)) {
        const cached = cloudAssetCacheRef.current.get(item.photoUrl);
        if (cached && cached.startsWith('http')) continue; // sudah sukses
      }

      try {
        const dataUrl = item.isInlineDataAsset
          ? item.photoUrl
          : await loadImageFromDB(item.photoUrl);
        if (!dataUrl) {
          localAssetAvailabilityRef.current.set(item.photoUrl, false);
          continue;
        }

        const uploadedUrl = await uploadCloudDataUrlAsset({
          dataUrl,
          path: createCloudAssetPath(...item.pathSegments),
        });

        if (uploadedUrl) {
          cloudAssetCacheRef.current.set(item.photoUrl, uploadedUrl);
          localAssetAvailabilityRef.current.set(item.photoUrl, true);
        } else {
          // Gagal lagi, masukkan kembali ke queue jika masih ada percobaan
          if ((item.retryCount || 0) < 5) {
            failedUploadQueueRef.current.push({
              ...item,
              retryCount: (item.retryCount || 0) + 1,
            });
          }
        }
      } catch {
        if ((item.retryCount || 0) < 5) {
          failedUploadQueueRef.current.push({
            ...item,
            retryCount: (item.retryCount || 0) + 1,
          });
        }
      }
    }
  }, []);

  // Timer periodik untuk retry queue
  useEffect(() => {
    const timerId = setInterval(() => {
      if (failedUploadQueueRef.current.length > 0 && !isOffline) {
        void processFailedUploadQueue();
      }
    }, RETRY_QUEUE_INTERVAL_MS);

    failedUploadRetryTimerRef.current = timerId;
    return () => clearInterval(timerId);
  }, [isOffline, processFailedUploadQueue]);

  const prepareCloudPhotoUrl = useCallback(async (photoUrl, pathSegments, options = {}) => {
    const shouldSkipUpload = Boolean(options?.skipUpload);
    if (!photoUrl || typeof photoUrl !== 'string') return photoUrl || null;
    if (cloudAssetCacheRef.current.has(photoUrl)) {
      const cached = cloudAssetCacheRef.current.get(photoUrl);
      // Jika cache berisi null (gagal sebelumnya), jangan langsung return null
      // — biarkan coba upload ulang
      if (cached !== null) return cached;
    }

    if (isPortableInlineAssetUrl(photoUrl)) {
      cloudAssetCacheRef.current.set(photoUrl, photoUrl);
      return photoUrl;
    }

    const isIndexedDbAsset = photoUrl.startsWith('idb://');
    const isInlineDataAsset = photoUrl.startsWith('data:');
    if (!isIndexedDbAsset && !isInlineDataAsset) return photoUrl;
    if (shouldSkipUpload) return null;

    const inFlightUpload = cloudAssetUploadInFlightRef.current.get(photoUrl);
    if (inFlightUpload) {
      const uploadedUrl = await inFlightUpload;
      const resolvedUrl = uploadedUrl || null;
      cloudAssetCacheRef.current.set(photoUrl, resolvedUrl);
      return resolvedUrl;
    }

    // Jika IndexedDB asset dan sebelumnya ditandai tidak tersedia, masih coba load
    // (bisa saja file sudah tersedia ulang setelah cleanup atau re-capture)
    const dataUrl = isInlineDataAsset ? photoUrl : await loadImageFromDB(photoUrl);
    if (!dataUrl) {
      localAssetAvailabilityRef.current.set(photoUrl, false);
      return null;
    }

    if (isIndexedDbAsset) {
      localAssetAvailabilityRef.current.set(photoUrl, true);
    }

    try {
      const uploadPromise = uploadCloudDataUrlAsset({
        dataUrl,
        path: createCloudAssetPath(...pathSegments),
      });
      cloudAssetUploadInFlightRef.current.set(photoUrl, uploadPromise);
      const uploadedUrl = await uploadPromise;

      const resolvedUrl = uploadedUrl || null;
      cloudAssetCacheRef.current.set(photoUrl, resolvedUrl);
      return resolvedUrl;
    } catch (error) {
      console.error('Gagal upload aset patroli ke cloud, memasukkan ke antrian retry.', error);
      // Hapus cache agar retry berikutnya bisa coba upload ulang
      cloudAssetCacheRef.current.delete(photoUrl);
      // Masukkan ke antrian retry background
      failedUploadQueueRef.current.push({
        photoUrl,
        pathSegments,
        isInlineDataAsset,
        retryCount: 0,
      });
      return null;
    } finally {
      cloudAssetUploadInFlightRef.current.delete(photoUrl);
    }
  }, []);
  const prepareSharedStateForCloudSync = useCallback(async (stateSnapshot, options = {}) => {
    const shouldSkipAssetUpload = Boolean(options?.skipAssetUpload);
    const boundedStateSnapshot = fitSharedStateToCloudBudget(stateSnapshot);

    if (shouldSkipAssetUpload) {
      return prepareStateForUrgentCloudSync(boundedStateSnapshot);
    }

    // Kumpulkan semua tugas upload gambar, urutkan berdasarkan prioritas
    const uploadTasks = [];

    // PRIORITAS 1: Dokumentasi temuan (incident documentation & progress)
    Object.entries(boundedStateSnapshot.incidentMeta || {}).forEach(([incidentId, meta]) => {
      (meta?.documentation || []).forEach((documentationItem, documentationIndex) => {
        const photoUrl = documentationItem?.photoUrl;
        if (!photoUrl || !isLocalOnlyAssetUrl(photoUrl)) return;
        uploadTasks.push(async () => compactMediaAuditRecordForCloudSync({
          ...documentationItem,
          photoUrl: await prepareCloudPhotoUrl(
            photoUrl,
            ['incident-documentation', incidentId, documentationItem.id || documentationIndex, photoUrl],
            { skipUpload: false },
          ),
        }));
      });
      (meta?.progress || []).forEach((progressItem, progressIndex) => {
        const photoUrl = progressItem?.photoUrl;
        if (!photoUrl || !isLocalOnlyAssetUrl(photoUrl)) return;
        uploadTasks.push(async () => compactMediaAuditRecordForCloudSync({
          ...progressItem,
          photoUrl: await prepareCloudPhotoUrl(
            photoUrl,
            ['incident-progress', incidentId, progressItem.id || progressIndex, photoUrl],
            { skipUpload: false },
          ),
        }));
      });
    });

    // PRIORITAS 2: Checkpoints (temuan lebih dulu, lalu aman)
    const checkpointTasks = [];
    Object.entries(boundedStateSnapshot.checkpointsByShip || {}).forEach(([shipId, shipCheckpoints]) => {
      (shipCheckpoints || []).forEach((checkpoint) => {
        const cpPhotoUrl = checkpoint?.photoUrl;
        if (cpPhotoUrl && isLocalOnlyAssetUrl(cpPhotoUrl)) {
          checkpointTasks.push(async () => ({
            photoUrl: await prepareCloudPhotoUrl(
              cpPhotoUrl,
              ['checkpoints', shipId, checkpoint.id, cpPhotoUrl],
              { skipUpload: false },
            ),
          }));
        }
        (checkpoint?.galleryPhotos || []).forEach((galleryPhoto, galleryIndex) => {
          const gpPhotoUrl = galleryPhoto?.photoUrl;
          if (gpPhotoUrl && isLocalOnlyAssetUrl(gpPhotoUrl)) {
            checkpointTasks.push(async () => ({
              photoUrl: await prepareCloudPhotoUrl(
                gpPhotoUrl,
                ['checkpoints-gallery', shipId, checkpoint.id, galleryPhoto.id || galleryIndex, gpPhotoUrl],
                { skipUpload: false },
              ),
              id: galleryPhoto.id,
              author: galleryPhoto.author,
              createdAt: galleryPhoto.createdAt,
            }));
          }
        });
      });
    });
    uploadTasks.push(...checkpointTasks);

    // PRIORITAS 3: History entries
    (boundedStateSnapshot.historyEntries || []).forEach((entry) => {
      (entry.checkpoints || []).forEach((checkpoint) => {
        const hcpPhotoUrl = checkpoint?.photoUrl;
        if (hcpPhotoUrl && isLocalOnlyAssetUrl(hcpPhotoUrl)) {
          uploadTasks.push(async () => ({
            photoUrl: await prepareCloudPhotoUrl(
              hcpPhotoUrl,
              ['history', entry.id || entry.key, checkpoint.id, hcpPhotoUrl],
              { skipUpload: false },
            ),
          }));
        }
        (checkpoint?.galleryPhotos || []).forEach((galleryPhoto, galleryIndex) => {
          const hgpPhotoUrl = galleryPhoto?.photoUrl;
          if (hgpPhotoUrl && isLocalOnlyAssetUrl(hgpPhotoUrl)) {
            uploadTasks.push(async () => ({
              photoUrl: await prepareCloudPhotoUrl(
                hgpPhotoUrl,
                ['history-gallery', entry.id || entry.key, checkpoint.id, galleryPhoto.id || galleryIndex, hgpPhotoUrl],
                { skipUpload: false },
              ),
              id: galleryPhoto.id,
              author: galleryPhoto.author,
              createdAt: galleryPhoto.createdAt,
            }));
          }
        });
      });
      (entry.crewSnapshot || []).forEach((crew) => {
        const crewPhotoUrl = crew?.photoUrl;
        if (crewPhotoUrl && isLocalOnlyAssetUrl(crewPhotoUrl)) {
          uploadTasks.push(async () => ({
            photoUrl: await prepareCloudPhotoUrl(
              crewPhotoUrl,
              ['history-crew', entry.id || entry.key, crew.id || crew.name, crewPhotoUrl],
              { skipUpload: false },
            ),
          }));
        }
      });
    });

    // PRIORITAS 4: Incidents data, ships, users (foto profil)
    (boundedStateSnapshot.incidentsData || []).forEach((incident) => {
      const incPhotoUrl = incident?.photoUrl;
      if (incPhotoUrl && isLocalOnlyAssetUrl(incPhotoUrl)) {
        uploadTasks.push(async () => ({
          photoUrl: await prepareCloudPhotoUrl(
            incPhotoUrl,
            ['incidents', incident.id, 'photo', incPhotoUrl],
            { skipUpload: false },
          ),
        }));
      }
    });

    (boundedStateSnapshot.shipsData || []).forEach((ship) => {
      const shipPhotoUrl = ship?.photoUrl;
      if (shipPhotoUrl && isLocalOnlyAssetUrl(shipPhotoUrl)) {
        uploadTasks.push(async () => ({
          photoUrl: await prepareCloudPhotoUrl(
            shipPhotoUrl,
            ['ships', ship.id, 'cover', shipPhotoUrl],
            { skipUpload: false },
          ),
        }));
      }
    });

    (boundedStateSnapshot.usersData || []).forEach((user) => {
      const userPhotoUrl = user?.photoUrl;
      if (userPhotoUrl && isLocalOnlyAssetUrl(userPhotoUrl)) {
        uploadTasks.push(async () => ({
          photoUrl: await prepareCloudPhotoUrl(
            userPhotoUrl,
            ['users', user.id, 'avatar', userPhotoUrl],
            { skipUpload: false },
          ),
        }));
      }
    });

    // Jalankan upload dengan batch pool max 3 concurrent
    if (uploadTasks.length > 0) {
      await processConcurrentBatch(uploadTasks, 3);
    }

    // Kompilasi hasil akhir (compact records, foto sudah di-cache oleh prepareCloudPhotoUrl)
    const preparedCheckpointsByShip = Object.fromEntries(
      Object.entries(boundedStateSnapshot.checkpointsByShip || {}).map(([shipId, shipCheckpoints]) => ([
        shipId,
        (shipCheckpoints || []).map((checkpoint) => compactCheckpointRecordForCloudSync({
          ...checkpoint,
          photoUrl: cloudAssetCacheRef.current.get(checkpoint?.photoUrl) || stripLocalAssetUrlSync(checkpoint?.photoUrl) || null,
          galleryPhotos: (checkpoint.galleryPhotos || []).map((gp) => compactMediaAuditRecordForCloudSync({
            ...gp,
            photoUrl: cloudAssetCacheRef.current.get(gp?.photoUrl) || stripLocalAssetUrlSync(gp?.photoUrl) || null,
          })),
        })),
      ])),
    );

    const preparedIncidentMeta = Object.fromEntries(
      Object.entries(boundedStateSnapshot.incidentMeta || {}).map(([incidentId, meta]) => ([
        incidentId,
        {
          ...meta,
          documentation: (meta?.documentation || []).map((d) => compactMediaAuditRecordForCloudSync({
            ...d,
            photoUrl: cloudAssetCacheRef.current.get(d?.photoUrl) || stripLocalAssetUrlSync(d?.photoUrl) || null,
          })),
          progress: (meta?.progress || []).map((p) => compactMediaAuditRecordForCloudSync({
            ...p,
            photoUrl: cloudAssetCacheRef.current.get(p?.photoUrl) || stripLocalAssetUrlSync(p?.photoUrl) || null,
          })),
        },
      ])),
    );

    const preparedShipsData = (boundedStateSnapshot.shipsData || []).map((ship) => ({
      ...ship,
      photoUrl: cloudAssetCacheRef.current.get(ship?.photoUrl) || stripLocalAssetUrlSync(ship?.photoUrl) || null,
    }));

    const preparedUsersData = (boundedStateSnapshot.usersData || []).map((user) => ({
      ...user,
      photoUrl: cloudAssetCacheRef.current.get(user?.photoUrl) || stripLocalAssetUrlSync(user?.photoUrl) || null,
    }));

    const preparedIncidentsData = (boundedStateSnapshot.incidentsData || []).map((incident) => compactIncidentRecordForCloudSync({
      ...incident,
      photoUrl: cloudAssetCacheRef.current.get(incident?.photoUrl) || stripLocalAssetUrlSync(incident?.photoUrl) || null,
    }));

    const preparedHistoryEntries = (boundedStateSnapshot.historyEntries || []).map((entry) => compactHistoryEntryForCloudSync({
      ...entry,
      checkpoints: (entry.checkpoints || []).map((checkpoint) => compactCheckpointRecordForCloudSync({
        ...checkpoint,
        photoUrl: cloudAssetCacheRef.current.get(checkpoint?.photoUrl) || stripLocalAssetUrlSync(checkpoint?.photoUrl) || null,
        galleryPhotos: (checkpoint.galleryPhotos || []).map((gp) => compactMediaAuditRecordForCloudSync({
          ...gp,
          photoUrl: cloudAssetCacheRef.current.get(gp?.photoUrl) || stripLocalAssetUrlSync(gp?.photoUrl) || null,
        })),
      })),
      crewSnapshot: (entry.crewSnapshot || []).map((crew) => ({
        ...crew,
        photoUrl: cloudAssetCacheRef.current.get(crew?.photoUrl) || stripLocalAssetUrlSync(crew?.photoUrl) || null,
      })),
    }));

    return fitSharedStateToCloudBudget({
      activeShiftKey: boundedStateSnapshot.activeShiftKey,
      checkpointsByShip: preparedCheckpointsByShip,
      deletedRecords: boundedStateSnapshot.deletedRecords,
      historyEntries: preparedHistoryEntries,
      incidentMeta: preparedIncidentMeta,
      incidentsData: preparedIncidentsData,
      notifications: boundedStateSnapshot.notifications || [],
      shipsData: preparedShipsData,
      usersData: preparedUsersData,
      shiftStatusRecords: boundedStateSnapshot.shiftStatusRecords || {},
      activeSOSAlert: boundedStateSnapshot.activeSOSAlert || null,
      sosHistory: boundedStateSnapshot.sosHistory || [],
    });
  }, [prepareCloudPhotoUrl]);
  // Tampilkan penyebab laporan tidak tersinkron langsung ke layar (penting di HP yang
  // tak bisa buka Console). Hanya muncul untuk submit eksplisit (notifyOnError), bukan
  // untuk re-sync latar belakang.
  const notifyPatrolSyncIssue = useCallback((status) => {
    if (!status || status.syncStatus === 'ok' || status.syncStatus === 'invalid') return;

    if (status.syncStatus === 'sync-disabled') {
      setConfirmDialog({
        title: 'Sinkronisasi nonaktif',
        message: 'Aplikasi tidak terhubung ke server. Laporan hanya tersimpan di perangkat ini dan TIDAK akan terlihat di device lain. Hubungi admin untuk memeriksa konfigurasi server.',
        confirmText: 'MENGERTI',
        isAlert: true,
        onConfirm: () => {},
      });
      return;
    }
    if (status.syncStatus === 'no-access') {
      setConfirmDialog({
        title: 'Laporan belum terkirim ke server',
        message: 'Laporan tersimpan di perangkat, tetapi BELUM terkirim ke server karena sesi/izin cloud tidak aktif. Pastikan akun sudah di-approve admin, lalu coba keluar dan masuk kembali. Selama ini laporan tidak akan terlihat di device lain.',
        confirmText: 'MENGERTI',
        isAlert: true,
        onConfirm: () => {},
      });
      return;
    }
    if (status.syncStatus === 'offline') {
      setConfirmDialog({
        title: 'Sedang offline',
        message: 'Laporan tersimpan dan akan otomatis dikirim ke server saat koneksi kembali online.',
        confirmText: 'MENGERTI',
        isAlert: true,
        onConfirm: () => {},
      });
      return;
    }
    if (status.syncStatus === 'blocked') {
      const error = status.error || {};
      const detail = [error.message, error.hint, error.details].filter(Boolean).join(' — ');
      setConfirmDialog({
        title: 'Laporan GAGAL dikirim ke server',
        message: `Server menolak menyimpan laporan, jadi laporan ini TIDAK akan terlihat di device lain.\n\nPenyebab: ${detail || 'tidak diketahui'}\n\nSering karena nama kapal yang ditugaskan ke akun Anda tidak sama persis dengan kapal patroli, atau akun belum di-approve admin. Laporan tetap diantrekan dan dicoba lagi otomatis.`,
        confirmText: 'MENGERTI',
        isAlert: true,
        onConfirm: () => {},
      });
    }
  }, []);
  const uploadPatrolReportDomainMedia = useCallback(async (checkpointReport, galleryPhotos = []) => (
    Promise.all([
      isLocalOnlyAssetUrl(checkpointReport.photoUrl)
        ? prepareCloudPhotoUrl(
          checkpointReport.photoUrl,
          ['patrol-reports', checkpointReport.shipId, checkpointReport.shiftKey, checkpointReport.checkpointId, checkpointReport.photoUrl],
        )
        : Promise.resolve(checkpointReport.photoUrl),
      Promise.all(ensureArray(galleryPhotos).map(async (galleryPhoto, galleryIndex) => ({
        ...galleryPhoto,
        photoUrl: isLocalOnlyAssetUrl(galleryPhoto?.photoUrl)
          ? await prepareCloudPhotoUrl(
            galleryPhoto.photoUrl,
            ['patrol-reports-gallery', checkpointReport.shipId, checkpointReport.shiftKey, checkpointReport.checkpointId, galleryPhoto.id || galleryIndex, galleryPhoto.photoUrl],
          )
          : galleryPhoto?.photoUrl || null,
      }))),
    ])
  ), [prepareCloudPhotoUrl]);
  const syncPatrolReportToDomain = useCallback(async (checkpoint, options = {}) => {
    // JANGAN bail saat isOffline. savePatrolReport adalah SATU-SATUNYA jalur yang menulis
    // tabel patrol_reports (requestCloudSync hanya sinkron profiles/ships). Bila kita berhenti
    // di sini saat offline, laporan tidak pernah ditulis MAUPUN diantrekan, sehingga hanya ada
    // di device pembuat dan tak pernah terlihat di device lain. Dengan tetap memanggil
    // savePatrolReport, tulisan yang gagal (offline) otomatis masuk outbox IndexedDB dan
    // ter-flush saat kembali online.
    if (!isCloudSyncEnabled || !isCloudWriteEnabled) {
      const status = { syncStatus: 'sync-disabled' };
      if (options.notifyOnError) notifyPatrolSyncIssue(status);
      return status;
    }
    if (!hasOperationalCloudAccess) {
      const status = { syncStatus: 'no-access' };
      if (options.notifyOnError) notifyPatrolSyncIssue(status);
      return status;
    }

    const checkpointReport = createPatrolReportDomainRecord(checkpoint);
    if (!checkpointReport) return { syncStatus: 'invalid' };

    const reportKey = createPatrolReportMediaKey(checkpointReport);
    const galleryPhotos = ensureArray(checkpointReport.galleryPhotos);
    const hasLocalMedia = isLocalOnlyAssetUrl(checkpointReport.photoUrl)
      || galleryPhotos.some((galleryPhoto) => isLocalOnlyAssetUrl(galleryPhoto?.photoUrl));
    if (hasLocalMedia && reportKey) {
      patrolReportLocalMediaRef.current.set(reportKey, {
        photoUrl: checkpointReport.photoUrl,
        galleryPhotos,
      });
    }
    const pendingReport = createPatrolReportDomainRecord(checkpointReport, {
      photoUrl: hasLocalMedia ? stripLocalAssetUrlSync(checkpointReport.photoUrl) : checkpointReport.photoUrl,
      galleryPhotos: galleryPhotos.map((galleryPhoto) => ({
        ...galleryPhoto,
        photoUrl: hasLocalMedia ? stripLocalAssetUrlSync(galleryPhoto?.photoUrl) : galleryPhoto?.photoUrl || null,
      })),
      mediaStatus: hasLocalMedia ? 'uploading' : checkpointReport.mediaStatus,
    });

    if (!pendingReport) return { syncStatus: 'invalid' };

    const writeIfChanged = async (report) => {
      const serializedReport = serializeSharedStateSnapshot(report);
      if (!serializedReport || patrolReportDomainWriteCacheRef.current.get(reportKey) === serializedReport) {
        return { synced: true, unchanged: true };
      }

      const result = await savePatrolReport(report, {
        clientUpdatedAt: Date.now(),
      });
      patrolReportDomainWriteCacheRef.current.set(reportKey, serializedReport);
      return result;
    };

    // Status laporan ditentukan oleh tulisan BARIS (pendingReport). Upload media menyusul.
    const primaryResult = await writeIfChanged(pendingReport);
    const primaryStatus = toPatrolSyncStatus(primaryResult);
    if (options.notifyOnError) notifyPatrolSyncIssue(primaryStatus);

    // Saat offline, Storage tak terjangkau: lewati upload media. Baris laporan sudah
    // diantrekan ke outbox di atas (savePatrolReport), foto lokal tetap tersimpan di
    // patrolReportLocalMediaRef untuk diunggah ulang saat online.
    if (!hasLocalMedia || options.skipMediaUpload || isOffline || patrolReportDomainUploadInFlightRef.current.has(reportKey)) {
      return primaryStatus;
    }

    patrolReportDomainUploadInFlightRef.current.add(reportKey);
    try {
      const [uploadedPhotoUrl, uploadedGalleryPhotos] = await uploadPatrolReportDomainMedia(
        checkpointReport,
        galleryPhotos,
      );
      const mediaReady = Boolean(uploadedPhotoUrl)
        || uploadedGalleryPhotos.some((galleryPhoto) => Boolean(galleryPhoto?.photoUrl));
      const readyReport = createPatrolReportDomainRecord(checkpointReport, {
        photoUrl: uploadedPhotoUrl || null,
        galleryPhotos: uploadedGalleryPhotos,
        mediaStatus: mediaReady ? 'ready' : 'failed',
      });

      if (readyReport) {
        await writeIfChanged(readyReport);
        if (mediaReady) {
          patrolReportLocalMediaRef.current.delete(reportKey);
        }
      }

      return primaryStatus;
    } catch (error) {
      console.error('Gagal sync domain laporan patroli', error);
      return primaryStatus;
    } finally {
      patrolReportDomainUploadInFlightRef.current.delete(reportKey);
    }
  }, [hasOperationalCloudAccess, isOffline, notifyPatrolSyncIssue, uploadPatrolReportDomainMedia]);
  // Unggah ulang foto laporan patroli yang masih lokal (idb://) ke Storage saat online,
  // lalu tulis SEKALI ke patrol_reports dengan URL https. Dipakai untuk laporan yang
  // disubmit offline (fotonya belum sempat naik) — tanpa ini laporan muncul di device
  // lain tanpa foto. Menulis langsung URL https (tanpa strip-null lebih dulu) agar tidak
  // ada jendela foto kosong, dan menyelaraskan state lokal agar tidak diunggah berulang.
  const healPatrolReportMedia = useCallback(async (checkpoint) => {
    if (!isCloudSyncEnabled || !isCloudWriteEnabled || !hasOperationalCloudAccess || isOffline) return;

    const checkpointReport = createPatrolReportDomainRecord(checkpoint);
    if (!checkpointReport) return;

    const galleryPhotos = ensureArray(checkpointReport.galleryPhotos);
    const hasLocalMedia = isLocalOnlyAssetUrl(checkpointReport.photoUrl)
      || galleryPhotos.some((galleryPhoto) => isLocalOnlyAssetUrl(galleryPhoto?.photoUrl));
    if (!hasLocalMedia) return;

    const reportKey = createPatrolReportMediaKey(checkpointReport);
    if (!reportKey || patrolReportDomainUploadInFlightRef.current.has(reportKey)) return;

    patrolReportDomainUploadInFlightRef.current.add(reportKey);
    try {
      const [uploadedPhotoUrl, uploadedGalleryPhotos] = await uploadPatrolReportDomainMedia(
        checkpointReport,
        galleryPhotos,
      );
      const mediaReady = Boolean(uploadedPhotoUrl)
        || uploadedGalleryPhotos.some((galleryPhoto) => Boolean(galleryPhoto?.photoUrl));
      if (!mediaReady) return; // upload belum berhasil; dicoba lagi pada trigger berikutnya

      const readyReport = createPatrolReportDomainRecord(checkpointReport, {
        photoUrl: uploadedPhotoUrl || null,
        galleryPhotos: uploadedGalleryPhotos,
        mediaStatus: 'ready',
      });
      if (!readyReport) return;

      await savePatrolReport(readyReport, { clientUpdatedAt: Date.now() });
      const serializedReadyReport = serializeSharedStateSnapshot(readyReport);
      if (serializedReadyReport) {
        patrolReportDomainWriteCacheRef.current.set(reportKey, serializedReadyReport);
      }
      patrolReportLocalMediaRef.current.delete(reportKey);

      setCheckpointsByShip((previousState) => {
        const shipCheckpoints = ensureArray(previousState?.[readyReport.shipId]);
        let didChange = false;
        const nextShipCheckpoints = shipCheckpoints.map((shipCheckpoint) => {
          if (String(shipCheckpoint?.id) !== String(readyReport.id)) return shipCheckpoint;
          if (
            shipCheckpoint.photoUrl === readyReport.photoUrl
            && shipCheckpoint.mediaStatus === readyReport.mediaStatus
          ) return shipCheckpoint;
          didChange = true;
          return {
            ...shipCheckpoint,
            photoUrl: readyReport.photoUrl,
            galleryPhotos: readyReport.galleryPhotos,
            mediaStatus: readyReport.mediaStatus,
          };
        });
        if (!didChange) return previousState;
        return { ...previousState, [readyReport.shipId]: nextShipCheckpoints };
      });
    } catch (error) {
      console.error('Gagal mengunggah ulang foto laporan patroli saat online', error);
    } finally {
      patrolReportDomainUploadInFlightRef.current.delete(reportKey);
    }
  }, [hasOperationalCloudAccess, isOffline, uploadPatrolReportDomainMedia]);
  // Saat online, naikkan foto laporan kapal operasional yang masih lokal (mis. disubmit
  // offline) ke Storage lalu tulis ke patrol_reports. Konvergen: setelah ter-upload,
  // foto lokal jadi https sehingga tidak diproses ulang pada render berikutnya.
  useEffect(() => {
    if (isOffline || !isCloudSyncEnabled || !isCloudWriteEnabled || !hasOperationalCloudAccess || !cloudSyncBootstrapped) {
      return undefined;
    }

    const pendingMediaCheckpoints = ensureArray(checkpoints).filter((checkpoint) => (
      checkpoint?.status === 'completed'
      && (
        isLocalOnlyAssetUrl(checkpoint?.photoUrl)
        || ensureArray(checkpoint?.galleryPhotos).some((galleryPhoto) => isLocalOnlyAssetUrl(galleryPhoto?.photoUrl))
      )
    ));
    if (pendingMediaCheckpoints.length === 0) return undefined;

    let cancelled = false;
    (async () => {
      for (const checkpoint of pendingMediaCheckpoints) {
        if (cancelled) break;
        await healPatrolReportMedia(checkpoint);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [checkpoints, cloudSyncBootstrapped, hasOperationalCloudAccess, healPatrolReportMedia, isOffline]);
  const syncIncidentDetailToDomain = useCallback((incident, meta = {}, options = {}) => {
    if (!incident || incident.isSOS) return null;

    const domainIncident = createIncidentDomainSyncRecord(incident, meta, {
      incidentId: options.incidentId,
      shipName: options.shipName || incident.shipName || operationalShipName,
      updatedAt: options.updatedAt,
      updatedBy: options.updatedBy || currentUser,
    });
    if (!domainIncident) return null;

    return saveIncidentReport(domainIncident, {
      clientUpdatedAt: options.clientUpdatedAt,
      appendProgressItems: options.appendProgressItems,
      appendDocumentationItems: options.appendDocumentationItems,
    });
  }, [currentUser, operationalShipName]);
  const applyPendingShiftStatusRecords = useCallback((stateSnapshot = {}, fallbackShiftMeta = getShiftMeta()) => {
    if (pendingShiftStatusRecordsRef.current.size === 0) return stateSnapshot;

    const safeShiftMeta = getCanonicalShiftMeta(fallbackShiftMeta) || fallbackShiftMeta || getShiftMeta();
    const activeShiftKey = stateSnapshot.activeShiftKey || safeShiftMeta.key;
    const nextShiftStatusRecords = {
      ...(stateSnapshot.shiftStatusRecords || {}),
    };

    pendingShiftStatusRecordsRef.current.forEach((pendingRecord, recordKey) => {
      const normalizedPendingRecord = normalizeShiftStatusRecord(pendingRecord);
      if (!normalizedPendingRecord || normalizedPendingRecord.shiftKey !== activeShiftKey) {
        pendingShiftStatusRecordsRef.current.delete(recordKey);
        return;
      }

      const existingRecord = normalizeShiftStatusRecord(nextShiftStatusRecords[normalizedPendingRecord.key]);
      const existingTimestamp = getShiftStatusRecordTimestamp(existingRecord);
      const pendingTimestamp = getShiftStatusRecordTimestamp(normalizedPendingRecord);
      nextShiftStatusRecords[normalizedPendingRecord.key] = existingRecord
        ? mergeShiftStatusRecord(existingRecord, normalizedPendingRecord)
        : normalizedPendingRecord;

      if (existingRecord && existingTimestamp >= pendingTimestamp) {
        pendingShiftStatusRecordsRef.current.delete(recordKey);
      }
    });

    return createSharedStateSnapshot({
      ...stateSnapshot,
      activeShiftKey,
      shiftStatusRecords: pruneStaleShiftStatusRecords(nextShiftStatusRecords),
    });
  }, []);
  const applyCloudSharedState = useCallback((nextState, options = {}) => {
    if (!nextState || typeof nextState !== 'object') return null;
    const receivedAtServerMs = resolveExternalTimestampMs(options.receivedAtServerMs);
    const freshShiftMeta = getShiftMeta();

    const nextShips = normalizeShipsCollection(nextState.shipsData || getInitialShipsData());
    const nextUsers = normalizeUsersCollection(nextState.usersData || getMockUsersList());
    const nextCheckpointsByShip = createCheckpointsByShipState(
      nextShips,
      nextState.checkpointsByShip,
      nextState.checkpoints,
      null,
    );
    const incomingShiftState = migrateCheckpointStateToCurrentShift({
      ships: nextShips,
      checkpointsByShip: nextCheckpointsByShip,
      historyEntries: sortHistoryEntries(nextState.historyEntries || createSeedHistoryEntries()),
      shiftStatusRecords: nextState.shiftStatusRecords || {},
      users: nextUsers,
      currentShiftMeta: freshShiftMeta,
    });
    const incomingState = normalizeSharedStateTimeAudit(createSharedStateSnapshot({
      activeShiftKey: incomingShiftState.activeShiftKey,
      checkpointsByShip: incomingShiftState.checkpointsByShip,
      deletedRecords: nextState.deletedRecords,
      historyEntries: incomingShiftState.historyEntries,
      incidentMeta: nextState.incidentMeta && typeof nextState.incidentMeta === 'object' ? nextState.incidentMeta : {},
      incidentsData: Array.isArray(nextState.incidentsData) ? nextState.incidentsData : [],
      notifications: sortNotifications(nextState.notifications || []),
      shipsData: nextShips,
      usersData: nextUsers,
      shiftStatusRecords: incomingShiftState.shiftStatusRecords || {},
      activeSOSAlert: nextState.activeSOSAlert || null,
      sosHistory: nextState.sosHistory || [],
    }));
    const auditedIncomingState = receivedAtServerMs !== null
      ? markSharedStateTimeAuditReceived(incomingState, receivedAtServerMs)
      : incomingState;
    const normalizedCloudState = mergeSharedStateSnapshots({}, auditedIncomingState);
    const serializedCloudState = serializeSharedStateSnapshot(normalizedCloudState);
    const currentLocalState = localSharedStateRef.current || {};
    const resolvedActiveShiftKey = resolveLatestShiftKey(
      [currentLocalState.activeShiftKey, normalizedCloudState.activeShiftKey],
      freshShiftMeta,
    );
    const mergedState = createSharedStateSnapshot({
      ...mergeSharedStateSnapshots(currentLocalState, normalizedCloudState),
      activeShiftKey: resolvedActiveShiftKey,
    });
    const normalizedShiftState = migrateCheckpointStateToCurrentShift({
      ships: mergedState.shipsData,
      checkpointsByShip: mergedState.checkpointsByShip,
      historyEntries: mergedState.historyEntries,
      shiftStatusRecords: mergedState.shiftStatusRecords || {},
      users: mergedState.usersData,
      currentShiftMeta: freshShiftMeta,
    });
    const normalizedState = applyPendingShiftStatusRecords(createSharedStateSnapshot({
      ...mergedState,
      activeShiftKey: normalizedShiftState.activeShiftKey,
      checkpointsByShip: normalizedShiftState.checkpointsByShip,
      historyEntries: normalizedShiftState.historyEntries,
      shiftStatusRecords: normalizedShiftState.shiftStatusRecords || {},
    }), freshShiftMeta);
    const serializedState = serializeSharedStateSnapshot(normalizedState);
    const serializedCloudSyncBaseline = serializeSharedStateSnapshot(
      createCloudSyncStateSnapshot(normalizedState),
    );
    latestCloudSharedStateRef.current = normalizedCloudState;
    // Baseline sync harus mengikuti state yang benar-benar diterapkan ke UI.
    // Jika memakai snapshot SQL mentah, hasil normalisasi shift/audit waktu bisa
    // dianggap perubahan lokal baru dan memicu write loop setelah login.
    lastCloudSharedStateRef.current = serializedCloudSyncBaseline || serializedState;

    if (serializedState === lastSharedStateRef.current) return normalizedState;

    const flattenedCheckpoints = [
      ...Object.values(normalizedState.checkpointsByShip || {}).flat(),
      ...normalizedState.historyEntries.flatMap((entry) => entry.checkpoints || []),
    ];

    logCloudSyncDebug('apply-shared-state', {
      activeShiftKey: normalizedState.activeShiftKey,
      deletedHistory: Object.keys(normalizedState.deletedRecords?.historyEntries || {}).length,
      deletedIncidents: Object.keys(normalizedState.deletedRecords?.incidents || {}).length,
      deletedShips: Object.keys(normalizedState.deletedRecords?.ships || {}).length,
      deletedUsers: Object.keys(normalizedState.deletedRecords?.users || {}).length,
      notifications: normalizedState.notifications.length,
      historyEntries: normalizedState.historyEntries.length,
      ships: normalizedState.shipsData.length,
      users: normalizedState.usersData.length,
      checkpointShips: Object.keys(normalizedState.checkpointsByShip || {}).length,
    });

    lastSharedStateRef.current = serializedState;
    setActiveShiftKey(normalizedState.activeShiftKey);
    setCheckpointsByShip(normalizedState.checkpointsByShip);
    setShipsData(normalizedState.shipsData);
    setUsersData(normalizedState.usersData);
    setIncidentsData(normalizedState.incidentsData);
    setIncidentMeta(normalizedState.incidentMeta);
    setDeletedRecords(normalizedState.deletedRecords);
    setHistoryEntries(normalizedState.historyEntries);
    setShiftStatusRecords(normalizedState.shiftStatusRecords || {});
    setNotifications(normalizedState.notifications);
    setActiveSOSAlert(normalizedState.activeSOSAlert);
    setSosHistory(normalizedState.sosHistory);
    setSelectedReportDetail((previousReport) => {
      if (!previousReport) return previousReport;

      // Prefer a context-compatible checkpoint (matching historyId for read-only
      // history reports) to avoid overwriting documentation with a pending
      // current-shift checkpoint that shares the same id but has no data.
      const matchedCheckpoint = flattenedCheckpoints.find((checkpoint) => (
        String(checkpoint?.id) === String(previousReport.id)
        && isCheckpointContextCompatible(previousReport, checkpoint)
      )) || (
          // Fallback to any id match ONLY if the report is NOT a read-only
          // history entry — prevents pending checkpoints wiping documentation.
          !previousReport.readOnly && !previousReport.historyId
          && flattenedCheckpoints.find((checkpoint) => (
            String(checkpoint?.id) === String(previousReport.id)
          ))
        );

      if (!matchedCheckpoint) return previousReport;

      return {
        ...previousReport,
        ...matchedCheckpoint,
        // Preserve the display-critical flags from the original report context
        readOnly: previousReport.readOnly,
        historyId: previousReport.historyId || matchedCheckpoint.historyId || null,
        // Preserve documentation fields — use matched if present, else keep original
        resultType: matchedCheckpoint.resultType || previousReport.resultType,
        photoUrl: resolveMergedCheckpointPhotoUrl(matchedCheckpoint, previousReport),
        galleryPhotos: resolveMergedCheckpointGalleryPhotos(matchedCheckpoint, previousReport),
        kejadian: matchedCheckpoint.kejadian || previousReport.kejadian || '',
        penyebab: matchedCheckpoint.penyebab || previousReport.penyebab || '',
        tindakLanjut: matchedCheckpoint.tindakLanjut || previousReport.tindakLanjut || '',
        shipName: matchedCheckpoint.shipName || previousReport.shipName,
        date: matchedCheckpoint.date || previousReport.date,
        shipSnapshot: matchedCheckpoint.shipSnapshot ?? previousReport.shipSnapshot ?? null,
        gpsSnapshot: matchedCheckpoint.gpsSnapshot ?? previousReport.gpsSnapshot ?? null,
        weatherSnapshot: matchedCheckpoint.weatherSnapshot ?? previousReport.weatherSnapshot ?? null,
      };
    });
    setSelectedIncident((previousIncident) => {
      if (!previousIncident) return previousIncident;

      if (previousIncident.isSOS) {
        const matchedSOS = (
          normalizedState.activeSOSAlert?.id === previousIncident.id
            ? normalizedState.activeSOSAlert
            : normalizedState.sosHistory.find((entry) => entry.id === previousIncident.id)
        );

        if (!matchedSOS) return previousIncident;
        return {
          ...previousIncident,
          ...createSOSIncidentRecord(matchedSOS),
        };
      }

      if (previousIncident.isPatrol) {
        if (previousIncident.readOnly) return previousIncident;

        const matchedCheckpoint = flattenedCheckpoints.find((checkpoint) => (
          createPatrolIncidentId(checkpoint) === previousIncident.id
          && checkpoint.resultType === 'temuan'
        ));

        if (!matchedCheckpoint) return previousIncident;
        const matchedIncident = createPatrolIncidentRecord(matchedCheckpoint, {
          fallbackShipName: matchedCheckpoint.shipName || previousIncident.shipName,
          fallbackDate: matchedCheckpoint.date || previousIncident.date,
          readOnly: previousIncident.readOnly,
        });
        return {
          ...previousIncident,
          ...matchedIncident,
          photoUrl: resolveMergedAssetUrl(matchedIncident.photoUrl, previousIncident.photoUrl),
        };
      }

      const matchedIncident = normalizedState.incidentsData.find((incident) => (
        String(incident?.id) === String(previousIncident.id)
      ));

      return matchedIncident
        ? { ...previousIncident, ...matchedIncident }
        : previousIncident;
    });
    return normalizedState;
  }, [applyPendingShiftStatusRecords]);
  const handleIncomingCloudPayloadRef = useRef(null);
  const refreshCloudSharedStateRef = useRef(null);
  const handleIncomingCloudPayload = useCallback((cloudPayload, options = {}) => {
    const shouldClearState = options.clearWhenEmpty !== false;
    const payloadState = cloudPayload?.state && typeof cloudPayload.state === 'object'
      ? cloudPayload.state
      : null;
    const payloadClientUpdatedAt = resolveExternalTimestampMs(cloudPayload?.clientUpdatedAt);

    setCloudSyncBootstrapped(true);
    if (Number.isFinite(payloadClientUpdatedAt)) {
      lastCloudClientUpdatedAtRef.current = Math.max(
        lastCloudClientUpdatedAtRef.current,
        payloadClientUpdatedAt,
      );
    }

    logCloudSyncDebug('snapshot-received', {
      source: options.source || 'snapshot',
      hasState: Boolean(payloadState),
      activeShiftKey: payloadState?.activeShiftKey || null,
      clientUpdatedAt: payloadClientUpdatedAt,
      notifications: Array.isArray(payloadState?.notifications) ? payloadState.notifications.length : 0,
      historyEntries: Array.isArray(payloadState?.historyEntries) ? payloadState.historyEntries.length : 0,
    });

    if (!payloadState) {
      if (shouldClearState) {
        latestCloudSharedStateRef.current = null;
        lastCloudSharedStateRef.current = '';
      }
      return null;
    }

    const cloudReceivedAtMs = resolveExternalTimestampMs(cloudPayload?.updatedAt)
      || resolveExternalTimestampMs(cloudPayload?.clientUpdatedAt)
      || resolveExternalTimestampMs(options.receivedAtServerMs)
      || getTrustedNowMs();

    return applyCloudSharedState(payloadState, {
      receivedAtServerMs: cloudReceivedAtMs,
    });
  }, [applyCloudSharedState]);
  handleIncomingCloudPayloadRef.current = handleIncomingCloudPayload;
  const pendingCloudRefreshRef = useRef(null);
  const refreshCloudSharedState = useCallback(async (options = {}) => {
    if (!isCloudSyncEnabled) return null;

    // Jika fetch sedang berjalan, jadwalkan refresh ulang setelah selesai
    // agar request signal tidak hilang (sebelumnya langsung di-drop).
    if (cloudFetchInFlightRef.current) {
      pendingCloudRefreshRef.current = options;
      return null;
    }

    cloudFetchInFlightRef.current = true;
    try {
      const cloudPayload = await fetchCloudAppState({
        preferServer: options.preferServer !== false,
      });
      return handleIncomingCloudPayload(cloudPayload, {
        source: options.source || 'manual-refresh',
        clearWhenEmpty: options.clearWhenEmpty,
        receivedAtServerMs: options.receivedAtServerMs,
      });
    } catch (error) {
      setCloudSyncBootstrapped(true);
      console.error('Gagal menarik state patroli cloud', error);
      return null;
    } finally {
      cloudFetchInFlightRef.current = false;

      // Jalankan pending refresh jika ada request yang tertunda
      const pendingOptions = pendingCloudRefreshRef.current;
      if (pendingOptions) {
        pendingCloudRefreshRef.current = null;
        // Micro-task delay agar stack frame selesai dulu
        queueMicrotask(() => refreshCloudSharedState(pendingOptions));
      }
    }
  }, [handleIncomingCloudPayload]);
  refreshCloudSharedStateRef.current = refreshCloudSharedState;
  const applyPatrolReportDocuments = useCallback((reportDocuments = []) => {
    if (!Array.isArray(reportDocuments) || reportDocuments.length === 0) return;
    const reportsWithLocalMedia = reportDocuments.map((reportDocument) => {
      const reportKey = createPatrolReportMediaKey(reportDocument);
      const localMedia = reportKey ? patrolReportLocalMediaRef.current.get(reportKey) : null;
      if (!localMedia) return reportDocument;

      const hasCloudMedia = Boolean(reportDocument?.photoUrl)
        || ensureArray(reportDocument?.galleryPhotos).some((galleryPhoto) => Boolean(galleryPhoto?.photoUrl));
      if (hasCloudMedia && reportDocument?.mediaStatus === 'ready') {
        patrolReportLocalMediaRef.current.delete(reportKey);
        return reportDocument;
      }

      return {
        ...reportDocument,
        photoUrl: reportDocument?.photoUrl || localMedia.photoUrl || null,
        galleryPhotos: ensureArray(reportDocument?.galleryPhotos).length > 0
          ? reportDocument.galleryPhotos
          : ensureArray(localMedia.galleryPhotos),
      };
    });
    setCheckpointsByShip((previousState) => mergePatrolReportDocumentsIntoCheckpoints(
      previousState,
      reportsWithLocalMedia,
    ));
  }, []);
  const getUsersByRole = useCallback((roles) => (
    usersData.filter(user => roles.includes(user.role)).map(user => user.id)
  ), [usersData]);
  const getShipRecipients = useCallback((shipName, options = {}) => {
    const { includeAdmins = false, includePic = false, includePetugas = false, includeUserIds = [] } = options;
    const recipients = new Set(includeUserIds.filter(Boolean));
    usersData.forEach((user) => {
      if (includeAdmins && user.role === ACCESS_ROLES.ADMIN) recipients.add(user.id);
      if (shipName && includePic && user.role === ACCESS_ROLES.PIC && user.shipAssigned === shipName) recipients.add(user.id);
      if (
        shipName
        && includePetugas
        && user.role === ACCESS_ROLES.PETUGAS
        && user.shipAssigned === shipName
        && user.status === 'active'
      ) {
        recipients.add(user.id);
      }
    });
    return Array.from(recipients);
  }, [usersData]);
  const appendNotifications = useCallback((nextNotifications) => {
    if (!Array.isArray(nextNotifications) || nextNotifications.length === 0) return;
    setNotifications((previousNotifications) => {
      const workingNotifications = [...previousNotifications];
      const dedupeIndexMap = new Map();

      workingNotifications.forEach((notification, index) => {
        if (notification?.dedupeKey) dedupeIndexMap.set(notification.dedupeKey, index);
      });

      let didChange = false;

      nextNotifications.forEach((notification) => {
        const targetUserIds = Array.from(new Set(
          (Array.isArray(notification?.targetUserIds) ? notification.targetUserIds : []).filter(Boolean),
        ));
        if (targetUserIds.length === 0) return;

        if (notification.dedupeKey && dedupeIndexMap.has(notification.dedupeKey)) {
          const existingIndex = dedupeIndexMap.get(notification.dedupeKey);
          const existingNotification = workingNotifications[existingIndex];
          const mergedTargetUserIds = Array.from(new Set([
            ...(Array.isArray(existingNotification?.targetUserIds) ? existingNotification.targetUserIds : []),
            ...targetUserIds,
          ]));
          const nextRecord = {
            ...existingNotification,
            ...notification,
            id: existingNotification.id,
            dedupeKey: existingNotification.dedupeKey,
            createdAt: existingNotification.createdAt,
            targetUserIds: mergedTargetUserIds,
            readByUserIds: (Array.isArray(existingNotification?.readByUserIds) ? existingNotification.readByUserIds : [])
              .filter(userId => mergedTargetUserIds.includes(userId)),
          };

          const hasChanged = (
            existingNotification.title !== nextRecord.title
            || existingNotification.message !== nextRecord.message
            || existingNotification.senderName !== nextRecord.senderName
            || existingNotification.senderRole !== nextRecord.senderRole
            || existingNotification.route !== nextRecord.route
            || existingNotification.shipName !== nextRecord.shipName
            || existingNotification.shiftKey !== nextRecord.shiftKey
            || existingNotification.incidentId !== nextRecord.incidentId
            || existingNotification.historyId !== nextRecord.historyId
            || JSON.stringify(existingNotification.routeParams || {}) !== JSON.stringify(nextRecord.routeParams || {})
            || JSON.stringify(existingNotification.targetUserIds || []) !== JSON.stringify(mergedTargetUserIds)
          );

          if (hasChanged) {
            workingNotifications[existingIndex] = nextRecord;
            didChange = true;
            if (isShiftNotificationType(nextRecord.type)) {
              logShiftNotificationDebug('merge', {
                dedupeKey: nextRecord.dedupeKey,
                type: nextRecord.type,
                shipName: nextRecord.shipName,
                shiftKey: nextRecord.shiftKey,
                targetUserIds: nextRecord.targetUserIds,
                message: nextRecord.message,
              });
            }
          }
          return;
        }

        const record = createNotificationRecord({ ...notification, targetUserIds });
        workingNotifications.push(record);
        if (record.dedupeKey) dedupeIndexMap.set(record.dedupeKey, workingNotifications.length - 1);
        didChange = true;
        if (isShiftNotificationType(record.type)) {
          logShiftNotificationDebug('add', {
            dedupeKey: record.dedupeKey,
            type: record.type,
            shipName: record.shipName,
            shiftKey: record.shiftKey,
            targetUserIds: record.targetUserIds,
            message: record.message,
          });
        }
      });

      if (!didChange) return previousNotifications;
      logCloudSyncDebug('notifications-updated', {
        previousCount: previousNotifications.length,
        nextCount: workingNotifications.length,
        dedupeKeys: nextNotifications.map(notification => notification?.dedupeKey).filter(Boolean),
        types: nextNotifications.map(notification => notification?.type).filter(Boolean),
      });
      return sortNotifications(workingNotifications);
    });
  }, []);
  const markNotificationAsRead = useCallback((notificationId) => {
    if (!notificationWriteIdentityId) return;
    setNotifications(previousNotifications => ensureArray(previousNotifications).map((notification) => {
      const readByUserIds = Array.isArray(notification?.readByUserIds) ? notification.readByUserIds : [];
      if (notification?.id !== notificationId || readByUserIds.includes(notificationWriteIdentityId)) return notification;
      return { ...notification, readByUserIds: [...readByUserIds, notificationWriteIdentityId] };
    }));
  }, [notificationWriteIdentityId]);
  const markAllNotificationsAsRead = useCallback(() => {
    if (!notificationWriteIdentityId) return;
    setNotifications(previousNotifications => ensureArray(previousNotifications).map((notification) => (
      Array.isArray(notification?.targetUserIds)
        && notification.targetUserIds.some((targetUserId) => notificationRecipientIds.includes(targetUserId))
        && !(Array.isArray(notification?.readByUserIds) ? notification.readByUserIds : []).some((readIdentity) => notificationReadIdentityIds.includes(readIdentity))
        ? { ...notification, readByUserIds: [...(Array.isArray(notification?.readByUserIds) ? notification.readByUserIds : []), notificationWriteIdentityId] }
        : notification
    )));
  }, [notificationReadIdentityIds, notificationRecipientIds, notificationWriteIdentityId]);
  const navigateToLivePatrol = useCallback((tab = 'checkpoint') => {
    setSelectedHistoryId(null);
    setCurrentPage('home');
    setPatrolTab(tab);
    setSearchQuery('');
    setActiveForms({});
    setPendingPatrolCameraCapture(null);
    setSelectedReportDetail(null);
    setSelectedIncident(null);
  }, []);
  const openNotificationsPage = useCallback(() => {
    setNotificationReturnPage(currentPage);
    setShowSettingsDropdown(false);
    setShowNotificationsDropdown(false);
    setCurrentPage('notifications');
  }, [currentPage]);
  const closeNotificationsPage = useCallback(() => {
    setCurrentPage(notificationReturnPage || 'home');
  }, [notificationReturnPage]);
  const openHistoryEntry = useCallback((historyId) => {
    if (!visibleHistoryEntries.some(entry => entry.id === historyId)) return;
    setSelectedHistoryId(historyId);
    setCurrentPage('history');
    setPatrolTab('info');
    setSearchQuery('');
    setActiveForms({});
    setPendingPatrolCameraCapture(null);
    setSelectedReportDetail(null);
    setSelectedIncident(null);
  }, [visibleHistoryEntries]);
  const closeHistoryEntry = useCallback(() => {
    setSelectedHistoryId(null);
    setCurrentPage('history');
    setPatrolTab('checkpoint');
    setSearchQuery('');
  }, []);
  const handleDeleteHistoryEntry = useCallback((historyId) => {
    if (!isAdmin) return;
    const targetEntry = historyEntries.find(entry => entry.id === historyId);
    if (!targetEntry) return;
    setConfirmDialog({
      title: 'Hapus Riwayat Patroli',
      message: `Anda yakin ingin menghapus riwayat ${targetEntry.ship} - ${targetEntry.shift} (${targetEntry.date})?`,
      confirmText: 'YA, HAPUS',
      cancelText: 'BATAL',
      onConfirm: () => {
        const deletedAt = new Date().toISOString();
        setDeletedRecords(previousDeletedRecords => markDeletedRecord(previousDeletedRecords, 'historyEntries', historyId, deletedAt));
        setHistoryEntries(previousEntries => previousEntries.filter(entry => entry.id !== historyId));
        appendNotifications([{
          type: 'history_deleted',
          title: 'Riwayat patroli dihapus',
          message: `${targetEntry.ship} - ${targetEntry.shift} (${targetEntry.date}) dihapus oleh ${currentUser || 'Admin'}.`,
          senderName: currentUser || 'Admin',
          senderRole: currentUserRole,
          targetUserIds: getUsersByRole([ACCESS_ROLES.ADMIN]),
          route: 'history/list',
          historyId,
        }]);
        if (selectedHistoryId === historyId) {
          setSelectedHistoryId(null);
          setCurrentPage('history');
          setPatrolTab('checkpoint');
        }
      }
    });
  }, [appendNotifications, currentUser, currentUserRole, getUsersByRole, historyEntries, isAdmin, selectedHistoryId]);

  const handleDeleteHistoryEntriesBulk = useCallback((historyIds = [], options = {}) => {
    if (!isAdmin) return;
    const requestedIds = Array.from(new Set(ensureArray(historyIds).map(id => String(id || '')).filter(Boolean)));
    if (requestedIds.length === 0) return;
    // Hanya riwayat tersimpan (bukan live ON GOING) yang boleh dihapus massal.
    const eligibleEntries = historyEntries.filter(entry => requestedIds.includes(entry.id) && !entry.isLive);
    if (eligibleEntries.length === 0) return;
    const eligibleIds = eligibleEntries.map(entry => entry.id);
    const onAfterDelete = typeof options.onAfterDelete === 'function' ? options.onAfterDelete : null;
    setConfirmDialog({
      title: 'Hapus Riwayat Patroli Massal',
      message: `Anda yakin ingin menghapus ${eligibleEntries.length} riwayat patroli yang ditandai? Tindakan ini tidak dapat dibatalkan.`,
      confirmText: 'YA, HAPUS',
      cancelText: 'BATAL',
      onConfirm: () => {
        const deletedAt = new Date().toISOString();
        setDeletedRecords(previousDeletedRecords => (
          eligibleIds.reduce((acc, id) => markDeletedRecord(acc, 'historyEntries', id, deletedAt), previousDeletedRecords)
        ));
        setHistoryEntries(previousEntries => previousEntries.filter(entry => !eligibleIds.includes(entry.id)));
        appendNotifications([{
          type: 'history_deleted',
          title: 'Riwayat patroli dihapus (massal)',
          message: `${eligibleEntries.length} riwayat patroli dihapus oleh ${currentUser || 'Admin'}.`,
          senderName: currentUser || 'Admin',
          senderRole: currentUserRole,
          targetUserIds: getUsersByRole([ACCESS_ROLES.ADMIN]),
          route: 'history/list',
        }]);
        if (selectedHistoryId && eligibleIds.includes(selectedHistoryId)) {
          setSelectedHistoryId(null);
          setCurrentPage('history');
          setPatrolTab('checkpoint');
        }
        if (onAfterDelete) onAfterDelete(eligibleIds);
      }
    });
  }, [appendNotifications, currentUser, currentUserRole, getUsersByRole, historyEntries, isAdmin, selectedHistoryId]);

  // Computed incident lists
  const patrolIncidents = useMemo(() => (
    Object.values(checkpointsByShip)
      .flat()
      .filter(checkpoint => checkpoint.status === 'completed' && checkpoint.resultType === 'temuan')
      .map(checkpoint => createPatrolIncidentRecord(checkpoint, {
        fallbackShipName: checkpoint.shipName || operationalShipName || '',
      }))
  ), [checkpointsByShip, operationalShipName]);
  const historyPatrolIncidents = useMemo(() => (
    historyEntries.flatMap((entry) => (
      (entry.checkpoints || [])
        .filter(checkpoint => checkpoint.status === 'completed' && checkpoint.resultType === 'temuan')
        .map(checkpoint => createPatrolIncidentRecord(checkpoint, {
          fallbackShipName: entry.ship,
          fallbackDate: entry.date,
        }))
    ))
  ), [historyEntries]);
  const sosIncidents = useMemo(() => (
    Array.from(
      [...(Array.isArray(sosHistory) ? sosHistory : []), activeSOSAlert]
        .filter(Boolean)
        .reduce((sosMap, sosEntry) => sosMap.set(sosEntry.id, sosEntry), new Map())
        .values(),
    )
      .map(createSOSIncidentRecord)
      .filter(Boolean)
  ), [activeSOSAlert, sosHistory]);
  const allIncidents = useMemo(() => (
    Array.from(
      [...incidentsData, ...patrolIncidents, ...historyPatrolIncidents, ...sosIncidents].reduce((incidentMap, incident) => {
        const infoOverrides = incidentMeta[incident.id]?.infoOverrides || {};
        const normalizedIncident = {
          ...incident,
          ...infoOverrides,
          shipName: incident.shipName || operationalShipName || '',
        };
        const existingIncident = incidentMap.get(normalizedIncident.id);
        if (!existingIncident) {
          incidentMap.set(normalizedIncident.id, normalizedIncident);
          return incidentMap;
        }

        const shouldUseNext = getIncidentSortTimestamp(normalizedIncident) >= getIncidentSortTimestamp(existingIncident);
        const preferredIncident = shouldUseNext ? normalizedIncident : existingIncident;
        const fallbackIncident = shouldUseNext ? existingIncident : normalizedIncident;
        incidentMap.set(normalizedIncident.id, {
          ...fallbackIncident,
          ...preferredIncident,
          photoUrl: resolveMergedAssetUrl(preferredIncident.photoUrl, fallbackIncident.photoUrl),
        });
        return incidentMap;
      }, new Map()).values(),
    )
      .filter((incident) => incidentMeta[incident.id]?.deleted !== true)
      .sort((left, right) => getIncidentSortTimestamp(right) - getIncidentSortTimestamp(left))
  ), [historyPatrolIncidents, incidentMeta, incidentsData, operationalShipName, patrolIncidents, sosIncidents]);
  const visibleIncidents = useMemo(() => (
    isPetugas && assignedShipForCurrentUser
      ? allIncidents.filter((incident) => (
        incident.shipName === assignedShipForCurrentUser.name
        || (Array.isArray(incident.targetShipNames) && incident.targetShipNames.includes(assignedShipForCurrentUser.name))
      ))
      : allIncidents
  ), [allIncidents, assignedShipForCurrentUser, isPetugas]);
  useEffect(() => {
    if (!selectedIncident?.id) return;

    const latestIncident = allIncidents.find((incident) => incident.id === selectedIncident.id);
    if (!latestIncident) return;

    setSelectedIncident((previousIncident) => {
      if (!previousIncident || previousIncident.id !== latestIncident.id) return previousIncident;

      const mergedIncident = {
        ...previousIncident,
        ...latestIncident,
        readOnly: Boolean(previousIncident.readOnly || latestIncident.readOnly),
        photoUrl: resolveMergedAssetUrl(latestIncident.photoUrl, previousIncident.photoUrl),
      };

      return serializeSharedStateSnapshot(mergedIncident) === serializeSharedStateSnapshot(previousIncident)
        ? previousIncident
        : mergedIncident;
    });
  }, [allIncidents, selectedIncident?.id]);
  const syncIncidentDomainMediaUpload = useCallback(async ({
    incidentId,
    incident,
    group,
    item,
    photoUrl,
    clientUpdatedAt,
    updatedAt,
    updatedBy,
  }) => {
    const safeIncidentId = sanitizeText(incidentId || '', 180).trim();
    const mediaGroup = group === 'documentation' ? 'documentation' : 'progress';
    const safePhotoUrl = typeof photoUrl === 'string' ? photoUrl : '';
    const itemKey = getIncidentMediaItemKey(item);

    if (!safeIncidentId || !itemKey || !isLocalOnlyAssetUrl(safePhotoUrl)) return false;
    if (!isCloudSyncEnabled || !isCloudWriteEnabled || !hasOperationalCloudAccess || isOffline) return false;

    const uploadKey = `${safeIncidentId}|${mediaGroup}|${itemKey}|${safePhotoUrl}`;
    if (incidentDomainUploadInFlightRef.current.has(uploadKey)) return false;

    incidentDomainUploadInFlightRef.current.add(uploadKey);
    const startedAtMs = performance.now();

    try {
      const uploadedUrl = await prepareCloudPhotoUrl(
        safePhotoUrl,
        [
          mediaGroup === 'documentation' ? 'incident-documentation' : 'incident-progress',
          safeIncidentId,
          itemKey,
          safePhotoUrl,
        ],
      );

      if (!uploadedUrl || isLocalOnlyAssetUrl(uploadedUrl)) return false;

      const uploadedItem = compactMediaAuditRecordForCloudSync({
        ...item,
        photoUrl: uploadedUrl,
      });
      const appendOptions = mediaGroup === 'documentation'
        ? { appendDocumentationItems: [uploadedItem] }
        : { appendProgressItems: [uploadedItem] };
      const incidentForDomain = incident || {
        id: safeIncidentId,
        incidentId: safeIncidentId,
        shipName: operationalShipName,
        status: 'open',
      };
      const resolvedStatus = sanitizeText(incidentForDomain.status || '', 30) || 'open';

      const domainSyncResult = await syncIncidentDetailToDomain(incidentForDomain, {
        status: resolvedStatus,
        [mediaGroup]: [uploadedItem],
      }, {
        incidentId: safeIncidentId,
        clientUpdatedAt: Number.isFinite(clientUpdatedAt) ? clientUpdatedAt : Date.now(),
        updatedAt,
        updatedBy: updatedBy || currentUser,
        ...appendOptions,
      });

      if (!domainSyncResult) return false;

      setIncidentMeta((previousMeta) => {
        const currentMeta = previousMeta[safeIncidentId] || {};
        const currentItems = ensureArray(currentMeta[mediaGroup]);
        let didChange = false;
        const nextItems = currentItems.map((currentItem) => {
          const currentItemKey = getIncidentMediaItemKey(currentItem);
          if (currentItemKey !== itemKey) return currentItem;

          const currentPhotoUrl = typeof currentItem?.photoUrl === 'string' ? currentItem.photoUrl : '';
          if (currentPhotoUrl === uploadedUrl) return currentItem;
          if (
            currentPhotoUrl
            && !isLocalOnlyAssetUrl(currentPhotoUrl)
            && getAssetUrlPriority(currentPhotoUrl) >= getAssetUrlPriority(uploadedUrl)
          ) {
            return currentItem;
          }

          didChange = true;
          return {
            ...currentItem,
            photoUrl: uploadedUrl,
          };
        });

        if (!didChange) return previousMeta;
        return {
          ...previousMeta,
          [safeIncidentId]: {
            ...currentMeta,
            [mediaGroup]: nextItems,
          },
        };
      });

      const elapsedMs = Math.round(performance.now() - startedAtMs);
      if (elapsedMs > 4000) {
        console.info(`Upload foto ${mediaGroup} temuan selesai dalam ${elapsedMs}ms.`);
      }

      requestCloudSync('normal');
      return true;
    } catch (error) {
      console.error('Gagal sync foto temuan ke domain, akan dicoba ulang saat koneksi stabil.', error);
      return false;
    } finally {
      incidentDomainUploadInFlightRef.current.delete(uploadKey);
    }
  }, [
    currentUser,
    hasOperationalCloudAccess,
    isOffline,
    operationalShipName,
    prepareCloudPhotoUrl,
    requestCloudSync,
    syncIncidentDetailToDomain,
  ]);
  const flushIncidentDomainLocalMediaQueue = useCallback(async () => {
    if (!isCloudSyncEnabled || !isCloudWriteEnabled || !hasOperationalCloudAccess || isOffline) return;

    const incidentById = new Map(allIncidents.map((incident) => [incident.id, incident]));
    const uploadTasks = [];

    Object.entries(incidentMeta || {}).forEach(([incidentId, meta]) => {
      const incident = incidentById.get(incidentId)
        || (selectedIncident?.id === incidentId ? selectedIncident : null)
        || {
          id: incidentId,
          incidentId,
          shipName: operationalShipName,
          status: meta?.status || 'open',
        };

      ensureArray(meta?.documentation).forEach((item) => {
        if (!isLocalOnlyAssetUrl(item?.photoUrl)) return;
        uploadTasks.push(() => syncIncidentDomainMediaUpload({
          incidentId,
          incident,
          group: 'documentation',
          item,
          photoUrl: item.photoUrl,
          clientUpdatedAt: item.occurredAtClientMs || item.createdAtClientMs,
          updatedAt: item.createdAt,
          updatedBy: item.author,
        }));
      });

      ensureArray(meta?.progress).forEach((item) => {
        if (!isLocalOnlyAssetUrl(item?.photoUrl)) return;
        uploadTasks.push(() => syncIncidentDomainMediaUpload({
          incidentId,
          incident,
          group: 'progress',
          item,
          photoUrl: item.photoUrl,
          clientUpdatedAt: item.occurredAtClientMs || item.createdAtClientMs,
          updatedAt: item.createdAt,
          updatedBy: item.author,
        }));
      });
    });

    if (uploadTasks.length === 0) return;
    await processConcurrentBatch(uploadTasks, 2);
  }, [
    allIncidents,
    hasOperationalCloudAccess,
    incidentMeta,
    isOffline,
    operationalShipName,
    selectedIncident,
    syncIncidentDomainMediaUpload,
  ]);
  const activeShiftGuardSnapshot = useMemo(
    () => (operationalShipName ? buildGuardShiftSnapshot(usersData, operationalShipName, checkpoints, currentShiftStatusRecord) : []),
    [checkpoints, currentShiftStatusRecord, operationalShipName, usersData],
  );

  useEffect(() => {
    setShowShiftStatusModal(false);
  }, [currentShiftMeta.key, operationalShip?.id]);

  const handleNotificationClick = useCallback((notification) => {
    if (!notification) return;
    markNotificationAsRead(notification.id);
    setShowNotificationsDropdown(false);
    const route = normalizeNotificationRoute(notification);

    if (route === 'incidents/detail') {
      const incidentId = notification.routeParams?.incidentId || notification.incidentId;
      const incident = allIncidents.find(item => item.id === incidentId)
        || (activeSOSAlert?.id === incidentId ? createSOSIncidentRecord(activeSOSAlert) : null)
        || createSOSIncidentRecord(sosHistory.find((entry) => entry.id === incidentId));
      setSelectedHistoryId(null);
      setCurrentPage('incidents');
      setPatrolTab('checkpoint');
      setSearchQuery('');
      setActiveForms({});
      setSelectedReportDetail(null);
      if (incident) setSelectedIncident(incident);
      return;
    }

    if (route === 'history/detail') {
      openHistoryEntry(notification.routeParams?.historyId || notification.historyId);
      return;
    }

    if (route === 'history/list') {
      closeHistoryEntry();
      setSelectedIncident(null);
      setSelectedReportDetail(null);
      setSearchQuery('');
      setActiveForms({});
      setCurrentPage('history');
      return;
    }

    if (route === 'patrol/info') {
      navigateToLivePatrol('info');
      return;
    }

    if (route === 'patrol/checkpoint') {
      navigateToLivePatrol('checkpoint');
      return;
    }

    if (route === 'users/list') {
      closeHistoryEntry();
      setSelectedIncident(null);
      setSelectedReportDetail(null);
      setCurrentPage('users');
      return;
    }

    closeHistoryEntry();
  }, [activeSOSAlert, allIncidents, closeHistoryEntry, markNotificationAsRead, navigateToLivePatrol, openHistoryEntry, sosHistory]);

  const openSOSAlertFromPush = useCallback((payload = {}) => {
    const sosId = sanitizeText(payload.sosId || payload.incidentId || '', 180);
    if (!sosId) return false;

    const existingSOS = (activeSOSAlert?.id === sosId ? activeSOSAlert : null)
      || sosHistory.find((entry) => entry?.id === sosId)
      || null;
    const createdAt = sanitizeText(payload.createdAt || payload.triggeredAt || new Date().toISOString(), 80);
    const fallbackSOS = existingSOS || {
      id: sosId,
      senderUserId: sanitizeText(payload.senderUserId || '', 160) || 'unknown',
      senderName: sanitizeText(payload.senderName || '', 100) || 'Petugas',
      senderRole: sanitizeText(payload.senderRole || 'PETUGAS', 40),
      shipName: sanitizeText(payload.shipName || '', 100) || 'Tidak diketahui',
      lat: Number.isFinite(Number(payload.lat)) ? Number(payload.lat) : null,
      lng: Number.isFinite(Number(payload.lng)) ? Number(payload.lng) : null,
      triggeredAt: createdAt,
      createdAt,
      updatedAt: createdAt,
      targetUserIds: notificationRecipientIds,
      targetShipIds: [],
      targetShipNames: [],
      confirmedBy: [],
      status: 'active',
      timeTrustLevel: sanitizeText(payload.timeTrustLevel || 'server-trusted', 40),
      clockTamperDetected: payload.clockTamperDetected === 'true',
    };

    setActiveSOSAlert(fallbackSOS);
    setSosHistory((previousHistory) => upsertSOSHistoryEntry(previousHistory, fallbackSOS));
    setSelectedHistoryId(null);
    setSelectedReportDetail(null);
    setShowIncidentModal(false);
    setCurrentPage('incidents');
    setPatrolTab('checkpoint');
    setSearchQuery('');
    setActiveForms({});
    setSelectedIncident(createSOSIncidentRecord(fallbackSOS));
    void refreshCloudSharedState({
      reason: 'push-sos',
      preferServer: true,
      clearWhenEmpty: false,
    });
    return true;
  }, [activeSOSAlert, notificationRecipientIds, refreshCloudSharedState, sosHistory]);

  const createNotificationFromPushPayload = useCallback((payload = {}) => {
    // Fallback: generate dedupeKey stabil jika payload FCM lama belum membawanya.
    const resolvedDedupeKey = sanitizeText(payload.dedupeKey || '', 240) || (() => {
      const type = sanitizeText(payload.type || '', 80);
      const incidentId = sanitizeText(payload.incidentId || '', 180);
      if (!incidentId) return '';
      if (type === 'incident_progress_updated') {
        // progressId tidak tersedia di payload lama, tapi incidentId + type cukup
        // untuk mencegah duplikasi dari FCM yang sama (satu progress per cycle).
        return `incident-progress-fallback:${incidentId}:${type}`;
      }
      if (type === 'incident_created') {
        const checkpointId = sanitizeText(payload.checkpointId || '', 160);
        return checkpointId
          ? `patrol-finding-fallback:${incidentId}:${checkpointId}`
          : `manual-incident-fallback:${incidentId}`;
      }
      return '';
    })();

    return createNotificationRecord({
      type: sanitizeText(payload.type || 'push', 80),
      title: sanitizeText(payload.title || 'SmartPatrol', 120),
      message: sanitizeText(payload.body || payload.message || '', 240),
      senderName: sanitizeText(payload.senderName || 'SmartPatrol', 100),
      senderRole: sanitizeText(payload.senderRole || 'SYSTEM', 40),
      targetUserIds: notificationRecipientIds,
      route: normalizeNotificationRoute({
        route: payload.route,
        type: payload.type,
        incidentId: payload.incidentId || payload.sosId || '',
      }),
      routeParams: payload.incidentId ? { incidentId: sanitizeText(payload.incidentId, 180) } : {},
      incidentId: sanitizeText(payload.incidentId || payload.sosId || '', 180),
      shipName: sanitizeText(payload.shipName || '', 100),
      shiftKey: sanitizeText(payload.shiftKey || '', 160),
      historyId: sanitizeText(payload.historyId || '', 180),
      dedupeKey: resolvedDedupeKey,
      createdAt: sanitizeText(payload.createdAt || new Date().toISOString(), 80),
    });
  }, [notificationRecipientIds]);

  const handleNativePushForeground = useCallback((payload = {}) => {
    const notification = createNotificationFromPushPayload(payload);
    appendNotifications([notification]);

    if (payload.type === 'sos' || payload.route === 'sos/active') {
      openSOSAlertFromPush(payload);
    }
  }, [appendNotifications, createNotificationFromPushPayload, openSOSAlertFromPush]);

  const handleNativePushAction = useCallback((payload = {}) => {
    if (payload.type === 'sos' || payload.route === 'sos/active') {
      if (openSOSAlertFromPush(payload)) return;
    }

    const notification = createNotificationFromPushPayload(payload);
    appendNotifications([notification]);
    handleNotificationClick(notification);
  }, [appendNotifications, createNotificationFromPushPayload, handleNotificationClick, openSOSAlertFromPush]);

  // Token FCM device aktif; dipakai handleLogout untuk menghapus langganan saat
  // user benar-benar keluar (bukan saat effect cleanup biasa).
  const activePushTokenRef = useRef('');
  // Handler push disimpan di ref agar perubahan referensi (mis. notificationRecipientIds)
  // TIDAK memicu effect setup ulang. Re-run berlebihan menyebabkan token push dihapus &
  // didaftarkan berulang (churn) sehingga baris di push_subscriptions sempat hilang.
  const nativePushHandlersRef = useRef({ onNotification: () => { }, onAction: () => { } });
  nativePushHandlersRef.current = {
    onNotification: handleNativePushForeground,
    onAction: handleNativePushAction,
  };

  useEffect(() => {
    if (!hasOperationalCloudAccess || !nativePushProfile || !firebaseAuthUid) return () => { };

    let cleanupPush = null;
    let disposed = false;

    setupNativePushNotifications(nativePushProfile, {
      onNotification: (payload) => nativePushHandlersRef.current.onNotification(payload),
      onAction: (payload) => nativePushHandlersRef.current.onAction(payload),
      onToken: (token) => { activePushTokenRef.current = token || ''; },
    })
      .then((cleanup) => {
        if (disposed) {
          cleanup?.();
          return;
        }
        cleanupPush = cleanup;
      })
      .catch((error) => {
        console.error('Inisialisasi push notification native gagal', error);
      });

    return () => {
      disposed = true;
      // Hanya lepas listener foreground; token SENGAJA dipertahankan agar push tetap
      // sampai saat tab/app ditutup. Token dihapus hanya saat logout eksplisit
      // (handleLogout); pergantian user di device sama ditangani upsert on conflict.
      cleanupPush?.();
    };
  }, [firebaseAuthUid, hasOperationalCloudAccess, nativePushProfile]);

  // Deep Linking from URL Parameters (e.g. from Telegram Notifications)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const urlParams = new URLSearchParams(window.location.search);
    const incidentId = urlParams.get('incidentId');
    if (!incidentId) return;

    const incident = allIncidents.find(item => item.id === incidentId)
      || (activeSOSAlert?.id === incidentId ? createSOSIncidentRecord(activeSOSAlert) : null)
      || createSOSIncidentRecord(sosHistory.find((entry) => entry.id === incidentId));

    if (incident) {
      setSelectedHistoryId(null);
      setCurrentPage('incidents');
      setPatrolTab('checkpoint');
      setSearchQuery('');
      setActiveForms({});
      setSelectedReportDetail(null);
      setSelectedIncident(incident);

      // Bersihkan param dari URL tanpa reload
      const newUrl = new URL(window.location.href);
      newUrl.searchParams.delete('incidentId');
      window.history.replaceState({}, '', newUrl.toString());
    }
  }, [allIncidents, activeSOSAlert, sosHistory, setSelectedHistoryId, setCurrentPage, setPatrolTab, setSearchQuery, setActiveForms, setSelectedReportDetail, setSelectedIncident]);

  useEffect(() => {
    // Sama seperti initial state: pakai getTrustedDate().getTime() supaya shiftClock
    // selalu finite. Sebelumnya setShiftClock(null) di-no-op oleh React (state sama)
    // dan shiftClock stuck null seterusnya kalau anchor tidak pernah sync.
    const refreshShiftClock = () => setShiftClock(getTrustedDate().getTime());
    const handleVisibilityChange = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        refreshShiftClock();
      }
    };

    const timerId = window.setInterval(refreshShiftClock, 60 * 1000);
    window.addEventListener('focus', refreshShiftClock);
    window.addEventListener('pageshow', refreshShiftClock);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }

    return () => {
      window.clearInterval(timerId);
      window.removeEventListener('focus', refreshShiftClock);
      window.removeEventListener('pageshow', refreshShiftClock);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      }
    };
  }, []);

  useEffect(() => {
    setCheckpointsByShip((previousState) => {
      const nextState = createCheckpointsByShipState(shipsData, previousState, null, activeShiftKey);
      // shallowEqualObjects checks top-level ship-id keys — avoids full JSON.stringify on all checkpoints
      return shallowEqualObjects(previousState, nextState) ? previousState : nextState;
    });
  }, [activeShiftKey, shipsData]);

  useEffect(() => {
    if (!selectedHistoryId) return;
    if (selectedHistoryEntry) return;
    setSelectedHistoryId(null);
  }, [selectedHistoryEntry, selectedHistoryId]);

  useEffect(() => {
    setSelectedReportDetail((previousReport) => {
      if (!previousReport) return previousReport;

      const canonicalCheckpoint = getCanonicalCheckpointRecord(previousReport);
      if (!canonicalCheckpoint) return previousReport;

      const nextReport = {
        ...previousReport,
        ...canonicalCheckpoint,
        // Preserve display-critical flags from the original report context
        readOnly: previousReport.readOnly,
        historyId: previousReport.historyId || canonicalCheckpoint.historyId || null,
        // Preserve documentation fields — use canonical if present, else keep original
        resultType: canonicalCheckpoint.resultType || previousReport.resultType,
        photoUrl: resolveMergedCheckpointPhotoUrl(canonicalCheckpoint, previousReport),
        galleryPhotos: resolveMergedCheckpointGalleryPhotos(canonicalCheckpoint, previousReport),
        kejadian: canonicalCheckpoint.kejadian || previousReport.kejadian || '',
        penyebab: canonicalCheckpoint.penyebab || previousReport.penyebab || '',
        tindakLanjut: canonicalCheckpoint.tindakLanjut || previousReport.tindakLanjut || '',
        shipName: canonicalCheckpoint.shipName || previousReport.shipName,
        date: canonicalCheckpoint.date || previousReport.date,
        shipSnapshot: canonicalCheckpoint.shipSnapshot ?? previousReport.shipSnapshot ?? null,
        gpsSnapshot: canonicalCheckpoint.gpsSnapshot ?? previousReport.gpsSnapshot ?? null,
        weatherSnapshot: canonicalCheckpoint.weatherSnapshot ?? previousReport.weatherSnapshot ?? null,
      };

      return serializeSharedStateSnapshot(nextReport) === serializeSharedStateSnapshot(previousReport)
        ? previousReport
        : nextReport;
    });
    setSelectedIncident((previousIncident) => {
      if (!previousIncident?.isPatrol) return previousIncident;
      if (previousIncident.readOnly) return previousIncident;

      const checkpointId = previousIncident?.checkpointId
        || String(previousIncident.id || '').replace(/^p-/, '');
      if (!checkpointId) return previousIncident;

      const canonicalCheckpoint = getCanonicalCheckpointRecord({ id: checkpointId });
      if (!canonicalCheckpoint || canonicalCheckpoint.resultType !== 'temuan') return previousIncident;

      const nextIncident = {
        ...previousIncident,
        ...createPatrolIncidentRecord(canonicalCheckpoint, {
          fallbackShipName: canonicalCheckpoint.shipName || previousIncident.shipName,
          fallbackDate: canonicalCheckpoint.date || previousIncident.date,
          readOnly: previousIncident.readOnly,
        }),
      };

      return serializeSharedStateSnapshot(nextIncident) === serializeSharedStateSnapshot(previousIncident)
        ? previousIncident
        : nextIncident;
    });
  }, [getCanonicalCheckpointRecord]);

  useEffect(() => {
    setUsersData((previousUsers) => {
      const nextUsers = previousUsers;
      // Effect ini mempertahankan referensi users tanpa mutasi tambahan saat boot awal.
      return previousUsers === nextUsers ? previousUsers : nextUsers;
    });
  }, []);

  useEffect(() => {
    if (!operationalShipName) return;
    const { startAt, endAt } = currentShiftSchedule;
    const now = new Date(shiftClock);
    if (now < startAt || now >= endAt) return;
    appendNotifications([{
      type: 'shift_started',
      title: 'Shift patroli dimulai',
      message: `${currentShiftMeta.label} ${currentShiftMeta.timeRange} untuk ${operationalShipName} telah dimulai.`,
      senderName: 'Sistem',
      senderRole: 'SYSTEM',
      targetUserIds: getShipRecipients(operationalShipName, { includePic: true, includePetugas: true }),
      route: 'patrol/checkpoint',
      shipName: operationalShipName,
      shiftKey: currentShiftMeta.key,
      dedupeKey: `shift-started:${operationalShipName}:${currentShiftMeta.key}`,
      createdAt: startAt.toISOString(),
    }]);
  }, [appendNotifications, currentShiftMeta, currentShiftSchedule, getShipRecipients, operationalShipName, shiftClock]);

  useEffect(() => {
    if (!operationalShipName) return;
    const { endAt, checkpointPendingAt, shiftEndingSoonAt } = currentShiftSchedule;
    const now = new Date(shiftClock);
    const remainingMinutes = Math.ceil((endAt.getTime() - now.getTime()) / MINUTE_IN_MS);
    const pendingCheckpoints = checkpoints.filter(checkpoint => checkpoint.status === 'pending').length;
    const targetUserIds = getShipRecipients(operationalShipName, { includePic: true, includePetugas: true });

    logShiftNotificationDebug('evaluate', {
      shipName: operationalShipName,
      shiftKey: currentShiftMeta.key,
      shiftLabel: currentShiftMeta.label,
      now: now.toISOString(),
      remainingMinutes,
      pendingCheckpoints,
      targetUserIds,
      checkpointPendingAt: checkpointPendingAt.toISOString(),
      shiftEndingSoonAt: shiftEndingSoonAt.toISOString(),
    });

    if (now >= endAt) {
      logShiftNotificationDebug('skip-window', {
        shipName: operationalShipName,
        shiftKey: currentShiftMeta.key,
        remainingMinutes,
      });
      return;
    }

    const scheduledNotifications = [];

    if (pendingCheckpoints > 0 && now >= checkpointPendingAt) {
      scheduledNotifications.push({
        type: 'checkpoint_pending',
        title: 'Checkpoint belum tuntas',
        message: `Masih ada ${pendingCheckpoints} titik patroli belum diisi di ${operationalShipName}. Segera selesaikan sebelum shift berakhir (±1 jam lagi).`,
        senderName: 'Sistem',
        senderRole: 'SYSTEM',
        targetUserIds,
        route: 'patrol/checkpoint',
        shipName: operationalShipName,
        shiftKey: currentShiftMeta.key,
        dedupeKey: `checkpoint-pending:${operationalShipName}:${currentShiftMeta.key}`,
        createdAt: checkpointPendingAt.toISOString(),
      });
    }

    if (now >= shiftEndingSoonAt) {
      scheduledNotifications.push({
        type: 'shift_ending_soon',
        title: 'Shift akan berakhir',
        message: 'Shift akan berakhir 15 menit lagi silahkan cek kembali laporan patroli anda',
        senderName: 'Sistem',
        senderRole: 'SYSTEM',
        targetUserIds,
        route: 'patrol/info',
        shipName: operationalShipName,
        shiftKey: currentShiftMeta.key,
        dedupeKey: `shift-ending-soon:${operationalShipName}:${currentShiftMeta.key}`,
        createdAt: shiftEndingSoonAt.toISOString(),
      });
    }

    appendNotifications(scheduledNotifications);
  }, [appendNotifications, checkpoints, currentShiftMeta, currentShiftSchedule, getShipRecipients, operationalShipName, shiftClock]);

  useEffect(() => {
    const persistedShiftMeta = getCanonicalShiftMetaFromKey(activeShiftKey) || getShiftMetaFromKey(activeShiftKey);
    if (!persistedShiftMeta || persistedShiftMeta.key === currentShiftMeta.key) return;

    const persistedShiftStartAt = getShiftScheduleTimes(persistedShiftMeta).startAt.getTime();
    const currentShiftStartAt = getShiftScheduleTimes(currentShiftMeta).startAt.getTime();

    if (persistedShiftStartAt >= currentShiftStartAt) {
      logCloudSyncDebug('skip-future-shift-history', {
        persistedShiftKey: persistedShiftMeta.key,
        currentShiftKey: currentShiftMeta.key,
      });
      setActiveShiftKey(previousKey => (
        previousKey === currentShiftMeta.key ? previousKey : currentShiftMeta.key
      ));
      return;
    }

    logCloudSyncDebug('reconcile-shift-history', {
      persistedShiftKey: persistedShiftMeta.key,
      currentShiftKey: currentShiftMeta.key,
      shipCount: shipsData.length,
    });

    const nextHistoryBatch = [];
    let workingShiftMeta = persistedShiftMeta;
    let workingCheckpointsByShip = { ...checkpointsByShip };
    const resetTimestamp = getTrustedDate().toISOString();

    let iterations = 0;
    while (workingShiftMeta.key !== currentShiftMeta.key) {
      if (iterations++ > 31) {
        console.warn('MAX_ITERATIONS reached during shift reconciliation.', {
          persistedKey: persistedShiftMeta.key,
          currentKey: currentShiftMeta.key,
        });
        break;
      }
      shipsData.forEach((ship) => {
        const shipCheckpoints = workingCheckpointsByShip[ship.id] || createShipCheckpointCollection(ship);
        nextHistoryBatch.push(buildHistoryEntry({
          shiftMeta: workingShiftMeta,
          checkpoints: shipCheckpoints,
          ship,
          shiftStatusRecords,
          users: usersData,
          weatherInfo,
        }));
        workingCheckpointsByShip[ship.id] = resetCheckpointCollection(shipCheckpoints, {
          updatedAt: resetTimestamp,
          shiftKey: currentShiftMeta.key,
        });
      });
      workingShiftMeta = getNextShiftMeta(workingShiftMeta);
    }

    setHistoryEntries(previousEntries => mergeHistoryEntries(previousEntries, nextHistoryBatch));

    const individualNotifications = nextHistoryBatch.flatMap((entry) => {
      const notificationsBatch = [
        {
          type: 'shift_history_created',
          title: 'Riwayat shift tersimpan',
          message: `${entry.ship} ${entry.shift} selesai. Summary: ${entry.summary.aman} Aman, ${entry.summary.temuan} Temuan, ${entry.summary.missed} Missed.`,
          senderName: 'Sistem',
          senderRole: 'SYSTEM',
          targetUserIds: getShipRecipients(entry.ship, { includePic: true }),
          route: 'history/detail',
          routeParams: { historyId: entry.id },
          historyId: entry.id,
          shipName: entry.ship,
          shiftKey: entry.key,
          dedupeKey: `shift-history-created:${entry.key}`,
          createdAt: entry.createdAt,
        },
      ];

      if (entry.missed > 0) {
        notificationsBatch.push({
          type: 'checkpoint_missed',
          title: 'Ada checkpoint missed',
          message: `${entry.missed} titik patroli missed pada ${entry.ship} ${entry.shift}.`,
          senderName: 'Sistem',
          senderRole: 'SYSTEM',
          targetUserIds: getShipRecipients(entry.ship, { includeAdmins: true, includePic: true }),
          route: 'history/detail',
          routeParams: { historyId: entry.id },
          historyId: entry.id,
          shipName: entry.ship,
          shiftKey: entry.key,
          dedupeKey: `checkpoint-missed:${entry.key}`,
          createdAt: entry.createdAt,
        });
      }

      return notificationsBatch;
    });

    appendNotifications(individualNotifications);
    setCheckpointsByShip(workingCheckpointsByShip);
    setShiftStatusRecords((previousRecords) => retainShiftStatusRecordsForShift(previousRecords, currentShiftMeta.key));
    setActiveForms({});
    setShowShiftStatusModal(false);
    setPendingPatrolCameraCapture(null);
    setSelectedReportDetail(null);
    setSelectedIncident(null);
    setActiveShiftKey(currentShiftMeta.key);
  }, [activeShiftKey, appendNotifications, checkpointsByShip, currentShiftMeta.key, getShipRecipients, shiftStatusRecords, shipsData, usersData, weatherInfo]);

  // Periodic checkpoint migration guard:
  // Pastikan checkpoint dari shift sebelumnya (misal data masuk via cloud sync)
  // tidak nyangkut di checkpointsByShip. Efek ini berjalan tiap ada perubahan
  // data agar catatan lama otomatis dipindahkan ke historyEntries.
  useEffect(() => {
    if (shipsData.length === 0) return;

    const migrationResult = migrateCheckpointStateToCurrentShift({
      ships: shipsData,
      checkpointsByShip,
      historyEntries,
      shiftStatusRecords,
      users: usersData,
      currentShiftMeta,
    });

    if (!migrationResult.migrated) return;

    setCheckpointsByShip(migrationResult.checkpointsByShip);
    setHistoryEntries(migrationResult.historyEntries);
    if (migrationResult.shiftStatusRecords) {
      setShiftStatusRecords(migrationResult.shiftStatusRecords);
    }
  }, [checkpointsByShip, historyEntries, shiftStatusRecords, shipsData, usersData, currentShiftMeta]);

  const updateOperationalShipCheckpoints = useCallback((updater) => {
    if (!operationalShip?.id) return;
    setCheckpointsByShip((previousState) => {
      const currentShipCheckpoints = previousState[operationalShip.id] || [];
      const nextShipCheckpoints = typeof updater === 'function'
        ? updater(currentShipCheckpoints)
        : updater;

      return {
        ...previousState,
        [operationalShip.id]: nextShipCheckpoints,
      };
    });
  }, [operationalShip?.id]);
  const openShiftStatusModal = useCallback(() => {
    if (!isShiftStatusRequired) return;
    setShowShiftStatusModal(true);
  }, [isShiftStatusRequired]);
  const closeShiftStatusModal = useCallback(() => {
    setShowShiftStatusModal(false);
  }, []);
  const handleSaveCurrentShiftStatus = useCallback((items = []) => {
    if (!operationalShip?.id || !currentUserRecord) return false;
    if (showTrustedTimeGateDialog()) return false;

    const guardSnapshot = ensureArray(activeShiftGuardSnapshot).filter(user => user?.id || user?.name);
    if (guardSnapshot.length === 0) {
      setShowShiftStatusModal(false);
      return false;
    }

    const trustedTimestamp = createTrustedTimestampRecord();
    const saveShiftMeta = getShiftMeta(new Date(trustedTimestamp.occurredAtTrustedMs));
    if (saveShiftMeta.key !== currentShiftMeta.key) {
      setShiftClock(trustedTimestamp.occurredAtTrustedMs);
    }
    const normalizedItems = normalizeShiftStatusItems(items);
    const itemsByUserId = new Map(normalizedItems.filter(item => item.userId).map(item => [item.userId, item]));
    const itemsByName = new Map(
      normalizedItems
        .map(item => [createGuardNameKey(item.name), item])
        .filter(([guardNameKey]) => Boolean(guardNameKey)),
    );

    const resolvedItems = guardSnapshot.map((guard) => {
      const matchedItem = itemsByUserId.get(guard.id) || itemsByName.get(createGuardNameKey(guard.name));
      return {
        userId: guard.id || null,
        name: guard.name,
        role: ACCESS_ROLES.PETUGAS,
        status: normalizeShiftGuardStatusValue(
          matchedItem?.status || guard.shiftStatus || SHIFT_GUARD_STATUS.PATROLI,
        ),
      };
    });

    const nextRecord = normalizeShiftStatusRecord({
      shipId: operationalShip.id,
      shipName: operationalShipName,
      shiftKey: saveShiftMeta.key,
      filledByUserId: currentUserRecord.id,
      filledByName: currentUserRecord.name || currentUser,
      filledAtTrustedIso: trustedTimestamp.occurredAtTrustedIso,
      filledAtTrustedMs: trustedTimestamp.occurredAtTrustedMs,
      filledAtClientMs: trustedTimestamp.occurredAtClientMs,
      timeTrustLevel: trustedTimestamp.timeTrustLevel,
      clockTamperDetected: trustedTimestamp.clockTamperDetected,
      items: resolvedItems,
    });
    if (!nextRecord) return false;

    pendingShiftStatusRecordsRef.current.set(nextRecord.key, nextRecord);
    setShiftStatusRecords((previousRecords) => ({
      ...retainShiftStatusRecordsForShift(previousRecords, saveShiftMeta.key),
      [nextRecord.key]: nextRecord,
    }));
    setShowShiftStatusModal(false);
    requestCloudSync('urgent');
    return true;
  }, [activeShiftGuardSnapshot, currentShiftMeta.key, currentUser, currentUserRecord, operationalShip?.id, operationalShipName, requestCloudSync, showTrustedTimeGateDialog]);

  // Patrol handlers
  const handleActionClick = useCallback(async (id, type) => {
    if (!canPatrolCurrentShip) return;
    if (showTrustedTimeGateDialog()) return;
    if (!isCurrentShiftStatusCompleted) {
      setShowShiftStatusModal(true);
      return;
    }

    setPendingPatrolCameraCapture({ id, type });
  }, [canPatrolCurrentShip, isCurrentShiftStatusCompleted, showTrustedTimeGateDialog]);
  const handleFormChange = useCallback((id, field, value) => { setActiveForms(prev => ({ ...prev, [id]: { ...prev[id], [field]: value } })); }, []);
  const handlePhotoUpload = useCallback(async (id, isIncident = false, options = {}) => {
    const useCameraOnly = Boolean(options.cameraOnly);
    if (!isIncident) {
      const patrolType = activeForms[id]?.type || 'aman';
      setPendingPatrolCameraCapture({ id, type: patrolType });
      return;
    }
    const dataUrl = await pickLocalImage({ cameraOnly: useCameraOnly });
    if (!dataUrl) return;
    const url = await saveImageToDB(dataUrl);
    if (!url) return;
    if (isIncident) setIncidentForm(prev => ({ ...prev, photoUrl: url }));
    else setActiveForms(prev => ({ ...prev, [id]: { ...prev[id], photoUrl: url } }));
  }, [activeForms]);
  const handleSubmitPatrol = useCallback(async (id) => {
    if (!currentUserRecord || !operationalShip) return;
    if (showTrustedTimeGateDialog()) return;
    if (!isCurrentShiftStatusCompleted) {
      setShowShiftStatusModal(true);
      return;
    }
    const currentCheckpoint = checkpoints.find(checkpoint => String(checkpoint.id) === String(id));
    if (!currentCheckpoint) return;
    const formState = activeForms[id];
    if (!formState || submittingPatrolId === id) return;

    // Validasi isian wajib untuk laporan temuan: penyebab, deskripsi (kejadian), dan tindak lanjut
    // harus diisi dengan konten bermakna (minimal REPORT_FIELD_MIN_LENGTH karakter).
    if (formState.type === 'temuan') {
      if (!isReportFieldValid(formState.kejadian) || !isReportFieldValid(formState.penyebab) || !isReportFieldValid(formState.tindakLanjut)) {
        return;
      }
    }

    setSubmittingPatrolId(id);

    try {
      const trustedTimestamp = createTrustedTimestampRecord();
      const trustedNow = new Date(trustedTimestamp.occurredAtTrustedMs);
      const timeString = formatAppTime(trustedNow);
      const dateString = formatAppDate(trustedNow);
      const environmentSnapshot = await capturePatrolEnvironmentSnapshot(
        operationalShip,
        trustedTimestamp.occurredAtTrustedIso,
        {
          fallbackWeather: weatherInfo,
          geolocationOptions: {
            enableHighAccuracy: true,
            timeout: PATROL_SUBMIT_GEOLOCATION_TIMEOUT_MS,
            maximumAge: PATROL_SUBMIT_GEOLOCATION_MAX_AGE_MS,
          },
          skipWeatherFetch: true,
        },
      );

      const submittedItem = {
        ...currentCheckpoint,
        incidentId: formState.type === 'temuan'
          ? `p-${currentCheckpoint.id}-${trustedTimestamp.occurredAtTrustedIso.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
          : null,
        status: 'completed',
        pendingOrigin: null,
        completedBy: currentUser,
        completedByUserId: currentUserRecord.id,
        date: dateString,
        time: timeString,
        completedAt: trustedTimestamp.occurredAtTrustedIso,
        updatedAt: trustedTimestamp.occurredAtTrustedIso,
        shiftKey: currentShiftMeta.key,
        shipName: operationalShipName,
        shipSnapshot: environmentSnapshot.shipSnapshot,
        gpsSnapshot: environmentSnapshot.gpsSnapshot,
        weatherSnapshot: environmentSnapshot.weatherSnapshot,
        photoUrl: formState.photoUrl,
        resultType: formState.type,
        penyebab: sanitizeMultilineText(formState.penyebab, 240),
        kejadian: sanitizeMultilineText(formState.kejadian, 280),
        tindakLanjut: sanitizeMultilineText(formState.tindakLanjut, 240),
        ...trustedTimestamp,
      };
      updateOperationalShipCheckpoints(shipCheckpoints => shipCheckpoints.map((checkpoint) => (
        String(checkpoint.id) === String(id) ? submittedItem : checkpoint
      )));
      setActiveForms(prev => {
        const newForms = { ...prev };
        delete newForms[id];
        return newForms;
      });
      setPendingPatrolCameraCapture(null);

      if (submittedItem?.resultType === 'temuan') {
        appendNotifications([{
          type: 'incident_created',
          title: 'Temuan patroli baru',
          message: `${submittedItem.name} dilaporkan sebagai temuan oleh ${currentUser}.`,
          senderName: currentUser,
          senderRole: currentUserRole,
          targetUserIds: getShipRecipients(operationalShipName, { includeAdmins: true, includePic: true, includePetugas: true }),
          route: 'incidents/detail',
          routeParams: { incidentId: submittedItem.incidentId },
          incidentId: submittedItem.incidentId,
          shipName: operationalShipName,
          dedupeKey: `patrol-finding:${currentShiftMeta.key}:${operationalShipName}:${id}:${submittedItem.incidentId}`,
          createdAt: submittedItem.completedAt,
        }]);
      }
      // Signal dikirim SETELAH data tersimpan ke cloud (di write effect baris ~6932),
      // bukan di sini. Sebelumnya signal prematur menyebabkan Device B fetch data lama.
      // notifyOnError menampilkan ke layar bila laporan gagal/terblokir sampai ke server
      // (RLS/izin/offline) — penting karena di HP Console tak bisa dibuka.
      void syncPatrolReportToDomain(submittedItem, { notifyOnError: true });
      requestCloudSync('urgent');
    } finally {
      setSubmittingPatrolId(previousId => (previousId === id ? null : previousId));
    }
  }, [activeForms, appendNotifications, checkpoints, currentShiftMeta.key, currentUser, currentUserRecord, currentUserRole, getShipRecipients, isCurrentShiftStatusCompleted, operationalShip, operationalShipName, requestCloudSync, showTrustedTimeGateDialog, submittingPatrolId, syncPatrolReportToDomain, updateOperationalShipCheckpoints, weatherInfo]);
  const handleDeleteReport = useCallback((id) => {
    setConfirmDialog({
      title: 'Hapus Laporan',
      message: 'Apakah Anda yakin ingin menghapus laporan patroli ini?',
      confirmText: 'YA, HAPUS',
      cancelText: 'BATAL',
      onConfirm: () => {
        const targetCheckpoint = checkpoints.find(checkpoint => String(checkpoint.id) === String(id));
        const resetReport = targetCheckpoint
          ? resetCheckpointForShift(targetCheckpoint, {
            shiftKey: currentShiftMeta.key,
            pendingOrigin: 'manual-reset',
          })
          : null;
        updateOperationalShipCheckpoints(prev => prev.map(c => (
          String(c.id) === String(id)
            ? resetCheckpointForShift(c, {
              shiftKey: currentShiftMeta.key,
              pendingOrigin: 'manual-reset',
            })
            : c
        )));
        if (resetReport) {
          void syncPatrolReportToDomain(resetReport, {
            skipMediaUpload: true,
          });
        }
        setSelectedReportDetail(null);
      }
    });
  }, [checkpoints, currentShiftMeta.key, syncPatrolReportToDomain, updateOperationalShipCheckpoints]);
  const handleAddReportGalleryPhoto = useCallback(async (reportId) => {
    if (!reportId || selectedReportDetail?.readOnly) return;

    const dataUrl = await pickLocalImage();
    if (!dataUrl) return;

    const photoUrl = await saveImageToDB(dataUrl);
    if (!photoUrl) return;

    const galleryPhoto = createCheckpointGalleryPhotoRecord(photoUrl, {
      author: currentUser || selectedReportDetail?.completedBy || '',
    });

    updateOperationalShipCheckpoints((previousCheckpoints) => previousCheckpoints.map((checkpoint) => (
      String(checkpoint.id) === String(reportId)
        ? {
          ...checkpoint,
          updatedAt: galleryPhoto.createdAt,
          galleryPhotos: [...(checkpoint.galleryPhotos || []), galleryPhoto],
        }
        : checkpoint
    )));

    setSelectedReportDetail((previousReport) => (
      previousReport && String(previousReport.id) === String(reportId)
        ? {
          ...previousReport,
          updatedAt: galleryPhoto.createdAt,
          galleryPhotos: [...(previousReport.galleryPhotos || []), galleryPhoto],
        }
        : previousReport
    ));
    requestCloudSync('urgent');
  }, [currentUser, requestCloudSync, selectedReportDetail?.completedBy, selectedReportDetail?.readOnly, updateOperationalShipCheckpoints]);
  const handleOpenPatrolResult = useCallback((item) => {
    const canonicalItem = getCanonicalCheckpointRecord(item) || item;
    setActiveForms({});
    setPendingPatrolCameraCapture(null);
    const isReadOnly = Boolean(canonicalItem?.readOnly || canonicalItem?.historyId || selectedHistoryEntry);
    if (canonicalItem.resultType === 'temuan') {
      setSelectedReportDetail(null);
      setSelectedIncident(createPatrolIncidentRecord(canonicalItem, {
        fallbackShipName: selectedHistoryEntry?.ship || operationalShipName,
        fallbackDate: selectedHistoryEntry?.date || formatAppDate(),
        readOnly: isReadOnly,
      }));
      return;
    }
    setSelectedIncident(null);
    setSelectedReportDetail({
      ...canonicalItem,
      shipName: canonicalItem.shipName || selectedHistoryEntry?.ship || operationalShipName,
      date: canonicalItem.date || selectedHistoryEntry?.date || formatAppDate(),
      shipSnapshot: canonicalItem.shipSnapshot || null,
      gpsSnapshot: canonicalItem.gpsSnapshot || null,
      weatherSnapshot: canonicalItem.weatherSnapshot || null,
      readOnly: isReadOnly,
    });
  }, [getCanonicalCheckpointRecord, selectedHistoryEntry, operationalShipName, setActiveForms, setSelectedIncident, setSelectedReportDetail]);
  const handleAddCustomPatrolNode = useCallback(() => {
    if (!canAddTemporaryPatrolNode || !operationalShip) return;
    if (showTrustedTimeGateDialog()) return;
    if (!isCurrentShiftStatusCompleted) {
      setShowShiftStatusModal(true);
      return;
    }

    const safeName = sanitizeText(newCustomNode, 80);
    if (!safeName) return;

    const nameKey = createCheckpointNameKey(safeName);
    if (checkpoints.some(checkpoint => createCheckpointNameKey(checkpoint.name) === nameKey)) {
      setNewCustomNode('');
      return;
    }

    const trustedTimestamp = createTrustedTimestampRecord();
    updateOperationalShipCheckpoints((previousCheckpoints) => ([
      ...previousCheckpoints,
      {
        id: `${operationalShip.id}::temporary::${trustedTimestamp.occurredAtTrustedMs}-${Math.random().toString(36).slice(2, 8)}`,
        name: safeName,
        desc: 'Titik tambahan sementara untuk shift berjalan.',
        status: 'pending',
        updatedAt: trustedTimestamp.occurredAtTrustedIso,
        createdAt: trustedTimestamp.occurredAtTrustedIso,
        shiftKey: currentShiftMeta.key,
        shipId: operationalShip.id,
        shipName: operationalShip.name,
        isTemporaryShiftNode: true,
        createdInShiftKey: currentShiftMeta.key,
      },
    ]));
    setNewCustomNode('');
    requestCloudSync('urgent');
  }, [canAddTemporaryPatrolNode, checkpoints, currentShiftMeta.key, isCurrentShiftStatusCompleted, newCustomNode, operationalShip, requestCloudSync, showTrustedTimeGateDialog, updateOperationalShipCheckpoints]);
  const closePatrolCameraCapture = useCallback(() => {
    setPendingPatrolCameraCapture(null);
  }, []);
  const handlePatrolCameraCapture = useCallback(async (dataUrl) => {
    const captureRequest = pendingPatrolCameraCapture;
    if (!captureRequest?.id || !captureRequest?.type || !dataUrl) return;
    const url = await saveImageToDB(dataUrl);
    if (!url) return;
    if (captureRequest.intent === 'incident-progress') {
      setNewProgress((previousProgress) => ({ ...previousProgress, photoUrl: url }));
      setPendingPatrolCameraCapture(null);
      return;
    }
    setActiveForms({
      [captureRequest.id]: {
        type: captureRequest.type,
        penyebab: '',
        kejadian: '',
        tindakLanjut: '',
        photoUrl: url,
      },
    });
    setPendingPatrolCameraCapture(null);
  }, [pendingPatrolCameraCapture]);

  // Incident handlers
  const openIncidentModal = useCallback(() => { setIncidentForm(createIncidentFormState()); setShowIncidentModal(true); }, []);
  const closeIncidentModal = useCallback(() => { setShowIncidentModal(false); setIncidentForm(createIncidentFormState()); }, []);
  const handleSubmitIncident = useCallback(() => {
    if (!currentUserRecord) return;
    if (showTrustedTimeGateDialog()) return;
    const loc = incidentForm.locType === 'custom' ? sanitizeText(incidentForm.customLocation, 80) : sanitizeText(incidentForm.location, 80);
    if (!loc) return;
    // Validasi isian wajib: deskripsi, penyebab, dan tindak lanjut harus diisi
    // dengan konten bermakna (minimal REPORT_FIELD_MIN_LENGTH karakter).
    if (!isReportFieldValid(incidentForm.deskripsi) || !isReportFieldValid(incidentForm.penyebab) || !isReportFieldValid(incidentForm.tindakLanjut)) return;
    const trustedTimestamp = createTrustedTimestampRecord();
    const trustedNow = new Date(trustedTimestamp.occurredAtTrustedMs);
    const createdAt = trustedTimestamp.occurredAtTrustedIso;
    const shipSnapshot = createShipLocationSnapshot(operationalShip);
    const newIncident = {
      ...incidentForm,
      id: `incident-${trustedTimestamp.occurredAtTrustedMs}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt,
      time: formatAppTime(trustedNow),
      date: formatAppDate(trustedNow),
      reportedBy: currentUser,
      shipName: operationalShipName,
      location: loc,
      customLocation: incidentForm.locType === 'custom' ? loc : '',
      photoUrl: incidentForm.photoUrl,
      shipSnapshot,
      penyebab: sanitizeMultilineText(incidentForm.penyebab, 240),
      deskripsi: sanitizeMultilineText(incidentForm.deskripsi, 320),
      tindakLanjut: sanitizeMultilineText(incidentForm.tindakLanjut, 240),
      ...trustedTimestamp,
    };
    setIncidentsData(prev => [newIncident, ...prev]);
    appendNotifications([{
      type: 'incident_created',
      title: 'Laporan temuan baru',
      message: `${loc} dilaporkan sebagai temuan baru oleh ${currentUser}.`,
      senderName: currentUser,
      senderRole: currentUserRole,
      targetUserIds: getShipRecipients(operationalShipName, { includeAdmins: true, includePic: true, includePetugas: true }),
      route: 'incidents/detail',
      routeParams: { incidentId: newIncident.id },
      incidentId: newIncident.id,
      shipName: operationalShipName,
      dedupeKey: `manual-incident:${newIncident.id}`,
      createdAt,
    }]);
    closeIncidentModal();
    void saveIncidentReport(newIncident, { clientUpdatedAt: trustedTimestamp.occurredAtClientMs });
    requestCloudSync('urgent');
  }, [appendNotifications, closeIncidentModal, currentUser, currentUserRecord, currentUserRole, getShipRecipients, incidentForm, operationalShip, operationalShipName, requestCloudSync, saveIncidentReport, showTrustedTimeGateDialog]);

  // Ship handlers
  const activeShip = useMemo(() => shipsData.find(s => s.id === activeShipId), [shipsData, activeShipId]);
  const updateActiveShip = useCallback((updates) => {
    if (!isAdmin || !activeShipId) return;
    const mutationMeta = createLocalEntityUpdateMeta();
    setShipsData(prev => prev.map((ship) => {
      if (ship.id !== activeShipId) return ship;
      return normalizeShipRecord({ ...ship, ...updates, ...mutationMeta });
    }));
  }, [isAdmin, activeShipId]);
  const openShipDocForm = useCallback(() => {
    if (!isAdmin || !activeShip) return;
    setNewShipDoc(createShipDocumentState());
    setShowShipDocForm(true);
  }, [isAdmin, activeShip]);
  const closeShipDocForm = useCallback(() => {
    setShowShipDocForm(false);
    setNewShipDoc(createShipDocumentState());
  }, []);
  const syncManagedUserOperationalAccess = useCallback(async (userRecord, overrides = {}) => {
    if (!isAdmin || !hasOperationalCloudAccess || !isFirebaseAuthEnabled) return true;

    const firebaseUid = sanitizeText(overrides.uid || userRecord?.firebaseUid || '', 160) || '';
    const safeEmail = sanitizeEmail(overrides.email || userRecord?.email || '');
    if (!firebaseUid || !safeEmail) return true;

    try {
      await syncOperationalUserAccess({
        uid: firebaseUid,
        email: safeEmail,
        name: sanitizeText(resolveExplicitOverride(overrides, userRecord, 'name', ''), 80) || safeEmail.split('@')[0] || 'Personil',
        role: ACCESS_ROLE_VALUES.includes(resolveExplicitOverride(overrides, userRecord, 'role', ACCESS_ROLES.PETUGAS))
          ? resolveExplicitOverride(overrides, userRecord, 'role', ACCESS_ROLES.PETUGAS)
          : ACCESS_ROLES.PETUGAS,
        status: sanitizeText(resolveExplicitOverride(overrides, userRecord, 'status', ''), 20).toLowerCase() || 'off-duty',
        shipAssigned: sanitizeText(resolveExplicitOverride(overrides, userRecord, 'shipAssigned', ''), 80),
        type: sanitizeText(resolveExplicitOverride(overrides, userRecord, 'type', 'BUJP'), 20) || 'BUJP',
        workerNumber: sanitizeText(resolveExplicitOverride(overrides, userRecord, 'workerNumber', ''), 40),
        legacyUserId: sanitizeText(resolveExplicitOverride(overrides, userRecord, 'legacyUserId', userRecord?.id || ''), 160) || null,
      });
      return true;
    } catch (error) {
      console.error('Gagal sinkronisasi akses operasional personel', error);
      setUserFormNotice('Perubahan penugasan tersimpan, tetapi akses login cloud user perlu disinkronkan ulang oleh admin.');
      return false;
    }
  }, [hasOperationalCloudAccess, isAdmin]);
  const updateUserRecordLocally = useCallback((userId, updates) => {
    if (!userId) return;
    const mutationMeta = createLocalEntityUpdateMeta();
    setUsersData((previousUsers) => previousUsers.map((user, index) => (
      user.id !== userId
        ? user
        : normalizeUserRecord({
          ...user,
          ...updates,
          ...mutationMeta,
        }, index)
    )));
  }, []);
  const handleTogglePersonnel = useCallback(async (userId) => {
    if (!isAdmin || !activeShip) return;
    const targetArray = scheduleMonth === 'current' ? activeShip.personnel : activeShip.personnelNextMonth;
    const isAssigned = targetArray.includes(userId);
    const targetUser = usersData.find(u => u.id === userId) || null;
    if (isAssigned) {
      const mutationMeta = createLocalEntityUpdateMeta();
      const removalResult = removeUserFromShipAssignment(shipsData, {
        userId,
        targetShipId: activeShip.id,
        scheduleType: scheduleMonth === 'current' ? 'current' : 'next',
        mutationMeta,
      });
      setShipsData(removalResult.ships);
      if (scheduleMonth === 'current') {
        const remainingShipName = removalResult.remainingCurrentAssignment?.shipName || '';
        updateUserRecordLocally(userId, {
          shipAssigned: remainingShipName || null,
          status: remainingShipName ? 'active' : 'off-duty',
        });
        requestCloudSync('urgent');
        await syncManagedUserOperationalAccess(targetUser, {
          shipAssigned: remainingShipName,
          status: remainingShipName ? 'active' : 'off-duty',
        });
      } else {
        requestCloudSync('urgent');
      }
    } else {
      setAssignPopupData({ userId, name: targetUser?.name, role: targetUser?.role, scheduleType: scheduleMonth });
      setShowAssignPopup(true);
    }
  }, [activeShip, isAdmin, requestCloudSync, scheduleMonth, shipsData, syncManagedUserOperationalAccess, updateUserRecordLocally, usersData]);

  const handleConfirmAssign = useCallback(async (userId, startDate, endDate, isTBC) => {
    if (!isAdmin || !activeShip || !assignPopupData) return;

    const scheduleType = assignPopupData.scheduleType || 'current';
    const targetUser = usersData.find((user) => user.id === userId) || null;

    // Automatically route to 'next assignment' or 'current' based on the date,
    // falling back to the tab they initiated it from if no start date is provided.
    const todayStr = new Date().toISOString().split('T')[0];
    let finalScheduleType = scheduleType;

    if (startDate && startDate > todayStr) {
      finalScheduleType = 'next';
    } else if (startDate && startDate <= todayStr) {
      finalScheduleType = 'current';
    }

    const mutationMeta = createLocalEntityUpdateMeta();
    setShipsData(assignUserToExclusiveShip(shipsData, {
      userId,
      targetShipId: activeShip.id,
      scheduleType: finalScheduleType === 'current' ? 'current' : 'next',
      schedule: {
        startDate,
        endDate,
        isTBC,
      },
      mutationMeta,
    }));

    if (finalScheduleType === 'current') {
      updateUserRecordLocally(userId, {
        shipAssigned: activeShip.name,
        status: 'active',
      });
      requestCloudSync('urgent');
      await syncManagedUserOperationalAccess(targetUser, {
        shipAssigned: activeShip.name,
        status: 'active',
      });
    } else {
      if (targetUser?.status !== 'active') {
        updateUserRecordLocally(userId, {
          shipAssigned: null,
          status: 'off-duty',
        });
      }
      requestCloudSync('urgent');
    }

    setShowAssignPopup(false);
    setAssignPopupData(null);
  }, [activeShip, assignPopupData, isAdmin, requestCloudSync, shipsData, syncManagedUserOperationalAccess, updateUserRecordLocally, usersData]);
  const handleAddShipCp = useCallback(() => {
    if (!isAdmin || !activeShip) return;
    const safeName = sanitizeText(newShipCp.name, 80);
    if (!safeName) return;
    if (activeShip.customCheckpoints.some(checkpoint => createCheckpointNameKey(checkpoint.name) === createCheckpointNameKey(safeName))) {
      setNewShipCp({ name: '', desc: '' });
      return;
    }
    updateActiveShip({
      customCheckpoints: [
        ...activeShip.customCheckpoints,
        { name: safeName, desc: sanitizeMultilineText(newShipCp.desc, 140), isDefault: false },
      ],
    });
    setNewShipCp({ name: '', desc: '' });
  }, [isAdmin, activeShip, newShipCp, updateActiveShip]);
  const handleShipPhotoUpdate = useCallback(async () => { if (!isAdmin || !activeShipId) return; const dataUrl = await pickLocalImage(); if (!dataUrl) return; const url = await saveImageToDB(dataUrl); if (url) updateActiveShip({ photoUrl: url }); }, [isAdmin, activeShipId, updateActiveShip]);
  const handleChangeSchedule = useCallback((userId, field, value) => { if (!isAdmin || !activeShip) return; const currentSchedules = activeShip.personnelSchedules || {}; const newSchedules = { ...currentSchedules, [userId]: { ...(currentSchedules[userId] || {}), [field]: value } }; updateActiveShip({ personnelSchedules: newSchedules }); }, [isAdmin, activeShip, updateActiveShip]);
  const handleShipFormPhotoUpload = useCallback(async () => {
    const dataUrl = await pickLocalImage();
    if (!dataUrl) return;
    const url = await saveImageToDB(dataUrl);
    if (url) setShipFormData(prev => ({ ...prev, photoUrl: url }));
  }, []);
  const handleShipDocUpload = useCallback(async () => {
    if (!isAdmin || !activeShip) return;
    const pickedFile = await pickLocalFile();
    if (!pickedFile?.dataUrl) return;
    const url = await saveImageToDB(pickedFile.dataUrl);
    if (!url) return;
    setNewShipDoc(prev => ({
      ...prev,
      fileUrl: url,
      fileName: sanitizeText(pickedFile.name, 120),
      mimeType: sanitizeText(pickedFile.type || 'application/octet-stream', 120) || 'application/octet-stream',
    }));
  }, [isAdmin, activeShip]);
  const handleAddShipDoc = useCallback(() => {
    if (!isAdmin || !activeShip) return;
    const safeTitle = sanitizeText(newShipDoc.title, 80);
    if (!safeTitle || !newShipDoc.fileUrl) return;
    updateActiveShip({
      documents: [
        ...activeShip.documents,
        {
          title: safeTitle,
          docDate: sanitizeText(newShipDoc.docDate, 20),
          desc: sanitizeMultilineText(newShipDoc.desc, 140),
          fileUrl: newShipDoc.fileUrl,
          fileName: sanitizeText(newShipDoc.fileName, 120),
          mimeType: sanitizeText(newShipDoc.mimeType, 120),
          uploadedAt: new Date().toISOString(),
        }
      ]
    });
    closeShipDocForm();
  }, [isAdmin, activeShip, newShipDoc, updateActiveShip, closeShipDocForm]);
  const handleDownloadShipDoc = useCallback(async (shipDocument) => {
    if (!shipDocument?.fileUrl) return;
    const dataUrl = shipDocument.fileUrl.startsWith('idb://') ? await loadImageFromDB(shipDocument.fileUrl) : shipDocument.fileUrl;
    if (!dataUrl) return;
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = shipDocument.fileName || `${sanitizeText(shipDocument.title || 'dokumen', 40) || 'dokumen'}`;
    link.rel = 'noopener noreferrer';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }, []);
  const handleDeleteShip = useCallback((id) => {
    if (!isAdmin) return;
    const targetShip = shipsData.find(s => s.id === id);
    if (!targetShip) return;

    if (targetShip.personnel.length > 0 || targetShip.personnelNextMonth.length > 0) {
      setConfirmDialog({
        title: 'Gagal Menghapus',
        message: `Armada ${targetShip.name} masih memiliki kru yang ditugaskan. Kosongkan kru terlebih dahulu.`,
        isAlert: true,
        confirmText: 'MENGERTI',
        onConfirm: () => { }
      });
      return;
    }

    setConfirmDialog({
      title: 'Hapus Armada',
      message: `Anda yakin ingin menghapus armada ${targetShip.name}? Semua data titik dan laporan terkait tidak akan ikut terhapus namun armada tidak lagi tersedia.`,
      confirmText: 'YA, HAPUS',
      cancelText: 'BATAL',
      onConfirm: () => {
        const deletedAt = new Date().toISOString();
        setDeletedRecords(previousDeletedRecords => markDeletedRecord(previousDeletedRecords, 'ships', id, deletedAt));
        setShipsData(prev => prev
          .filter(s => s.id !== id)
          .map((ship) => normalizeShipRecord({
            ...ship,
            sosRecipientShipIds: (ship.sosRecipientShipIds || []).filter((shipId) => shipId !== id),
          })));
        if (activeShipId === id) setActiveShipId(null);
        closeShipDocForm();
      }
    });
  }, [isAdmin, shipsData, activeShipId, closeShipDocForm]);

  // User handlers
  const clearUserManagementFeedback = useCallback(() => {
    setUserFormError('');
    setUserFormNotice('');
  }, []);
  const handleAuthPhotoUpload = useCallback(async () => {
    const dataUrl = await pickLocalImage({ cameraOnly: true, cameraFacing: 'user' });
    if (!dataUrl) return;
    const url = await saveImageToDB(dataUrl);
    if (url) {
      setAuthForm(prev => ({ ...prev, photoUrl: url }));
    }
  }, []);
  const handleUserPhotoUpload = useCallback(async () => { const dataUrl = await pickLocalImage(); if (!dataUrl) return; const url = await saveImageToDB(dataUrl); if (url) setUserFormData(prev => ({ ...prev, photoUrl: url })); }, []);
  const handleSaveUser = useCallback(async () => {
    if (!isAdmin) return;

    clearUserManagementFeedback();
    const safeName = sanitizeText(userFormData.name, 80);
    const safeEmail = sanitizeEmail(userFormData.email);
    const passwordInput = sanitizeText(userFormData.password, 120);

    if (!safeName || !safeEmail) {
      setUserFormError('Nama dan email user wajib diisi.');
      return;
    }
    if (safeEmail && usersData.some(u => (u.email || '').toLowerCase() === safeEmail)) {
      setUserFormError('Email user sudah dipakai oleh akun lain.');
      return;
    }
    if (passwordInput && passwordInput.length < 8) {
      setUserFormError('Password user minimal 8 karakter.');
      return;
    }
    if (passwordInput && !isFirebaseAuthEnabled) {
      setUserFormError('Supabase Auth wajib aktif untuk membuat user operasional baru.');
      return;
    }

    let authPayload = {
      hasCredential: false,
      passwordSalt: '',
      passwordHash: '',
      authProvider: 'none',
      firebaseUid: null,
    };

    if (passwordInput) {
      if (isFirebaseAuthEnabled) {
        try {
          const provisioned = await provisionFirebaseEmailUser({
            email: safeEmail,
            password: passwordInput,
            displayName: safeName,
          });
          authPayload = {
            hasCredential: false,
            passwordSalt: '',
            passwordHash: '',
            authProvider: 'supabase',
            firebaseUid: provisioned.user.uid,
          };
          setUserFormNotice('User baru berhasil dibuat dan langsung terhubung ke Supabase Auth.');
        } catch (error) {
          setUserFormError(getFirebaseAuthErrorMessage(error));
          return;
        }
      }
    } else {
      setUserFormNotice('User disimpan sebagai profil operasional. Akses login akan aktif setelah akun Supabase diikat.');
    }

    const role = ACCESS_ROLE_VALUES.includes(userFormData.role) ? userFormData.role : ACCESS_ROLES.PETUGAS;
    const userMutationMeta = createLocalEntityUpdateMeta();
    const newUser = {
      id: `u${Date.now()}`,
      ...userFormData,
      name: safeName,
      role,
      workerNumber: sanitizeText(userFormData.workerNumber, 40),
      email: safeEmail,
      password: '',
      ...authPayload,
      phone: sanitizePhone(userFormData.phone),
      address: sanitizeMultilineText(userFormData.address, 180),
      emergencyName: sanitizeText(userFormData.emergencyName, 80),
      emergencyContact: sanitizePhone(userFormData.emergencyContact),
      emergencyRelation: sanitizeText(userFormData.emergencyRelation, 40),
      officeAddress: sanitizeMultilineText(userFormData.officeAddress, 180),
      photoUrl: userFormData.photoUrl || createUserAvatar(safeName, usersData.length),
      status: role === ACCESS_ROLES.PETUGAS ? 'off-duty' : 'active',
      shipAssigned: null,
      ...userMutationMeta,
    };
    const nextUserRecord = normalizeUserRecord(newUser, usersData.length);
    if (nextUserRecord.firebaseUid) {
      try {
        await syncOperationalUserAccess({
          uid: nextUserRecord.firebaseUid,
          email: nextUserRecord.email,
          name: nextUserRecord.name,
          role: nextUserRecord.role,
          status: nextUserRecord.status,
          shipAssigned: nextUserRecord.shipAssigned || '',
          type: nextUserRecord.type,
          workerNumber: nextUserRecord.workerNumber || '',
          legacyUserId: nextUserRecord.id,
        });
      } catch (error) {
        console.error('Gagal sinkronisasi akses user baru', error);
        setUserFormNotice('Profil user tersimpan, tetapi akses cloud perlu disinkronkan ulang oleh admin.');
      }
    }
    setUsersData(prev => [...prev, nextUserRecord]);
    setShowUserForm(false);
    setUserFormData(createUserFormState());
    setSelectedUser(nextUserRecord);
  }, [clearUserManagementFeedback, isAdmin, userFormData, usersData]);
  const handleUpdateUser = useCallback(async () => {
    if (!selectedUser?.id) return;
    clearUserManagementFeedback();
    const currentRecord = usersData.find(u => u.id === selectedUser.id) || null;
    const selectedFirebaseUid = sanitizeText(selectedUser.firebaseUid || currentRecord?.firebaseUid || '', 160);
    const currentFirebaseUid = sanitizeText(currentUserRecord?.firebaseUid || '', 160);
    const isEditingOwnProfile = Boolean(
      selectedUser.id === sessionUserId
      || (currentUserRecord?.id && selectedUser.id === currentUserRecord.id)
      || (selectedFirebaseUid && currentFirebaseUid && selectedFirebaseUid === currentFirebaseUid)
    );
    if (!isAdmin && !isEditingOwnProfile) {
      setUserFormError('Anda hanya dapat mengubah profil akun sendiri.');
      return;
    }

    const isFirebaseUser = isFirebaseManagedUser(currentRecord || selectedUser);
    const nextEmail = isFirebaseUser ? sanitizeEmail(currentRecord?.email || selectedUser.email || '') : sanitizeEmail(selectedUser.email || '');
    const safeName = sanitizeText(selectedUser.name, 80);

    if (!safeName || !nextEmail) {
      setUserFormError('Nama dan email user wajib diisi.');
      return;
    }
    if (nextEmail && usersData.some(u => u.id !== selectedUser.id && (u.email || '').toLowerCase() === nextEmail)) {
      setUserFormError('Email user sudah dipakai oleh akun lain.');
      return;
    }

    const passwordInput = sanitizeText(selectedUser.password || '', 120);
    if (passwordInput && passwordInput.length < 8) {
      setUserFormError('Password user minimal 8 karakter.');
      return;
    }
    if (!isFirebaseUser && passwordInput && !isFirebaseAuthEnabled) {
      setUserFormError('Supabase Auth wajib aktif untuk mengikat ulang kredensial user.');
      return;
    }

    let authPayload = null;
    if (!isFirebaseUser && passwordInput) {
      if (isFirebaseAuthEnabled) {
        try {
          const provisioned = await provisionFirebaseEmailUser({
            email: nextEmail,
            password: passwordInput,
            displayName: safeName,
          });
          authPayload = {
            hasCredential: false,
            passwordSalt: '',
            passwordHash: '',
            authProvider: 'supabase',
            firebaseUid: provisioned.user.uid,
          };
          setUserFormNotice('User berhasil dihubungkan ke Supabase Auth.');
        } catch (error) {
          setUserFormError(getFirebaseAuthErrorMessage(error));
          return;
        }
      }
    }

    const selectedUserIndex = Math.max(usersData.findIndex(u => u.id === selectedUser.id), 0);
    const preservedRole = currentRecord?.role || ACCESS_ROLES.PETUGAS;
    const nextRole = isAdmin
      ? (ACCESS_ROLE_VALUES.includes(selectedUser.role) ? selectedUser.role : ACCESS_ROLES.PETUGAS)
      : preservedRole;
    const requestedStatus = sanitizeText(selectedUser.status || currentRecord?.status || '', 20).toLowerCase();
    const wantsInactive = requestedStatus === 'disabled';
    if (isEditingOwnProfile && wantsInactive) {
      setUserFormError('Akun yang sedang dipakai tidak bisa dinonaktifkan dari sesi ini.');
      return;
    }
    const nextShipAssigned = wantsInactive
      ? null
      : (sanitizeText(selectedUser.shipAssigned || '', 80) || null);
    const nextOperationalStatus = nextRole === ACCESS_ROLES.PETUGAS
      ? (wantsInactive ? 'disabled' : (nextShipAssigned ? 'active' : 'off-duty'))
      : (wantsInactive ? 'disabled' : 'active');
    const userMutationMeta = createLocalEntityUpdateMeta();
    const previewUser = normalizeUserRecord({
      ...(currentRecord || {}),
      ...selectedUser,
      name: safeName,
      role: nextRole,
      email: nextEmail,
      password: '',
      hasCredential: isFirebaseUser ? false : (authPayload?.hasCredential ?? currentRecord?.hasCredential ?? false),
      passwordSalt: isFirebaseUser ? '' : (authPayload?.passwordSalt ?? currentRecord?.passwordSalt ?? ''),
      passwordHash: isFirebaseUser ? '' : (authPayload?.passwordHash ?? currentRecord?.passwordHash ?? ''),
      authProvider: isFirebaseUser ? 'supabase' : (authPayload?.authProvider ?? currentRecord?.authProvider ?? 'none'),
      firebaseUid: isFirebaseUser ? (currentRecord?.firebaseUid || selectedUser.firebaseUid || null) : (authPayload?.firebaseUid ?? currentRecord?.firebaseUid ?? null),
      shipAssigned: nextShipAssigned,
      status: nextOperationalStatus,
      workerNumber: sanitizeText(selectedUser.workerNumber || '', 40),
      phone: sanitizePhone(selectedUser.phone || ''),
      address: sanitizeMultilineText(selectedUser.address || '', 180),
      emergencyName: sanitizeText(selectedUser.emergencyName || '', 80),
      emergencyContact: sanitizePhone(selectedUser.emergencyContact || ''),
      emergencyRelation: sanitizeText(selectedUser.emergencyRelation || '', 40),
      officeAddress: sanitizeMultilineText(selectedUser.officeAddress || '', 180),
      photoUrl: selectedUser.photoUrl || currentRecord?.photoUrl || createUserAvatar(safeName, selectedUserIndex),
      ...userMutationMeta,
    }, selectedUserIndex);

    if (previewUser.firebaseUid) {
      try {
        await syncOperationalUserAccess({
          uid: previewUser.firebaseUid,
          email: previewUser.email,
          name: previewUser.name,
          role: previewUser.role,
          status: previewUser.status,
          shipAssigned: previewUser.shipAssigned || '',
          type: previewUser.type,
          workerNumber: previewUser.workerNumber || '',
          legacyUserId: previewUser.id,
        });
      } catch (error) {
        console.error('Gagal sinkronisasi akses user terpilih', error);
        setUserFormNotice('Perubahan profil tersimpan lokal, tetapi akses cloud belum sinkron penuh.');
      }
    }

    setUsersData(prev => prev.map((u, index) => {
      if (u.id !== selectedUser.id) return u;
      const nextUser = {
        ...u,
        ...previewUser,
      };
      return normalizeUserRecord(nextUser, index);
    }));
    if (previewUser.status === 'disabled') {
      setShipsData((previousShips) => previousShips.map((ship) => {
        const nextSchedules = { ...(ship.personnelSchedules || {}) };
        delete nextSchedules[selectedUser.id];
        return {
          ...ship,
          personnel: ensureArray(ship.personnel).filter((userId) => userId !== selectedUser.id),
          personnelNextMonth: ensureArray(ship.personnelNextMonth).filter((userId) => userId !== selectedUser.id),
          personnelSchedules: nextSchedules,
        };
      }));
    }
    setSelectedUser({ ...previewUser, password: '' });
    setUserFormNotice((previousNotice) => previousNotice || 'Perubahan profil berhasil disimpan.');
  }, [clearUserManagementFeedback, currentUserRecord, isAdmin, selectedUser, sessionUserId, usersData]);
  const handleDeleteUser = useCallback((id) => {
    if (!isAdmin) return;
    const targetUser = usersData.find(u => u.id === id);
    if (targetUser?.role === ACCESS_ROLES.ADMIN) return;
    setConfirmDialog({
      title: 'Hapus Pengguna',
      message: `Anda yakin ingin menghapus akun ${targetUser.name}? Seluruh data penugasan akan dihapus.`,
      confirmText: 'YA, HAPUS',
      cancelText: 'BATAL',
      onConfirm: async () => {
        const deletedAt = new Date().toISOString();
        if (targetUser?.firebaseUid) {
          try {
            await revokeOperationalUserAccess({
              uid: targetUser.firebaseUid,
            });
          } catch (error) {
            console.error('Gagal revoke akses operasional user', error);
          }
        }
        setDeletedRecords(previousDeletedRecords => markDeletedRecord(previousDeletedRecords, 'users', id, deletedAt));
        setUsersData(prev => prev.filter(u => u.id !== id));
        setShipsData(prev => prev.map(ship => ({ ...ship, personnel: ship.personnel.filter(userId => userId !== id), personnelNextMonth: ship.personnelNextMonth.filter(userId => userId !== id) })));
        if (sessionUserId === id) { setSessionUserId(null); setAuthMode('login'); setAuthNotice('Akun sedang dipakai telah dihapus. Silakan login ulang.'); }
        setSelectedUser(null);
      }
    });
  }, [isAdmin, usersData, sessionUserId]);
  const handleEditUserPhotoUpload = useCallback(async () => { const dataUrl = await pickLocalImage(); if (!dataUrl) return; const url = await saveImageToDB(dataUrl); if (url) setSelectedUser(prev => ({ ...prev, photoUrl: url })); }, []);
  const handleApprovePendingUser = useCallback(async (pendingRegistration) => {
    if (!isAdmin || !pendingRegistration?.uid) return;

    clearUserManagementFeedback();
    try {
      const approvalResult = await approvePendingRegistration({
        uid: pendingRegistration.uid,
        role: ACCESS_ROLES.PETUGAS,
        status: 'off-duty',
        shipAssigned: '',
        type: pendingRegistration.type || 'BUJP',
        workerNumber: pendingRegistration.workerNumber || '',
      });
      const profileSeed = {
        id: `u${Date.now()}`,
        name: pendingRegistration.name,
        email: pendingRegistration.email,
        phone: pendingRegistration.phone,
        photoUrl: pendingRegistration.photoUrl,
        type: pendingRegistration.type || 'BUJP',
        workerNumber: pendingRegistration.workerNumber || '',
      };
      const approvedProfile = approvalResult?.profile || profileSeed;
      setUsersData((previousUsers) => upsertOperationalUserRecord(previousUsers, {
        access: approvalResult?.access || {},
        profile: approvedProfile,
        authUser: {
          uid: pendingRegistration.uid,
          email: pendingRegistration.email,
          displayName: pendingRegistration.name,
          phoneNumber: pendingRegistration.phone,
          photoURL: pendingRegistration.photoUrl,
        },
      }));
      setPendingRegistrations((previousList) =>
        previousList.map((entry) =>
          entry.uid === pendingRegistration.uid ? { ...entry, status: 'approved' } : entry
        )
      );
      requestCloudSync('urgent');
      setUserFormNotice(`Registrasi ${pendingRegistration.name} disetujui. Aktivasi login penuh menunggu penugasan kapal.`);
    } catch (error) {
      console.error('Gagal approve onboarding pending', error);
      setUserFormError('Approval onboarding gagal diproses. Coba lagi.');
    }
  }, [clearUserManagementFeedback, isAdmin, requestCloudSync]);
  const handleRejectPendingUser = useCallback(async (pendingRegistration) => {
    if (!isAdmin || !pendingRegistration?.uid) return;

    clearUserManagementFeedback();
    try {
      await rejectPendingRegistration({
        uid: pendingRegistration.uid,
      });
      setPendingRegistrations((previousList) =>
        previousList.map((entry) =>
          entry.uid === pendingRegistration.uid ? { ...entry, status: 'rejected' } : entry
        )
      );
      setUserFormNotice(`Registrasi ${pendingRegistration.name} ditolak.`);
    } catch (error) {
      console.error('Gagal reject onboarding pending', error);
      setUserFormError('Penolakan onboarding gagal diproses. Coba lagi.');
    }
  }, [clearUserManagementFeedback, isAdmin]);

  // Progress & incident meta handlers
  const handleAddProgress = useCallback(async (incidentId) => {
    const incident = allIncidents.find(item => item.id === incidentId) || selectedIncident;
    if (!canManageIncident(incident)) return;
    if (showTrustedTimeGateDialog()) return;
    const trustedTimestamp = createTrustedTimestampRecord();
    const trustedNow = new Date(trustedTimestamp.occurredAtTrustedMs);
    const createdAt = trustedTimestamp.occurredAtTrustedIso;
    const time = formatAppTime(trustedNow);
    const date = formatAppDate(trustedNow);

    const localPhotoUrl = newProgress.photoUrl;
    const progressId = `progress-${trustedTimestamp.occurredAtTrustedMs}-${Math.random().toString(36).slice(2, 8)}`;
    const progressRecord = {
      id: progressId,
      ...newProgress,
      comment: sanitizeMultilineText(newProgress.comment, 240),
      photoUrl: localPhotoUrl,
      time,
      date,
      author: currentUser,
      createdAt,
      ...trustedTimestamp,
    };
    const domainProgressRecord = {
      ...progressRecord,
      photoUrl: stripLocalAssetUrlSync(localPhotoUrl),
    };
    const baseMeta = incidentMeta[incidentId] || {};
    const nextMeta = mergeIncidentMetaCollection({
      [incidentId]: baseMeta,
    }, {
      [incidentId]: {
        status: baseMeta.status || 'open',
        progress: [progressRecord],
      },
    })[incidentId];
    const domainMeta = mergeIncidentMetaCollection({
      [incidentId]: baseMeta,
    }, {
      [incidentId]: {
        status: baseMeta.status || 'open',
        progress: [domainProgressRecord],
      },
    })[incidentId];

    // Simpan state dengan URL lokal dulu (instan muncul di UI)
    setIncidentMeta(prev => mergeIncidentMetaCollection(prev, {
      [incidentId]: {
        status: prev[incidentId]?.status || 'open',
        progress: [progressRecord],
      },
    }));
    appendNotifications([{
      type: 'incident_progress_updated',
      title: 'Update temuan baru',
      message: `${incident?.location || 'Temuan'} mendapat update baru dari ${currentUser}.`,
      senderName: currentUser,
      senderRole: currentUserRole,
      targetUserIds: getShipRecipients(incident?.shipName || operationalShipName, { includeAdmins: true, includePic: true, includePetugas: true, includeUserIds: incident?.reportedBy ? usersData.filter(user => user.name === incident.reportedBy).map(user => user.id) : [] }),
      route: 'incidents/detail',
      routeParams: { incidentId },
      incidentId,
      shipName: incident?.shipName || operationalShipName,
      dedupeKey: `incident-progress:${incidentId}:${progressId}`,
      createdAt,
    }]);
    setNewProgress({ comment: '', photoUrl: null });

    void syncIncidentDetailToDomain(incident, domainMeta || nextMeta, {
      incidentId,
      clientUpdatedAt: trustedTimestamp.occurredAtClientMs,
      updatedAt: createdAt,
      updatedBy: currentUser,
      appendProgressItems: [domainProgressRecord],
    });
    requestCloudSync('urgent');

    if (isLocalOnlyAssetUrl(localPhotoUrl)) {
      void syncIncidentDomainMediaUpload({
        incidentId,
        incident,
        group: 'progress',
        item: progressRecord,
        photoUrl: localPhotoUrl,
        clientUpdatedAt: trustedTimestamp.occurredAtClientMs,
        updatedAt: createdAt,
        updatedBy: currentUser,
      });
    }
  }, [allIncidents, appendNotifications, canManageIncident, currentUser, currentUserRole, getShipRecipients, incidentMeta, newProgress, operationalShipName, requestCloudSync, selectedIncident, showTrustedTimeGateDialog, syncIncidentDetailToDomain, syncIncidentDomainMediaUpload, usersData]);
  const handleAddIncidentDocumentation = useCallback(async (incidentId) => {
    const incident = allIncidents.find(item => item.id === incidentId) || selectedIncident;
    if (!canManageIncident(incident)) return;
    if (showTrustedTimeGateDialog()) return;
    const dataUrl = await pickLocalImage();
    if (!dataUrl) return;
    const photoUrlFromCamera = await saveImageToDB(dataUrl);
    if (!photoUrlFromCamera) return;

    const trustedTimestamp = createTrustedTimestampRecord();
    const trustedNow = new Date(trustedTimestamp.occurredAtTrustedMs);
    const createdAt = trustedTimestamp.occurredAtTrustedIso;
    const time = formatAppTime(trustedNow);
    const date = formatAppDate(trustedNow);

    const docId = `doc-${trustedTimestamp.occurredAtTrustedMs}-${Math.random().toString(36).slice(2, 8)}`;
    const documentationRecord = {
      id: docId,
      photoUrl: photoUrlFromCamera,
      createdAt,
      date,
      time,
      author: currentUser,
      ...trustedTimestamp,
    };
    const domainDocumentationRecord = {
      ...documentationRecord,
      photoUrl: stripLocalAssetUrlSync(photoUrlFromCamera),
    };
    const baseMeta = incidentMeta[incidentId] || {};
    const domainMeta = mergeIncidentMetaCollection({
      [incidentId]: baseMeta,
    }, {
      [incidentId]: {
        status: baseMeta.status || 'open',
        documentation: [domainDocumentationRecord],
      },
    })[incidentId];

    setIncidentMeta((previousMeta) => ({
      ...previousMeta,
      [incidentId]: {
        ...previousMeta[incidentId],
        status: previousMeta[incidentId]?.status || 'open',
        documentation: [
          documentationRecord,
          ...(previousMeta[incidentId]?.documentation || []),
        ],
      },
    }));

    void syncIncidentDetailToDomain(incident, domainMeta, {
      incidentId,
      clientUpdatedAt: trustedTimestamp.occurredAtClientMs,
      updatedAt: createdAt,
      updatedBy: currentUser,
      appendDocumentationItems: [domainDocumentationRecord],
    });
    requestCloudSync('urgent');

    void syncIncidentDomainMediaUpload({
      incidentId,
      incident,
      group: 'documentation',
      item: documentationRecord,
      photoUrl: photoUrlFromCamera,
      clientUpdatedAt: trustedTimestamp.occurredAtClientMs,
      updatedAt: createdAt,
      updatedBy: currentUser,
    });
  }, [allIncidents, canManageIncident, currentUser, incidentMeta, requestCloudSync, selectedIncident, showTrustedTimeGateDialog, syncIncidentDetailToDomain, syncIncidentDomainMediaUpload]);
  const handleUpdateIncidentInfo = useCallback((incidentId, updates) => {
    const incident = allIncidents.find(item => item.id === incidentId) || selectedIncident;
    if (!incident || !canManageIncident(incident)) return false;
    const trustedTimestamp = createTrustedTimestampRecord();
    const updatedAt = trustedTimestamp.occurredAtTrustedIso;

    const nextIncidentInfo = {
      deskripsi: sanitizeMultilineText(updates?.deskripsi || '', 320),
      penyebab: sanitizeMultilineText(updates?.penyebab || '', 240),
      tindakLanjut: sanitizeMultilineText(updates?.tindakLanjut || '', 240),
    };
    const baseMeta = incidentMeta[incidentId] || {};
    const nextMeta = mergeIncidentMetaCollection({
      [incidentId]: baseMeta,
    }, {
      [incidentId]: {
        ...baseMeta,
        infoOverrides: nextIncidentInfo,
      },
    })[incidentId];

    setIncidentMeta((previousMeta) => mergeIncidentMetaCollection(previousMeta, {
      [incidentId]: {
        ...previousMeta[incidentId],
        infoOverrides: nextIncidentInfo,
      },
    }));

    if (!incident.readOnly && typeof incidentId === 'string' && incidentId.startsWith('p-')) {
      const activeCheckpointForIncident = Object.values(checkpointsByShip)
        .flat()
        .find((checkpoint) => createPatrolIncidentId(checkpoint) === incidentId && !checkpoint.readOnly);
      const updatedCheckpointForDomain = activeCheckpointForIncident
        ? {
          ...activeCheckpointForIncident,
          kejadian: nextIncidentInfo.deskripsi,
          penyebab: nextIncidentInfo.penyebab,
          tindakLanjut: nextIncidentInfo.tindakLanjut,
          updatedAt,
        }
        : null;
      setCheckpointsByShip((previousState) => Object.fromEntries(
        Object.entries(previousState).map(([shipId, shipCheckpoints]) => ([
          shipId,
          shipCheckpoints.map((checkpoint) => {
            if (createPatrolIncidentId(checkpoint) !== incidentId || checkpoint.readOnly) return checkpoint;
            return {
              ...checkpoint,
              kejadian: nextIncidentInfo.deskripsi,
              penyebab: nextIncidentInfo.penyebab,
              tindakLanjut: nextIncidentInfo.tindakLanjut,
              updatedAt,
            };
          }),
        ])),
      ));
      if (updatedCheckpointForDomain) {
        void syncPatrolReportToDomain(updatedCheckpointForDomain, {
          skipMediaUpload: true,
        });
      }
    } else if (!incident.readOnly) {
      setIncidentsData((previousIncidents) => previousIncidents.map((entry) => (
        entry.id === incidentId
          ? {
            ...entry,
            deskripsi: nextIncidentInfo.deskripsi,
            penyebab: nextIncidentInfo.penyebab,
            tindakLanjut: nextIncidentInfo.tindakLanjut,
            updatedAt,
          }
          : entry
      )));
    }

    setSelectedIncident((previousIncident) => (
      previousIncident?.id === incidentId
        ? { ...previousIncident, ...nextIncidentInfo }
        : previousIncident
    ));

    void syncIncidentDetailToDomain({
      ...incident,
      ...nextIncidentInfo,
      updatedAt,
    }, nextMeta, {
      incidentId,
      clientUpdatedAt: trustedTimestamp.occurredAtClientMs,
      updatedAt,
      updatedBy: currentUser,
    });
    requestCloudSync('urgent');

    return true;
  }, [allIncidents, canManageIncident, checkpointsByShip, currentUser, incidentMeta, requestCloudSync, selectedIncident, syncIncidentDetailToDomain, syncPatrolReportToDomain]);
  const handleCloseIncident = useCallback((incidentId) => {
    const incident = allIncidents.find(item => item.id === incidentId) || selectedIncident;
    if (!canCloseIncident(incident)) return;
    setConfirmDialog({
      title: incident?.isSOS ? 'Tutup Laporan SOS' : 'Tutup Laporan',
      message: incident?.isSOS ? 'Apakah Anda yakin kondisi SOS ini sudah selesai ditangani?' : 'Apakah Anda yakin masalah ini sudah selesai diselesaikan?',
      confirmText: 'YA, TUTUP',
      cancelText: 'BELUM',
      onConfirm: () => {
        if (showTrustedTimeGateDialog()) return;
        const trustedTimestamp = createTrustedTimestampRecord();
        const createdAt = trustedTimestamp.occurredAtTrustedIso;
        setIncidentMeta(prev => mergeIncidentMetaCollection(prev, {
          [incidentId]: {
            ...(prev[incidentId] || {}),
            status: 'closed',
          },
        }));
        if (incident?.isSOS) {
          const resolvedSOS = {
            ...(activeSOSAlert?.id === incidentId ? activeSOSAlert : incident),
            status: 'resolved',
            resolvedAt: createdAt,
            resolvedBy: currentUser || 'Sistem',
            resolvedAtClientMs: trustedTimestamp.occurredAtClientMs,
            resolvedTimeTrustLevel: trustedTimestamp.timeTrustLevel,
            resolvedClockTamperDetected: trustedTimestamp.clockTamperDetected,
            updatedAt: createdAt,
            updatedAtClientMs: trustedTimestamp.occurredAtClientMs,
            updatedTimeTrustLevel: trustedTimestamp.timeTrustLevel,
            updatedClockTamperDetected: trustedTimestamp.clockTamperDetected,
          };
          setActiveSOSAlert((previousAlert) => (
            previousAlert?.id === incidentId ? null : previousAlert
          ));
          setSosHistory((previousHistory) => upsertSOSHistoryEntry(previousHistory, resolvedSOS));
        }
        appendNotifications([{
          type: incident?.isSOS ? 'sos_closed' : 'incident_closed',
          title: incident?.isSOS ? 'SOS ditutup' : 'Temuan ditutup',
          message: `${incident?.location || (incident?.isSOS ? 'SOS' : 'Temuan')} telah ditutup oleh ${currentUser}.`,
          senderName: currentUser,
          senderRole: currentUserRole,
          targetUserIds: getShipRecipients(incident?.shipName || operationalShipName, { includeAdmins: true, includePic: true, includePetugas: true, includeUserIds: incident?.reportedBy ? usersData.filter(user => user.name === incident.reportedBy).map(user => user.id) : [] }),
          route: 'incidents/detail',
          routeParams: { incidentId },
          incidentId,
          shipName: incident?.shipName || operationalShipName,
          dedupeKey: incident?.isSOS ? `sos-closed:${incidentId}` : `incident-closed:${incidentId}`,
          createdAt,
        }]);
        void syncIncidentDetailToDomain({
          ...incident,
          status: 'closed',
          updatedAt: createdAt,
        }, {
          ...(incidentMeta[incidentId] || {}),
          status: 'closed',
        }, {
          incidentId,
          clientUpdatedAt: trustedTimestamp.occurredAtClientMs,
          updatedAt: createdAt,
          updatedBy: currentUser,
        });
        requestCloudSync('urgent');
      }
    });
  }, [activeSOSAlert, allIncidents, appendNotifications, canCloseIncident, currentUser, currentUserRole, getShipRecipients, incidentMeta, operationalShipName, requestCloudSync, selectedIncident, showTrustedTimeGateDialog, syncIncidentDetailToDomain, usersData]);
  const handleDeleteIncident = useCallback((incidentId) => {
    if (!isAdmin) return;

    const incident = allIncidents.find(item => item.id === incidentId) || selectedIncident;
    if (!incident) return;

    setConfirmDialog({
      title: incident.isSOS ? 'Hapus SOS' : 'Hapus Temuan',
      message: `Anda yakin ingin menghapus ${incident.isSOS ? 'SOS' : 'temuan'} ${incident.location || 'ini'}?`,
      confirmText: 'YA, HAPUS',
      cancelText: 'BATAL',
      onConfirm: () => {
        if (incident.isSOS) {
          setActiveSOSAlert((previousAlert) => (
            previousAlert?.id === incidentId ? null : previousAlert
          ));
          setSosHistory((previousHistory) => previousHistory.filter((entry) => entry.id !== incidentId));
          setIncidentMeta((previousMeta) => ({
            ...previousMeta,
            [incidentId]: {
              ...(previousMeta[incidentId] || {}),
              deleted: true,
            },
          }));
          void deleteSosAlert(incidentId);
        } else if (incident.isPatrol) {
          let removedFromActiveShift = false;

          setCheckpointsByShip((previousState) => Object.fromEntries(
            Object.entries(previousState).map(([shipId, shipCheckpoints]) => ([
              shipId,
              shipCheckpoints.map((checkpoint) => {
                if (createPatrolIncidentId(checkpoint) !== incidentId) return checkpoint;
                removedFromActiveShift = true;
                return resetCheckpointForShift(checkpoint, {
                  shiftKey: currentShiftMeta.key,
                  pendingOrigin: 'manual-reset',
                });
              }),
            ])),
          ));

          if (!removedFromActiveShift) {
            setIncidentMeta((previousMeta) => ({
              ...previousMeta,
              [incidentId]: {
                ...(previousMeta[incidentId] || {}),
                deleted: true,
              },
            }));
          } else {
            setIncidentMeta((previousMeta) => {
              if (!previousMeta[incidentId]) return previousMeta;
              const nextMeta = { ...previousMeta };
              delete nextMeta[incidentId];
              return nextMeta;
            });
          }
          void deletePatrolReport({
            checkpointId: incident.checkpointId,
            shiftKey: incident.shiftKey,
            shipId: incident.shipId,
            photoUrl: incident.photoUrl,
          });
        } else {
          const deletedAt = new Date().toISOString();
          setDeletedRecords((previousDeletedRecords) => markDeletedRecord(previousDeletedRecords, 'incidents', incidentId, deletedAt));
          setIncidentsData((previousIncidents) => previousIncidents.filter((entry) => entry.id !== incidentId));
          setIncidentMeta((previousMeta) => {
            if (!previousMeta[incidentId]) return previousMeta;
            const nextMeta = { ...previousMeta };
            delete nextMeta[incidentId];
            return nextMeta;
          });
          // Dual-write: hapus dokumen incident dari collection domain (beserta foto Storage)
          void deleteIncidentReport(incidentId, incident.photoUrl);
        }

        setSelectedIncident((previousIncident) => (
          previousIncident?.id === incidentId ? null : previousIncident
        ));
        requestCloudSync('urgent');
      },
    });
  }, [allIncidents, currentShiftMeta.key, deleteIncidentReport, deletePatrolReport, deleteSosAlert, isAdmin, requestCloudSync, selectedIncident]);
  const handlePhotoProgress = useCallback(() => {
    setPendingPatrolCameraCapture({
      id: 'incident-progress',
      type: 'temuan',
      intent: 'incident-progress',
    });
  }, []);
  const handleUpdateIncidentPhoto = useCallback(async (incidentId) => {
    const dataUrl = await pickLocalImage();
    if (!dataUrl) return;
    const url = await saveImageToDB(dataUrl);
    if (!url) return;
    if (typeof incidentId === 'string' && incidentId.startsWith('p-')) {
      const activeCheckpointForIncident = Object.values(checkpointsByShip)
        .flat()
        .find((checkpoint) => createPatrolIncidentId(checkpoint) === incidentId && !checkpoint.readOnly);
      const updatedCheckpointForDomain = activeCheckpointForIncident
        ? { ...activeCheckpointForIncident, photoUrl: url }
        : null;
      setCheckpointsByShip(previousState => Object.fromEntries(
        Object.entries(previousState).map(([shipId, shipCheckpoints]) => ([
          shipId,
          shipCheckpoints.map(checkpoint => (
            createPatrolIncidentId(checkpoint) === incidentId && !checkpoint.readOnly
              ? { ...checkpoint, photoUrl: url }
              : checkpoint
          )),
        ])),
      ));
      if (updatedCheckpointForDomain) {
        void syncPatrolReportToDomain(updatedCheckpointForDomain);
      }
    } else {
      setIncidentsData(prev => prev.map(inc => inc.id === incidentId ? { ...inc, photoUrl: url } : inc));
      const incident = allIncidents.find(item => item.id === incidentId) || selectedIncident;
      if (incident && !incident.isSOS) {
        void syncIncidentDetailToDomain({
          ...incident,
          photoUrl: stripLocalAssetUrlSync(url),
        }, incidentMeta[incidentId] || {}, {
          incidentId,
          clientUpdatedAt: Date.now(),
          updatedAt: new Date().toISOString(),
          updatedBy: currentUser,
        });
      }
    }
    setSelectedIncident(prev => prev && prev.id === incidentId ? { ...prev, photoUrl: url } : prev);
    requestCloudSync('urgent');
  }, [allIncidents, checkpointsByShip, currentUser, incidentMeta, requestCloudSync, selectedIncident, syncIncidentDetailToDomain, syncPatrolReportToDomain]);

  // Ship form handlers
  const handleSaveShip = useCallback(() => {
    if (!isAdmin) return;
    const safeName = sanitizeText(shipFormData.name, 80);
    if (!safeName) return;
    const newShip = normalizeShipRecord({
      id: 's' + Date.now(),
      ...shipFormData,
      name: safeName,
      imoNumber: sanitizeText(shipFormData.imoNumber, 20),
      routeLoading: sanitizeText(shipFormData.routeLoading, 100),
      routeDischarge: sanitizeText(shipFormData.routeDischarge, 100),
      cargoType: sanitizeText(shipFormData.cargoType, 80),
      cargoAmount: sanitizeText(shipFormData.cargoAmount, 40),
      defaultCheckpointsInitialized: true,
      customCheckpoints: normalizeShipCheckpointDefinitions(shipFormData.customCheckpoints),
      lat: '-6.0000',
      lng: '106.0000',
      personnel: [],
      personnelNextMonth: [],
      documents: [],
      photoUrl: shipFormData.photoUrl || createPosterDataUrl(safeName, 'Armada Lokal', 2, false),
    });
    setShipsData(prev => [...prev, newShip]);
    setShowShipForm(false);
    setShipFormData(createShipFormState());
    setNewCheckpoint('');
  }, [isAdmin, shipFormData]);
  const handleAddCheckpointToForm = useCallback(() => {
    setNewCheckpoint((previousValue) => {
      const safeName = sanitizeText(previousValue, 80);
      if (!safeName) return previousValue;
      setShipFormData((formData) => {
        if (formData.customCheckpoints.some(checkpoint => createCheckpointNameKey(checkpoint.name) === createCheckpointNameKey(safeName))) {
          return formData;
        }
        return {
          ...formData,
          customCheckpoints: [
            ...formData.customCheckpoints,
            { name: safeName, desc: '', isDefault: false },
          ],
        };
      });
      return '';
    });
  }, []);
  const handleRemoveCheckpointFromForm = useCallback((index) => {
    setShipFormData((previousFormData) => {
      return {
        ...previousFormData,
        customCheckpoints: previousFormData.customCheckpoints.filter((_, checkpointIndex) => checkpointIndex !== index),
      };
    });
  }, []);

  // Auth handlers
  const clearOperationalSessionState = useCallback(() => {
    setSessionUserId(null);
    setAuthAccessState(null);
    setAuthAccessBusy(false);
    setPendingRegistrations([]);
    setCurrentPage('home');
    setActiveShipId(null);
    setSelectedIncident(null);
    setSelectedReportDetail(null);
    setSelectedUser(null);
    setSelectedHistoryId(null);
    setShowUserForm(false);
    setShowShipForm(false);
    setShowShipDocForm(false);
    setShowNotificationsDropdown(false);
    setNotificationReturnPage('home');
    hasAppliedRoleLandingRef.current = false;
    setActiveForms({});
    setPendingPatrolCameraCapture(null);
    setNewProgress({ comment: '', photoUrl: null });
    setNewShipDoc(createShipDocumentState());
    setAuthMode('login');
  }, []);
  const resetAuthSession = useCallback((message = 'Sesi Anda telah berakhir. Silakan login kembali.') => {
    clearOperationalSessionState();
    setAuthError('');
    setAuthNotice(message);
    setAuthForm(createAuthFormState());
  }, [clearOperationalSessionState]);
  const handleLogout = useCallback(async (message = 'Sesi Anda telah berakhir. Silakan login kembali.') => {
    // Hapus langganan push device ini agar akun lain di device sama tidak menerima
    // notifikasi milik user yang baru saja logout (best-effort; jangan blok logout).
    const pushToken = activePushTokenRef.current;
    if (pushToken) {
      activePushTokenRef.current = '';
      try { await removePushSubscription(pushToken); } catch { /* abaikan */ }
    }
    if (firebaseAuthUser) {
      try {
        await logoutFirebaseUser();
      } catch (error) {
        console.error('Gagal logout Supabase', error);
      }
    }
    resetAuthSession(message);
  }, [firebaseAuthUser, resetAuthSession]);
  const finalizeAuthorizedLogin = useCallback((resolvedUser) => {
    const landingPage = getDefaultPageForRole(resolvedUser.role);
    setSessionUserId(resolvedUser.id);
    setCurrentPage(landingPage);
    setActiveShipId(null);
    setNotificationReturnPage(landingPage);
    hasAppliedRoleLandingRef.current = true;
    setAuthMode('login');
    setAuthForm(createAuthFormState());
  }, []);
  const handleLogin = useCallback(async () => {
    const safeEmail = sanitizeEmail(authForm.email);
    const passwordInput = sanitizeText(authForm.password, 120);
    if (!safeEmail || !passwordInput) {
      setAuthError('Email dan password wajib diisi.');
      return;
    }
    if (!isFirebaseAuthEnabled) {
      setAuthError('Supabase Auth tidak aktif pada build aplikasi ini. Muat ulang aplikasi, hapus cache PWA bila perlu, lalu pastikan bundle yang dideploy memuat config Supabase SmartPatrol.');
      return;
    }

    setAuthBusy(true);
    setAuthAccessBusy(true);
    setAuthError('');
    setAuthNotice('');

    try {
      const localUser = usersData.find(item => (item.email || '').toLowerCase() === safeEmail) || null;
      const credential = await loginWithFirebaseEmail(safeEmail, passwordInput);
      setFirebaseAuthUser(credential.user);
      setFirebaseAuthReady(true);
      const accessResult = await resolveOperationalAccess();
      setAuthAccessState(accessResult || null);

      if (!accessResult?.access) {
        await logoutFirebaseUser();
        clearOperationalSessionState();
        if (accessResult?.status === 'pending') {
          setAuthError('Registrasi Anda masih menunggu approval admin.');
          return;
        }
        if (accessResult?.status === 'rejected') {
          setAuthError('Registrasi Anda ditolak admin. Hubungi admin operasional.');
          return;
        }
        setAuthError('Akun Supabase ini belum memiliki akses operasional SmartPatrol.');
        return;
      }

      const resolvedUser = buildOperationalUserRecordFromAccess({
        access: accessResult.access,
        profile: accessResult.profile,
        authUser: credential.user,
        existingUser: localUser,
        users: usersData,
      });
      setUsersData((previousUsers) => upsertOperationalUserRecord(previousUsers, {
        access: accessResult.access,
        profile: accessResult.profile,
        authUser: credential.user,
      }));

      if (!accessResult.access.enabled || !canUserAccessApplication(resolvedUser)) {
        await logoutFirebaseUser();
        clearOperationalSessionState();
        setAuthError('Akun Anda sudah tervalidasi, tetapi belum aktif untuk operasi. Tunggu assignment admin.');
        return;
      }

      finalizeAuthorizedLogin(resolvedUser);
    } catch (error) {
      try {
        await logoutFirebaseUser();
      } catch {
        // Abaikan cleanup logout jika login memang gagal sebelum sesi Supabase terbentuk.
      }
      clearOperationalSessionState();
      setAuthError(getFirebaseAuthErrorMessage(error));
    } finally {
      setAuthBusy(false);
      setAuthAccessBusy(false);
    }
  }, [authForm, finalizeAuthorizedLogin, usersData]);
  const handleRegister = useCallback(async () => {
    const safeName = sanitizeText(authForm.name, 80);
    const safeEmail = sanitizeEmail(authForm.email);
    const passwordInput = sanitizeText(authForm.password, 120);
    const confirmPassword = sanitizeText(authForm.confirmPassword, 120);
    const safeType = sanitizeText(authForm.type, 20) || 'BUJP';
    const safeWorkerNumber = sanitizeText(authForm.workerNumber, 40);
    const safePhone = sanitizePhone(authForm.phone);
    const existingUser = usersData.find(user => (user.email || '').toLowerCase() === safeEmail) || null;

    if (!safeName || !safeEmail || !passwordInput || !confirmPassword) {
      setAuthError('Nama, email, password, dan konfirmasi password wajib diisi.');
      return;
    }
    if (passwordInput.length < 8) {
      setAuthError('Password minimal 8 karakter.');
      return;
    }
    if (passwordInput !== confirmPassword) {
      setAuthError('Konfirmasi password belum sama.');
      return;
    }
    if (existingUser && isFirebaseManagedUser(existingUser)) {
      setAuthError('Email ini sudah terdaftar di Supabase.');
      return;
    }
    if (!isFirebaseAuthEnabled) {
      setAuthError('Supabase Auth belum aktif. Registrasi cloud belum bisa dipakai.');
      return;
    }

    publicRegistrationFlowRef.current = true;
    setAuthBusy(true);
    setAuthAccessBusy(true);
    setAuthError('');
    setAuthNotice('');

    try {
      const credential = await registerWithFirebaseEmail(safeEmail, passwordInput, {
        display_name: safeName,
        name: safeName,
        phone: safePhone,
        type: safeType,
        worker_number: safeWorkerNumber,
        smartpatrol_registration_flow: 'public',
      });
      const hasRegistrationSession = Boolean(credential?.session?.access_token);
      let uploadedPhoto = {
        photoUrl: '',
        photoPath: '',
      };

      if (authForm.photoUrl && hasRegistrationSession) {
        try {
          uploadedPhoto = await uploadRegistrationPhotoAsset({
            uid: credential.user.uid,
            photoUrl: authForm.photoUrl,
          });
        } catch (photoError) {
          console.error('Gagal upload foto registrasi ke storage onboarding', photoError);
        }
      }

      if (hasRegistrationSession) {
        await createPendingRegistration({
          uid: credential.user.uid,
          email: safeEmail,
          name: safeName,
          phone: safePhone,
          photoUrl: uploadedPhoto.photoUrl,
          photoPath: uploadedPhoto.photoPath,
          type: safeType,
          workerNumber: safeWorkerNumber,
        });
      }

      await logoutFirebaseUser();
      setSessionUserId(null);
      setAuthAccessState(null);
      setAuthMode('login');
      setCurrentPage('home');
      setNotificationReturnPage('home');
      setAuthForm(createAuthFormState({ email: safeEmail }));
      setAuthNotice('Registrasi berhasil dikirim. Silakan tunggu approval admin sebelum akun diaktifkan.');
      setConfirmDialog({
        title: 'Registrasi Berhasil',
        message: 'Akun Anda sudah terdaftar di antrean onboarding SmartPatrol. Silakan tunggu approval admin sebelum login operasional dijalankan.',
        confirmText: 'MENGERTI',
        isAlert: true,
        onConfirm: () => { },
      });
    } catch (error) {
      try {
        await logoutFirebaseUser();
      } catch {
        // Abaikan cleanup logout jika registrasi gagal sebelum sesi Supabase terbentuk.
      }
      setAuthAccessState(null);
      setAuthError(getFirebaseAuthErrorMessage(error));
      publicRegistrationFlowRef.current = false;
    } finally {
      setAuthBusy(false);
      setAuthAccessBusy(false);
    }
  }, [authForm, usersData]);

  // Persistence effects
  useEffect(() => {
    const timerId = setTimeout(() => {
      savePersistedState({
        ...sharedState,
        theme,
      }, {
        sessionUserId,
      });
    }, 1000); // Debounce local persistence 1s
    return () => clearTimeout(timerId);
  }, [sessionUserId, sharedState, theme]);
  useEffect(() => {
    if (!isCloudSyncEnabled || !hasOperationalCloudAccess) return () => { };

    return subscribeToCloudAppState((cloudPayload) => {
      handleIncomingCloudPayloadRef.current?.(cloudPayload, {
        source: 'realtime-snapshot',
        clearWhenEmpty: true,
      });
    }, (error) => {
      setCloudSyncBootstrapped(true);
      console.error('Gagal subscribe data patroli cloud', error);
    });
  }, [hasOperationalCloudAccess]);
  useEffect(() => {
    if (!isCloudSyncEnabled || !hasOperationalCloudAccess || !currentShiftMeta?.key) return () => { };
    if (patrolReportSubscriptionTargets.length === 0) return () => { };

    const unsubscribers = patrolReportSubscriptionTargets.map((target) => (
      subscribeToPatrolReports({
        shiftKey: currentShiftMeta.key,
        shipId: target.shipId,
        shipName: target.shipName,
      }, applyPatrolReportDocuments, (error) => {
        console.error('Gagal subscribe domain laporan patroli', error);
      })
    ));

    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, [applyPatrolReportDocuments, currentShiftMeta.key, hasOperationalCloudAccess, patrolReportSubscriptionTargets]);
  useEffect(() => {
    if (!isCloudSyncEnabled || !hasOperationalCloudAccess) return () => { };

    const unsubIncidents = subscribeToIncidents((incidentDocuments) => {
      if (!Array.isArray(incidentDocuments) || incidentDocuments.length === 0) return;
      const {
        incidents: domainIncidents,
        incidentMeta: domainIncidentMeta,
      } = splitIncidentDomainDocuments(incidentDocuments);

      setIncidentsData((prevIncidents) => {
        const mergedIncidents = mergeIncidentsCollection(prevIncidents, domainIncidents);
        return serializeSharedStateSnapshot(mergedIncidents) === serializeSharedStateSnapshot(prevIncidents)
          ? prevIncidents
          : mergedIncidents;
      });
      if (Object.keys(domainIncidentMeta).length > 0) {
        setIncidentMeta((previousMeta) => {
          const mergedMeta = mergeIncidentMetaCollection(previousMeta, domainIncidentMeta);
          return serializeSharedStateSnapshot(mergedMeta) === serializeSharedStateSnapshot(previousMeta)
            ? previousMeta
            : mergedMeta;
        });
      }
    }, (error) => {
      console.error('Gagal subscribe domain laporan temuan', error);
    });

    return () => {
      unsubIncidents();
    };
  }, [hasOperationalCloudAccess]);

  // Subscribe ke shift_history_entries — history yang dibuat server-side oleh cron job.
  // Merge ke historyEntries agar tab History terisi otomatis walau app tidak terbuka saat shift berakhir.
  useEffect(() => {
    if (!isCloudSyncEnabled || !hasOperationalCloudAccess) return () => { };

    const unsubShiftHistory = subscribeToShiftHistoryEntries(
      (rows) => {
        if (!Array.isArray(rows) || rows.length === 0) return;
        const serverEntries = rows.map((row) => {
          // Bentuk key identik dengan createHistoryEntryKey di client
          const shipToken = String(row.ship_id || 'ship')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/(^-|-$)/g, '') || 'ship';
          const key = `${shipToken}|${row.shift_key}`;
          const id  = `history-${key}`;
          return {
            id,
            key,
            date:    formatDateLabel(row.date_key),
            dateKey: row.date_key,
            shift:   row.shift_label,
            shiftId: row.shift_id,
            time:    row.time_range,
            ship:    row.ship_name,
            createdAt: row.finalized_at,
            isLive:    false,
            readOnly:  true,
            summary: {
              aman:      row.aman_count   || 0,
              temuan:    row.temuan_count || 0,
              missed:    row.missed_count || 0,
              total:     row.total_count  || 0,
              completed: (row.aman_count || 0) + (row.temuan_count || 0),
              pending:   0,
            },
            checkpoints:  Array.isArray(row.checkpoints)   ? row.checkpoints   : [],
            crewSnapshot: Array.isArray(row.crew_snapshot) ? row.crew_snapshot : [],
          };
        });
        setHistoryEntries((prev) => mergeHistoryEntries(prev, serverEntries));
      },
      (error) => {
        console.error('Gagal subscribe shift history entries', error);
      },
    );

    return () => { unsubShiftHistory(); };
  }, [hasOperationalCloudAccess, isCloudSyncEnabled]);

  useEffect(() => {
    const hasLocalIncidentMedia = Object.values(incidentMeta || {}).some((meta) => (
      ensureArray(meta?.documentation).some((item) => isLocalOnlyAssetUrl(item?.photoUrl))
      || ensureArray(meta?.progress).some((item) => isLocalOnlyAssetUrl(item?.photoUrl))
    ));

    if (!isCloudSyncEnabled || !isCloudWriteEnabled || !hasOperationalCloudAccess || isOffline || !hasLocalIncidentMedia) {
      return () => { };
    }

    void flushIncidentDomainLocalMediaQueue();
    const timerId = setInterval(() => {
      void flushIncidentDomainLocalMediaQueue();
    }, RETRY_QUEUE_INTERVAL_MS);

    return () => clearInterval(timerId);
  }, [flushIncidentDomainLocalMediaQueue, hasOperationalCloudAccess, incidentMeta, isOffline]);
  useEffect(() => {
    if (!isCloudSyncEnabled || !isCloudWriteEnabled || !hasOperationalCloudAccess || isOffline) return () => { };
    if (patrolReportSubscriptionTargets.length === 0) return () => { };

    const timerId = setTimeout(() => {
      patrolReportSubscriptionTargets.forEach((target) => {
        ensureArray(checkpointsByShip?.[target.shipId])
          .filter((checkpoint) => (
            checkpoint?.status === 'completed'
            || getCheckpointPendingOrigin(checkpoint) === 'manual-reset'
          ))
          .forEach((checkpoint) => {
            void syncPatrolReportToDomain(checkpoint);
          });
      });
    }, 500);

    return () => clearTimeout(timerId);
  }, [checkpointsByShip, hasOperationalCloudAccess, isOffline, patrolReportSubscriptionTargets, syncPatrolReportToDomain]);
  useEffect(() => {
    if (!isCloudSyncEnabled || !hasOperationalCloudAccess) return () => { };

    let isDisposed = false;

    const clearPendingRefresh = () => {
      if (cloudSignalRefreshTimerRef.current !== null && typeof window !== 'undefined') {
        window.clearTimeout(cloudSignalRefreshTimerRef.current);
        cloudSignalRefreshTimerRef.current = null;
      }
    };

    const runSignalRefresh = async (signal, attempt = 0) => {
      if (isDisposed) return;
      const expectedClientUpdatedAt = resolveExternalTimestampMs(signal?.clientUpdatedAt) || 0;
      if (expectedClientUpdatedAt > 0 && lastCloudClientUpdatedAtRef.current >= expectedClientUpdatedAt) {
        return;
      }

      await refreshCloudSharedStateRef.current?.({
        source: attempt === 0 ? 'signal-refresh' : `signal-refresh-${attempt}`,
        preferServer: true,
        clearWhenEmpty: false,
      });

      if (isDisposed) return;
      if (expectedClientUpdatedAt > 0 && lastCloudClientUpdatedAtRef.current >= expectedClientUpdatedAt) {
        return;
      }
      if (attempt >= 5) return;

      const retryDelayMs = attempt === 0
        ? 100
        : Math.min(1500, 300 + (attempt * 200));

      if (typeof window !== 'undefined') {
        cloudSignalRefreshTimerRef.current = window.setTimeout(() => {
          runSignalRefresh(signal, attempt + 1);
        }, retryDelayMs);
      }
    };

    const unsubscribe = subscribeToCloudSyncSignal((signalPayload) => {
      const signal = signalPayload?.signal && typeof signalPayload.signal === 'object'
        ? signalPayload.signal
        : null;
      const revision = sanitizeText(signal?.revision || '', 160);

      if (!signal || !revision) return;
      if (signal.instanceId === appInstanceIdRef.current) return;
      if (revision === lastCloudSignalRevisionRef.current) return;

      lastCloudSignalRevisionRef.current = revision;

      logCloudSyncDebug('signal-received', {
        reason: signal.reason || 'state-sync',
        priority: signal.priority || 'normal',
        clientUpdatedAt: signal.clientUpdatedAt || null,
      });

      if (signal.activeSOSAlert) {
        const currentSOS = (
          activeSOSAlertRef.current?.id === signal.activeSOSAlert.id
            ? activeSOSAlertRef.current
            : sosHistoryRef.current.find((entry) => entry.id === signal.activeSOSAlert.id)
        ) || null;
        const mergedSOS = mergeSOSRecords(currentSOS || {}, signal.activeSOSAlert);

        setSosHistory((previousHistory) => upsertSOSHistoryEntry(previousHistory, mergedSOS));
        setActiveSOSAlert((previousAlert) => (
          resolveLatestActiveSOSAlert(mergeSOSHistoryCollection(
            [...(Array.isArray(sosHistoryRef.current) ? sosHistoryRef.current : []), previousAlert].filter(Boolean),
            [mergedSOS],
          ))
        ));
      }

      clearPendingRefresh();
      runSignalRefresh(signal, 0);
    }, (error) => {
      console.error('Gagal subscribe sinyal sinkronisasi cloud', error);
    });
    return () => {
      isDisposed = true;
      clearPendingRefresh();
      unsubscribe();
    };
  }, [hasOperationalCloudAccess]);
  useEffect(() => {
    if (!isCloudSyncEnabled || !hasOperationalCloudAccess) return () => { };

    let isDisposed = false;

    const runRefresh = (source, options = {}) => {
      if (isDisposed) return;
      refreshCloudSharedStateRef.current?.({
        source,
        ...options,
      });
    };

    runRefresh('bootstrap', {
      preferServer: isNavigatorOnline(),
      clearWhenEmpty: true,
    });

    const handleOnline = () => {
      runRefresh('online', {
        preferServer: true,
        clearWhenEmpty: false,
      });
    };

    const handleFocus = () => {
      runRefresh('focus', {
        preferServer: isNavigatorOnline(),
        clearWhenEmpty: false,
      });
    };

    const handleVisibilityChange = () => {
      if (typeof document === 'undefined' || document.visibilityState !== 'visible') return;
      runRefresh('visibility-visible', {
        preferServer: isNavigatorOnline(),
        clearWhenEmpty: false,
      });
    };

    const refreshIntervalId = typeof window !== 'undefined'
      ? window.setInterval(() => {
        if (!isNavigatorOnline()) return;
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;

        runRefresh('interval', {
          preferServer: true,
          clearWhenEmpty: false,
        });
      }, 8000)
      : null;

    if (typeof window !== 'undefined') {
      window.addEventListener('online', handleOnline);
      window.addEventListener('focus', handleFocus);
    }

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }

    return () => {
      isDisposed = true;

      if (refreshIntervalId !== null && typeof window !== 'undefined') {
        window.clearInterval(refreshIntervalId);
      }

      if (typeof window !== 'undefined') {
        window.removeEventListener('online', handleOnline);
        window.removeEventListener('focus', handleFocus);
      }

      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      }
    };
  }, [hasOperationalCloudAccess]);
  useEffect(() => {
    if (!isCloudSyncEnabled || !isCloudWriteEnabled || !hasOperationalCloudAccess || isOffline || !cloudSyncBootstrapped) return;

    const scheduledPriorityVersion = cloudSyncPriorityVersionRef.current;
    const syncDelayMs = cloudSyncPriorityRef.current === 'urgent'
      ? URGENT_CLOUD_SYNC_DEBOUNCE_MS
      : CLOUD_SYNC_DEBOUNCE_MS;

    const timerId = setTimeout(() => {
      const cloudReadyState = createCloudSyncStateSnapshot(mergeSharedStateSnapshots(
        latestCloudSharedStateRef.current || {},
        createSharedStateSnapshot({
          ...sharedState,
          activeShiftKey: currentShiftMeta.key,
        }),
      ));
      const serializedState = serializeSharedStateSnapshot(cloudReadyState);
      const hasPendingLocalAssets = collectLocalOnlyAssetUrls(cloudReadyState).length > 0;
      if (!serializedState || (serializedState === lastCloudSharedStateRef.current && !hasPendingLocalAssets)) return;

      cloudSaveQueueRef.current = cloudSaveQueueRef.current
        .catch(() => { })
        .then(async () => {
          try {
            const shouldSkipAssetUpload = cloudSyncPriorityRef.current === 'urgent';
            // Gunakan ref terbaru, bukan closure `sharedState` yang bisa stale.
            const freshSharedState = localSharedStateRef.current || sharedState;
            const latestStateForWrite = createCloudSyncStateSnapshot(mergeSharedStateSnapshots(
              latestCloudSharedStateRef.current || {},
              createSharedStateSnapshot({
                ...freshSharedState,
                activeShiftKey: currentShiftMeta.key,
              }),
            ));
            const latestSerializedState = serializeSharedStateSnapshot(latestStateForWrite);
            const latestHasPendingLocalAssets = collectLocalOnlyAssetUrls(latestStateForWrite).length > 0;
            if (!latestSerializedState) return;
            if (latestSerializedState === lastCloudSharedStateRef.current) {
              if (!latestHasPendingLocalAssets) return;
              const hasSyncableLocalAssets = await hasUploadableLocalAssets(latestStateForWrite);
              if (!hasSyncableLocalAssets) return;
            }

            // Fast path: urgent sync pakai fungsi synchronous, skip ratusan Promise.
            // Normal sync tetap pakai prepareSharedStateForCloudSync (upload aset).
            const preparedState = shouldSkipAssetUpload
              ? prepareStateForUrgentCloudSync(latestStateForWrite)
              : await prepareSharedStateForCloudSync(latestStateForWrite, {
                skipAssetUpload: false,
              });

            logCloudSyncDebug('save-shared-state', {
              activeShiftKey: preparedState.activeShiftKey,
              historyEntries: preparedState.historyEntries.length,
              incidents: preparedState.incidentsData.length,
              payloadBytes: measureSharedStateSnapshotBytes(preparedState),
              ships: preparedState.shipsData.length,
              skipAssetUpload: shouldSkipAssetUpload,
              users: preparedState.usersData.length,
            });
            const receivedAtServerMs = getTrustedNowMs();
            const commitClientUpdatedAt = Date.now();
            const verifiedPreparedState = markSharedStateTimeAuditReceived(
              mergeSharedStateSnapshots({}, preparedState),
              receivedAtServerMs,
            );

            const signalPayload = {
              reason: shouldSkipAssetUpload ? 'state-sync-urgent' : 'state-sync',
              priority: shouldSkipAssetUpload ? 'urgent' : 'normal',
              clientUpdatedAt: commitClientUpdatedAt,
              activeSOSAlert: verifiedPreparedState.activeSOSAlert,
              shipName: operationalShipName,
            };

            const savedState = await saveCloudAppState(verifiedPreparedState, {
              clientUpdatedAt: commitClientUpdatedAt,
              mergeState: (cloudState, pendingState) => createCloudSyncStateSnapshot(
                mergeSharedStateSnapshots(cloudState || {}, pendingState || {}),
              ),
            });

            // Signal dikirim setelah commit shared-state selesai supaya device lain
            // tidak fetch snapshot lama dan menunggu retry signal-refresh.
            await emitCloudSyncSignal(signalPayload);

            const committedState = markSharedStateTimeAuditReceived(
              mergeSharedStateSnapshots({}, savedState || verifiedPreparedState),
              receivedAtServerMs,
            );
            const committedSerializedState = serializeSharedStateSnapshot(committedState);

            if (!committedSerializedState) return;

            lastCloudClientUpdatedAtRef.current = Math.max(
              lastCloudClientUpdatedAtRef.current,
              commitClientUpdatedAt,
            );
            if (shouldSkipAssetUpload && latestHasPendingLocalAssets) {
              // Jangan terapkan snapshot urgent ke device pengirim karena snapshot
              // itu sengaja menghapus URL idb://. State lokal harus tetap menyimpan
              // foto agar sync normal berikutnya bisa upload ke Supabase Storage.
              localSharedStateRef.current = createSharedStateSnapshot(
                mergeSharedStateSnapshots(localSharedStateRef.current || {}, latestStateForWrite),
              );
            } else {
              applyCloudSharedState(committedState, {
                receivedAtServerMs,
              });
            }

            if (shouldSkipAssetUpload && latestHasPendingLocalAssets) {
              requestCloudSync('normal');
            }
          } finally {
            if (cloudSyncPriorityVersionRef.current === scheduledPriorityVersion) {
              cloudSyncPriorityRef.current = 'normal';
            }
          }
        })
        .catch((error) => {
          console.error('Gagal mengirim laporan patroli ke cloud, jadwalkan retry', error);
          // Retry sync setelah error agar data tidak hilang
          requestCloudSync('normal');
        });
    }, syncDelayMs);

    return () => clearTimeout(timerId);
  }, [applyCloudSharedState, cloudSyncBootstrapped, cloudSyncKick, currentShiftMeta.key, emitCloudSyncSignal, hasOperationalCloudAccess, hasUploadableLocalAssets, isOffline, operationalShipName, prepareSharedStateForCloudSync, requestCloudSync, sharedState]);
  useEffect(() => { saveAuthSession(sessionUserId); }, [sessionUserId]);
  useEffect(() => {
    isOfflineRef.current = isOffline;
  }, [isOffline]);
  useEffect(() => {
    firebaseAuthUserRef.current = firebaseAuthUser;
  }, [firebaseAuthUser]);
  useEffect(() => {
    if (!isFirebaseAuthEnabled) {
      setFirebaseAuthReady(true);
      return () => { };
    }

    return subscribeToFirebaseAuthChanges((nextUser, authEvent = {}) => {
      const isTransientAuthNull = !nextUser
        && !authEvent?.explicit
        && (authEvent?.isTransient || isOfflineRef.current);
      if (isTransientAuthNull) {
        // Auth-null involunter (refresh token gagal / SIGNED_OUT non-eksplisit saat
        // internet hilang walau radio menyala). Pertahankan user terakhir agar sesi
        // patroli tidak diputus di tengah submit. Hanya logout eksplisit pengguna
        // (authEvent.explicit) atau pencabutan akses server yang membersihkan sesi.
        const activeUid = sanitizeText(firebaseAuthUserRef.current?.uid || '', 160);
        if (activeUid) setAuthAccessOfflineUid(activeUid);
        setFirebaseAuthReady(true);
        setAuthAccessBusy(false);
        return;
      }

      firebaseAuthUserRef.current = nextUser;
      setFirebaseAuthUser(nextUser);
      setFirebaseAuthReady(true);
      if (nextUser) {
        // Ada user Supabase aktif: reset resolved UID agar effect resolver
        // memuat RBAC untuk UID baru (atau re-resolve untuk UID yang sama).
        setAuthAccessResolvedUid('');
        setAuthAccessBusy(true);
      } else {
        // Tidak ada user: clear access state, biarkan validator yang putuskan reset sesi.
        publicRegistrationFlowRef.current = false;
        setAuthAccessState(null);
        setAuthAccessBusy(false);
        setAuthAccessResolvedUid('');
        setAuthAccessOfflineUid('');
      }
    });
  }, []);
  useEffect(() => {
    if (!isFirebaseAuthEnabled || !firebaseAuthReady) return;
    if (publicRegistrationFlowRef.current) {
      setAuthAccessState(null);
      setAuthAccessBusy(false);
      return;
    }
    if (!firebaseAuthUser) {
      setAuthAccessState(null);
      return;
    }

    const currentUid = sanitizeText(firebaseAuthUser.uid || '', 160);
    if (!currentUid) return;

    let cancelled = false;
    setAuthAccessBusy(true);

    resolveOperationalAccess()
      .then((accessResult) => {
        if (cancelled) return;
        if (accessResult?.access) {
          setAuthAccessState(accessResult);
          setAuthAccessResolvedUid(currentUid);
          setAuthAccessOfflineUid('');
          setUsersData((previousUsers) => upsertOperationalUserRecord(previousUsers, {
            access: accessResult.access,
            profile: accessResult.profile,
            authUser: firebaseAuthUser,
          }));
        } else {
          // Access denied or pending — tetap set resolved agar validator bisa putuskan logout.
          setAuthAccessState(accessResult || null);
          setAuthAccessResolvedUid(currentUid);
          setAuthAccessOfflineUid('');
        }
      })
      .catch((error) => {
        if (cancelled) return;
        console.error('Gagal memuat akses operasional user aktif', error);
        // Network error / offline — set offline fallback agar sesi tetap valid.
        setAuthAccessState(null);
        setAuthAccessOfflineUid(currentUid);
      })
      .finally(() => {
        if (!cancelled) {
          setAuthAccessBusy(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [firebaseAuthReady, firebaseAuthUser, authAccessResolveNonce]);
  // Self-heal: bila resolusi akses gagal jaringan (authAccessState null, belum definitif)
  // dan koneksi tersedia, jadwalkan re-resolve dengan backoff. Ini memulihkan
  // currentUserRecord -> operationalShip -> daftar checkpoint setelah reconnect TANPA
  // perlu refresh manual. Berhenti saat akses ter-resolve, jawaban definitif, atau offline.
  useEffect(() => {
    const retryState = authAccessRetryRef.current;
    const clearRetryTimer = () => {
      if (retryState.timer) {
        clearTimeout(retryState.timer);
        retryState.timer = null;
      }
    };

    if (!isFirebaseAuthEnabled || !firebaseAuthReady || !firebaseAuthUser) {
      clearRetryTimer();
      retryState.attempts = 0;
      return clearRetryTimer;
    }
    if (isOffline) {
      // Reset budget retry agar reconnect berikutnya dapat percobaan penuh.
      clearRetryTimer();
      retryState.attempts = 0;
      return clearRetryTimer;
    }

    const currentUid = sanitizeText(firebaseAuthUser.uid || '', 160);
    const isResolved = Boolean(authAccessState?.access);
    const isDefinitive = authAccessResolvedUid === currentUid;
    if (isResolved || isDefinitive) {
      clearRetryTimer();
      retryState.attempts = 0;
      return clearRetryTimer;
    }
    if (authAccessBusy || retryState.timer || retryState.attempts >= 6) {
      return clearRetryTimer;
    }

    const delay = Math.min(800 * 2 ** retryState.attempts, 15000);
    retryState.timer = setTimeout(() => {
      retryState.timer = null;
      retryState.attempts += 1;
      setAuthAccessResolveNonce((nonce) => nonce + 1);
    }, delay);
    return clearRetryTimer;
  }, [authAccessBusy, authAccessResolvedUid, authAccessState, firebaseAuthReady, firebaseAuthUser, isOffline]);
  useEffect(() => {
    if (!isFirebaseAuthEnabled || !firebaseAuthUser || !authAccessState?.access) return;
    const matchedUser = resolvePreferredUserRecord(usersData, {
      sessionUserId,
      firebaseAuthEmail: firebaseAuthUser.email || '',
      firebaseAuthUid: firebaseAuthUser.uid || '',
    });
    if (matchedUser?.id && matchedUser.id !== sessionUserId) {
      setSessionUserId(matchedUser.id);
    }
  }, [authAccessState, firebaseAuthUser, sessionUserId, usersData]);
  useEffect(() => {
    if (!isFirebaseAuthEnabled || !firebaseAuthReady) return;
    if (authBusy || authAccessBusy || firebaseAuthUser || !sessionUserId) return;
    if (isOffline) {
      const activeUser = usersData.find(user => user.id === sessionUserId) || null;
      const offlineUid = sanitizeText(activeUser?.firebaseUid || '', 160);
      if (offlineUid && authAccessOfflineUid !== offlineUid) {
        setAuthAccessOfflineUid(offlineUid);
      }
      return;
    }
    // Reset HANYA bila resolveOperationalAccess sudah memberi jawaban DEFINITIF untuk UID
    // aktif (authAccessResolvedUid === currentUid). Bila resolusi gagal jaringan
    // (authAccessOfflineUid di-set, resolvedUid belum cocok) atau masih pending, JANGAN
    // reset — mencegah logout liar saat koneksi flaky / baru pulih (reconnect).
    const currentUid = sanitizeText(firebaseAuthUser?.uid || '', 160);
    if (authAccessResolvedUid !== currentUid) return;
    resetAuthSession('Sesi cloud Anda telah berakhir. Silakan login kembali.');
  }, [authAccessBusy, authAccessResolvedUid, authAccessOfflineUid, authBusy, firebaseAuthReady, firebaseAuthUser, isOffline, resetAuthSession, sessionUserId, usersData]);
  useEffect(() => {
    if (!isAdmin || !hasOperationalCloudAccess) {
      setPendingRegistrations([]);
      return () => { };
    }

    return subscribeToPendingRegistrations((entries) => {
      setPendingRegistrations(entries);
    }, (error) => {
      console.error('Gagal memuat onboarding pending', error);
    });
  }, [hasOperationalCloudAccess, isAdmin]);
  // Notif user management untuk admin: registrasi baru menunggu persetujuan.
  // Run pertama hanya menyemai ref agar pending lama tidak menghasilkan notif retroaktif.
  const previousPendingRegistrationsRef = useRef(null);
  useEffect(() => {
    const previousList = previousPendingRegistrationsRef.current;
    previousPendingRegistrationsRef.current = pendingRegistrations;
    if (!isAdmin || previousList === null) return;

    const previousPendingUids = new Set(
      ensureArray(previousList)
        .filter((entry) => sanitizeText(entry?.status || 'pending', 30) === 'pending')
        .map((entry) => entry?.uid)
        .filter(Boolean),
    );
    const adminIds = getUsersByRole([ACCESS_ROLES.ADMIN]);
    if (adminIds.length === 0) return;

    const registrationNotifications = [];
    ensureArray(pendingRegistrations).forEach((entry) => {
      if (!entry?.uid) return;
      if (sanitizeText(entry?.status || 'pending', 30) !== 'pending') return;
      if (previousPendingUids.has(entry.uid)) return;
      registrationNotifications.push({
        type: 'registration_pending',
        title: 'Registrasi baru menunggu persetujuan',
        message: `${entry.name || 'Pengguna baru'} (${entry.email || '-'}) mendaftar dan menunggu persetujuan admin.`,
        senderName: 'Sistem',
        senderRole: 'SYSTEM',
        targetUserIds: adminIds,
        route: 'users/list',
        dedupeKey: `registration-pending:${entry.uid}`,
      });
    });

    if (registrationNotifications.length > 0) appendNotifications(registrationNotifications);
  }, [appendNotifications, getUsersByRole, isAdmin, pendingRegistrations]);
  useEffect(() => {
    if (!sessionUserId) return;
    const activeUser = currentUserRecord || usersData.find(user => user.id === sessionUserId);
    if (!activeUser) {
      resetAuthSession('Sesi login tidak lagi valid.');
      return;
    }

    if (isFirebaseAuthEnabled) {
      if (!firebaseAuthReady || authBusy || authAccessBusy) return;
      if (!firebaseAuthUser || !authAccessEnabled) {
        if (isOffline && activeUser) {
          const offlineUid = sanitizeText(activeUser?.firebaseUid || '', 160);
          if (offlineUid && authAccessOfflineUid !== offlineUid) {
            setAuthAccessOfflineUid(offlineUid);
          }
          return;
        }
        // Reset HANYA saat jawaban akses DEFINITIF (resolvedUid === currentUid). Resolusi
        // gagal jaringan (authAccessOfflineUid di-set) atau masih pending JANGAN memicu
        // logout — mencegah tendangan saat koneksi baru pulih (reconnect).
        const currentUid = sanitizeText(firebaseAuthUser?.uid || '', 160);
        if (authAccessResolvedUid !== currentUid) return;
        resetAuthSession('Sesi cloud Anda telah berakhir. Silakan login kembali.');
        return;
      }
      if (authAccessStatus === 'restricted') {
        handleLogout('Akses operasional Anda sedang nonaktif. Hubungi admin untuk assignment ulang.');
        return;
      }
      if (authAccessStatus === 'rejected') {
        handleLogout('Registrasi Anda ditolak admin operasional.');
        return;
      }
      if (authAccessStatus === 'pending') {
        handleLogout('Registrasi Anda masih menunggu approval admin.');
        return;
      }
    }

    if (!canUserAccessApplication(activeUser)) {
      handleLogout('Petugas off-duty atau tanpa penugasan kapal tidak bisa tetap login.');
      return;
    }
    if (isWaitingForAssignedFleetSync) {
      return;
    }
    // Armada belum termuat (mis. window hydrate saat baru reconnect): assignedShip bisa
    // sesaat null walau petugas masih terdaftar. Jangan kick — tunggu ships terisi.
    if (!shipsData?.length) return;
    if (activeUser.role === ACCESS_ROLES.PETUGAS && !assignedShipForCurrentUser) {
      handleLogout('Petugas yang tidak lagi terdaftar di armada aktif tidak bisa tetap login.');
    }
  }, [assignedShipForCurrentUser, authAccessBusy, authAccessEnabled, authAccessOfflineUid, authAccessStatus, authBusy, currentUserRecord, firebaseAuthReady, firebaseAuthUser, handleLogout, isOffline, isWaitingForAssignedFleetSync, resetAuthSession, sessionUserId, shipsData, usersData]);
  useEffect(() => { if (!currentUserRecord) return; if (!isAdmin && (currentPage === 'users' || currentPage === 'ships' || currentPage === 'daily-report')) { setCurrentPage('home'); setActiveShipId(null); setShowShipForm(false); setShowShipDocForm(false); setShowUserForm(false); setSelectedUser(null); } }, [currentPage, currentUserRecord, isAdmin]);
  useEffect(() => { if (activeShipId) return; setShowShipDocForm(false); }, [activeShipId]);
  useEffect(() => {
    if (!selectedHistoryId) return;
    if (currentPage !== 'home' && currentPage !== 'history') setSelectedHistoryId(null);
  }, [currentPage, selectedHistoryId]);
  useEffect(() => {
    const previousUsers = previousUsersDataRef.current;
    if (!previousUsers?.length) {
      previousUsersDataRef.current = usersData;
      return;
    }

    const assignmentNotifications = [];
    usersData.forEach((user) => {
      const previousUser = previousUsers.find(item => item.id === user.id);
      if (!previousUser) return;
      if (previousUser.shipAssigned === user.shipAssigned && previousUser.status === user.status) return;
      if (!user.shipAssigned) return;

      // Notif untuk PIC kapal: ada perubahan penugasan personel.
      assignmentNotifications.push({
        type: 'assignment_changed',
        title: 'Penugasan patroli diperbarui',
        message: `${user.name} sekarang ditugaskan ke ${user.shipAssigned}.`,
        senderName: 'Sistem',
        senderRole: 'SYSTEM',
        targetUserIds: getShipRecipients(user.shipAssigned, { includePic: true }),
        route: 'patrol/info',
        shipName: user.shipAssigned,
        dedupeKey: `assignment-changed:${user.id}:${user.shipAssigned}:${user.status}`,
      });

      // Notif "selamat bertugas" personal saat user dipindahkan/ditugaskan ke kapal baru.
      if (previousUser.shipAssigned !== user.shipAssigned) {
        assignmentNotifications.push({
          type: 'welcome_to_ship',
          title: 'Selamat bertugas',
          message: `Anda telah ditugaskan ke ${user.shipAssigned}. Selamat bertugas dan tetap waspada!`,
          senderName: 'Sistem',
          senderRole: 'SYSTEM',
          targetUserIds: [user.id],
          route: 'patrol/info',
          shipName: user.shipAssigned,
          dedupeKey: `welcome-to-ship:${user.id}:${user.shipAssigned}`,
        });
      }
    });

    previousUsersDataRef.current = usersData;
    appendNotifications(assignmentNotifications);
  }, [appendNotifications, getShipRecipients, usersData]);

  // Persistensi notifikasi ke cloud (fan-out per penerima). Efek ini menjaga agar
  // notifikasi yang dibuat lokal benar-benar tersimpan di tabel notifications sehingga
  // sampai ke device penerima lain, dan status baca milik user ini ikut tersinkron.
  // Idempoten: insert pakai ignoreDuplicates, update read hanya untuk baris milik user.
  const notificationSyncRef = useRef(new Map());
  useEffect(() => {
    if (!isCloudSyncEnabled || !isCloudWriteEnabled || isOffline || !hasOperationalCloudAccess) return;
    const recordsToCreate = [];
    const readBaseIds = [];
    ensureArray(notifications).forEach((notification) => {
      if (!notification?.id) return;
      const targetUserIds = Array.isArray(notification.targetUserIds) ? notification.targetUserIds : [];
      if (targetUserIds.length === 0) return;
      const readByUserIds = Array.isArray(notification.readByUserIds) ? notification.readByUserIds : [];
      const targetSig = targetUserIds.slice().sort().join(',');
      const ownRead = Boolean(currentUserId && readByUserIds.includes(currentUserId));
      const signature = `${targetSig}|${ownRead ? 1 : 0}`;
      const previousSig = notificationSyncRef.current.get(notification.id);
      if (previousSig === signature) return;
      const previousTargetSig = previousSig ? previousSig.split('|')[0] : null;
      if (previousTargetSig !== targetSig) recordsToCreate.push(notification);
      if (ownRead) readBaseIds.push(getNotificationCloudBaseId(notification));
      notificationSyncRef.current.set(notification.id, signature);
    });
    if (recordsToCreate.length > 0) {
      persistNotificationRecords(recordsToCreate).catch((error) => {
        console.warn('Gagal menyimpan notifikasi ke cloud', error);
      });
    }
    if (readBaseIds.length > 0 && currentUserId) {
      markNotificationRecipientRead(readBaseIds, currentUserId).catch((error) => {
        console.warn('Gagal menandai notifikasi dibaca di cloud', error);
      });
    }
  }, [currentUserId, hasOperationalCloudAccess, isOffline, notifications]);

  // Weather
  useEffect(() => {
    let cancelled = false;

    const hydrateWeather = async () => {
      const cachedWeather = loadWeatherCache();

      if (weatherInfo) {
        if (!cancelled) setWeatherLoading(false);
        return;
      }

      if (!isNavigatorOnline()) {
        if (!cancelled && ensureObject(cachedWeather)) {
          setWeatherInfo(cachedWeather);
        }
        if (!cancelled) setWeatherLoading(false);
        return;
      }

      try {
        const response = await fetch('https://api.open-meteo.com/v1/forecast?latitude=-6.1021&longitude=106.8833&current_weather=true');
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();
        const currentWeather = ensureObject(data?.current_weather);

        if (cancelled) return;

        if (currentWeather) {
          setWeatherInfo(currentWeather);
          saveWeatherCache(currentWeather);
        } else if (ensureObject(cachedWeather)) {
          setWeatherInfo(cachedWeather);
        }
      } catch (error) {
        console.error('Gagal memuat cuaca operasional', error);
        if (!cancelled && ensureObject(cachedWeather)) {
          setWeatherInfo(cachedWeather);
        }
      } finally {
        if (!cancelled) setWeatherLoading(false);
      }
    };

    hydrateWeather();
    return () => {
      cancelled = true;
    };
  }, [weatherInfo]);
  const getWeatherDetail = useCallback((code) => { if (code === 0) return { text: 'Cerah', icon: <Sun className="w-5 h-5 text-cyan-400" /> }; if (code >= 1 && code <= 3) return { text: 'Berawan', icon: <Cloud className="w-5 h-5 text-cyan-200" /> }; if (code >= 51 && code <= 67) return { text: 'Hujan Ringan', icon: <CloudRain className="w-5 h-5 text-cyan-500" /> }; if (code >= 80 && code <= 99) return { text: 'Hujan Badai', icon: <CloudRain className="w-5 h-5 text-yellow-500" /> }; return { text: 'Tidak Diketahui', icon: <Cloud className="w-5 h-5 text-slate-500" /> }; }, []);

  const uiValue = useMemo(() => ({
    currentPage,
    setCurrentPage,
    theme,
    setTheme,
    isOffline,
    showSettingsDropdown,
    setShowSettingsDropdown,
    showNotificationsDropdown,
    setShowNotificationsDropdown,
    notificationReturnPage,
    openNotificationsPage,
    closeNotificationsPage,
    confirmDialog,
    setConfirmDialog,
  }), [
    closeNotificationsPage,
    confirmDialog,
    currentPage,
    isOffline,
    notificationReturnPage,
    openNotificationsPage,
    setConfirmDialog,
    showNotificationsDropdown,
    showSettingsDropdown,
    theme,
  ]);
  // isAuthSessionRestoring = true saat sessionUserId ada tapi auth belum settle
  // (cold start: Supabase Auth belum ready, access masih loading, resolved UID belum cocok).
  const isAuthSessionRestoring = useMemo(() => {
    if (!sessionUserId) return false;
    if (!isFirebaseAuthEnabled) return false;
    if (!firebaseAuthReady) return true;
    if (authBusy || authAccessBusy) return true;
    if (isWaitingForAssignedFleetSync) return true;
    const currentUid = sanitizeText(firebaseAuthUser?.uid || '', 160);
    if (currentUid && authAccessResolvedUid !== currentUid && authAccessOfflineUid !== currentUid) return true;
    return false;
  }, [sessionUserId, firebaseAuthReady, firebaseAuthUser, authBusy, authAccessBusy, authAccessResolvedUid, authAccessOfflineUid, isWaitingForAssignedFleetSync]);

  const authValue = useMemo(() => ({
    sessionUserId,
    authAccessStatus,
    authAccessBusy,
    authMode,
    setAuthMode,
    authBusy,
    authError,
    setAuthError,
    authNotice,
    setAuthNotice,
    authForm,
    setAuthForm,
    handleLogin,
    handleRegister,
    handleLogout,
    handleAuthPhotoUpload,
    isAuthSessionRestoring,
  }), [
    authAccessBusy,
    authAccessStatus,
    authBusy,
    authError,
    setAuthError,
    authNotice,
    setAuthNotice,
    authForm,
    authMode,
    authNotice,
    handleAuthPhotoUpload,
    handleLogin,
    handleLogout,
    handleRegister,
    isAuthSessionRestoring,
    sessionUserId,
  ]);
  const roleValue = useMemo(() => ({
    currentUserRecord,
    currentUser,
    currentUserId,
    currentUserRole,
    isAdmin,
    isPic,
    isPetugas,
  }), [
    currentUser,
    currentUserId,
    currentUserRecord,
    currentUserRole,
    isAdmin,
    isPetugas,
    isPic,
  ]);
  const patrolValue = useMemo(() => ({
    checkpoints,
    currentShiftMeta,
    currentShiftSchedule,
    activeShiftKey,
    activeShiftGuardSnapshot,
    currentShiftStatusRecord,
    filteredCheckpoints,
    searchQuery,
    setSearchQuery,
    patrolTab,
    setPatrolTab,
    activeForms,
    setActiveForms,
    activePatrolId,
    activePatrolState,
    activePatrolItem,
    canPatrolCurrentShip,
    isShiftStatusRequired,
    isCurrentShiftStatusCompleted,
    showShiftStatusModal,
    canAddTemporaryPatrolNode,
    shouldForcePatrolCameraCapture,
    pendingPatrolCameraCapture,
    submittingPatrolId,
    completedCount,
    totalCount,
    progressPercentage,
    newCustomNode,
    setNewCustomNode,
    openShiftStatusModal,
    closeShiftStatusModal,
    handleSaveCurrentShiftStatus,
    handleActionClick,
    handleFormChange,
    handlePhotoUpload,
    handleSubmitPatrol,
    handleDeleteReport,
    handleAddReportGalleryPhoto,
    handleOpenPatrolResult,
    handleAddCustomPatrolNode,
    closePatrolCameraCapture,
    handlePatrolCameraCapture,
  }), [
    activeForms,
    activePatrolId,
    activePatrolItem,
    activePatrolState,
    activeShiftGuardSnapshot,
    activeShiftKey,
    canAddTemporaryPatrolNode,
    canPatrolCurrentShip,
    checkpoints,
    closeShiftStatusModal,
    closePatrolCameraCapture,
    completedCount,
    currentShiftStatusRecord,
    currentShiftMeta,
    currentShiftSchedule,
    filteredCheckpoints,
    handleSaveCurrentShiftStatus,
    handleActionClick,
    handleAddCustomPatrolNode,
    handleAddReportGalleryPhoto,
    handleDeleteReport,
    handleFormChange,
    handleOpenPatrolResult,
    handlePatrolCameraCapture,
    handlePhotoUpload,
    handleSubmitPatrol,
    isCurrentShiftStatusCompleted,
    isShiftStatusRequired,
    newCustomNode,
    openShiftStatusModal,
    patrolTab,
    pendingPatrolCameraCapture,
    progressPercentage,
    searchQuery,
    showShiftStatusModal,
    shouldForcePatrolCameraCapture,
    submittingPatrolId,
    totalCount,
  ]);
  const shipValue = useMemo(() => ({
    shipsData,
    operationalShip,
    operationalShipName,
    activeShipId,
    setActiveShipId,
    activeShip,
    shipDetailTab,
    setShipDetailTab,
    scheduleMonth,
    setScheduleMonth,
    showAssignPopup,
    setShowAssignPopup,
    assignPopupData,
    setAssignPopupData,
    handleConfirmAssign,
    isEditingShipInfo,
    setIsEditingShipInfo,
    editShipInfoData,
    setEditShipInfoData,
    updateActiveShip,
    handleTogglePersonnel,
    handleAddShipCp,
    handleShipPhotoUpdate,
    handleChangeSchedule,
    handleAddShipDoc,
    handleShipDocUpload,
    handleDownloadShipDoc,
    newShipCp,
    setNewShipCp,
    newShipDoc,
    setNewShipDoc,
    showShipDocForm,
    openShipDocForm,
    closeShipDocForm,
    showShipForm,
    setShowShipForm,
    shipFormData,
    setShipFormData,
    newCheckpoint,
    setNewCheckpoint,
    handleSaveShip,
    handleDeleteShip,
    handleAddCheckpointToForm,
    handleRemoveCheckpointFromForm,
    handleShipFormPhotoUpload,
  }), [
    activeShip,
    activeShipId,
    assignPopupData,
    closeShipDocForm,
    editShipInfoData,
    handleAddCheckpointToForm,
    handleAddShipCp,
    handleAddShipDoc,
    handleChangeSchedule,
    handleConfirmAssign,
    handleDeleteShip,
    handleDownloadShipDoc,
    handleRemoveCheckpointFromForm,
    handleSaveShip,
    handleShipDocUpload,
    handleShipFormPhotoUpload,
    handleShipPhotoUpdate,
    handleTogglePersonnel,
    isEditingShipInfo,
    newCheckpoint,
    newShipCp,
    newShipDoc,
    operationalShip,
    operationalShipName,
    openShipDocForm,
    scheduleMonth,
    shipDetailTab,
    shipFormData,
    shipsData,
    showAssignPopup,
    showShipDocForm,
    showShipForm,
    updateActiveShip,
  ]);
  const incidentValue = useMemo(() => ({
    incidentsData,
    incidentMeta,
    allIncidents,
    visibleIncidents,
    showIncidentModal,
    incidentForm,
    setIncidentForm,
    incidentLocationOptions,
    selectedIncident,
    setSelectedIncident,
    openIncidentModal,
    closeIncidentModal,
    handleSubmitIncident,
    canManageIncident,
    canCloseIncident,
    handleAddProgress,
    handleAddIncidentDocumentation,
    handleUpdateIncidentInfo,
    handleCloseIncident,
    handleDeleteIncident,
    newProgress,
    setNewProgress,
    handlePhotoProgress,
    handleUpdateIncidentPhoto,
  }), [
    allIncidents,
    canCloseIncident,
    canManageIncident,
    closeIncidentModal,
    handleAddIncidentDocumentation,
    handleAddProgress,
    handleCloseIncident,
    handleDeleteIncident,
    handleUpdateIncidentInfo,
    handlePhotoProgress,
    handleSubmitIncident,
    handleUpdateIncidentPhoto,
    incidentForm,
    incidentLocationOptions,
    incidentMeta,
    incidentsData,
    newProgress,
    openIncidentModal,
    selectedIncident,
    showIncidentModal,
    visibleIncidents,
  ]);
  const userManagementValue = useMemo(() => ({
    usersData,
    pendingRegistrations,
    showUserForm,
    setShowUserForm,
    userFormData,
    setUserFormData,
    userFormError,
    userFormNotice,
    clearUserManagementFeedback,
    selectedUser,
    setSelectedUser,
    handleSaveUser,
    handleUpdateUser,
    handleDeleteUser,
    handleUserPhotoUpload,
    handleEditUserPhotoUpload,
    handleApprovePendingUser,
    handleRejectPendingUser,
  }), [
    clearUserManagementFeedback,
    handleApprovePendingUser,
    handleDeleteUser,
    handleEditUserPhotoUpload,
    handleRejectPendingUser,
    handleSaveUser,
    handleUpdateUser,
    handleUserPhotoUpload,
    pendingRegistrations,
    selectedUser,
    showUserForm,
    userFormData,
    userFormError,
    userFormNotice,
    usersData,
  ]);
  const reportValue = useMemo(() => ({
    selectedReportDetail,
    setSelectedReportDetail,
    previewPhoto,
    setPreviewPhoto,
  }), [previewPhoto, selectedReportDetail]);
  const weatherValue = useMemo(() => ({
    weatherInfo,
    weatherLoading,
    getWeatherDetail,
  }), [getWeatherDetail, weatherInfo, weatherLoading]);
  const historyValue = useMemo(() => ({
    historyEntries: visibleHistoryEntries,
    selectedHistoryEntry,
    setSelectedHistoryId,
    openHistoryEntry,
    closeHistoryEntry,
    handleDeleteHistoryEntry,
    handleDeleteHistoryEntriesBulk,
    handleOpenPatrolResult,
  }), [
    closeHistoryEntry,
    handleDeleteHistoryEntry,
    handleDeleteHistoryEntriesBulk,
    handleOpenPatrolResult,
    openHistoryEntry,
    selectedHistoryEntry,
    visibleHistoryEntries,
  ]);
  const notificationValue = useMemo(() => ({
    notifications,
    visibleNotifications,
    unreadNotificationCount,
    appendNotifications,
    markNotificationAsRead,
    markAllNotificationsAsRead,
    handleNotificationClick,
  }), [
    appendNotifications,
    handleNotificationClick,
    markAllNotificationsAsRead,
    markNotificationAsRead,
    notifications,
    unreadNotificationCount,
    visibleNotifications,
  ]);
  const sosValue = useMemo(() => ({
    activeSOSAlert,
    sosHistory,
    handleSOSTrigger,
    handleSOSConfirm,
    handleSOSAcknowledgeSelf,
    handleSOSDismiss,
  }), [
    activeSOSAlert,
    handleSOSAcknowledgeSelf,
    handleSOSConfirm,
    handleSOSDismiss,
    handleSOSTrigger,
    sosHistory,
  ]);
  const appValue = useMemo(() => ({
    ...uiValue,
    ...authValue,
    ...roleValue,
    ...patrolValue,
    ...shipValue,
    ...incidentValue,
    ...userManagementValue,
    ...reportValue,
    ...weatherValue,
    ...historyValue,
    ...notificationValue,
    ...sosValue,
  }), [
    authValue,
    historyValue,
    incidentValue,
    notificationValue,
    patrolValue,
    reportValue,
    roleValue,
    shipValue,
    sosValue,
    uiValue,
    userManagementValue,
    weatherValue,
  ]);

  return (
    <AppContext.Provider value={appValue}>
      <UIContext.Provider value={uiValue}>
        <AuthContext.Provider value={authValue}>
          <RoleContext.Provider value={roleValue}>
            <PatrolContext.Provider value={patrolValue}>
              <ShipContext.Provider value={shipValue}>
                <IncidentContext.Provider value={incidentValue}>
                  <UserManagementContext.Provider value={userManagementValue}>
                    <ReportContext.Provider value={reportValue}>
                      <WeatherContext.Provider value={weatherValue}>
                        <HistoryContext.Provider value={historyValue}>
                          <NotificationContext.Provider value={notificationValue}>
                            <SOSContext.Provider value={sosValue}>
                              {children}
                            </SOSContext.Provider>
                          </NotificationContext.Provider>
                        </HistoryContext.Provider>
                      </WeatherContext.Provider>
                    </ReportContext.Provider>
                  </UserManagementContext.Provider>
                </IncidentContext.Provider>
              </ShipContext.Provider>
            </PatrolContext.Provider>
          </RoleContext.Provider>
        </AuthContext.Provider>
      </UIContext.Provider>
    </AppContext.Provider>
  );
}
