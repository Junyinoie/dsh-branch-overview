import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import test from 'node:test';

import { apply, ROUTE_ACTION, ROUTE_SWITCH } from '../index.js';

const exec = promisify(execFile);

async function git(root, ...args) {
  const result = await exec('git', ['-C', root, ...args], { maxBuffer: 1024 * 1024 });
  return result.stdout.trim();
}

async function makeRepo() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-branch-overview-'));
  await git(root, 'init', '-q');
  await git(root, 'config', 'user.email', 'test@example.com');
  await git(root, 'config', 'user.name', 'Test');
  await writeFile(join(root, 'tracked.txt'), 'one\n');
  await git(root, 'add', 'tracked.txt');
  await git(root, 'commit', '-q', '-m', 'init');
  await git(root, 'branch', '-M', 'master');
  await git(root, 'switch', '-q', '-c', 'work');
  return root;
}

function pluginRoutes() {
  const routes = new Map();
  const webCtx = {
    effect(run) { run(); },
    webServer: {
      register(route) { routes.set(route.path, route); },
    },
  };
  apply({ inject(_deps, run) { run(webCtx); } }, {});
  return routes;
}

function post(routes, path, payload) {
  return new Promise((resolve, reject) => {
    const req = Readable.from([Buffer.from(JSON.stringify(payload))]);
    req.method = 'POST';
    const chunks = [];
    const res = {
      status: 0,
      writeHead(status) { this.status = status; },
      end(chunk) {
        if (chunk) chunks.push(Buffer.from(chunk));
        try {
          resolve({ status: this.status, json: JSON.parse(Buffer.concat(chunks).toString()) });
        } catch (error) {
          reject(error);
        }
      },
    };
    Promise.resolve(routes.get(path).handler(req, res)).catch(reject);
  });
}

test('save commits tracked and new files, but excludes local backups', async (t) => {
  const root = await makeRepo();
  t.after(() => rm(root, { recursive: true, force: true }));
  const routes = pluginRoutes();

  await writeFile(join(root, 'tracked.txt'), 'one\ntwo\n');
  await writeFile(join(root, 'new-file.txt'), 'new\n');
  await mkdir(join(root, '.dsh-backups'), { recursive: true });
  await writeFile(join(root, '.dsh-backups', 'backup.patch'), 'backup\n');
  await mkdir(join(root, 'sub'), { recursive: true });
  await writeFile(join(root, 'sub', '.DS_Store'), 'noise\n');

  const saved = await post(routes, ROUTE_ACTION, { repoPath: root, action: 'save', confirm: true });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.files, 2);
  assert.equal(saved.json.remaining, 0);

  const committed = await git(root, 'show', '--pretty=', '--name-only', 'HEAD');
  assert.deepEqual(committed.split('\n').sort(), ['new-file.txt', 'tracked.txt']);
  assert.equal(await git(root, 'status', '--porcelain', '--untracked-files=all', '--', 'tracked.txt', 'new-file.txt'), '');
  assert.match(await git(root, 'status', '--porcelain'), /\.dsh-backups/);

  const switched = await post(routes, ROUTE_SWITCH, { repoPath: root, branch: 'master' });
  assert.equal(switched.status, 200);
  assert.equal(await git(root, 'branch', '--show-current'), 'master');
});

test('master cannot be saved or pushed, and only master can be pulled', async (t) => {
  const root = await makeRepo();
  t.after(() => rm(root, { recursive: true, force: true }));
  const routes = pluginRoutes();
  await git(root, 'switch', '-q', 'master');

  const saved = await post(routes, ROUTE_ACTION, { repoPath: root, action: 'save', confirm: true });
  assert.equal(saved.status, 403);

  const pushed = await post(routes, ROUTE_ACTION, { repoPath: root, action: 'push', branch: 'master', confirm: true });
  assert.equal(pushed.status, 403);

  const pulled = await post(routes, ROUTE_ACTION, { repoPath: root, action: 'pull', branch: 'work' });
  assert.equal(pulled.status, 403);
});

test('dirty switch is refused, then succeeds after save without creating a stash', async (t) => {
  const root = await makeRepo();
  t.after(() => rm(root, { recursive: true, force: true }));
  const routes = pluginRoutes();

  await writeFile(join(root, 'tracked.txt'), 'one\ndirty\n');
  const refused = await post(routes, ROUTE_SWITCH, { repoPath: root, branch: 'master' });
  assert.equal(refused.status, 409);
  assert.equal(refused.json.code, 'dirty');
  assert.equal(await git(root, 'branch', '--show-current'), 'work');
  assert.equal(await git(root, 'stash', 'list'), '');

  const saved = await post(routes, ROUTE_ACTION, { repoPath: root, action: 'save', confirm: true });
  assert.equal(saved.status, 200);
  const switched = await post(routes, ROUTE_SWITCH, { repoPath: root, branch: 'master' });
  assert.equal(switched.status, 200);
  assert.equal(await git(root, 'branch', '--show-current'), 'master');
  assert.equal(await git(root, 'stash', 'list'), '');
});

test('dirty master can be moved to a work branch without saving', async (t) => {
  const root = await makeRepo();
  t.after(() => rm(root, { recursive: true, force: true }));
  const routes = pluginRoutes();

  await git(root, 'switch', '-q', 'master');
  await writeFile(join(root, 'tracked.txt'), 'one\ncarried\n');
  const switched = await post(routes, ROUTE_SWITCH, { repoPath: root, branch: 'work' });
  assert.equal(switched.status, 200);
  assert.equal(switched.json.carried, 1);
  assert.equal(await git(root, 'branch', '--show-current'), 'work');
  assert.match(await git(root, 'status', '--porcelain'), /tracked\.txt/);
});

test('slash branch names switch to the exact local branch', async (t) => {
  const root = await makeRepo();
  t.after(() => rm(root, { recursive: true, force: true }));
  const routes = pluginRoutes();
  await git(root, 'branch', 'feature/foo');

  const switched = await post(routes, ROUTE_SWITCH, { repoPath: root, branch: 'feature/foo' });
  assert.equal(switched.status, 200);
  assert.equal(await git(root, 'branch', '--show-current'), 'feature/foo');
});

test('save is blocked while a rebase is in progress', async (t) => {
  const root = await makeRepo();
  t.after(() => rm(root, { recursive: true, force: true }));
  const routes = pluginRoutes();
  await mkdir(join(root, '.git', 'rebase-merge'));
  await writeFile(join(root, 'tracked.txt'), 'one\nrebase\n');

  const saved = await post(routes, ROUTE_ACTION, { repoPath: root, action: 'save', confirm: true });
  assert.equal(saved.status, 409);
  assert.equal(saved.json.code, 'pending');
});
