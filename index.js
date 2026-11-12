/**
 * dsh-branch-overview — Host half.
 *
 * Serves read-only git facts for every repository reachable from the profile's
 * workspaces — local branches, last commit, upstream sync state, worktrees and
 * uncommitted changes — and switches the main checkout when the user asks for
 * it from the panel or the composer chip.
 *
 * Only explicit actions write: `/action` saves or pushes/pulls, and `/switch`
 * moves a clean worktree. The plugin never stashes, discards, force-pushes or
 * commits to `master`.
 * @module dsh-branch-overview
 */
import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';

export const name = 'dsh-branch-overview';

/** No hard service requirement: the webServer row is injected below. */
export const inject = [];

/** Exact routes the browser half posts to. */
export const ROUTE_SCAN = '/plugin/branch-overview/scan';
export const ROUTE_SWITCH = '/plugin/branch-overview/switch';
export const ROUTE_ACTION = '/plugin/branch-overview/action';

/** Cached answer lifetime; `refresh: true` bypasses it. */
const CACHE_TTL_MS = 15000;
/** Guards: a runaway workspace tree must not keep the panel waiting. */
const MAX_REPOS = 40;
const MAX_ENTRIES_PER_DIR = 300;
const MAX_BRANCHES_PER_REPO = 300;
/** Per-branch `rev-list --not --remotes` probes: one spawn each, so bounded. */
const MAX_UNPUSHED_LOOKUPS = 30;
const GIT_TIMEOUT_MS = 20000;
const BODY_LIMIT = 16 * 1024;
/** Branches the plugin must not commit to or push. */
const PROTECTED_BRANCH = 'master';
/** Local-only paths never included in a save. */
const SAVE_EXCLUDES = ['.dsh-backups', '.tmp', '.cache', '.DS_Store'];

/** Folder names that describe repository structure, not the change itself. */
const SUMMARY_SKIP_SEGMENTS = new Set([
  '页面', '组件', '样式', '事件', '图片资源', '工具', '原型迁移', '共享', '公共',
  'src', 'lib', 'app', 'client', 'shared', 'public', 'assets', 'styles', 'test', 'tests', 'doc', 'docs',
  'page', 'pages', 'component', 'components', 'style', 'styles', 'script', 'scripts',
]);

/**
 * Chinese subject for a save commit: the most specific CJK folder or file names
 * among the changed paths, so the branch list shows `保存：资金看板（3 个文件）`
 * instead of an ISO timestamp.
 */
export function summarizeChanges(files) {
  const names = [];
  for (const file of files) {
    const parts = String(file).split('/').filter((part) => part !== '');
    for (let index = 0; index < parts.length; index += 1) {
      const raw = index === parts.length - 1 ? parts[index].replace(/\.[^.]+$/, '') : parts[index];
      const name = raw.trim();
      if (name === '' || SUMMARY_SKIP_SEGMENTS.has(name)) continue;
      if (!/[\u3400-\u9fff]/.test(name)) continue;
      const clipped = name.length > 24 ? `${name.slice(0, 24)}…` : name;
      if (!names.includes(clipped)) names.push(clipped);
      if (names.length >= 3) break;
    }
    if (names.length >= 3) break;
  }
  const scope = names.join('、');
  const count = files.length;
  return scope === '' ? `保存改动（${count} 个文件）` : `保存：${scope}（${count} 个文件）`;
}

/** Run one git command without a shell; never throws. */
function git(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error !== null) {
        resolve({ ok: false, out: '', err: String(stderr ?? '').trim() || error.message });
        return;
      }
      resolve({ ok: true, out: String(stdout), err: '' });
    });
  });
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** A repo checkout has `.git` (a directory, or a file for linked worktrees). */
async function hasGitEntry(dir) {
  try {
    await stat(join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}

/** Repository root owning `dir`, or '' when it is not inside a repository. */
async function repoRootOf(dir) {
  const result = await git(dir, ['rev-parse', '--show-toplevel']);
  return result.ok ? result.out.trim() : '';
}

/** Checked-out branch of a worktree, or '' when it cannot be read. */
async function currentBranchOf(dir) {
  const result = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return result.ok ? result.out.trim() : '';
}

/** A merge, rebase, cherry-pick or revert must be finished before saving/switching. */
async function pendingOperationOf(root) {
  for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
    const found = await git(root, ['rev-parse', '-q', '--verify', marker]);
    if (found.ok) return marker === 'MERGE_HEAD' ? '合并' : marker === 'CHERRY_PICK_HEAD' ? 'cherry-pick' : 'revert';
  }
  for (const marker of ['rebase-merge', 'rebase-apply']) {
    const path = await git(root, ['rev-parse', '--git-path', marker]);
    if (!path.ok) continue;
    const markerPath = path.out.trim();
    const resolved = isAbsolute(markerPath) ? markerPath : join(root, markerPath);
    try {
      await stat(resolved);
      return 'rebase';
    } catch {
      // Marker absent: no rebase in progress.
    }
  }
  return '';
}

/** Local-only paths that are never part of save or a dirty-switch check. */
function isExcludedPath(file) {
  const path = String(file ?? '').replace(/\\/g, '/');
  if (path === '.DS_Store' || path.endsWith('/.DS_Store')) return true;
  return SAVE_EXCLUDES.some((entry) => path === entry || path.startsWith(`${entry}/`));
}

/** Parse `git status --porcelain=v1 -z` into path records. */
async function statusEntriesOf(root) {
  const result = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (!result.ok) return { ok: false, error: firstLine(result.err) };
  const records = result.out.split('\0');
  const entries = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === '') continue;
    const code = record.slice(0, 2);
    const path = record.slice(3);
    let oldPath = '';
    if (code[0] === 'R' || code[0] === 'C') {
      oldPath = records[index + 1] ?? '';
      index += 1;
    }
    entries.push({ code, path, oldPath });
  }
  return { ok: true, entries };
}

/** Changes that are not local-only backups/temp files. */
function meaningfulChanges(entries) {
  return entries.filter((entry) => !isExcludedPath(entry.path) && !isExcludedPath(entry.oldPath));
}

/**
 * Repositories reachable from one workspace directory: the workspace itself,
 * or its children (a project container holding repos), up to `maxDepth`.
 * @param workspacePath - absolute workspace directory.
 * @param maxDepth - directory levels to descend (1 = direct children).
 */
async function discoverRepos(workspacePath, maxDepth) {
  if (!(await isDirectory(workspacePath))) return [];
  const self = await repoRootOf(workspacePath);
  if (self !== '') return [self];
  const roots = [];
  const seen = new Set();
  let frontier = [workspacePath];
  for (let depth = 0; depth < maxDepth && frontier.length > 0 && roots.length < MAX_REPOS; depth += 1) {
    const next = [];
    for (const dir of frontier) {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries.slice(0, MAX_ENTRIES_PER_DIR)) {
        if (!entry.isDirectory()) continue;
        if (entry.name === 'node_modules') continue;
        if (entry.name.startsWith('.')) continue;
        const child = join(dir, entry.name);
        if (await hasGitEntry(child)) {
          const root = await repoRootOf(child);
          if (root !== '' && !seen.has(root)) {
            seen.add(root);
            roots.push(root);
          }
          continue;
        }
        next.push(child);
      }
    }
    frontier = next.slice(0, MAX_ENTRIES_PER_DIR);
  }
  return roots;
}

/** Split `%(upstream:track)`, e.g. `[ahead 1, behind 2]` or `[gone]`. */
function parseTrack(track) {
  const ahead = /ahead (\d+)/.exec(track);
  const behind = /behind (\d+)/.exec(track);
  return {
    ahead: ahead === null ? 0 : Number(ahead[1]),
    behind: behind === null ? 0 : Number(behind[1]),
    gone: track.includes('gone'),
  };
}

/** Parse `git worktree list --porcelain` into ordered entries. */
function parseWorktrees(text) {
  const entries = [];
  let current = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length).trim(), branch: '', main: entries.length === 0, bare: false };
      entries.push(current);
      continue;
    }
    if (current === null) continue;
    if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
      continue;
    }
    if (line === 'bare') current.bare = true;
  }
  return entries;
}

/**
 * Read one repository's branch facts.
 * @param root - absolute repository root.
 * @param section - workspace title the repository was found under.
 */
async function readRepo(root, section) {
  const [head, status, refs, worktreeList, remoteRefs] = await Promise.all([
    git(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(root, ['status', '--porcelain']),
    git(root, [
      'for-each-ref',
      '--sort=-committerdate',
      '--format=%(refname:short)\t%(committerdate:iso-strict)\t%(upstream:short)\t%(upstream:track)\t%(authorname)\t%(HEAD)\t%(subject)',
      'refs/heads',
    ]),
    git(root, ['worktree', 'list', '--porcelain']),
    git(root, ['for-each-ref', '--format=x', 'refs/remotes']),
  ]);
  if (!refs.ok) {
    return { root, name: basename(root), section, ok: false, error: refs.err.split('\n')[0] ?? 'git failed' };
  }
  const worktrees = worktreeList.ok ? parseWorktrees(worktreeList.out) : [];
  const worktreeByBranch = new Map();
  for (const entry of worktrees) {
    if (entry.branch !== '') worktreeByBranch.set(entry.branch, entry.path);
  }
  const dirtyFiles = status.ok ? status.out.split('\n').filter((line) => line !== '') : [];
  const dirtyTracked = dirtyFiles.filter((line) => line.startsWith('??') === false && line.startsWith('!!') === false);
  const dirtyUntracked = dirtyFiles.filter((line) => line.startsWith('??'));
  const remotes = remoteRefs.ok ? remoteRefs.out.split('\n').filter((line) => line !== '' && !line.endsWith('/HEAD')) : [];
  const branches = [];
  for (const line of refs.out.split('\n')) {
    if (line === '') continue;
    const parts = line.split('\t');
    if (parts.length < 7) continue;
    const [branchName, date, upstream, track, author, headMark] = parts;
    const subject = parts.slice(6).join('\t');
    const sync = parseTrack(track);
    branches.push({
      name: branchName,
      date,
      upstream,
      ahead: sync.ahead,
      behind: sync.behind,
      gone: sync.gone,
      author,
      current: headMark === '*',
      subject,
      worktreePath: worktreeByBranch.get(branchName) ?? '',
      // `null` = needs the per-branch `rev-list --not --remotes` probe; a
      // branch with an upstream already knows its count from `%(upstream:track)`.
      unpushed: upstream === '' ? null : sync.ahead,
    });
    if (branches.length >= MAX_BRANCHES_PER_REPO) break;
  }
  const hasRemote = remotes.length > 0;
  let lookups = 0;
  await Promise.all(branches.map(async (branch) => {
    if (branch.unpushed !== null) return;
    if (!hasRemote || lookups >= MAX_UNPUSHED_LOOKUPS) {
      branch.unpushed = 0;
      return;
    }
    lookups += 1;
    const counted = await git(root, ['rev-list', '--count', branch.name, '--not', '--remotes']);
    branch.unpushed = counted.ok ? Number(counted.out.trim()) || 0 : 0;
  }));
  const currentBranch = head.ok ? head.out.trim() : '';
  return {
    root,
    name: basename(root),
    section,
    ok: true,
    noRemote: !hasRemote,
    currentBranch,
    detached: currentBranch === 'HEAD',
    dirty: {
      count: dirtyFiles.length,
      tracked: dirtyTracked.length,
      untracked: dirtyUntracked.length,
      files: dirtyFiles.slice(0, 20),
    },
    worktrees,
    remoteBranchCount: remotes.length,
    branches,
  };
}

/** Read the profile's workspaces from the workspace registry, when mounted. */
function workspaceEntries(ctx) {
  const entries = [];
  let registry;
  try {
    registry = ctx.get('workspaceRegistry');
  } catch {
    registry = undefined;
  }
  if (registry === undefined) {
    try {
      registry = ctx.get('workspace');
    } catch {
      registry = undefined;
    }
  }
  if (registry === undefined || registry === null || typeof registry.list !== 'function') return entries;
  for (const workspace of registry.list()) {
    const path = workspace === null || workspace === undefined ? undefined : workspace.path;
    if (typeof path !== 'string' || path === '') continue;
    entries.push({
      title: typeof workspace.title === 'string' && workspace.title !== '' ? workspace.title : path,
      path,
    });
  }
  return entries;
}

/** A conservative branch-name check: no flags, no whitespace, valid ref characters. */
const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** First non-blank line of git output — what the UI shows as the reason. */
function firstLine(text) {
  const line = String(text ?? '')
    .split('\n')
    .map((part) => part.trim())
    .find((part) => part !== '');
  return line === undefined ? 'git failed' : line;
}

/**
 * Update the local branch from origin without switching the checkout.
 * Checked-out branch: `git pull --ff-only`; otherwise a fast-forward-only
 * fetch into the local ref (`git fetch origin <branch>:<branch>`), which git
 * refuses when the local branch has diverged or sits in another worktree.
 */
async function pullRemoteBranch(root, branch) {
  if (branch !== PROTECTED_BRANCH) {
    return { status: 403, body: { ok: false, code: 'protected', action: 'pull', branch, error: `只支持拉取 ${PROTECTED_BRANCH}` } };
  }
  const head = await currentBranchOf(root);
  if (head === branch) {
    const pulled = await git(root, ['pull', '--ff-only', 'origin', branch]);
    if (!pulled.ok) return { status: 409, body: { ok: false, code: 'git', action: 'pull', branch, error: firstLine(pulled.err) } };
    return { status: 200, body: { ok: true, action: 'pull', branch, mode: 'pull', detail: firstLine(pulled.out) } };
  }
  const fetched = await git(root, ['fetch', 'origin', `${branch}:${branch}`]);
  if (!fetched.ok) return { status: 409, body: { ok: false, code: 'git', action: 'pull', branch, error: firstLine(fetched.err) } };
  const sha = await git(root, ['rev-parse', '--short', `refs/heads/${branch}`]);
  return { status: 200, body: { ok: true, action: 'pull', branch, mode: 'fetch', sha: sha.ok ? sha.out.trim() : '' } };
}

/** Save all current-branch changes as one local commit. Never pushes. */
async function saveWorkingChanges(root, message) {
  const branch = await currentBranchOf(root);
  if (branch === '' || branch === 'HEAD') {
    return { status: 409, body: { ok: false, code: 'detached', action: 'save', error: '当前是 detached HEAD，不能保存到本地分支' } };
  }
  if (branch === PROTECTED_BRANCH) {
    return { status: 403, body: { ok: false, code: 'protected', action: 'save', branch, error: `${PROTECTED_BRANCH} 只允许拉取，不能保存` } };
  }
  const pending = await pendingOperationOf(root);
  if (pending !== '') {
    return { status: 409, body: { ok: false, code: 'pending', action: 'save', branch, error: `当前处于${pending}过程中，请先完成后再保存` } };
  }
  const status = await statusEntriesOf(root);
  if (!status.ok) return { status: 409, body: { ok: false, code: 'git', action: 'save', branch, error: status.error } };
  const changes = meaningfulChanges(status.entries);
  if (changes.length === 0) {
    return { status: 409, body: { ok: false, code: 'clean', action: 'save', branch, error: '没有可保存的改动（本地备份/临时文件不参与保存）' } };
  }
  const excludes = SAVE_EXCLUDES.flatMap((entry) => [`:(exclude)${entry}`, `:(exclude)${entry}/**`]);
  const added = await git(root, ['add', '-A', '--', '.', ...excludes, ':(exclude,glob)**/.DS_Store']);
  if (!added.ok) return { status: 409, body: { ok: false, code: 'git', action: 'save', branch, error: firstLine(added.err) } };
  const staged = await git(root, ['diff', '--cached', '--name-only', '-z']);
  const files = staged.ok ? staged.out.split('\0').filter((item) => item !== '') : [];
  if (files.length === 0) {
    return { status: 409, body: { ok: false, code: 'clean', action: 'save', branch, error: '排除本地临时文件后没有可保存的改动' } };
  }
  const text = typeof message === 'string' && message.trim() !== ''
    ? message.trim().slice(0, 500)
    : summarizeChanges(files);
  const committed = await git(root, ['commit', '-m', text]);
  if (!committed.ok) {
    return { status: 409, body: { ok: false, code: 'git', action: 'save', branch, files: files.length, error: firstLine(committed.err) } };
  }
  const sha = await git(root, ['rev-parse', '--short', 'HEAD']);
  const after = await statusEntriesOf(root);
  const remaining = after.ok ? meaningfulChanges(after.entries).length : -1;
  return {
    status: 200,
    body: { ok: true, action: 'save', branch, files: files.length, commit: sha.ok ? sha.out.trim() : '', message: text, remaining },
  };
}

/** Push one branch to origin; a branch without upstream gets `-u` on first push. */
async function pushLocalBranch(root, branch) {
  if (branch === PROTECTED_BRANCH) {
    return { status: 403, body: { ok: false, code: 'protected', action: 'push', branch, error: `${PROTECTED_BRANCH} 只允许拉取，不能推送` } };
  }
  const head = await currentBranchOf(root);
  const isCurrent = head === branch;
  let upstream = '';
  if (isCurrent) {
    const probe = await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    if (probe.ok) upstream = probe.out.trim();
  }
  const args = isCurrent && upstream !== ''
    ? ['push']
    : isCurrent
      ? ['push', '-u', 'origin', branch]
      : ['push', 'origin', branch];
  const pushed = await git(root, args);
  if (!pushed.ok) return { status: 409, body: { ok: false, code: 'git', action: 'push', branch, error: firstLine(pushed.err) } };
  return { status: 200, body: { ok: true, action: 'push', branch, upstream: isCurrent && upstream !== '' ? upstream : `origin/${branch}` } };
}

/** Read and JSON-parse one bounded request body. */
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        req.destroy();
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(new Error(`invalid JSON body: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Mount the read-only scan route and the explicit switch route.
 * @param ctx - plugin context.
 * @param config - row config: `{ repos?: string[], depth?: number }`.
 */
export function apply(ctx, config = {}) {
  const extraRepos = Array.isArray(config.repos) ? config.repos.filter((item) => typeof item === 'string' && item !== '') : [];
  const depth = typeof config.depth === 'number' && Number.isFinite(config.depth) ? Math.min(Math.max(1, Math.trunc(config.depth)), 2) : 2;
  let cacheKey = '';
  let cache = null;
  let cacheAt = 0;
  const repoLocks = new Set();

  /** Serialize writes for one repository so two windows cannot race. */
  async function withRepoLock(root, run) {
    if (repoLocks.has(root)) {
      return { status: 409, body: { ok: false, code: 'busy', error: '该仓库正在处理另一个操作，请稍后再试' } };
    }
    repoLocks.add(root);
    try {
      return await run();
    } finally {
      repoLocks.delete(root);
    }
  }

  /** Build (or reuse) the overview payload for all workspaces, or for one path. */
  async function buildOverview(force, onlyPath) {
    const key = onlyPath === undefined ? '*' : onlyPath;
    if (!force && cache !== null && cacheKey === key && Date.now() - cacheAt < CACHE_TTL_MS) {
      return { ...cache, cached: true };
    }
    const started = Date.now();
    const found = new Map();
    const workspacesOut = [];
    if (onlyPath !== undefined) {
      const roots = await discoverRepos(onlyPath, depth);
      workspacesOut.push({ title: basename(onlyPath), path: onlyPath, repos: roots.length });
      for (const root of roots) found.set(root, { root, section: basename(onlyPath) });
    } else {
      for (const workspace of workspaceEntries(ctx)) {
        const roots = await discoverRepos(workspace.path, depth);
        workspacesOut.push({ title: workspace.title, path: workspace.path, repos: roots.length });
        for (const root of roots) {
          if (!found.has(root)) found.set(root, { root, section: workspace.title });
        }
      }
      for (const path of extraRepos) {
        const root = (await repoRootOf(path)) || path;
        if (!found.has(root)) found.set(root, { root, section: '自定义仓库' });
      }
    }
    const selected = [...found.values()].slice(0, MAX_REPOS);
    const repos = await Promise.all(selected.map((item) => readRepo(item.root, item.section)));
    const payload = {
      generatedAt: new Date().toISOString(),
      tookMs: Date.now() - started,
      depth,
      path: onlyPath,
      workspaces: workspacesOut,
      repos,
      truncated: found.size > MAX_REPOS,
    };
    cache = payload;
    cacheKey = key;
    cacheAt = Date.now();
    return { ...payload, cached: false };
  }

  /**
   * Switch one worktree to a clean branch. If the name is a remote-tracking
   * branch, create its local counterpart only when no exact local branch exists.
   */
  async function switchBranch(repoPath, branch) {
    const root = await repoRootOf(repoPath);
    if (root === '') {
      return { status: 400, body: { ok: false, code: 'not-a-repo', error: `不是 git 仓库目录：${repoPath}` } };
    }
    const current = await currentBranchOf(root);
    if (current === branch) {
      return { status: 200, body: { ok: true, switched: false, branch: current, root } };
    }
    const pending = await pendingOperationOf(root);
    if (pending !== '') {
      return { status: 409, body: { ok: false, code: 'pending', root, currentBranch: current, error: `当前处于${pending}过程中，请先完成后再切换` } };
    }
    const status = await statusEntriesOf(root);
    if (!status.ok) {
      return { status: 409, body: { ok: false, code: 'git', root, currentBranch: current, error: status.error } };
    }
    const dirty = meaningfulChanges(status.entries);
    if (dirty.length > 0 && current !== PROTECTED_BRANCH) {
      return {
        status: 409,
        body: {
          ok: false,
          code: 'dirty',
          root,
          currentBranch: current,
          dirty: { count: dirty.length, files: dirty.slice(0, 20).map((entry) => entry.path) },
          error: `工作区还有 ${dirty.length} 个未保存改动，请先保存到本地分支再切换`,
        },
      };
    }
    // master cannot be saved or pushed. If it is dirty, let the user move those
    // changes to a work branch instead of trapping them on master.
    const carried = current === PROTECTED_BRANCH ? dirty.length : 0;
    let target = branch;
    let created = false;
    const exactLocal = await git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    if (!exactLocal.ok) {
      const remote = await git(root, ['show-ref', '--verify', '--quiet', `refs/remotes/${branch}`]);
      if (!remote.ok) {
        return { status: 404, body: { ok: false, code: 'not-found', root, currentBranch: current, error: `找不到分支：${branch}` } };
      }
      const slash = branch.indexOf('/');
      if (slash < 0 || slash === branch.length - 1) {
        return { status: 409, body: { ok: false, code: 'invalid', root, currentBranch: current, error: `无法解析远端分支：${branch}` } };
      }
      target = branch.slice(slash + 1);
      const localTarget = await git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${target}`]);
      created = !localTarget.ok;
    }
    const args = created
      ? ['switch', '--create', target, '--track', branch]
      : ['switch', target];
    const switched = await git(root, args);
    if (!switched.ok) {
      return { status: 409, body: { ok: false, code: 'git', root, currentBranch: current, error: switched.err.split('\n').slice(-3).join(' ').trim() } };
    }
    const now = await currentBranchOf(root);
    cache = null;
    return {
      status: 200,
      body: { ok: true, switched: true, branch: now, previous: current, root, ...(created ? { created: target } : {}), ...(carried > 0 ? { carried } : {}) },
    };
  }

  ctx.inject(['webServer'], (webCtx) => {
    const send = (res, status, body) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: ROUTE_SCAN,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          send(res, 405, { error: 'method not allowed' });
          return;
        }
        let body;
        try {
          body = await readJson(req);
        } catch (error) {
          send(res, 400, { error: error instanceof Error ? error.message : String(error) });
          return;
        }
        const onlyPath = body !== null && typeof body === 'object' && typeof body.path === 'string' && isAbsolute(body.path) ? body.path : undefined;
        try {
          send(res, 200, await buildOverview(body !== null && typeof body === 'object' && body.refresh === true, onlyPath));
        } catch (error) {
          send(res, 500, { error: error instanceof Error ? error.message : String(error) });
        }
      },
    }), 'branch-overview: scan route');
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: ROUTE_SWITCH,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          send(res, 405, { error: 'method not allowed' });
          return;
        }
        let body;
        try {
          body = await readJson(req);
        } catch (error) {
          send(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
          return;
        }
        const repoPath = body !== null && typeof body === 'object' && typeof body.repoPath === 'string' ? body.repoPath : '';
        const branch = body !== null && typeof body === 'object' && typeof body.branch === 'string' ? body.branch.trim() : '';
        if (!isAbsolute(repoPath)) {
          send(res, 400, { ok: false, code: 'invalid', error: '"repoPath" 必须是绝对路径' });
          return;
        }
        if (branch === '' || branch.startsWith('-')) {
          send(res, 400, { ok: false, code: 'invalid', error: '"branch" 不能为空或以 - 开头' });
          return;
        }
        try {
          const root = await repoRootOf(repoPath);
          if (root === '') {
            send(res, 400, { ok: false, code: 'not-a-repo', error: `不是 git 仓库目录：${repoPath}` });
            return;
          }
          const outcome = await withRepoLock(root, () => switchBranch(repoPath, branch));
          send(res, outcome.status, outcome.body);
        } catch (error) {
          send(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      },
    }), 'branch-overview: switch route');
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: ROUTE_ACTION,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          send(res, 405, { error: 'method not allowed' });
          return;
        }
        let body;
        try {
          body = await readJson(req);
        } catch (error) {
          send(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
          return;
        }
        const repoPath = body !== null && typeof body === 'object' && typeof body.repoPath === 'string' ? body.repoPath : '';
        const action = body !== null && typeof body === 'object' && typeof body.action === 'string' ? body.action : '';
        const branch = body !== null && typeof body === 'object' && typeof body.branch === 'string' ? body.branch.trim() : '';
        if (!isAbsolute(repoPath)) {
          send(res, 400, { ok: false, code: 'invalid', error: '"repoPath" 必须是绝对路径' });
          return;
        }
        if (action !== 'pull' && action !== 'push' && action !== 'save') {
          send(res, 400, { ok: false, code: 'invalid', error: '"action" 必须是 pull / push / save' });
          return;
        }
        if ((action === 'pull' || action === 'push') && !BRANCH_NAME.test(branch)) {
          send(res, 400, { ok: false, code: 'invalid', error: '"branch" 不是合法的分支名' });
          return;
        }
        if (action === 'pull' && branch !== PROTECTED_BRANCH) {
          send(res, 403, { ok: false, code: 'protected', action, error: `只支持拉取 ${PROTECTED_BRANCH}` });
          return;
        }
        if (action === 'push' && branch === PROTECTED_BRANCH) {
          send(res, 403, { ok: false, code: 'protected', action, error: `${PROTECTED_BRANCH} 只允许拉取，不能推送` });
          return;
        }
        if ((action === 'save' || action === 'push') && (body === null || typeof body !== 'object' || body.confirm !== true)) {
          send(res, 409, { ok: false, code: 'confirm-required', action, error: `${action === 'save' ? '保存' : '推送'}需要显式确认（confirm: true）` });
          return;
        }
        try {
          const root = await repoRootOf(repoPath);
          if (root === '') {
            send(res, 400, { ok: false, code: 'not-a-repo', error: `不是 git 仓库目录：${repoPath}` });
            return;
          }
          const message = body !== null && typeof body === 'object' && typeof body.message === 'string' ? body.message : '';
          const outcome = await withRepoLock(root, () => (
            action === 'pull'
              ? pullRemoteBranch(root, branch)
              : action === 'save'
                ? saveWorkingChanges(root, message)
                : pushLocalBranch(root, branch)
          ));
          if (outcome.status === 200) cache = null;
          send(res, outcome.status, outcome.body);
        } catch (error) {
          send(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      },
    }), 'branch-overview: action route');
  });
}
