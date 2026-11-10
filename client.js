/**
 * dsh-branch-overview — browser half.
 *
 * Three registrations, all on the same read-only data:
 *  - `sidebar.panellist` + `main`: the full 分支总览 panel;
 *  - `conversation.input.left`: a composer chip showing the current
 *    repository/branch of the session directory, with a switch dialog so the
 *    branch can be changed without leaving the conversation.
 *
 * Switching posts to the Host half's explicit `/switch` route, which runs
 * `git switch`; a dirty worktree is confirmed first.
 */
window.__ModuleLoader__.load({
  id: 'dsh-branch-overview',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useState } = React;

    const PANEL_ID = 'branch-overview';
    const ROUTE_SCAN = '/plugin/branch-overview/scan';
    const ROUTE_SWITCH = '/plugin/branch-overview/switch';
    const ROUTE_ACTION = '/plugin/branch-overview/action';
    const REFRESH_MS = 60000;
    const LABEL = '分支总览';
    const CHIP_ID = 'branch-overview-chip';

    /**
     * The left-nav 「分支总览」 entry and its full panel are switched off: this
     * plugin contributes only the composer chip (the workspace-facing branch
     * display). Flip to `true` to bring the sidebar entry and panel back.
     */
    const SHOW_PANEL = false;

    /** Theme-token colors with neutral fallbacks, so a renamed token degrades safely. */
    const T = {
      text: 'var(--dsw-alias-label-primary, #1f2328)',
      muted: 'var(--dsw-alias-label-secondary, #6b7280)',
      faint: 'var(--dsw-alias-label-tertiary, #9aa4b2)',
      border: 'var(--dsw-alias-border-l2, rgba(120,130,145,.24))',
      surface: 'var(--dsw-alias-bg-l2, rgba(120,130,145,.07))',
      surfaceAlt: 'var(--dsw-alias-bg-l3, rgba(120,130,145,.14))',
      panel: 'var(--dsw-alias-bg-primary, #ffffff)',
      accent: 'var(--dsw-alias-brand-primary, #2f6feb)',
      ok: 'var(--dsw-alias-success-primary, #15803d)',
      warn: 'var(--dsw-alias-warning-primary, #b45309)',
      danger: 'var(--dsw-alias-danger-primary, #b91c1c)',
    };
    const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

    function BranchGlyph(props) {
      const size = typeof props.size === 'number' ? props.size : 16;
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        h('circle', { cx: 6, cy: 5, r: 2.6 }),
        h('circle', { cx: 6, cy: 19, r: 2.6 }),
        h('circle', { cx: 18, cy: 7, r: 2.6 }),
        h('path', { d: 'M6 7.6v8.8' }),
        h('path', { d: 'M18 9.6c0 3.2-2.4 5.2-6 5.4' }));
    }

    function RailIcon(props) {
      return h(BranchGlyph, { size: props !== null && props !== undefined && typeof props.size === 'number' && props.size > 0 ? props.size : 16 });
    }

    function Badge(props) {
      return h('span', {
        style: {
          display: 'inline-block', padding: '1px 6px', borderRadius: 999,
          fontSize: 11, lineHeight: '16px', whiteSpace: 'nowrap',
          background: T.surfaceAlt, color: props.color !== undefined ? props.color : T.muted,
        },
      }, props.text);
    }

    /**
     * Split a branch name at its last `/`: the parent path stays as written and
     * the leaf segment is what the user reads. `yhj/1102/renzi` -> `yhj/1102/` + `renzi`.
     */
    function splitBranch(name) {
      if (typeof name !== 'string' || name === '') return { prefix: '', leaf: name === undefined ? '' : String(name) };
      const index = name.lastIndexOf('/');
      if (index < 0 || index === name.length - 1) return { prefix: '', leaf: name };
      return { prefix: name.slice(0, index + 1), leaf: name.slice(index + 1) };
    }

    /**
     * Branch label precise to the leaf: the parent folders are dimmed and may
     * ellipsize, the last segment never truncates. `title` keeps the full name.
     */
    function BranchName(props) {
      const parts = splitBranch(props.name);
      return h('span', {
        title: typeof props.name === 'string' ? props.name : '',
        style: {
          display: 'inline-flex', alignItems: 'baseline', minWidth: 0, maxWidth: '100%',
          flex: '0 1 auto',
          fontFamily: MONO, fontSize: typeof props.size === 'number' ? props.size : 12,
        },
      },
        parts.prefix !== ''
          ? h('span', {
            style: { color: T.faint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: '0 1 auto', minWidth: 0 },
          }, parts.prefix)
          : null,
        h('span', {
          style: { color: T.text, fontWeight: props.strong === true ? 600 : 400, flex: '0 0 auto', whiteSpace: 'nowrap' },
        }, parts.leaf));
    }

    const REPO_KEY_PREFIX = 'dsh-branch-overview:repo:';

    /** Remembered repository root for one session directory, or ''. */
    function readStoredRepo(cwd) {
      try {
        const value = window.localStorage.getItem(REPO_KEY_PREFIX + cwd);
        return typeof value === 'string' ? value : '';
      } catch {
        return '';
      }
    }

    /** Persist the repository the user picked for one session directory. */
    function storeRepo(cwd, root) {
      try {
        window.localStorage.setItem(REPO_KEY_PREFIX + cwd, root);
      } catch {
        // Private mode or a disabled storage: the pick simply is not remembered.
      }
    }

    /**
     * Which repository the chip fronts when the session directory holds more
     * than one: the remembered pick when it still exists, otherwise the first
     * repository that has a checked-out branch (never an unreadable one).
     */
    function pickPrimaryRepo(repos, storedRoot) {
      if (!Array.isArray(repos) || repos.length === 0) return null;
      if (typeof storedRoot === 'string' && storedRoot !== '') {
        const stored = repos.find((repo) => repo.root === storedRoot);
        if (stored !== undefined) return stored;
      }
      return repos.find((repo) => typeof repo.currentBranch === 'string' && repo.currentBranch !== '') ?? repos[0];
    }

    function formatDate(iso) {
      if (typeof iso !== 'string' || iso === '') return '';
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return '';
      const pad = (value) => String(value).padStart(2, '0');
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    function formatClock(iso) {
      if (typeof iso !== 'string' || iso === '') return '';
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return '';
      const pad = (value) => String(value).padStart(2, '0');
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    }

    /** Upstream sync state for one branch row. */
    function statusOf(branch) {
      if (branch.gone === true) return { text: '上游已删除', color: T.warn };
      if (typeof branch.upstream !== 'string' || branch.upstream === '') return { text: '无上游', color: T.faint };
      const ahead = Number(branch.ahead) || 0;
      const behind = Number(branch.behind) || 0;
      if (ahead > 0 && behind > 0) return { text: `分叉 +${ahead} -${behind}`, color: T.warn };
      if (ahead > 0) return { text: `领先 ${ahead}`, color: T.accent };
      if (behind > 0) return { text: `落后 ${behind}`, color: T.warn };
      return { text: '已同步', color: T.ok };
    }

    /** Tracked/untracked split of a repo's dirty state (older scans fall back to `count`). */
    function dirtyParts(repo) {
      const dirty = repo !== null && repo !== undefined ? repo.dirty : undefined;
      const count = dirty !== null && dirty !== undefined && typeof dirty.count === 'number' ? dirty.count : 0;
      const tracked = dirty !== null && dirty !== undefined && typeof dirty.tracked === 'number' ? dirty.tracked : count;
      const untracked = dirty !== null && dirty !== undefined && typeof dirty.untracked === 'number' ? dirty.untracked : 0;
      return { count, tracked, untracked };
    }
    async function postJson(url, payload) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload !== null && typeof payload === 'object' ? payload : {}),
      });
      const json = await response.json().catch(() => ({}));
      return { status: response.status, ok: response.ok, json: json !== null && typeof json === 'object' ? json : {} };
    }

    async function fetchScan(pathOrNull, force) {
      const payload = typeof pathOrNull === 'string' && pathOrNull !== '' ? { path: pathOrNull, refresh: force === true } : { refresh: force === true };
      const result = await postJson(ROUTE_SCAN, payload);
      if (!result.ok || typeof result.json.error === 'string') {
        throw new Error(typeof result.json.error === 'string' ? result.json.error : `HTTP ${result.status}`);
      }
      return result.json;
    }

    /**
     * Load the overview for every workspace (`null`), for one directory, or not
     * at all (`''`). Polls while mounted.
     */
    function useScan(pathOrNull) {
      const [data, setData] = useState(null);
      const [error, setError] = useState('');
      const skip = pathOrNull === '';
      const load = useCallback(async (force) => {
        if (skip) return;
        try {
          const next = await fetchScan(pathOrNull, force);
          setData(next);
          setError('');
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }, [pathOrNull, skip]);
      useEffect(() => {
        if (skip) {
          setData(null);
          return undefined;
        }
        void load(false);
        const timer = setInterval(() => { void load(false); }, REFRESH_MS);
        return () => clearInterval(timer);
      }, [load, skip]);
      return { data, error, reload: (force) => { void load(force === true); } };
    }

    const OVERLAY = {
      position: 'fixed', inset: 0, zIndex: 80, display: 'flex',
      alignItems: 'center', justifyContent: 'center', background: 'rgba(15,23,42,.38)',
    };
    const DIALOG = {
      width: 'min(620px, calc(100vw - 40px))', maxHeight: 'min(74vh, 680px)',
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
      background: T.panel, color: T.text, borderRadius: 12,
      border: `1px solid ${T.border}`, boxShadow: '0 16px 48px rgba(15,23,42,.28)',
    };

    /** One row of the in-dialog legend: what a badge means and which action is risky. */
    const LEGEND = [
      { label: '当前', title: '当前检出分支', desc: '这个分支正被检出，工作区里的改动都属于它。', danger: '切换' },
      { label: '未保存 N', title: '未提交的已跟踪改动', desc: '有 N 个已跟踪文件改了但还没 commit。', danger: '丢弃（不可恢复）；暂存/切换前会二次确认' },
      { label: '未跟踪 M', title: '未跟踪的新文件', desc: '有 M 个新文件没被 git 跟踪；暂存和丢弃都不会处理它们。', danger: '无（需手动 git add 或删除）' },
      { label: '未推送 M', title: '本地提交未推送', desc: '本地有 M 个提交还没推到远端。', danger: '推送（会影响远端，点击前二次确认）' },
      { label: '工作树占用', title: '该分支在别的 worktree 里', desc: '同一分支不能同时在两处检出，所以这里不能切换。', danger: '无（请到对应工作树里操作）' },
      { label: '已同步', title: '与上游一致', desc: '本地分支和它跟踪的远端分支指向同一个提交。', danger: '无' },
      { label: '领先 / 落后 / 分叉', title: '与上游的差异', desc: '领先=本地有未推送提交；落后=远端有未拉取提交；分叉=两边都有。', danger: '落后/分叉时推送会被 git 拒绝，需先拉取或合并' },
      { label: '无上游', title: '没设置 tracking', desc: '这个本地分支还没关联远端分支。', danger: '推送会自动执行 git push -u origin <分支>' },
      { label: '上游已删除', title: '远端分支已不存在', desc: '它跟踪的远端分支已被删除。', danger: '推送可能重新创建该远端分支' },
    ];

    /** The legend body: every badge with its meaning and the risky action it enables. */
    function Legend() {
      return h('div', { style: { flex: 1, overflow: 'auto', padding: '10px 14px 14px' } },
        h('div', { style: { fontSize: 12, color: T.muted, marginBottom: 6 } }, '状态说明与对应的危险操作'),
        LEGEND.map((item) => h('div', { key: item.label, style: { padding: '8px 0', borderTop: `1px solid ${T.border}` } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 } },
            h(Badge, { text: item.label, color: item.label === '未保存 N' ? T.warn : item.label === '未推送 M' ? T.accent : T.muted }),
            h('span', { style: { fontSize: 12, fontWeight: 600, color: T.text } }, item.title)),
          h('div', { style: { fontSize: 11.5, color: T.muted, lineHeight: '17px' } }, item.desc),
          item.danger !== '无' ? h('div', { style: { fontSize: 11.5, color: T.danger, marginTop: 2 } }, `危险操作：${item.danger}`) : null)));
    }

    /** Branch picker dialog shared by the composer chip and the panel. */
    function SwitchDialog(props) {
      const repos = Array.isArray(props.repos) ? props.repos : [];
      const [activeRoot, setActiveRoot] = useState(props.repo !== null && props.repo !== undefined ? props.repo.root : '');
      const active = repos.find((repo) => repo.root === activeRoot) ?? props.repo ?? repos[0];
      const [filter, setFilter] = useState('');
      const [busy, setBusy] = useState('');
      const [error, setError] = useState('');
      const [pending, setPending] = useState(null);
      const [busyAction, setBusyAction] = useState('');
      const [actionNote, setActionNote] = useState('');
      const [actionError, setActionError] = useState('');
      const [confirmDiscard, setConfirmDiscard] = useState(false);
      const [helpOpen, setHelpOpen] = useState(false);
      const branches = active !== null && active !== undefined && Array.isArray(active.branches) ? active.branches : [];
      const needle = filter.trim().toLowerCase();
      const visible = branches.filter((branch) => needle === '' || `${branch.name} ${branch.subject} ${branch.upstream}`.toLowerCase().includes(needle));
      const counts = dirtyParts(active);
      const dirtyCount = counts.tracked;
      const untrackedCount = counts.untracked;
      const noRemote = active !== null && active !== undefined && active.noRemote === true;

      /** Small secondary button used by the row quick actions. */
      function actionStyle(isDisabled) {
        return {
          padding: '3px 8px', borderRadius: 6, fontSize: 11, whiteSpace: 'nowrap',
          border: `1px solid ${T.border}`, background: 'transparent',
          color: isDisabled ? T.faint : T.muted, cursor: isDisabled ? 'default' : 'pointer',
        };
      }

      /**
       * Run one quick action against the active repository: `pull` (master
       * only), `stash` (current branch only) or `push` (any branch). Pushing
       * asks first because it is visible to everyone else.
       */
      async function runAction(branch, action, options) {
        if (active === null || active === undefined) return;
        const opts = options !== null && typeof options === 'object' ? options : {};
        if (action === 'push' && typeof window !== 'undefined' && typeof window.confirm === 'function') {
          if (!window.confirm(`把分支 ${branch.name} 推送到 origin 吗？`)) return;
        }
        setBusyAction(`${action}:${branch.name}`);
        setActionError('');
        setActionNote('');
        try {
          const result = await postJson(ROUTE_ACTION, { repoPath: active.root, action, branch: branch.name, confirm: opts.confirm === true });
          if (result.json.ok === true) {
            if (action === 'pull') setActionNote(`已更新 ${branch.name}（${result.json.mode === 'fetch' ? 'fetch 快进本地分支' : 'pull --ff-only'}）`);
            else if (action === 'stash') setActionNote(`已暂存 ${result.json.files} 个改动 → ${result.json.stash}`);
            else if (action === 'discard') {
              setConfirmDiscard(false);
              const leftover = typeof result.json.remaining === 'number' && result.json.remaining > 0 ? `；仍有 ${result.json.remaining} 个未跟踪文件未处理` : '';
              setActionNote(`已丢弃 ${result.json.files} 个文件的改动${leftover}`);
            } else setActionNote(`已推送 ${branch.name} → ${result.json.upstream}`);
            if (typeof props.onAction === 'function') props.onAction();
            return;
          }
          setActionError(typeof result.json.error === 'string' ? result.json.error : `操作失败（HTTP ${result.status}）`);
        } catch (cause) {
          setActionError(cause instanceof Error ? cause.message : String(cause));
        } finally {
          setBusyAction('');
        }
      }

      async function submit(branch, options) {
        if (active === null || active === undefined) return;
        const opts = options !== null && typeof options === 'object' ? options : {};
        setBusy(branch.name);
        setError('');
        try {
          const result = await postJson(ROUTE_SWITCH, {
            repoPath: active.root,
            branch: branch.name,
            force: opts.force === true,
            stash: opts.stash === true,
          });
          if (result.json.ok === true) {
            setPending(null);
            if (typeof props.onSwitched === 'function') props.onSwitched(active.root, branch.name);
            if (typeof props.onClose === 'function') props.onClose();
            return;
          }
          if (result.json.code === 'dirty') {
            setPending({ branch });
            return;
          }
          const reason = typeof result.json.error === 'string' ? result.json.error : `切换失败（HTTP ${result.status}）`;
          const saved = typeof result.json.stashed === 'string' && result.json.stashed !== ''
            ? `（改动已暂存为 ${result.json.stashed}，可用 git stash pop 恢复）`
            : '';
          setError(`${reason}${saved}`);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
          setBusy('');
        }
      }

      return h('div', { style: OVERLAY, onClick: (event) => { if (event.target === event.currentTarget && typeof props.onClose === 'function') props.onClose(); } },
        h('div', { style: DIALOG, role: 'dialog', 'aria-modal': true, 'aria-label': '切换分支' },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', borderBottom: `1px solid ${T.border}` } },
            h('span', { style: { fontSize: 14, fontWeight: 600 } }, '切换分支'),
            h('span', { style: { fontSize: 11.5, color: T.faint, fontFamily: MONO, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 } },
              active !== null && active !== undefined ? active.root : ''),
            h('button', {
              type: 'button',
              onClick: () => { setHelpOpen((open) => open === false); setPending(null); setConfirmDiscard(false); },
              title: helpOpen ? '返回分支列表' : '状态说明与危险操作',
              'aria-label': helpOpen ? '返回分支列表' : '状态说明与危险操作',
              'aria-pressed': helpOpen,
              style: {
                width: 20, height: 20, borderRadius: 999, lineHeight: '18px', padding: 0,
                border: `1px solid ${helpOpen ? T.accent : T.border}`,
                background: 'transparent', color: helpOpen ? T.accent : T.muted,
                fontSize: 12, cursor: 'pointer', flex: 'none',
              },
            }, '?'),
            h('button', {
              type: 'button', onClick: () => { if (typeof props.onClose === 'function') props.onClose(); },
              style: { border: 'none', background: 'transparent', color: T.muted, fontSize: 16, cursor: 'pointer', lineHeight: '16px' },
              'aria-label': '关闭',
            }, '×')),
          repos.length > 1
            ? h('div', { style: { display: 'flex', gap: 6, padding: '8px 14px 0', flexWrap: 'wrap' } },
              repos.map((repo) => h('button', {
                key: repo.root,
                type: 'button',
                onClick: () => {
                  setActiveRoot(repo.root);
                  setPending(null);
                  setConfirmDiscard(false);
                  setError('');
                  if (typeof props.onSelectRepo === 'function') props.onSelectRepo(repo.root);
                },
                style: {
                  padding: '3px 10px', borderRadius: 999, fontSize: 11.5, cursor: 'pointer',
                  border: `1px solid ${T.border}`,
                  background: repo.root === (active !== null && active !== undefined ? active.root : '') ? T.surfaceAlt : 'transparent',
                  color: T.text,
                },
              }, repo.name)))
            : null,
          noRemote
            ? h('div', { style: { padding: '8px 14px 0', fontSize: 11.5, color: T.warn } }, '该仓库未配置远端：拉取与推送不可用，只能切换分支或暂存。')
            : null,
          helpOpen ? h(Legend) : null,
          helpOpen ? null : h('div', { style: { padding: '10px 14px 6px' } },
            h('input', {
              value: filter,
              placeholder: '筛选分支 / 提交说明 / 上游',
              onChange: (event) => setFilter(event.target.value),
              style: {
                width: '100%', boxSizing: 'border-box', padding: '6px 9px', borderRadius: 6, fontSize: 12,
                border: `1px solid ${T.border}`, background: 'transparent', color: T.text, outline: 'none',
              },
            })),
          helpOpen ? null : h('div', { style: { flex: 1, overflow: 'auto', padding: '0 8px 8px' } },
            visible.length === 0 ? h('div', { style: { padding: '16px 8px', fontSize: 12, color: T.muted } }, '没有匹配的分支') : null,
            visible.map((branch) => {
              const status = statusOf(branch);
              const occupied = typeof branch.worktreePath === 'string' && branch.worktreePath !== '';
              const disabled = branch.current === true || occupied || busy !== '' || busyAction !== '';
              const isMaster = branch.name === 'master';
              const actionBusy = busyAction !== '';
              const rowActions = [];
              if (isMaster) {
                rowActions.push(h('button', {
                  key: 'pull',
                  type: 'button',
                  disabled: actionBusy || noRemote,
                  title: noRemote ? '未配置远端' : 'fetch origin master 并快进本地 master（不切换分支）',
                  onClick: () => { void runAction(branch, 'pull'); },
                  style: actionStyle(actionBusy || noRemote),
                }, busyAction === `pull:${branch.name}` ? '拉取中…' : '拉取'));
              }
              if (!isMaster) {
                if (branch.current === true) {
                  rowActions.push(h('button', {
                    key: 'stash',
                    type: 'button',
                    disabled: actionBusy || dirtyCount === 0,
                    title: dirtyCount > 0 ? `暂存当前 ${dirtyCount} 个未提交改动` : '没有未提交改动',
                    onClick: () => { void runAction(branch, 'stash'); },
                    style: actionStyle(actionBusy || dirtyCount === 0),
                  }, busyAction === `stash:${branch.name}` ? '暂存中…' : '暂存'));
                  rowActions.push(h('button', {
                    key: 'discard',
                    type: 'button',
                    disabled: actionBusy || dirtyCount === 0,
                    title: dirtyCount > 0 ? `丢弃当前 ${dirtyCount} 个未提交改动（不可恢复）` : '没有未提交改动',
                    onClick: () => { setConfirmDiscard(true); setActionError(''); setActionNote(''); },
                    style: { ...actionStyle(actionBusy || dirtyCount === 0), color: actionBusy || dirtyCount === 0 ? T.faint : T.danger },
                  }, '丢弃'));
                }
                rowActions.push(h('button', {
                  key: 'push',
                  type: 'button',
                  disabled: actionBusy || noRemote,
                  title: noRemote ? '未配置远端' : `推送 ${branch.name} 到 origin`,
                  onClick: () => { void runAction(branch, 'push'); },
                  style: actionStyle(actionBusy || noRemote),
                }, busyAction === `push:${branch.name}` ? '推送中…' : '推送'));
              }
              return h('div', {
                key: branch.name,
                style: { display: 'flex', alignItems: 'center', gap: 10, padding: '7px 8px', borderRadius: 6, borderTop: `1px solid ${T.border}` },
              },
                h('div', { style: { flex: 1, minWidth: 0 } },
                  h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
                    h(BranchName, { name: branch.name, size: 12, strong: branch.current === true }),
                    branch.current === true ? h(Badge, { text: '当前', color: T.accent }) : null,
                    branch.current === true && dirtyCount > 0 ? h(Badge, { text: `未保存 ${dirtyCount}`, color: T.warn }) : null,
                    branch.current === true && untrackedCount > 0 ? h(Badge, { text: `未跟踪 ${untrackedCount}` }) : null,
                    typeof branch.unpushed === 'number' && branch.unpushed > 0 ? h(Badge, { text: `未推送 ${branch.unpushed}`, color: T.accent }) : null,
                    occupied ? h(Badge, { text: '工作树占用' }) : null,
                    h('span', { style: { fontSize: 11, color: status.color, whiteSpace: 'nowrap' } }, status.text)),
                  h('div', { style: { fontSize: 11, color: T.faint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                    `${formatDate(branch.date)} · ${typeof branch.subject === 'string' && branch.subject !== '' ? branch.subject : '(无提交说明)'}`)),
                ...rowActions,
                h('button', {
                  type: 'button',
                  disabled,
                  title: occupied ? '该分支已被另一个工作树占用' : branch.current === true ? '已是当前分支' : `git switch ${branch.name}`,
                  onClick: () => { void submit(branch, { force: false }); },
                  style: {
                    padding: '3px 10px', borderRadius: 6, fontSize: 11.5, whiteSpace: 'nowrap',
                    border: `1px solid ${T.border}`, background: T.surface,
                    color: disabled ? T.faint : T.text, cursor: disabled ? 'default' : 'pointer',
                  },
                }, busy === branch.name ? '切换中…' : branch.current === true ? '当前' : '切换'));
            })),
          actionNote !== ''
            ? h('div', { style: { padding: '8px 14px', borderTop: `1px solid ${T.border}`, fontSize: 12, color: T.ok } }, actionNote)
            : null,
          actionError !== ''
            ? h('div', { style: { padding: '8px 14px', borderTop: `1px solid ${T.border}`, fontSize: 12, color: T.danger } }, `操作失败：${actionError}`)
            : null,
          confirmDiscard
            ? h('div', { style: { padding: '10px 14px', borderTop: `1px solid ${T.border}`, background: T.surface, fontSize: 12, color: T.danger } },
              h('div', { style: { marginBottom: 8 } },
                `将丢弃当前工作区 ${dirtyCount} 个已跟踪文件的改动（含已暂存），此操作无法撤销${untrackedCount > 0 ? `；${untrackedCount} 个未跟踪文件会保留` : ''}。`),
              h('div', { style: { display: 'flex', gap: 8 } },
                h('button', {
                  type: 'button', disabled: busy !== '',
                  onClick: () => { const cur = branches.find((item) => item.current === true); if (cur !== undefined) void runAction(cur, 'discard', { confirm: true }); },
                  style: { padding: '4px 12px', borderRadius: 6, border: `1px solid ${T.border}`, background: T.surfaceAlt, color: T.danger, fontSize: 12, cursor: busy !== '' ? 'default' : 'pointer' },
                }, '确认丢弃'),
                h('button', {
                  type: 'button', onClick: () => setConfirmDiscard(false),
                  style: { padding: '4px 12px', borderRadius: 6, border: `1px solid ${T.border}`, background: 'transparent', color: T.text, fontSize: 12, cursor: 'pointer' },
                }, '取消')))
            : null,
          pending !== null
            ? h('div', { style: { padding: '10px 14px', borderTop: `1px solid ${T.border}`, background: T.surface, fontSize: 12, color: T.warn } },
              h('div', { style: { marginBottom: 8 } },
                `当前工作区有 ${dirtyCount} 个未提交改动。暂存后再切换到 ${pending.branch.name}？（之后可用 git stash pop 恢复）`),
              h('div', { style: { display: 'flex', gap: 8 } },
                h('button', {
                  type: 'button', disabled: busy !== '',
                  onClick: () => { void submit(pending.branch, { stash: true }); },
                  style: { padding: '4px 12px', borderRadius: 6, border: `1px solid ${T.border}`, background: T.surfaceAlt, color: T.text, fontSize: 12, cursor: busy !== '' ? 'default' : 'pointer' },
                }, busy !== '' ? '处理中…' : '暂存并切换'),
                h('button', {
                  type: 'button', onClick: () => setPending(null),
                  style: { padding: '4px 12px', borderRadius: 6, border: `1px solid ${T.border}`, background: 'transparent', color: T.text, fontSize: 12, cursor: 'pointer' },
                }, '取消')))
            : null,
          error !== ''
            ? h('div', { style: { padding: '8px 14px', borderTop: `1px solid ${T.border}`, fontSize: 12, color: T.danger } }, `切换失败：${error}`)
            : null));
    }

    const GRID = 'minmax(150px, 1.4fr) minmax(110px, 1fr) 96px minmax(180px, 2.2fr) 96px 60px';

    function BranchRow(props) {
      const branch = props.branch;
      const status = statusOf(branch);
      const occupied = typeof branch.worktreePath === 'string' && branch.worktreePath !== '';
      const dirtyCount = typeof props.dirtyCount === 'number' ? props.dirtyCount : 0;
      const small = { fontSize: 11, lineHeight: '16px' };
      return h('div', {
        style: {
          display: 'grid', gridTemplateColumns: GRID, gap: 10,
          alignItems: 'center', padding: '6px 8px', borderRadius: 6,
          borderTop: `1px solid ${T.border}`, minWidth: 0,
        },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
          h(BranchName, { name: branch.name, size: 12, strong: branch.current === true }),
          branch.current === true ? h(Badge, { text: '当前', color: T.accent }) : null,
          branch.current === true && dirtyCount > 0 ? h(Badge, { text: `未保存 ${dirtyCount}`, color: T.warn }) : null,
          branch.current === true && typeof props.untrackedCount === 'number' && props.untrackedCount > 0 ? h(Badge, { text: `未跟踪 ${props.untrackedCount}` }) : null,
          typeof branch.unpushed === 'number' && branch.unpushed > 0 ? h(Badge, { text: `未推送 ${branch.unpushed}`, color: T.accent }) : null,
          occupied ? h(Badge, { text: '工作树' }) : null),
        h('span', {
          title: typeof branch.upstream === 'string' ? branch.upstream : '',
          style: { fontFamily: MONO, fontSize: 11, color: T.faint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
        }, typeof branch.upstream === 'string' && branch.upstream !== '' ? branch.upstream : '—'),
        h('span', { style: { fontSize: 11.5, color: status.color, whiteSpace: 'nowrap' } }, status.text),
        h('div', { style: { minWidth: 0 } },
          h('div', {
            title: typeof branch.subject === 'string' ? branch.subject : '',
            style: { fontSize: 12, color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          }, typeof branch.subject === 'string' && branch.subject !== '' ? branch.subject : '(无提交说明)'),
          typeof branch.author === 'string' && branch.author !== '' ? h('div', { style: { ...small, color: T.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, branch.author) : null),
        h('span', { style: { fontFamily: MONO, fontSize: 11, color: T.faint, whiteSpace: 'nowrap' } }, formatDate(branch.date)),
        branch.current === true
          ? h('span', { style: { fontSize: 11, color: T.faint } }, '')
          : h('button', {
            type: 'button',
            disabled: occupied || props.busy === true,
            title: occupied ? '该分支已被工作树占用，请在对应工作树里切换' : `切换到 ${branch.name}`,
            onClick: () => { if (typeof props.onSwitch === 'function') props.onSwitch(branch); },
            style: {
              padding: '2px 8px', borderRadius: 6, fontSize: 11, whiteSpace: 'nowrap',
              border: `1px solid ${T.border}`, background: T.surface,
              color: occupied ? T.faint : T.text, cursor: occupied ? 'default' : 'pointer',
            },
          }, '切换'));
    }

    function RepoCard(props) {
      const repo = props.repo;
      const branches = props.branches;
      const bits = [];
      if (typeof repo.currentBranch === 'string' && repo.currentBranch !== '') {
        bits.push(h(Badge, { key: 'cur', text: `${repo.detached === true ? '分离 HEAD' : '当前'} ${repo.currentBranch}`, color: T.accent }));
      }
      const repoCounts = dirtyParts(repo);
      const dirtyCount = repoCounts.tracked;
      const repoUntracked = repoCounts.untracked;
      if (dirtyCount > 0) bits.push(h(Badge, { key: 'dirty', text: `未保存 ${dirtyCount}`, color: T.warn }));
      if (repoUntracked > 0) bits.push(h(Badge, { key: 'untracked', text: `未跟踪 ${repoUntracked}` }));
      const allBranches = Array.isArray(repo.branches) ? repo.branches : [];
      const unpushedTotal = allBranches.reduce((sum, branch) => sum + (typeof branch.unpushed === 'number' ? branch.unpushed : 0), 0);
      if (unpushedTotal > 0) bits.push(h(Badge, { key: 'unpushed', text: `未推送 ${unpushedTotal}`, color: T.accent }));
      if (repo.noRemote === true) bits.push(h(Badge, { key: 'noremote', text: '未配置远端' }));
      const worktrees = Array.isArray(repo.worktrees) ? repo.worktrees : [];
      if (worktrees.length > 1) bits.push(h(Badge, { key: 'wt', text: `工作树 ${worktrees.length}` }));
      if (typeof repo.stashCount === 'number' && repo.stashCount > 0) bits.push(h(Badge, { key: 'stash', text: `stash ${repo.stashCount}` }));
      if (typeof repo.remoteBranchCount === 'number' && repo.remoteBranchCount > 0) bits.push(h(Badge, { key: 'remote', text: `远端 ${repo.remoteBranchCount}` }));
      return h('section', {
        style: { border: `1px solid ${T.border}`, borderRadius: 10, background: T.surface, padding: '10px 12px 12px', marginBottom: 12 },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 2 } },
          h('span', { style: { fontSize: 13.5, fontWeight: 600, color: T.text } }, repo.name),
          typeof repo.section === 'string' && repo.section !== '' ? h('span', { style: { fontSize: 11.5, color: T.faint } }, repo.section) : null,
          h('button', {
            type: 'button',
            onClick: () => { if (typeof props.onOpenSwitch === 'function') props.onOpenSwitch(repo); },
            style: {
              marginLeft: 'auto', padding: '3px 10px', borderRadius: 6, fontSize: 11.5, cursor: 'pointer',
              border: `1px solid ${T.border}`, background: T.surfaceAlt, color: T.text,
            },
          }, '切换分支'),
          ...bits),
        h('div', {
          title: repo.root,
          style: { fontFamily: MONO, fontSize: 11, color: T.faint, marginBottom: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
        }, repo.root),
        repo.ok === false
          ? h('div', { style: { fontSize: 12, color: T.danger } }, `读取失败：${typeof repo.error === 'string' ? repo.error : '未知错误'}`)
          : h('div', null,
            h('div', {
              style: {
                display: 'grid', gridTemplateColumns: GRID, gap: 10, padding: '0 8px 4px',
                fontSize: 11, color: T.faint, borderBottom: `1px solid ${T.border}`,
              },
            },
              h('span', null, '分支'), h('span', null, '上游'), h('span', null, '同步状态'),
              h('span', null, '最近提交'), h('span', null, '提交时间'), h('span', null, '操作')),
            branches.length === 0
              ? h('div', { style: { padding: '10px 8px', fontSize: 12, color: T.muted } }, '没有匹配的分支')
              : branches.map((branch) => h(BranchRow, {
                key: branch.name,
                branch,
                dirtyCount,
                untrackedCount: repoUntracked,
                busy: props.switchingRoot === repo.root,
                onSwitch: (target) => { if (typeof props.onSwitchBranch === 'function') props.onSwitchBranch(repo, target); },
              })),
            h('div', { style: { padding: '6px 8px 0', fontSize: 11, color: T.faint } },
              `${Array.isArray(repo.branches) ? repo.branches.length : 0} 个本地分支`)));
    }

    function Panel() {
      const { data, error, reload } = useScan(null);
      const [filter, setFilter] = useState('');
      const [dialog, setDialog] = useState(null);
      const [switchingRoot, setSwitchingRoot] = useState('');
      const [actionError, setActionError] = useState('');
      const repos = data !== null && data !== undefined && Array.isArray(data.repos) ? data.repos : [];
      const needle = filter.trim().toLowerCase();
      const groups = useMemo(() => repos
        .map((repo) => {
          const branches = Array.isArray(repo.branches) ? repo.branches : [];
          if (needle === '') return { repo, branches };
          return { repo, branches: branches.filter((branch) => `${branch.name} ${branch.subject} ${branch.upstream}`.toLowerCase().includes(needle)) };
        })
        .filter((group) => needle === '' || group.branches.length > 0), [repos, needle]);
      const totalBranches = repos.reduce((sum, repo) => sum + (Array.isArray(repo.branches) ? repo.branches.length : 0), 0);

      async function switchFromPanel(repo, branch) {
        const counts = dirtyParts(repo);
        const dirtyCount = counts.tracked;
        if (dirtyCount > 0 && typeof window !== 'undefined' && typeof window.confirm === 'function') {
          const proceed = window.confirm(`工作区 ${repo.name} 有 ${dirtyCount} 个未提交改动，切换到 ${branch.name} 会把这些改动带过去。继续？`);
          if (!proceed) return;
        }
        setSwitchingRoot(repo.root);
        setActionError('');
        try {
          const result = await postJson(ROUTE_SWITCH, { repoPath: repo.root, branch: branch.name, force: true });
          if (result.json.ok !== true) {
            setActionError(typeof result.json.error === 'string' ? result.json.error : `切换失败（HTTP ${result.status}）`);
          } else {
            reload(true);
          }
        } catch (cause) {
          setActionError(cause instanceof Error ? cause.message : String(cause));
        } finally {
          setSwitchingRoot('');
        }
      }

      const meta = data === null || data === undefined
        ? ''
        : `${repos.length} 个仓库 · ${totalBranches} 个本地分支 · 更新于 ${formatClock(data.generatedAt)}（${typeof data.tookMs === 'number' ? data.tookMs : 0}ms）`;

      return h('div', { style: { height: '100%', overflow: 'auto', padding: '20px 24px', boxSizing: 'border-box', color: T.text } },
        h('div', { style: { maxWidth: 1240, margin: '0 auto' } },
          h('div', { style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 14 } },
            h('div', null,
              h('div', { style: { fontSize: 16, fontWeight: 600 } }, LABEL),
              h('div', { style: { fontSize: 11.5, color: T.faint, marginTop: 2 } }, meta === '' ? '正在读取各工作区的 git 仓库…' : meta)),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
              h('input', {
                value: filter,
                placeholder: '筛选分支 / 提交说明 / 上游',
                onChange: (event) => setFilter(event.target.value),
                style: {
                  width: 220, padding: '5px 8px', borderRadius: 6, fontSize: 12,
                  border: `1px solid ${T.border}`, background: 'transparent', color: T.text, outline: 'none',
                },
              }),
              h('button', {
                type: 'button',
                onClick: () => reload(true),
                style: {
                  padding: '5px 12px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
                  border: `1px solid ${T.border}`, background: T.surfaceAlt, color: T.text,
                },
              }, '刷新'))),
          error !== ''
            ? h('div', { style: { border: `1px solid ${T.border}`, borderRadius: 8, padding: '8px 10px', fontSize: 12, color: T.danger, marginBottom: 12 } }, `读取失败：${error}`)
            : null,
          actionError !== ''
            ? h('div', { style: { border: `1px solid ${T.border}`, borderRadius: 8, padding: '8px 10px', fontSize: 12, color: T.danger, marginBottom: 12 } }, `切换失败：${actionError}`)
            : null,
          repos.length === 0
            ? h('div', { style: { border: `1px dashed ${T.border}`, borderRadius: 10, padding: '24px 20px', fontSize: 12.5, color: T.muted, lineHeight: '20px' } },
              h('div', { style: { fontWeight: 600, marginBottom: 4, color: T.text } }, '没有发现 git 仓库'),
              '把仓库目录（例如 /Users/spencer/Desktop/AI原型/scm）添加为 DSH 工作区，插件会扫描工作区本身及其子目录里的仓库。')
            : null,
          groups.map((group) => h(RepoCard, {
            key: group.repo.root,
            repo: group.repo,
            branches: group.branches,
            switchingRoot,
            onSwitchBranch: (repo, branch) => { void switchFromPanel(repo, branch); },
            onOpenSwitch: (repo) => setDialog(repo),
          })),
          h('div', { style: { fontSize: 11, color: T.faint, marginTop: 8 } },
            '只读扫描 + 显式切换；未提交改动会先确认，工作树占用的分支不可在这里切换。'),
          dialog !== null
            ? h(SwitchDialog, {
              repo: dialog,
              repos,
              onClose: () => setDialog(null),
              onAction: () => { reload(true); },
              onSwitched: () => { setDialog(null); reload(true); },
            })
            : null));
    }

    /**
     * Composer chip: shows the session directory's repository and branch, and
     * opens the switch dialog. Renders nothing outside a git worktree.
     */
    function BranchChip(props) {
      const sessionId = props !== null && props !== undefined ? props.sessionId : undefined;
      const useSessions = props !== null && props !== undefined ? props.useSessions : undefined;
      let summary;
      try {
        summary = typeof useSessions === 'function' ? useSessions((state) => (state !== null && state !== undefined && state.byId !== undefined ? state.byId[sessionId] : undefined)) : undefined;
      } catch {
        summary = undefined;
      }
      const cwd = summary !== null && summary !== undefined && typeof summary.cwd === 'string' ? summary.cwd : '';
      const { data, reload } = useScan(cwd === '' ? '' : cwd);
      const [open, setOpen] = useState(false);
      const [selectedRoot, setSelectedRoot] = useState('');
      useEffect(() => {
        if (cwd === '') return;
        const stored = readStoredRepo(cwd);
        if (stored !== '') setSelectedRoot(stored);
      }, [cwd]);
      const repos = data !== null && data !== undefined && Array.isArray(data.repos) ? data.repos.filter((repo) => repo.ok !== false) : [];
      const primary = pickPrimaryRepo(repos, selectedRoot);
      if (cwd === '' || primary === null) return null;
      const chooseRepo = (root) => {
        setSelectedRoot(root);
        storeRepo(cwd, root);
      };
      const chipCounts = dirtyParts(primary);
      const dirtyCount = chipCounts.tracked;
      const chipUntracked = chipCounts.untracked;
      const currentInfo = Array.isArray(primary.branches) ? primary.branches.find((branch) => branch.current === true) : undefined;
      const unpushedCount = currentInfo !== undefined && typeof currentInfo.unpushed === 'number' ? currentInfo.unpushed : 0;
      return h('div', { style: { display: 'inline-flex', alignItems: 'center', minWidth: 0 } },
        h('button', {
          type: 'button',
          onClick: () => setOpen(true),
          title: `${primary.root} — 点击切换分支`,
          style: {
            display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: 420, minWidth: 0,
            padding: '2px 8px', borderRadius: 999, cursor: 'pointer',
            border: `1px solid ${T.border}`, background: T.surface, color: T.muted,
            fontSize: 11.5, lineHeight: '18px',
          },
        },
          h(BranchGlyph, { size: 13 }),
          h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, primary.name),
          repos.length > 1
            ? h('span', {
              title: `该目录下有 ${repos.length} 个仓库：${repos.map((repo) => repo.name).join(' / ')}；点击选择`,
              style: {
                color: T.faint, fontSize: 10, lineHeight: '13px', padding: '0 5px',
                border: `1px solid ${T.border}`, borderRadius: 999, flex: 'none',
              },
            }, `${repos.length}仓库`)
            : null,
          h(BranchName, { name: primary.currentBranch !== '' ? primary.currentBranch : '—', size: 11.5, strong: true }),
          dirtyCount > 0
            ? h('span', {
              title: `${dirtyCount} 个已跟踪文件的未保存改动`,
              style: {
                color: T.warn, fontSize: 10.5, lineHeight: '14px', padding: '0 5px',
                border: `1px solid ${T.warn}`, borderRadius: 999, flex: 'none',
              },
            }, `未保存 ${dirtyCount}`)
            : null,
          dirtyCount === 0 && chipUntracked > 0
            ? h('span', {
              title: `${chipUntracked} 个未跟踪文件`,
              style: {
                color: T.faint, fontSize: 10.5, lineHeight: '14px', padding: '0 5px',
                border: `1px solid ${T.border}`, borderRadius: 999, flex: 'none',
              },
            }, `未跟踪 ${chipUntracked}`)
            : null,
          unpushedCount > 0
            ? h('span', {
              title: `当前分支有 ${unpushedCount} 个提交未推送`,
              style: {
                color: T.accent, fontSize: 10.5, lineHeight: '14px', padding: '0 5px',
                border: `1px solid ${T.accent}`, borderRadius: 999, flex: 'none',
              },
            }, `未推送 ${unpushedCount}`)
            : null),
        open
          ? h(SwitchDialog, {
            repo: primary,
            repos,
            onClose: () => setOpen(false),
            onSelectRepo: chooseRepo,
            onAction: () => { reload(true); },
            onSwitched: () => { setOpen(false); reload(true); },
          })
          : null);
    }

    return {
      inject: ['slots', 'layout'],
      __internals: { pickPrimaryRepo, splitBranch, readStoredRepo, storeRepo, SwitchDialog, Legend },
      apply(ctx) {
        let layout;
        try {
          layout = ctx.get('layout');
        } catch {
          layout = undefined;
        }
        const closePanel = () => {
          try {
            if (layout !== undefined && layout !== null && typeof layout.selectPanel === 'function') layout.selectPanel(null);
          } catch {
            // Layout not ready: leaving the panel selected is harmless.
          }
        };
        if (SHOW_PANEL) {
          ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 6,
            label: LABEL,
          }, (props) => h(RailIcon, props)));
          ctx.slots.inject('main', () => ctx.slots.register({
            name: 'main',
            key: PANEL_ID,
          }, () => h(Panel, { onClose: closePanel })));
        }
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: CHIP_ID,
          order: 6,
        }, BranchChip));
      },
    };
  },
});
