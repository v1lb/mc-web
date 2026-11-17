// Everything the site remembers lives in this browser's localStorage: settings, report history, the daily
// counter of free cleanings and the Pro key. Storage errors never break the page (private mode, full disk).

import { reportJson } from './report.js';
import { hasAiEvidence, privacyExposure } from './core/privacy.js';
import { verifyLicense } from './core/license.js';

export const FREE_DAILY_LIMIT = 10;
export const FREE_PER_RUN = 5;
export const PRO_PER_RUN = 50;
export const FREE_HISTORY = 10;
export const PRO_HISTORY = 50;

const KEY = { settings: 'mc.settings', history: 'mc.history', quota: 'mc.quota', license: 'mc.license' };
const DEFAULTS = {
  saveHistory: true, lang: null, theme: 'system', mapConsent: false,
  apiEnabled: false, apiEndpoint: '', apiHeaderName: 'Authorization', apiKey: '', apiSendGps: false,
};

function read(key, fallback) {
  try { const raw = localStorage.getItem(key); return raw == null ? fallback : JSON.parse(raw); } catch { return fallback; }
}
function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}

export const settings = { ...DEFAULTS, ...read(KEY.settings, {}) };
export function saveSettings(patch) { Object.assign(settings, patch); return write(KEY.settings, settings); }

// --- Pro ---

export const entitlement = { isPro: false, expiresAt: null, note: null };

export async function loadEntitlement() {
  const token = read(KEY.license, null);
  Object.assign(entitlement, { isPro: false, expiresAt: null, note: null });
  if (!token) return entitlement;
  try {
    const info = await verifyLicense(token);
    Object.assign(entitlement, { isPro: true, expiresAt: info.expiresAt, note: info.note });
  } catch { /* expired or invalid: free plan */ }
  return entitlement;
}

/** Throws LicenseError when the key is refused. */
export async function applyLicense(token) {
  const info = await verifyLicense(token);
  write(KEY.license, String(token).trim());
  Object.assign(entitlement, { isPro: true, expiresAt: info.expiresAt, note: info.note });
  return info;
}

export function removeLicense() {
  try { localStorage.removeItem(KEY.license); } catch { /* nothing to remove */ }
  Object.assign(entitlement, { isPro: false, expiresAt: null, note: null });
}

// --- Daily quota of free cleanings (UTC day). A convenience limit, not a protection: it fails open. ---

const today = () => new Date().toISOString().slice(0, 10);
export function usedToday() {
  const q = read(KEY.quota, null);
  return q && q.day === today() && Number.isInteger(q.used) ? Math.max(0, q.used) : 0;
}
export function recordClean(count = 1) { write(KEY.quota, { day: today(), used: usedToday() + count }); }
export const perRun = () => (entitlement.isPro ? PRO_PER_RUN : Math.min(FREE_PER_RUN, Math.max(0, FREE_DAILY_LIMIT - usedToday())));

/** Throws { code: 'DAILY_LIMIT' } when the free plan has used up today's cleanings. */
export function checkQuota(count = 1) {
  if (!entitlement.isPro && usedToday() + count > FREE_DAILY_LIMIT) throw Object.assign(new Error('daily limit'), { code: 'DAILY_LIMIT', limit: FREE_DAILY_LIMIT });
}

// --- History: reports only, never the files ---

export function allHistory() {
  const list = read(KEY.history, []);
  return Array.isArray(list) ? list.filter((e) => e && e.id && e.report) : [];
}
/** What the current plan shows: the newest 10 reports for free, 50 with Pro. */
export const visibleHistory = () => allHistory().slice(0, entitlement.isPro ? PRO_HISTORY : FREE_HISTORY);

export function addHistory(report) {
  if (!settings.saveHistory) return null;
  const entry = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Date.now(), fileName: report.file.name, format: report.file.format,
    hasAiEvidence: hasAiEvidence(report), hasGps: report.gps != null, exposureCount: privacyExposure(report).items.length,
    report: reportJson(report),
  };
  let list = [entry, ...allHistory()].slice(0, PRO_HISTORY);
  // Long prompts make reports heavy: when the storage is full, the oldest reports go first.
  while (!write(KEY.history, list) && list.length > 1) list = list.slice(0, -1);
  return entry;
}

export function deleteHistory(id) { return write(KEY.history, allHistory().filter((e) => e.id !== id)); }
export function clearHistory() { try { localStorage.removeItem(KEY.history); return true; } catch { return false; } }

/** Counters for the statistics block. [days]: checks per day for the last 7 days, oldest first. */
export function historyStats(now = Date.now()) {
  const list = visibleHistory();
  const days = new Array(7).fill(0);
  const startOfToday = new Date(now); startOfToday.setHours(0, 0, 0, 0);
  for (const e of list) {
    const age = Math.floor((startOfToday.getTime() - new Date(e.createdAt).setHours(0, 0, 0, 0)) / 86400000);
    if (age >= 0 && age < 7) days[6 - age]++;
  }
  return { total: list.length, ai: list.filter((e) => e.hasAiEvidence).length, gps: list.filter((e) => e.hasGps).length,
    week: days.reduce((a, b) => a + b, 0), days };
}
