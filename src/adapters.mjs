// Optional CLI wake-up adapters (off by default, per project).
//
// An MCP server cannot wake a conversation whose turn has ended. When a person
// explicitly enables an adapter, IdleShift may start that vendor's own CLI so
// work continues while no app is waiting. The CLI - not IdleShift - talks to
// the AI service, under that CLI's own login and permission settings. This is
// a different mechanism from the app-side waiting, and is shown separately.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { relayCommand, tomlInline, SERVER_NAME } from './hosts.mjs';
import { TOOL_NAMES } from './tools.mjs';
import { stamp } from './db.mjs';
import { t, resolveUiLanguage } from './i18n/index.mjs';

const LIMIT_RE = /usage limit|rate limit|quota|limit reached|too many requests|上限/i;

export function wakePrompt(root, lang = 'en') {
  return t(lang, 'adapters.wake_prompt', root);
}

function locate(name, extra = []) {
  for (const c of extra) if (c && fs.existsSync(c)) return c;
  const r = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [name], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.split(/\r?\n/).map(l => l.trim()).find(l => l && (process.platform !== 'win32' || /\.exe$/i.test(l))) || null : null;
}

export const ADAPTERS = {
  claude: {
    name: 'Claude Code CLI', client: 'claude-code',
    exe: env => locate('claude', [env.USERPROFILE && path.join(env.USERPROFILE, '.local', 'bin', 'claude.exe')]),
    build({ root, access, home, env, model, lang = 'en' }) {
      const cfg = path.join(home, 'adapter-mcp.json');
      const e = relayCommand(env);
      fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { [SERVER_NAME]: { type: 'stdio', command: e.command, args: e.args, env: e.env || {} } } }));
      const tools = [...TOOL_NAMES.map(t => `mcp__${SERVER_NAME}__${t}`), 'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', ...(access === 'write' ? ['Edit', 'Write'] : [])];
      return { args: ['-p', '--output-format', 'json', '--mcp-config', cfg, '--permission-mode', access === 'write' ? 'acceptEdits' : 'default', '--allowedTools', ...tools, ...(model ? ['--model', model] : [])], stdin: wakePrompt(root, lang) };
    }
  },
  codex: {
    name: 'Codex CLI', client: 'codex-mcp-client',
    exe: () => locate('codex'),
    build({ root, access, env, model, lang = 'en' }) {
      const e = relayCommand(env);
      const args = ['exec', '--cd', root, '-s', access === 'write' ? 'workspace-write' : 'read-only', '--skip-git-repo-check',
        '-c', `mcp_servers.${SERVER_NAME}.command=${tomlInline(e.command)}`, '-c', `mcp_servers.${SERVER_NAME}.args=${tomlInline(e.args)}`, '-c', `mcp_servers.${SERVER_NAME}.tool_timeout_sec=120`,
        // Codex asks before every MCP tool call unless the server's tools are pre-approved; headless runs cannot answer.
        '-c', `mcp_servers.${SERVER_NAME}.default_tools_approval_mode="approve"`];
      if (e.env) for (const [k, v] of Object.entries(e.env)) args.push('-c', `mcp_servers.${SERVER_NAME}.env.${k}=${tomlInline(v)}`);
      if (model) args.push('-m', model);
      return { args: [...args, '-'], stdin: wakePrompt(root, lang) };
    }
  },
  agy: {
    name: (lang = resolveUiLanguage('auto')) => t(lang, 'adapters.antigravity_name'),
    exe: env => locate('agy', [env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe')]),
    build({ root, model, lang = 'en' }) {
      return { args: ['--input-format', 'stream-json', '--output-format', 'stream-json', '--print-timeout', '1500s', ...(model ? ['--model', model] : [])], stdin: JSON.stringify({ event: 'user', message: { content: wakePrompt(root, lang) } }) + '\n' };
    }
  }
};

export class AdapterManager {
  constructor(ctx, { home, env = process.env, log = () => {} }) {
    this.ctx = ctx; this.home = home; this.env = env; this.log = log;
    this.running = new Map();   // projectId -> { key, child, started }
    this.launches = [];         // { project, at }
    this.backoff = new Map();   // key -> until
    this.openSince = new Map(); // projectId -> first time work was seen with nobody waiting
  }

  status() { return { running: [...this.running].map(([project, r]) => ({ project, adapter: r.key, started: r.started })), backoff: Object.fromEntries(this.backoff) }; }

  tick() {
    const core = this.ctx.core;
    const now = Date.now();
    this.launches = this.launches.filter(l => now - l.at < 3600_000);
    for (const pr of core.all('SELECT * FROM projects WHERE stopped=0')) {
      let cfg; try { cfg = JSON.parse(pr.adapters || '{}'); } catch { cfg = {}; }
      const keys = Object.keys(ADAPTERS).filter(k => cfg[k]?.enabled);
      if (!keys.length || this.running.has(pr.id)) continue;
      const open = core.offerableCount(pr.id);
      const usable = k => (this.backoff.get(k) || 0) < now && !core.limited(`cli-${k}`) && core.offerableCount(pr.id, ADAPTERS[k].client || null) > 0;
      const waiting = [...core.waiters.values()].some(w => w.project === pr.id);
      const busy = core.one("SELECT COUNT(*) c FROM participants WHERE project_id=? AND revoked=0 AND last_seen>?", pr.id, now - 60_000).c;
      if (!open || waiting || busy) { this.openSince.delete(pr.id); continue; }
      if (!this.openSince.has(pr.id)) { this.openSince.set(pr.id, now); continue; }
      if (now - this.openSince.get(pr.id) < 20_000) continue; // give a connected app a moment to pick the work up first
      if (this.launches.filter(l => l.project === pr.id).length >= (cfg.max_per_hour || 3)) continue;
      const root = core.one('SELECT path_display FROM roots WHERE project_id=? ORDER BY created_at LIMIT 1', pr.id)?.path_display;
      if (!root || !fs.existsSync(root)) continue;
      const key = keys.find(usable); // skip a CLI that would only be told "nothing for you"
      if (key) this.launch(pr.id, key, root, cfg[key].access, cfg[key].model);
    }
  }

  launch(projectId, key, root, access, model) {
    const a = ADAPTERS[key];
    const exe = a.exe(this.env);
    const core = this.ctx.core;
    if (!exe) { this.backoff.set(key, Date.now() + 3600_000); core.event('adapter_missing', { project: projectId, data: { adapter: key } }); return; }
    const { args, stdin } = a.build({ root, access, home: this.home, env: this.env, model, lang: core.aiLang() });
    const logFile = path.join(this.home, 'logs', `adapter-${key}-${stamp()}.log`);
    const out = fs.createWriteStream(logFile);
    const child = spawn(exe, args, { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: this.env });
    let tail = '';
    const keep = d => { out.write(d); tail = (tail + d.toString('utf8')).slice(-4000); };
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
    const timer = setTimeout(() => child.kill(), 30 * 60_000);
    this.running.set(projectId, { key, child, started: Date.now() });
    this.launches.push({ project: projectId, at: Date.now() });
    this.openSince.delete(projectId);
    core.event('adapter_started', { project: projectId, data: { adapter: key, access } });
    this.log(`adapter ${key} started for ${projectId}`);
    const done = code => {
      if (!this.running.has(projectId)) return;
      clearTimeout(timer); out.end(); this.running.delete(projectId);
      const limited = code !== 0 && LIMIT_RE.test(tail);
      if (limited) this.ctx.core.setQuota(`cli-${key}`, { state: 'limit', detail: this.ctx.core.tUi('adapters.limit_detail') }, 'adapter');
      if (code !== 0) this.backoff.set(key, Date.now() + (limited ? 30 : 10) * 60_000);
      this.ctx.core.event('adapter_exited', { project: projectId, data: { adapter: key, code, limited, log: path.basename(logFile) } });
      this.log(`adapter ${key} exited ${code}`);
    };
    child.on('exit', done);
    child.on('error', () => done(-1));
  }

  stopAll() { for (const r of this.running.values()) try { r.child.kill(); } catch { /* already gone */ } }
}
