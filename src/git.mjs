// Git worktree helpers. Every git invocation uses spawnSync with an argument array
// (no shell) and never touches remotes (no push/fetch/pull).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function runGit(cwd, args) {
  const res = spawnSync('git', ['-c', 'core.longpaths=true', '-c', 'core.quotepath=false', ...args], {
    cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  if (res.error) {
    return { ok: false, code: -1, stdout: '', stderr: res.error.message || String(res.error), enoent: res.error.code === 'ENOENT' };
  }
  return {
    ok: res.status === 0,
    code: res.status ?? -1,
    stdout: (res.stdout || '').trimEnd(),
    stderr: (res.stderr || '').trimEnd(),
    enoent: false
  };
}

export function gitAvailable(cwd = process.cwd()) {
  const r = runGit(cwd, ['--version']);
  if (!r.ok) return { ok: false, version: null, reason: r.enoent ? 'git コマンドが見つかりません' : (r.stderr || 'git の実行に失敗しました') };
  const m = r.stdout.match(/(\d+)\.(\d+)/);
  const version = m ? `${m[1]}.${m[2]}` : r.stdout.trim();
  return { ok: true, version, reason: '' };
}

export function detectRepo(rootPath) {
  if (!rootPath || !fs.existsSync(rootPath)) {
    return { isRepo: false, hasHead: false, repoRoot: null, baseCommit: null, targetBranch: null, dirtyCount: 0, dirtyFiles: [], reason: '作業フォルダーが存在しません' };
  }
  const avail = gitAvailable(rootPath);
  if (!avail.ok) {
    return { isRepo: false, hasHead: false, repoRoot: null, baseCommit: null, targetBranch: null, dirtyCount: 0, dirtyFiles: [], reason: avail.reason };
  }
  const top = runGit(rootPath, ['rev-parse', '--show-toplevel']);
  if (!top.ok || !top.stdout) {
    return { isRepo: false, hasHead: false, repoRoot: null, baseCommit: null, targetBranch: null, dirtyCount: 0, dirtyFiles: [], reason: 'git リポジトリではありません' };
  }
  const repoRoot = path.resolve(top.stdout.trim());
  const head = runGit(repoRoot, ['rev-parse', '--verify', 'HEAD']);
  if (!head.ok || !head.stdout) {
    return { isRepo: true, hasHead: false, repoRoot, baseCommit: null, targetBranch: null, dirtyCount: 0, dirtyFiles: [], reason: 'コミットが1つもないリポジトリです' };
  }
  const branch = runGit(repoRoot, ['symbolic-ref', '--short', 'HEAD']);
  const status = runGit(repoRoot, ['status', '--porcelain']);
  const dirtyLines = status.ok && status.stdout ? status.stdout.split(/\r?\n/).filter(Boolean) : [];
  const dirtyFiles = dirtyLines.map(l => l.slice(3).trim()).filter(Boolean);
  const dirtyCount = dirtyLines.length;
  return {
    isRepo: true,
    hasHead: true,
    repoRoot,
    baseCommit: head.stdout.trim(),
    targetBranch: branch.ok && branch.stdout ? branch.stdout.trim() : null,
    dirtyCount,
    dirtyFiles,
    reason: ''
  };
}

export function branchExists(repoRoot, branch) {
  if (!repoRoot || !fs.existsSync(repoRoot)) return false;
  return runGit(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).ok;
}

export function createWorktree({ repoRoot, worktreePath, branch, baseCommit }) {
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  const r = runGit(repoRoot, ['worktree', 'add', '-b', branch, worktreePath, baseCommit]);
  if (!r.ok) return { ok: false, error: r.stderr || r.stdout || 'git worktree add に失敗しました' };
  return { ok: true, error: '' };
}

export function worktreeStatus(worktreePath) {
  if (!worktreePath || !fs.existsSync(worktreePath)) return { exists: false, uncommittedCount: 0, lines: [] };
  const r = runGit(worktreePath, ['status', '--porcelain']);
  const lines = r.ok && r.stdout ? r.stdout.split(/\r?\n/).filter(Boolean) : [];
  return { exists: true, uncommittedCount: lines.length, lines };
}

export function diffStats(repoRoot, baseCommit, branch) {
  if (!repoRoot || !fs.existsSync(repoRoot) || !baseCommit || !branch) return { commitCount: 0, stat: '' };
  const cnt = runGit(repoRoot, ['rev-list', '--count', `${baseCommit}..${branch}`]);
  const stat = runGit(repoRoot, ['diff', '--stat', `${baseCommit}..${branch}`]);
  return {
    commitCount: cnt.ok ? Number(cnt.stdout.trim()) || 0 : 0,
    stat: stat.ok ? stat.stdout.trim() : ''
  };
}

export function removeWorktree({ repoRoot, worktreePath, branch, force = false, deleteBranch = false, forceBranch = false }) {
  const errors = [];
  if (worktreePath && fs.existsSync(worktreePath) && repoRoot && fs.existsSync(repoRoot)) {
    const args = ['worktree', 'remove'];
    if (force) args.push('--force');
    args.push(worktreePath);
    const r = runGit(repoRoot, args);
    if (!r.ok) errors.push(r.stderr || r.stdout || 'git worktree remove に失敗しました');
  }
  if (repoRoot && fs.existsSync(repoRoot)) {
    runGit(repoRoot, ['worktree', 'prune']);
    if (deleteBranch && branch && branchExists(repoRoot, branch)) {
      const br = runGit(repoRoot, ['branch', forceBranch ? '-D' : '-d', branch]);
      if (!br.ok) errors.push(br.stderr || br.stdout || 'git branch 削除に失敗しました');
    }
  }
  return { ok: errors.length === 0, error: errors.join('; ') };
}

export function checkMergeConflict(repoRoot, targetBranch, featureBranch) {
  if (!repoRoot || !fs.existsSync(repoRoot)) return { ok: false, conflict: false, reason: 'リポジトリが見つかりません' };
  const r = runGit(repoRoot, ['merge-tree', '--write-tree', targetBranch, featureBranch]);
  if (!r.ok) {
    // If exit code is 1 and stdout has conflict markers, or stderr indicates syntax error
    if (r.stdout && !r.stderr) {
      // In git 2.38+, merge-tree exits with 1 on conflict and outputs tree OID or conflict list
      const lines = r.stdout.split(/\r?\n/).filter(Boolean);
      const conflictFiles = [];
      for (const line of lines) {
        const m = line.match(/CONFLICT \([^)]+\): (?:Merge conflict in )?(.+?)(?:;.*)?$/);
        if (m) {
          conflictFiles.push(m[1].trim());
        } else if (line.includes('CONFLICT')) {
          conflictFiles.push(line.trim());
        }
      }
      const files = conflictFiles.length > 0 ? Array.from(new Set(conflictFiles)) : lines.filter(l => l.includes('CONFLICT') || l.includes('Auto-merging'));
      return { ok: false, conflict: true, files: files.length ? files : [r.stdout], reason: '競合が発生します' };
    }
    const avail = gitAvailable(repoRoot);
    return { ok: false, conflict: false, reason: `git merge-tree が失敗しました（git 2.38以上が必要です。現在: ${avail.version || '不明'}）` };
  }
  return { ok: true, conflict: false, reason: '' };
}

export function executeMerge({ repoRoot, branch, title, taskId }) {
  if (!repoRoot || !fs.existsSync(repoRoot)) return { ok: false, error: 'リポジトリが見つかりません' };
  // First try fast-forward
  const ff = runGit(repoRoot, ['merge', '--ff-only', branch]);
  if (ff.ok) return { ok: true, method: 'ff' };
  // If not ff, non-ff with message
  const msg = `IdleShift: merge ${taskId} ${title || ''}`.trim();
  const noFf = runGit(repoRoot, ['merge', '--no-ff', '-m', msg, branch]);
  if (noFf.ok) return { ok: true, method: 'no-ff' };
  // Failed, abort
  runGit(repoRoot, ['merge', '--abort']);
  return { ok: false, error: noFf.stderr || noFf.stdout || 'マージに失敗しました' };
}

export function pruneRepoWorktrees(repoRoot) {
  if (!repoRoot || !fs.existsSync(repoRoot)) return { ok: false };
  return runGit(repoRoot, ['worktree', 'prune']);
}
