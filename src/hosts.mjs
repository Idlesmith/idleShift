// Connection setup for AI apps. Nothing is written unless a person clicks:
// every change shows the exact entry first, keeps a backup of the file, and
// can be removed again. Only our own "idleshift" entry is ever touched.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { APP_ROOT, dataHome } from './paths.mjs';
import { stamp } from './db.mjs';
import { t, resolveUiLanguage } from './i18n/index.mjs';

export const SERVER_NAME = 'idleshift';

export function relayCommand(env = process.env) {
  const entry = { command: process.execPath, args: ['--disable-warning=ExperimentalWarning', path.join(APP_ROOT, 'bin', 'idleshift.mjs'), 'mcp'] };
  if (env.IDLESHIFT_HOME) {
    const explicit = path.resolve(env.IDLESHIFT_HOME);
    const defaultHome = path.resolve(path.join(userHome(env), '.idleshift'));
    if (explicit.toLowerCase() !== defaultHome.toLowerCase()) {
      entry.env = { IDLESHIFT_HOME: explicit };
    }
  }
  return entry;
}

const userHome = env => env.USERPROFILE || env.HOME || '';

function findExe(name, candidates) {
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  const r = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [name], { encoding: 'utf8', windowsHide: true });
  const first = r.status === 0 ? r.stdout.split(/\r?\n/).map(l => l.trim()).find(l => l && (process.platform !== 'win32' || /\.(exe|cmd)$/i.test(l))) : null;
  return first || null;
}

const tomlStr = v => (v.includes("'") || /[\r\n]/.test(v) ? JSON.stringify(v) : `'${v}'`);
export const tomlInline = v => (Array.isArray(v) ? `[${v.map(tomlStr).join(', ')}]` : tomlStr(v));

function codexBlock(entry) {
  const lines = [`[mcp_servers.${SERVER_NAME}]`, `command = ${tomlStr(entry.command)}`, `args = ${tomlInline(entry.args)}`, 'startup_timeout_sec = 30', 'tool_timeout_sec = 3600', 'default_tools_approval_mode = "approve"'];
  if (entry.env) { lines.push('', `[mcp_servers.${SERVER_NAME}.env]`); for (const [k, v] of Object.entries(entry.env)) lines.push(`${k} = ${tomlStr(v)}`); }
  return lines.join('\n') + '\n';
}

// Conservative TOML editing, following https://toml.io/en/v1.0.0.
// Parse key paths rather than matching their spelling. Unsupported constructs
// are rejected before hostChange creates a backup or writes the original file.
const tomlError = (lang = resolveUiLanguage('auto')) => { throw new Error(t(lang, 'hosts.toml_error')); };

function tomlQuoted(line, start) {
  const quote = line[start];
  if (line.slice(start, start + 3) === quote.repeat(3)) tomlError();
  let value = '';
  for (let i = start + 1; i < line.length; i++) {
    const c = line[i];
    if (c === quote) return { value, end: i + 1 };
    if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(c)) tomlError();
    if (quote === '"' && c === '\\') {
      const e = line[++i];
      const escapes = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
      if (Object.hasOwn(escapes, e)) value += escapes[e];
      else if (e === 'u' || e === 'U') {
        const size = e === 'u' ? 4 : 8;
        const hex = line.slice(i + 1, i + 1 + size);
        if (hex.length !== size || !/^[0-9a-f]+$/i.test(hex)) tomlError();
        const cp = Number.parseInt(hex, 16);
        if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) tomlError();
        value += String.fromCodePoint(cp); i += size;
      } else tomlError();
    } else value += c;
  }
  tomlError();
}

function tomlKey(line, terminator) {
  const keys = []; let i = 0;
  const ws = () => { while (line[i] === ' ' || line[i] === '\t') i++; };
  for (;;) {
    ws();
    if (line[i] === '"' || line[i] === "'") {
      const token = tomlQuoted(line, i); keys.push(token.value); i = token.end;
    } else {
      const key = /^[A-Za-z0-9_-]+/.exec(line.slice(i));
      if (!key) tomlError();
      keys.push(key[0]); i += key[0].length;
    }
    ws();
    if (line[i] === terminator) return { keys, rest: line.slice(i + 1) };
    if (line[i++] !== '.') tomlError();
  }
}

// Only single-line values are editable. This prevents header-like text inside
// multiline strings or arrays from ever being interpreted as a table boundary.
function checkTomlValue(value) {
  const brackets = []; let content = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '#') break;
    if (c === ' ' || c === '\t') continue;
    content = true;
    if (c === '"' || c === "'") { i = tomlQuoted(value, i).end - 1; continue; }
    if (c === '[' || c === '{') brackets.push(c);
    if (c === ']' || c === '}') {
      if (brackets.pop() !== (c === ']' ? '[' : '{')) tomlError();
    }
  }
  if (!content || brackets.length) tomlError();
}

export function splitToml(text) {
  const lines = text.split(/\r?\n/);
  const out = []; const block = []; let inside = false; let table = [];
  for (const l of lines) {
    const line = l.trimStart();
    if (line && !line.startsWith('#')) {
      if (line.startsWith('[')) {
        const parsed = tomlKey(line.slice(1), ']');
        if (!/^[ \t]*(?:#.*)?$/.test(parsed.rest)) tomlError();
        table = parsed.keys;
        inside = table[0] === 'mcp_servers' && table[1] === SERVER_NAME;
      } else {
        const parsed = tomlKey(line, '=');
        const full = [...table, ...parsed.keys];
        // Dotted/inline server definitions outside our own table cannot be
        // removed by a table-range edit; leave the complete file untouched.
        if (!inside && full[0] === 'mcp_servers' && (full.length === 1 || full[1] === SERVER_NAME)) tomlError();
        checkTomlValue(parsed.rest);
      }
    }
    (inside ? block : out).push(l);
  }
  return { rest: out.join('\n').replace(/\n{3,}$/, '\n'), block: block.join('\n').trim() };
}

function jsonHost({ key, name, file, note, shape = e => ({ command: e.command, args: e.args, ...(e.env ? { env: e.env } : {}) }) }) {
  return {
    key, name, note, kind: 'json', file,
    detected: () => fs.existsSync(path.dirname(file)),
    current() {
      if (!fs.existsSync(file)) return null;
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      return j.mcpServers?.[SERVER_NAME] ?? null;
    },
    desired: entry => shape(entry),
    apply(entry) {
      const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '{}';
      const j = text.trim() ? JSON.parse(text) : {};
      if (typeof j !== 'object' || Array.isArray(j)) throw new Error(t(resolveUiLanguage('auto'), 'hosts.invalid_format'));
      j.mcpServers = j.mcpServers && typeof j.mcpServers === 'object' ? j.mcpServers : {};
      if (entry) j.mcpServers[SERVER_NAME] = shape(entry); else delete j.mcpServers[SERVER_NAME];
      const indent = text.match(/^(\s+)"/m)?.[1] ?? '  ';
      return JSON.stringify(j, null, indent.includes('\t') ? '\t' : indent.length) + '\n';
    }
  };
}

export function hostList(env = process.env, lang = resolveUiLanguage('auto')) {
  const home = userHome(env);
  const agyNew = path.join(home, '.gemini', 'config', 'mcp_config.json');
  const agyOld = path.join(home, '.gemini', 'antigravity', 'mcp_config.json');
  const codexFile = path.join(env.CODEX_HOME || path.join(home, '.codex'), 'config.toml');
  return [
    {
      key: 'claude-code', name: t(lang, 'hosts.claude_code_name'), kind: 'cli', file: path.join(home, '.claude.json'),
      note: t(lang, 'hosts.claude_code_note'),
      exe: () => findExe('claude', [path.join(home, '.local', 'bin', 'claude.exe')]),
      detected() { return !!this.exe(); },
      current() { try { return JSON.parse(fs.readFileSync(this.file, 'utf8')).mcpServers?.[SERVER_NAME] ?? null; } catch { return null; } },
      desired: e => ({ type: 'stdio', command: e.command, args: e.args, env: e.env || {} })
    },
    jsonHost({ key: 'claude-desktop', name: t(lang, 'hosts.claude_desktop_name'), file: path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json'), note: t(lang, 'hosts.claude_desktop_note') }),
    {
      key: 'codex', name: t(lang, 'hosts.codex_name'), kind: 'toml', file: codexFile,
      note: t(lang, 'hosts.codex_note'),
      detected: () => fs.existsSync(path.dirname(codexFile)),
      current() { if (!fs.existsSync(codexFile)) return null; return splitToml(fs.readFileSync(codexFile, 'utf8')).block || null; },
      desired: e => codexBlock(e).trim(),
      apply(entry) {
        const text = fs.existsSync(codexFile) ? fs.readFileSync(codexFile, 'utf8') : '';
        const { rest } = splitToml(text);
        return entry ? `${rest.replace(/\s*$/, '')}\n\n${codexBlock(entry)}` : rest.replace(/\s*$/, '') + '\n';
      }
    },
    jsonHost({ key: 'antigravity', name: 'Antigravity', file: fs.existsSync(agyNew) || !fs.existsSync(agyOld) ? agyNew : agyOld, note: t(lang, 'hosts.antigravity_note'), shape: e => ({ command: e.command, args: e.args, ...(e.env ? { env: e.env } : {}), disabled: false }) })
  ];
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const show = (v, lang = 'en') => (v == null ? t(lang, 'hosts.not_registered') : typeof v === 'string' ? v : JSON.stringify(v, null, 2));

export function hostStatus(env = process.env, lang = resolveUiLanguage('auto')) {
  const entry = relayCommand(env);
  return hostList(env, lang).map(h => {
    let current = null, error = null, detected = false;
    try { detected = !!h.detected(); current = detected ? h.current() : null; } catch (e) { error = t(lang, 'hosts.read_error', String(e.message || e).slice(0, 120)); }
    const desired = h.desired(entry);
    const isRegistered = current != null;
    const isUpToDate = isRegistered && same(current, desired);
    let reason = null;
    if (isRegistered && !isUpToDate) {
      const curStr = typeof current === 'string' ? current : JSON.stringify(current);
      if (curStr.includes('IDLESHIFT_HOME')) {
        reason = t(lang, 'hosts.outdated_legacy_home');
      } else {
        reason = t(lang, 'hosts.outdated_generic');
      }
    }
    return { key: h.key, name: h.name, note: h.note, file: h.file, detected, registered: isRegistered, up_to_date: isUpToDate, reason, error, current: show(current, lang), desired: show(desired, lang) };
  });
}

function backup(file, key, home) {
  if (!fs.existsSync(file)) return null;
  const target = path.join(home, 'host-backups', `${key}-${stamp()}${path.extname(file) || '.bak'}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(file, target);
  return target;
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.idleshift-tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

// register=true adds/updates our entry, false removes it.
export function hostChange(key, register, { env = process.env, home = dataHome(env), lang = resolveUiLanguage('auto') } = {}) {
  const h = hostList(env, lang).find(x => x.key === key);
  if (!h) throw new Error(t(lang, 'hosts.unknown_host'));
  const entry = relayCommand(env);
  if (h.kind === 'cli') {
    const exe = h.exe();
    if (!exe) throw new Error(t(lang, 'hosts.claude_not_found'));
    const saved = backup(h.file, key, home);
    spawnSync(exe, ['mcp', 'remove', '--scope', 'user', SERVER_NAME], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    if (register) {
      const r = spawnSync(exe, ['mcp', 'add-json', '--scope', 'user', SERVER_NAME, JSON.stringify(h.desired(entry))], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
      if (r.status !== 0) throw new Error(t(lang, 'hosts.register_failed', (r.stderr || r.stdout || '').trim().slice(0, 200)));
    }
    return { ok: true, backup: saved };
  }
  const next = h.apply(register ? entry : null);
  const saved = backup(h.file, key, home);
  writeAtomic(h.file, next);
  return { ok: true, backup: saved };
}
