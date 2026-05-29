/*
Tujuan: Helper pengiriman Web Push via Firebase Cloud Messaging HTTP v1 dari Edge Function.
Caller: Edge Function send-push.
Dependensi: FCM_SERVICE_ACCOUNT (JSON service account) di env; Web Crypto (RS256) bawaan Deno.
Main Functions: Ambil OAuth2 access token dari service account (cache di memori), kirim pesan FCM v1.
Side Effects: HTTP ke oauth2.googleapis.com dan fcm.googleapis.com.
*/

interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id: string;
  token_uri?: string;
}

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
let cachedToken: CachedToken | null = null;
let cachedServiceAccount: ServiceAccount | null = null;

export function getServiceAccount(): ServiceAccount {
  if (cachedServiceAccount) return cachedServiceAccount;
  let raw = Deno.env.get('FCM_SERVICE_ACCOUNT') || '';
  if (!raw) throw new Error('FCM_SERVICE_ACCOUNT belum dikonfigurasi.');

  // Toleran terhadap cara-set yang umum bikin JSON "tidak valid":
  //  - spasi/baris baru di ujung
  //  - terbungkus tanda kutip ekstra ('...' atau "...") oleh shell/UI
  //  - di-encode base64 (workaround agar newline private_key aman)
  raw = raw.trim();
  if (raw.length >= 2 && ((raw[0] === '"' && raw.at(-1) === '"') || (raw[0] === "'" && raw.at(-1) === "'"))) {
    raw = raw.slice(1, -1).trim();
  }
  if (!raw.startsWith('{')) {
    // Mungkin base64 dari JSON. Coba decode; kalau hasilnya '{...}', pakai itu.
    try {
      const decoded = atob(raw.replace(/\s+/g, '')).trim();
      if (decoded.startsWith('{')) raw = decoded;
    } catch {
      // bukan base64 — biarkan, JSON.parse di bawah yang akan melapor.
    }
  }

  let parsed: ServiceAccount;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    // Pesan diagnostik tanpa membocorkan isi secret: panjang + 1 char awal.
    const reason = error instanceof Error ? error.message : 'unknown';
    throw new Error(
      `FCM_SERVICE_ACCOUNT bukan JSON valid (len=${raw.length}, mulai='${raw.slice(0, 1)}'): ${reason}. ` +
      'Pastikan secret berisi ISI PENUH file JSON service account Firebase (mulai "{" diakhiri "}").',
    );
  }
  const missing = ['client_email', 'private_key', 'project_id'].filter((k) => !(parsed as Record<string, unknown>)[k]);
  if (missing.length > 0) {
    throw new Error(`FCM_SERVICE_ACCOUNT tidak lengkap (field kosong: ${missing.join(', ')}).`);
  }
  cachedServiceAccount = parsed;
  return parsed;
}

function base64UrlEncode(input: Uint8Array | string): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToPkcs8(pem: string): ArrayBuffer {
  const normalized = pem.replace(/\\n/g, '\n');
  const base64 = normalized
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const binary = atob(base64);
  const buffer = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) buffer[i] = binary.charCodeAt(i);
  return buffer.buffer;
}

async function signJwt(serviceAccount: ServiceAccount): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: serviceAccount.client_email,
    scope: FCM_SCOPE,
    aud: serviceAccount.token_uri || 'https://oauth2.googleapis.com/token',
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  };
  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claims))}`;

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToPkcs8(serviceAccount.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAtMs > Date.now() + 60_000) {
    return cachedToken.accessToken;
  }
  const serviceAccount = getServiceAccount();
  const jwt = await signJwt(serviceAccount);

  const response = await fetch(serviceAccount.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Gagal ambil access token FCM: ${response.status} ${detail}`);
  }
  const data = await response.json();
  cachedToken = {
    accessToken: data.access_token,
    expiresAtMs: Date.now() + (Number(data.expires_in || 3600) * 1000),
  };
  return cachedToken.accessToken;
}

export interface FcmSendResult {
  token: string;
  ok: boolean;
  status: number;
  shouldRemove: boolean;
  // Ringkasan error dari FCM bila gagal (untuk diagnosis di log send-push).
  detail?: string;
}

// Kirim satu pesan ke satu token. message harus mengikuti format FCM v1
// (tanpa field "token" — diisi di sini).
export async function sendToToken(
  token: string,
  message: Record<string, unknown>,
): Promise<FcmSendResult> {
  const serviceAccount = getServiceAccount();
  const accessToken = await getAccessToken();
  const endpoint = `https://fcm.googleapis.com/v1/projects/${serviceAccount.project_id}/messages:send`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message: { ...message, token } }),
  });

  // Token mati/dicabut → tandai untuk dihapus dari push_subscriptions.
  let shouldRemove = false;
  let detail: string | undefined;
  if (!response.ok) {
    // Ambil body error sekali saja untuk diagnosis (status + isi pesan FCM).
    const errorText = await response.text().catch(() => '');
    detail = errorText ? errorText.slice(0, 500) : undefined;
    if (response.status === 404) {
      shouldRemove = true;
    } else if (response.status === 400) {
      const upper = String(errorText).toUpperCase();
      if (upper.includes('UNREGISTERED') || upper.includes('INVALID_ARGUMENT')) {
        shouldRemove = true;
      }
    }
  }

  return {
    token,
    ok: response.ok,
    status: response.status,
    shouldRemove,
    detail,
  };
}
