// Vendored from quota-clock (MIT License, Copyright (c) quota-clock contributors). See NOTICE.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const TAIL_BYTES = 256 * 1024;
const missing = error => error.code === 'ENOENT' || error.code === 'ENOTDIR';

async function entries(directory) {
  try { return await fs.readdir(directory, { withFileTypes: true }); }
  catch (error) { if (missing(error)) return []; throw error; }
}

async function sessionFiles(root) {
  const files = [];
  async function visit(directory, depth = 0) {
    for (const entry of await entries(directory)) {
      const file = path.join(directory, entry.name);
      if (depth < 3) {
        if (entry.isDirectory() && (depth === 0 ? /^\d{4}$/ : /^\d{2}$/).test(entry.name)) await visit(file, depth + 1);
      } else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
        try { files.push({ file, mtime: (await fs.stat(file)).mtimeMs }); }
        catch (error) { if (!missing(error)) throw error; }
      }
    }
  }
  await visit(root);
  return files.sort((a, b) => b.mtime - a.mtime || b.file.localeCompare(a.file));
}

async function readTail(file) {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const { size } = await handle.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(Math.min(size, TAIL_BYTES));
    let count = 0;
    while (count < buffer.length) {
      const { bytesRead } = await handle.read(buffer, count, buffer.length - count, start + count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    const text = buffer.subarray(0, count).toString('utf8');
    // The first line may start mid-record or mid-UTF-8 character.
    return start ? text.slice(text.indexOf('\n') === -1 ? text.length : text.indexOf('\n') + 1) : text;
  } catch (error) {
    if (missing(error)) return '';
    throw error;
  } finally { await handle?.close(); }
}

function quotaRecords(event) {
  if (event?.type !== 'event_msg' || event.payload?.type !== 'token_count') return [];
  if (typeof event.timestamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(event.timestamp) || !Number.isFinite(Date.parse(event.timestamp))) return [];
  const limits = event.payload.rate_limits;
  if (!limits || typeof limits !== 'object') return [];
  const records = [];
  for (const key of ['primary', 'secondary']) {
    const quota = limits[key];
    if (!quota || typeof quota !== 'object') continue;
    const { used_percent: used, window_minutes: minutes, resets_at: reset } = quota;
    if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100) continue;
    if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) continue;
    if (typeof reset !== 'number' || !Number.isFinite(reset) || reset <= 0) continue;
    const at = new Date(reset * 1000);
    if (!Number.isFinite(at.getTime())) continue;
    records.push({ service: 'codex', window: minutes === 300 ? '5h' : minutes === 10080 ? 'weekly' : `${minutes}m`,
      resetAt: at.toISOString(), periodMinutes: minutes, usedPercent: used,
      source: 'codex-session', fetchedAt: new Date(event.timestamp).toISOString() });
  }
  return records;
}

// Read only bounded tails of session rollouts. Never open auth.json or other app files.
// Non-quota lines are not parsed or returned; paths and payload details are not persisted.
export async function collectCodex({ codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex') } = {}) {
  for (const { file } of await sessionFiles(path.join(codexHome, 'sessions'))) {
    const lines = (await readTail(file)).split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!/"type"\s*:\s*"token_count"/.test(line) || !/"rate_limits"\s*:/.test(line)) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      const records = quotaRecords(event);
      if (records.length) return records;
    }
  }
  return [];
}

export const codexCollector = Object.freeze({ name: 'codex-session', collect: collectCodex });
