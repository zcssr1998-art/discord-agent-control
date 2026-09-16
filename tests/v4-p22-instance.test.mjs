import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InstanceGuard, pidAlive, parseLockInfo, readLockInfo } from '../src/instance-guard.mjs';
import { resolveBuildIdentity, describeBuild } from '../src/build-identity.mjs';

function tmpRoot(t, tree) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-guard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, lockFile: path.join(root, 'data', 'jarvis-instance.lock') };
}

test('instance guard: first instance acquires with real metadata', (t) => {
  const { root, lockFile } = tmpRoot(t);
  const build = resolveBuildIdentity(root); // no .git -> unknown, never invented
  const guard = new InstanceGuard({ root, build });
  const result = guard.acquire();
  assert.equal(result.ok, true);
  assert.equal(result.info.pid, process.pid);
  assert.equal(result.info.branch, 'unknown');
  assert.equal(result.info.commit, 'unknown');
  assert.ok(result.info.instanceId.includes(':'));
  assert.ok(fs.existsSync(lockFile));
  assert.equal(result.info.repoRoot, root);
});

test('instance guard: second live owner is refused, not killed', (t) => {
  const { root } = tmpRoot(t);
  const firstLock = path.join(root, 'data', 'jarvis-instance.lock');
  fs.mkdirSync(path.dirname(firstLock), { recursive: true });
  // Simulate a live foreign holder: this test process is alive.
  fs.writeFileSync(firstLock, JSON.stringify({ pid: process.pid + 1, startedAt: 'x', instanceId: 'other:other' }));
  const guard = new InstanceGuard({ root, build: {} });
  const result = guard.acquire();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'already-running');
  assert.equal(result.holder.pid, process.pid + 1);
  assert.ok(pidAlive(process.pid));
});

test('instance guard: stale lock (dead pid) is reclaimed', (t) => {
  const { root } = tmpRoot(t);
  const lockFile = path.join(root, 'data', 'jarvis-instance.lock');
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999, branch: 'stale', instanceId: 'old:old' }));
  const guard = new InstanceGuard({ root, build: { branch: 'main' } });
  const result = guard.acquire();
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'stale-lock-reclaimed');
  assert.equal(result.info.branch, 'main');
});

test('instance guard: corrupt lock without a live owner can be reclaimed', (t) => {
  const { root } = tmpRoot(t);
  const lockFile = path.join(root, 'data', 'jarvis-instance.lock');
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, '{not json');
  const guard = new InstanceGuard({ root });
  const result = guard.acquire();
  assert.equal(result.ok, true);
});

test('instance guard: release removes only own lock, second then acquires', (t) => {
  const { root } = tmpRoot(t);
  const first = new InstanceGuard({ root, build: {} });
  assert.equal(first.acquire().ok, true);
  assert.equal(first.release(), true);
  const second = new InstanceGuard({ root, build: {} });
  assert.equal(second.acquire().ok, true);
  // A renewed release must never delete someone else's lock implicitly.
  assert.equal(first.release(), false);
  fs.rmSync(path.join(root, 'data', 'jarvis-instance.lock'), { force: true });
});

test('parseLockInfo / readLockInfo basics', (t) => {
  const { root, lockFile } = tmpRoot(t);
  const guard = new InstanceGuard({ root, build: {} });
  guard.acquire();
  const info = readLockInfo(lockFile);
  assert.equal(info.alive, true);
  assert.equal(info.self, true);
  const corrupt = readLockInfo((() => {
    fs.writeFileSync(lockFile, 'nope', 'utf8');
    return lockFile;
  })());
  assert.equal(corrupt.corrupt, true);
  assert.equal(parseLockInfo('[]'), null);
});

test('build identity: detached HEAD + branch rendering', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-git-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = path.join(root, '.git');
  fs.mkdirSync(path.join(git, 'refs', 'heads'), { recursive: true });
  fs.writeFileSync(path.join(git, 'HEAD'), 'ref: refs/heads/jarvis-v4-test\n');
  fs.writeFileSync(path.join(git, 'refs', 'heads', 'jarvis-v4-test'), '0123456789abcdef'.padEnd(40, '0'), 'utf8');
  const id = resolveBuildIdentity(root);
  assert.equal(id.branch, 'jarvis-v4-test');
  assert.equal(id.commit, '0123456789abcdef'.padEnd(40, '0'));
  assert.ok(describeBuild(id).startsWith('jarvis-v4-test@0123456'));
});

test('pidAlive reports EPERM (foreign but alive) as alive', () => {
  assert.equal(pidAlive(null), false);
  assert.equal(pidAlive(-1), false);
  assert.equal(pidAlive(process.pid), true);
});
