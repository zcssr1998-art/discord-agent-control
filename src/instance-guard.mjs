// P2.2A: single-instance runtime guard.
//
// One live Jarvis bridge per checkout/bot identity. The lock is an exclusive
// file under git-ignored runtime data carrying real identity metadata. A second
// live owner process must fail fast BEFORE it logs into Discord. A stale lock
// (its PID no longer exists) is reclaimed. Never kill another process: a live
// lock holder is reported, never attacked.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const DEFAULT_LOCK_FILE = 'data/jarvis-instance.lock';

export function stringifyLockInfo(info) {
  return JSON.stringify(info, null, 2);
}

/** A pid is "alive" when the OS still has a process behind it (any user). */
export function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (error) {
    if (error?.code === 'EPERM') return true;
    return false;
  }
}

/** Parse and validate lock file contents; null when unreadable/corrupt. */
export function parseLockInfo(text) {
  try {
    const info = JSON.parse(text);
    if (!info || typeof info !== 'object') return null;
    if (!Number.isInteger(info.pid)) return null;
    return info;
  } catch {
    return null;
  }
}

/** True when this lock belongs to a live process owned by someone else. */
export function lockHeldByOther(text, { pid = process.pid } = {}) {
  const info = parseLockInfo(text);
  if (!info) return false;
  if (info.pid === pid) return false;
  return pidAlive(info.pid);
}

/**
 * Read a live runtime identity from an existing lock file (used by /doctor to
 * warn about a duplicate instance). Returns { info, alive } for owned locks.
 */
export function readLockInfo(lockFile, { selfPid = process.pid } = {}) {
  if (!fs.existsSync(lockFile)) return null;
  const info = parseLockInfo(fs.readFileSync(lockFile, 'utf8'));
  if (!info) return { corrupt: true, alive: false, self: false };
  const alive = pidAlive(info.pid);
  const self = info.pid === selfPid
    || (info.instanceId && typeof info.instanceId === 'string' && info.instanceId.endsWith(`:${selfPid}`));
  info.alive = alive;
  info.self = self;
  return info;
}

export class InstanceGuard {
  constructor({ root, build = {}, lockFile = null } = {}) {
    this.root = root;
    this.lockFile = lockFile || path.join(root, DEFAULT_LOCK_FILE);
    this.build = build || {};
    this.info = null;
    this.acquired = false;
  }

  /**
   * Create/O_EXCL the lock file. `force` removes a corrupt file that could
   * never belong to a live process. Returns { ok, reason, holder }.
   */
  acquire({ force = false } = {}) {
    fs.mkdirSync(path.dirname(this.lockFile), { recursive: true });
    const payload = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      repoRoot: this.root,
      branch: this.build.branch ?? 'unknown',
      commit: this.build.commit ?? 'unknown',
      instanceId: `${randomId()}:${process.pid}`,
      host: os.hostname(),
    };
    let fd = null;
    try {
      fd = fs.openSync(this.lockFile, 'wx');
      fs.writeFileSync(fd, stringifyLockInfo(payload));
      fs.closeSync(fd);
      fd = null;
      this.info = payload;
      this.acquired = true;
      return { ok: true, info: payload };
    } catch (error) {
      if (fd) try { fs.closeSync(fd); } catch { /* ignore */ }
      if (error?.code !== 'EEXIST') return { ok: false, reason: `lock create failed: ${error?.message || error}` };
    }
    // Existed. Inspect it.
    let text = '';
    try { text = fs.readFileSync(this.lockFile, 'utf8'); } catch { text = ''; }
    let info = parseLockInfo(text);
    if (!info || (force && !lockHeldByOther(text))) {
      // Corrupt/partial write or a lock owned by a dead pid (or ourselves):
      // reclaiming is safe and required by the crash-recovery contract. A live
      // holder's lock is never taken over.
      try { fs.rmSync(this.lockFile, { force: true }); } catch { /* best effort */ }
      try {
        fd = fs.openSync(this.lockFile, 'wx');
        fs.writeFileSync(fd, stringifyLockInfo(payload));
        fs.closeSync(fd);
        fd = null;
        this.info = payload;
        this.acquired = true;
        return { ok: true, info: payload, reason: 'stale-lock-reclaimed' };
      } catch (error) {
        return { ok: false, reason: `lock reclaim failed: ${error?.message || error}` };
      }
    }
    if (!info) return { ok: false, reason: 'corrupt-lock', holder: null };
    if (info.pid === process.pid) {
      // Our own leftover from the same pid (e.g. restart in-process in tests).
      try { fs.rmSync(this.lockFile, { force: true }); } catch { /* ignore */ }
      return this.acquire({ force: true });
    }
    const alive = pidAlive(info.pid);
    if (!alive) {
      // Stale lock: old holder is gone. Reclaim safely.
      try { fs.rmSync(this.lockFile, { force: true }); } catch { /* ignore */ }
      try {
        fd = fs.openSync(this.lockFile, 'wx');
        fs.writeFileSync(fd, stringifyLockInfo(payload));
        fs.closeSync(fd);
        fd = null;
        this.info = payload;
        this.acquired = true;
        return { ok: true, info: payload, reason: 'stale-lock-reclaimed' };
      } catch (error) {
        return { ok: false, reason: `lock reclaim failed: ${error?.message || error}` };
      }
    }
    return { ok: false, reason: 'already-running', holder: info };
  }

  /** Release only when we own the current content. Never delete someone else's lock. */
  release() {
    if (!this.acquired || !this.info) return false;
    try {
      const text = fs.existsSync(this.lockFile) ? fs.readFileSync(this.lockFile, 'utf8') : '';
      const info = parseLockInfo(text);
      if (info && info.pid !== process.pid) {
        this.acquired = false;
        return false;
      }
      fs.rmSync(this.lockFile, { force: true });
      this.acquired = false;
      return true;
    } catch {
      this.acquired = false;
      return false;
    }
  }
}

function randomId() {
  return Math.random().toString(16).slice(2, 10) + Math.random().toString(16).slice(2, 6);
}

export default InstanceGuard;
