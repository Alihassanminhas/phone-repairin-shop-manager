import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL?.replace(/\/$/, '') ?? '';
const REFRESH_TOKEN_KEY = 'owner_refresh_token';
const DEVICE_ID_KEY = 'owner_device_id';
const OWNER_KEY = 'owner_account';
let memoryAccessToken: string | null = null;
let memoryAccessExpiry = 0;
let refreshInFlight: Promise<string> | null = null;

export type OwnerAccount = { id: string; email: string; shopName: string };
export type OwnerSession = { owner: OwnerAccount; accessToken: string; refreshToken: string; expiresIn: number; recoveryCode?: string };

async function deviceId(): Promise<string> {
  const existing = await SecureStore.getItemAsync(DEVICE_ID_KEY);
  if (existing) return existing;
  const created = Crypto.randomUUID();
  await SecureStore.setItemAsync(DEVICE_ID_KEY, created);
  return created;
}

async function authRequest(path: string, body: Record<string, unknown>): Promise<OwnerSession> {
  if (!API_BASE_URL) throw new Error('Set EXPO_PUBLIC_API_URL in the Android build environment to connect the owner account. Local repairs remain available offline.');
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/v1/auth/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
  } catch {
    throw new Error('Could not reach the shop server. Check the connection and try again.');
  }
  const result: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(extractMessage(result) ?? authFailureMessage(response.status));
  }
  if (typeof result !== 'object' || result === null || !('accessToken' in result) || !('refreshToken' in result) || !('owner' in result)) {
    throw new Error('The server returned an invalid sign-in response.');
  }
  const session = result as OwnerSession;
  memoryAccessToken = session.accessToken;
  memoryAccessExpiry = Date.now() + session.expiresIn * 1000;
  await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, session.refreshToken);
  await SecureStore.setItemAsync(OWNER_KEY, JSON.stringify(session.owner));
  return session;
}

function authFailureMessage(status: number): string {
  if (status === 401) return 'Email or password was not accepted. If this is the first setup, create the owner account first.';
  if (status === 404) return 'The shop API URL or authentication endpoint was not found. Check EXPO_PUBLIC_API_URL in the EAS preview environment.';
  if (status >= 500) return 'The shop server returned an error. Check its /health/ready endpoint and Render logs.';
  return `The shop server rejected the request (HTTP ${status}). Check the account details and server configuration.`;
}

export async function signInOwner(email: string, password: string): Promise<OwnerSession> {
  return authRequest('login', { email: email.trim().toLowerCase(), password, deviceId: await deviceId() });
}

export async function setupOwner(input: { email: string; password: string; shopName: string; bootstrapCode: string }): Promise<OwnerSession> {
  return authRequest('bootstrap', { ...input, email: input.email.trim().toLowerCase(), deviceId: await deviceId() });
}

export async function recoverOwnerPassword(email: string, recoveryCode: string, newPassword: string): Promise<string | null> {
  if (!API_BASE_URL) throw new Error('Set EXPO_PUBLIC_API_URL in the Android build environment to recover the owner account.');
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/v1/auth/recover`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email.trim().toLowerCase(), recoveryCode, newPassword }) });
  } catch {
    throw new Error('Could not reach the shop server. Check the connection and try again.');
  }
  if (!response.ok) {
    const result: unknown = await response.json().catch(() => ({}));
    throw new Error(extractMessage(result) ?? 'Password recovery could not be completed.');
  }
  const result: unknown = await response.json().catch(() => ({}));
  await clearSavedSession();
  if (typeof result === 'object' && result !== null && 'recoveryCode' in result && typeof result.recoveryCode === 'string') return result.recoveryCode;
  return null;
}

export async function signOutOwner(): Promise<void> {
  if (API_BASE_URL) {
    try {
      await ownerAuthenticatedFetch('/v1/auth/logout', { method: 'POST' });
    } catch { /* Local sign-out must still work while offline. */ }
  }
  await clearSavedSession();
}

export async function getSavedOwner(): Promise<OwnerAccount | null> {
  const value = await SecureStore.getItemAsync(OWNER_KEY);
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && 'id' in parsed && 'email' in parsed && 'shopName' in parsed
      ? parsed as OwnerAccount : null;
  } catch { return null; }
}

/** Refreshes the short lived access token and rotates the refresh token before sync calls. */
export async function getValidOwnerAccessToken(): Promise<string> {
  if (memoryAccessToken && memoryAccessExpiry > Date.now() + 60_000) return memoryAccessToken;
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = refreshOwnerAccessToken();
  try { return await refreshInFlight; } finally { refreshInFlight = null; }
}

async function refreshOwnerAccessToken(): Promise<string> {
  const refreshToken = await SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
  if (!refreshToken || !API_BASE_URL) throw new Error('Sign in to the shop account before syncing.');
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/v1/auth/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken }) });
  } catch {
    throw new Error('Could not reach the shop server. Your offline records are safe and will retry later.');
  }
  if (!response.ok) {
    await clearSavedSession();
    throw new Error('Your shop session expired. Sign in again to sync.');
  }
  const refreshed = await response.json() as { accessToken?: unknown; refreshToken?: unknown; expiresIn?: unknown };
  if (typeof refreshed.accessToken !== 'string' || typeof refreshed.refreshToken !== 'string' || typeof refreshed.expiresIn !== 'number') throw new Error('The server returned an invalid refreshed session.');
  memoryAccessToken = refreshed.accessToken;
  memoryAccessExpiry = Date.now() + refreshed.expiresIn * 1000;
  await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, refreshed.refreshToken);
  return refreshed.accessToken;
}

export async function ownerAuthenticatedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getValidOwnerAccessToken();
  const url = `${getOwnerApiBaseUrl()}${path}`;
  const requestWithToken = (accessToken: string) => fetch(url, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers).entries()), Authorization: `Bearer ${accessToken}` } });
  let response: Response;
  try { response = await requestWithToken(token); } catch { throw new Error('Could not reach the shop server. Your offline records are safe and will retry later.'); }
  if (response.status !== 401) return response;
  if (memoryAccessToken === token) { memoryAccessToken = null; memoryAccessExpiry = 0; }
  const refreshedToken = await getValidOwnerAccessToken();
  try { return await requestWithToken(refreshedToken); } catch { throw new Error('Could not reach the shop server. Your offline records are safe and will retry later.'); }
}

async function clearSavedSession(): Promise<void> {
  memoryAccessToken = null;
  memoryAccessExpiry = 0;
  refreshInFlight = null;
  await Promise.all([SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY), SecureStore.deleteItemAsync(OWNER_KEY)]);
}

export function getOwnerApiBaseUrl(): string {
  if (!API_BASE_URL) throw new Error('Set EXPO_PUBLIC_API_URL in the Android build environment to connect the owner account.');
  return API_BASE_URL;
}

function extractMessage(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  if ('message' in value && typeof value.message === 'string') return value.message;
  if ('error' in value && typeof value.error === 'object' && value.error !== null && 'message' in value.error && typeof value.error.message === 'string') return value.error.message;
  return null;
}
