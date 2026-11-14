// AI service usage windows (5-hour / weekly limits) collected on this PC.
// Collectors are vendored from quota-clock; see NOTICE.
import { codexCollector } from './collectors/codex.mjs';
import { claudeCodeCollector } from './collectors/claude-code.mjs';
import { antigravityCollector } from './collectors/antigravity.mjs';
import { defaultHome } from './store.mjs';

export const BUILTIN_COLLECTORS = Object.freeze([codexCollector, claudeCodeCollector, antigravityCollector]);

// Which usage "service" a participant's client consumes by default. Overridable per label.
export const DEFAULT_USAGE_SERVICE = Object.freeze({
  'claude-code': 'claude',
  'claude-ai': 'claude',
  'codex-mcp-client': 'codex',
  'antigravity-client': 'antigravity'
});

export const USAGE_SOURCES = Object.freeze(['codex-session', 'claude-code', 'antigravity-statusline', 'self-report', 'manual']);

// Run each collector on its own so one broken source never hides the others.
export async function collectUsage({ collectors = BUILTIN_COLLECTORS, home = defaultHome(), now = new Date() } = {}) {
  const records = [], errors = [];
  for (const c of collectors) {
    const name = c?.name || 'collector';
    try {
      const run = typeof c === 'function' ? c : c.collect;
      const out = await run.call(c, { now: new Date(now), home });
      if (!Array.isArray(out)) throw new Error('collector did not return an array');
      for (const r of out) {
        const rec = normalizeRecord(r, { source: r?.source ?? name, fetchedAt: r?.fetchedAt ?? new Date(now).toISOString() });
        if (rec) records.push(rec);
      }
    } catch (error) {
      errors.push({ collector: name, error: String(error?.message || error).slice(0, 300) });
    }
  }
  return { records, errors };
}

const clean = (v, max = 80) => {
  const s = String(v ?? '').trim();
  return s && s.length <= max && /^[\w.:@+-]+$/.test(s) ? s : null;
};

// Accepts quota-clock records ({service, window, resetAt, periodMinutes, usedPercent, source, fetchedAt})
// and returns the DB shape, or null when the record is unusable.
export function normalizeRecord(r, defaults = {}) {
  if (!r || typeof r !== 'object') return null;
  const service = clean(r.service), window = clean(r.window);
  if (!service || !window) return null;
  const resetsAt = toMs(r.resetAt ?? r.resets_at);
  if (resetsAt == null) return null;
  const used = r.usedPercent ?? r.used_percent;
  const usedPercent = used == null ? null : Number(used);
  if (usedPercent != null && !(Number.isFinite(usedPercent) && usedPercent >= 0 && usedPercent <= 100)) return null;
  const period = r.periodMinutes ?? r.period_minutes ?? null;
  const periodMinutes = period == null ? null : Number(period);
  const source = clean(r.source ?? defaults.source, 40) || 'manual';
  const fetchedAt = toMs(r.fetchedAt ?? r.fetched_at ?? defaults.fetchedAt);
  return {
    service, window, used_percent: usedPercent, resets_at: resetsAt,
    period_minutes: Number.isFinite(periodMinutes) && periodMinutes > 0 ? Math.round(periodMinutes) : null,
    source, fetched_at: fetchedAt
  };
}

function toMs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? (v < 1e12 ? Math.round(v * 1000) : Math.round(v)) : null;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

// Roll a periodic window forward once its reset has passed.
export function nextResetMs(resetsAt, periodMinutes, now) {
  if (resetsAt > now || !periodMinutes) return resetsAt;
  const p = periodMinutes * 60_000;
  return resetsAt + (Math.floor((now - resetsAt) / p) + 1) * p;
}
