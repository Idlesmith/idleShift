// Vendored from quota-clock (MIT License, Copyright (c) quota-clock contributors). See NOTICE.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaultHome } from '../store.mjs';
import { formatRemaining } from '../time.mjs';

export const CLAUDE_CODE_FILE = 'claude-code.json';

const WINDOW_SPECS = [
  { key: 'five_hour', window: '5h', periodMinutes: 300 },
  { key: 'seven_day', window: 'weekly', periodMinutes: 10080 },
];

function parseResetEpochSeconds(value) {
  const sec = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(sec) || sec <= 0) return null;
  const d = new Date(sec * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function parseUsedPercentage(value) {
  if (value === undefined || value === null || value === '') return null;
  const pct = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(pct)) return null;
  return Math.min(100, Math.max(0, pct));
}

// Extract only rate_limits.five_hour and rate_limits.seven_day from Claude Code statusline JSON.
// Never retain conversation paths, session IDs, workspace paths, or any other fields.
export function extractRateLimits(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const rawLimits = payload.rate_limits;
  if (!rawLimits || typeof rawLimits !== 'object' || Array.isArray(rawLimits)) return null;

  const extracted = {};
  for (const { key } of WINDOW_SPECS) {
    const entry = rawLimits[key];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const resetsAt = parseResetEpochSeconds(entry.resets_at);
    if (!resetsAt) continue;
    const usedPercentage = parseUsedPercentage(entry.used_percentage);
    extracted[key] = {
      used_percentage: usedPercentage,
      resets_at: Number(entry.resets_at),
    };
  }
  return Object.keys(extracted).length ? extracted : null;
}

export function writeClaudeCodeStatusline(rawInput, { home = defaultHome(), now = new Date() } = {}) {
  const at = new Date(typeof now === 'function' ? now() : now);
  if (Number.isNaN(at.getTime())) throw new Error('Invalid timestamp for statusline.');
  const text = String(rawInput ?? '').trim();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  const rateLimits = extractRateLimits(parsed);
  if (rateLimits) {
    fs.mkdirSync(home, { recursive: true });
    const file = path.join(home, CLAUDE_CODE_FILE);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    const stored = {
      version: 1,
      fetchedAt: at.toISOString(),
      rate_limits: rateLimits,
    };
    fs.writeFileSync(tmp, JSON.stringify(stored, null, 2) + '\n');
    fs.renameSync(tmp, file);
  }
  return { rateLimits, summary: formatStatuslineSummary(parsed, rateLimits, at) };
}

export function formatStatuslineSummary(payload, rateLimits = extractRateLimits(payload), now = new Date()) {
  const at = new Date(typeof now === 'function' ? now() : now);
  const parts = [];
  if (rateLimits) {
    for (const { key, window } of WINDOW_SPECS) {
      const entry = rateLimits[key];
      if (!entry) continue;
      const pct = entry.used_percentage === null || entry.used_percentage === undefined
        ? '?%'
        : `${Math.round(entry.used_percentage)}%`;
      const remainingMs = Math.max(0, entry.resets_at * 1000 - at.getTime());
      parts.push(`${window} ${pct} (${formatRemaining(remainingMs)})`);
    }
  }
  if (!parts.length) return 'quota-clock: waiting for rate_limits';
  return `claude ${parts.join(' | ')}`;
}

export function runStatuslineChain(command, rawInput, env = process.env) {
  const result = spawnSync(command, {
    input: rawInput,
    encoding: 'utf8',
    shell: true,
    env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr || '').trim() || `exit code ${result.status}`;
    throw new Error(`Chained statusline command failed: ${detail}`);
  }
  return result.stdout ?? '';
}

export function readClaudeCodeRecords({ home = defaultHome() } = {}) {
  const file = path.join(home, CLAUDE_CODE_FILE);
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`${file} is not valid JSON (${e.message}).`);
  }
  const rateLimits = extractRateLimits(data);
  if (!rateLimits) return [];
  const fetchedAt = typeof data.fetchedAt === 'string' && !Number.isNaN(Date.parse(data.fetchedAt))
    ? new Date(data.fetchedAt).toISOString()
    : null;

  const records = [];
  for (const { key, window, periodMinutes } of WINDOW_SPECS) {
    const entry = rateLimits[key];
    if (!entry) continue;
    const resetAt = parseResetEpochSeconds(entry.resets_at);
    if (!resetAt) continue;
    records.push({
      service: 'claude',
      window,
      resetAt,
      periodMinutes,
      usedPercent: entry.used_percentage ?? null,
      source: 'claude-code',
      fetchedAt,
      note: '',
    });
  }
  return records;
}

export const claudeCodeCollector = Object.freeze({
  name: 'claude-code',
  async collect(options = {}) {
    const home = options.home ?? defaultHome();
    return readClaudeCodeRecords({ home });
  },
});
