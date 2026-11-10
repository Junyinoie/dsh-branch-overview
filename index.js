/**
 * dsh-branch-overview — Host half.
 *
 * Serves read-only git facts for every repository reachable from the profile's
 * workspaces — local branches, last commit, upstream sync state, worktrees and
 * uncommitted changes — and switches the main checkout when the user asks for
 * it from the panel or the composer chip.
 *
 * Only the explicit `/switch` route writes: it runs `git switch`, never
 * commits, never touches the index, and refuses to move a dirty worktree
 * unless the request carries `force: true`.
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
  const [head, status, refs, worktreeList, remoteRefs, stash] = await Promise.all([
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
    git(root, ['stash', 'list']),
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
    stashCount: stash.ok ? stash.out.split('\n').filter((line) => line !== '').length : 0,
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

/** Stash the worktree's uncommitted changes (tracked files) on the current branch. */
async function stashWorkingChanges(root) {
  const status = await git(root, ['status', '--porcelain']);
  const files = status.ok ? status.out.split('\n').filter((line) => line !== '') : [];
  const tracked = files.filter((line) => line.startsWith('??') === false && line.startsWith('!!') === false);
  if (tracked.length === 0) {
    return {
      status: 409,
      body: {
        ok: false,
        code: 'clean',
        action: 'stash',
        error: files.length > 0 ? '只有未跟踪文件，git stash 不会包含它们' : '没有未提交改动',
      },
    };
  }
  const branch = await currentBranchOf(root);
  const stashed = await git(root, ['stash', 'push', '-m', `dsh-branch-overview ${branch} ${new Date().toISOString()}`]);
  if (!stashed.ok) return { status: 409, body: { ok: false, code: 'git', action: 'stash', error: firstLine(stashed.err) } };
  const ref = await git(root, ['rev-parse', '--short', 'stash@{0}']);
  return { status: 200, body: { ok: true, action: 'stash', branch, files: tracked.length, stash: ref.ok ? ref.out.trim() : 'stash@{0}' } };
}

/** Push one branch to origin; a branch without upstream gets `-u` on first push. */
async function pushLocalBranch(root, branch) {
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

/** Discard uncommitted changes to tracked files (staged and unstaged alike). */
async function discardWorkingChanges(root) {
  const status = await git(root, ['status', '--porcelain']);
  const files = status.ok ? status.out.split('\n').filter((line) => line !== '') : [];
  const tracked = files.filter((line) => line.startsWith('??') === false && line.startsWith('!!') === false);
  if (tracked.length === 0) {
    return {
      status: 409,
      body: {
        ok: false,
        code: 'clean',
        action: 'discard',
        error: files.length > 0 ? '只剩未跟踪文件，丢弃不会处理它们' : '没有未提交改动',
      },
    };
  }
  const restored = await git(root, ['restore', '--source=HEAD', '--staged', '--worktree', '.']);
  if (!restored.ok) {
    return { status: 409, body: { ok: false, code: 'git', action: 'discard', error: firstLine(restored.err) } };
  }
  const after = await git(root, ['status', '--porcelain']);
  const remaining = after.ok ? after.out.split('\n').filter((line) => line !== '').length : -1;
  return { status: 200, body: { ok: true, action: 'discard', files: tracked.length, remaining } };
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
   * Switch one worktree to `branch`, creating a local tracking branch for a
   * remote-only ref. A dirty worktree needs `force: true`.
   */
  async function switchBranch(repoPath, branch, force, stashFirst) {
    const root = await repoRootOf(repoPath);
    if (root === '') {
      return { status: 400, body: { ok: false, code: 'not-a-repo', error: `不是 git 仓库目录：${repoPath}` } };
    }
    const current = await currentBranchOf(root);
    if (current === branch) {
      return { status: 200, body: { ok: true, switched: false, branch: current, root } };
    }
    const status = await git(root, ['status', '--porcelain']);
    const dirtyFiles = status.ok ? status.out.split('\n').filter((line) => line !== '') : [];
    const dirtyTracked = dirtyFiles.filter((line) => line.startsWith('??') === false && line.startsWith('!!') === false);
    const dirtyUntracked = dirtyFiles.filter((line) => line.startsWith('??'));
    let stashed = '';
    let stashError = '';
    if (dirtyTracked.length > 0) {
      if (stashFirst === true) {
        // Saving first keeps the switch deterministic: the worktree is clean
        // before git touches it, so a conflicting change can no longer make
        // `git switch` refuse halfway.
        const saved = await git(root, ['stash', 'push', '-m', `dsh-branch-overview before switch to ${branch} ${new Date().toISOString()}`]);
        if (saved.ok) {
          const ref = await git(root, ['rev-parse', '--short', 'stash@{0}']);
          stashed = ref.ok ? ref.out.trim() : 'stash@{0}';
        } else {
          stashError = firstLine(saved.err);
        }
      }
      if (stashError !== '' && force !== true) {
        return { status: 409, body: { ok: false, code: 'git', root, currentBranch: current, error: `暂存失败：${stashError}` } };
      }
      if (stashed === '' && stashError === '' && force !== true) {
        return {
          status: 409,
          body: {
            ok: false,
            code: 'dirty',
            root,
            currentBranch: current,
            dirty: { count: dirtyFiles.length, files: dirtyFiles.slice(0, 20) },
            error: `工作区有 ${dirtyTracked.length} 个已跟踪文件改动${dirtyUntracked.length > 0 ? `（另有 ${dirtyUntracked.length} 个未跟踪文件）` : ''}，切换会把它带到新分支`,
          },
        };
      }
    }
    let target = branch;
    const remote = /^([^/]+)\/(.+)$/.exec(branch);
    if (remote !== null) {
      const local = remote[2];
      const exists = await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${local}`]);
      target = exists.ok ? local : branch;
      if (!exists.ok) {
        const created = await git(root, ['switch', '--create', local, branch]);
        if (!created.ok) {
          return { status: 409, body: { ok: false, code: 'git', root, error: created.err.split('\n')[0] ?? 'git switch failed', ...(stashed === '' ? {} : { stashed }) } };
        }
        const nowCreated = await currentBranchOf(root);
        return { status: 200, body: { ok: true, switched: true, branch: nowCreated, previous: current, root, created: local, ...(stashed === '' ? {} : { stashed }) } };
      }
    }
    const switched = await git(root, ['switch', target]);
    if (!switched.ok) {
      return { status: 409, body: { ok: false, code: 'git', root, currentBranch: current, error: switched.err.split('\n').slice(-3).join(' ').trim(), ...(stashed === '' ? {} : { stashed }) } };
    }
    const now = await currentBranchOf(root);
    cache = null;
    return { status: 200, body: { ok: true, switched: true, branch: now, previous: current, root, ...(stashed === '' ? {} : { stashed }) } };
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
          const outcome = await switchBranch(repoPath, branch, body.force === true, body.stash === true);
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
        if (action !== 'pull' && action !== 'stash' && action !== 'push' && action !== 'discard') {
          send(res, 400, { ok: false, code: 'invalid', error: '"action" 必须是 pull / stash / push / discard' });
          return;
        }
        if ((action === 'pull' || action === 'push') && !BRANCH_NAME.test(branch)) {
          send(res, 400, { ok: false, code: 'invalid', error: '"branch" 不是合法的分支名' });
          return;
        }
        if (action === 'discard' && (body === null || typeof body !== 'object' || body.confirm !== true)) {
          send(res, 409, { ok: false, code: 'confirm-required', action: 'discard', error: '丢弃改动需要显式确认（confirm: true）' });
          return;
        }
        try {
          const root = await repoRootOf(repoPath);
          if (root === '') {
            send(res, 400, { ok: false, code: 'not-a-repo', error: `不是 git 仓库目录：${repoPath}` });
            return;
          }
          const outcome = action === 'pull'
            ? await pullRemoteBranch(root, branch)
            : action === 'stash'
              ? await stashWorkingChanges(root)
              : action === 'discard'
                ? await discardWorkingChanges(root)
                : await pushLocalBranch(root, branch);
          if (outcome.status === 200) cache = null;
          send(res, outcome.status, outcome.body);
        } catch (error) {
          send(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      },
    }), 'branch-overview: action route');
  });
}
