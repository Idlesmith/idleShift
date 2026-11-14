// Vendored from quota-clock (MIT License, Copyright (c) quota-clock contributors). See NOTICE.
import { antigravityCollector } from './antigravity.mjs';
import { codexCollector } from './codex.mjs';
import { claudeCodeCollector } from './claude-code.mjs';

export { claudeCodeCollector, codexCollector, antigravityCollector };

// Built-in collector functions.
// A collector is an async function, or { name, collect }, returning quota records.
export const collectors = Object.freeze([codexCollector, claudeCodeCollector, antigravityCollector]);

export async function collect({ collectors: selected = collectors, now = new Date(), home } = {}) {
  if (!Array.isArray(selected)) throw new Error('collectors must be an array.');
  const at = new Date(typeof now === 'function' ? now() : now);
  if (Number.isNaN(at.getTime())) throw new Error('Invalid collection time.');
  const records = [];
  for (const collector of selected) {
    const run = typeof collector === 'function' ? collector : collector?.collect;
    if (typeof run !== 'function') throw new Error('Each collector must be a function or have a collect function.');
    const result = await run.call(collector, { now: new Date(at), home });
    if (!Array.isArray(result)) throw new Error('A collector must return an array of quota records.');
    for (const record of result) {
      if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Invalid collector record.');
      records.push({ ...record, source: record.source ?? (collector.name || 'collector'), fetchedAt: record.fetchedAt === undefined ? at.toISOString() : record.fetchedAt });
    }
  }
  return records;
}
