// Vendored from quota-clock (MIT License, Copyright (c) quota-clock contributors). See NOTICE.
// Time parsing and reset arithmetic. Everything takes an explicit `now` so it is testable.
const UNIT_MS = { d: 86_400_000, h: 3_600_000, m: 60_000 };
const HINT = 'Use e.g. "155m", "2h30m", "+155", "00:50" or an ISO date.';

export function parseWhen(input, now = new Date()) {
  if (input instanceof Date) return new Date(input.getTime());
  const s = String(input ?? '').trim();
  if (!s) throw new Error(`Empty time. ${HINT}`);
  const base = now.getTime();

  // "+155" = minutes from now
  let m = /^\+(\d+)$/.exec(s);
  if (m) return new Date(base + Number(m[1]) * UNIT_MS.m);

  // "3d", "2h30m", "155m", "1d2h"
  if (/^(\d+[dhm])+$/i.test(s)) {
    let ms = 0;
    for (const [, n, u] of s.toLowerCase().matchAll(/(\d+)([dhm])/g)) ms += Number(n) * UNIT_MS[u];
    return new Date(base + ms);
  }

  // "00:50" / "13:05" local time, next occurrence (today or tomorrow)
  m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (m) {
    const hh = Number(m[1]), mm = Number(m[2]);
    if (hh > 23 || mm > 59) throw new Error(`Invalid time of day "${s}". ${HINT}`);
    const d = new Date(base);
    d.setHours(hh, mm, 0, 0);
    if (d.getTime() <= base) d.setDate(d.getDate() + 1);
    return d;
  }

  // ISO 8601
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return d;
  }
  throw new Error(`Cannot understand time "${s}". ${HINT}`);
}

// If resetAt has passed and the window repeats, roll it forward to the next future reset.
export function nextReset(resetAt, periodMinutes, now = new Date()) {
  const t = new Date(resetAt).getTime();
  if (Number.isNaN(t)) throw new Error(`Invalid reset time: ${resetAt}`);
  const n = now.getTime();
  if (t > n || !periodMinutes || periodMinutes <= 0) return new Date(t);
  const p = periodMinutes * UNIT_MS.m;
  const steps = Math.floor((n - t) / p) + 1;
  return new Date(t + steps * p);
}

export function formatRemaining(ms) {
  if (ms <= 0) return 'now';
  const total = Math.ceil(ms / UNIT_MS.m);
  const d = Math.floor(total / 1440), h = Math.floor((total % 1440) / 60), m = total % 60;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m || !parts.length) parts.push(`${m}m`);
  return parts.join(' ');
}
