// Vendored from quota-clock (MIT License, Copyright (c) quota-clock contributors). See NOTICE.
import fs from 'node:fs';
import path from 'node:path';
import { defaultHome } from '../store.mjs';
import { formatRemaining } from '../time.mjs';

export const ANTIGRAVITY_FILE = 'antigravity.json';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const iso = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const cell = value => String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');

// Return a fresh allowlisted quota map, never the surrounding statusline metadata.
export function extractAntigravityQuota(payload, { now = new Date() } = {}) {
  if (!object(payload) || !object(payload.quota)) return null;
  const at = new Date(typeof now === 'function' ? now() : now);
  if (!Number.isFinite(at.getTime())) throw new Error('Invalid timestamp for statusline.');
  const entries = [];
  for (const [bucket, raw] of Object.entries(payload.quota)) {
    if (!bucket.trim() || !object(raw)) continue;
    const quota = {};
    if (finite(raw.remaining_fraction) && raw.remaining_fraction >= 0 && raw.remaining_fraction <= 1) quota.remaining_fraction = raw.remaining_fraction;
    if (finite(raw.remaining_amount) && raw.remaining_amount >= 0) quota.remaining_amount = raw.remaining_amount;
    if (typeof raw.disabled === 'boolean') quota.disabled = raw.disabled;
    let reset = iso(raw.reset_time);
    if (finite(raw.reset_in_seconds) && raw.reset_in_seconds >= 0) {
      quota.reset_in_seconds = raw.reset_in_seconds;
      if (!reset) {
        const next = new Date(at.getTime() + raw.reset_in_seconds * 1000);
        if (Number.isFinite(next.getTime())) reset = next.toISOString();
      }
    }
    if (reset) quota.reset_time = reset;
    // Disabled buckets may lack a reset. They are retained only as quota metadata.
    if (reset || quota.disabled === true) entries.push([bucket, quota]);
  }
  return entries.length ? Object.fromEntries(entries) : null;
}

function usedPercent(quota) {
  return quota.remaining_fraction === undefined ? null : Math.round(100 * (1 - quota.remaining_fraction) * 1e10) / 1e10;
}

export function writeAntigravityStatusline(rawInput, { home = defaultHome(), now = new Date() } = {}) {
  const at = new Date(typeof now === 'function' ? now() : now);
  if (!Number.isFinite(at.getTime())) throw new Error('Invalid timestamp for statusline.');
  let parsed;
  try { parsed = JSON.parse(String(rawInput ?? '')); } catch { parsed = null; }
  const quota = extractAntigravityQuota(parsed, { now: at });
  parsed = null;
  if (quota) {
    fs.mkdirSync(home, { recursive: true });
    const file = path.join(home, ANTIGRAVITY_FILE);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, fetchedAt: at.toISOString(), quota }, null, 2) + '\n');
    fs.renameSync(tmp, file);
  }
  const parts = Object.entries(quota ?? {}).map(([bucket, entry]) => {
    if (entry.disabled) return `${cell(bucket)} disabled`;
    const used = usedPercent(entry);
    return `${cell(bucket)} ${used === null ? '?%' : `${used}%`} (${formatRemaining(Date.parse(entry.reset_time) - at.getTime())})`;
  });
  return { quota, summary: parts.length ? `antigravity ${parts.join(' | ')}` : 'quota-clock: waiting for antigravity quota' };
}

export function readAntigravityRecords({ home = defaultHome() } = {}) {
  const file = path.join(home, ANTIGRAVITY_FILE);
  if (!fs.existsSync(file)) return [];
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error('Antigravity quota cache is not valid JSON.');
    throw error;
  }
  const fetchedAt = iso(data?.fetchedAt);
  if (!fetchedAt) return [];
  const quota = extractAntigravityQuota(data, { now: new Date(fetchedAt) });
  return Object.entries(quota ?? {}).filter(([, entry]) => !entry.disabled && entry.reset_time).map(([window, entry]) => ({
    service: 'antigravity', window, resetAt: entry.reset_time, periodMinutes: null,
    usedPercent: usedPercent(entry), source: 'antigravity-statusline', fetchedAt, note: '',
  }));
}

// Passive cache import only. Never launch agy, query APIs, or change application settings.
export const antigravityCollector = Object.freeze({ name: 'antigravity-statusline', collect: async options => readAntigravityRecords(options) });
