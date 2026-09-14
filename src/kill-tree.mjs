/**
 * Process-tree termination.
 *
 * Two very different situations, deliberately kept apart:
 *
 *   1. `killTree(pid)` — async. Used while the bridge is alive (`!stop`, task
 *      timeout, `!reset`). Safe to await.
 *   2. `killTreeSync(pid)` — synchronous. Used ONLY from a `process.on('exit')`
 *      handler, where no async work can run any more.
 *
 * `killTreeSync` is the one and only place `spawnSync` is allowed in this
 * repository. The rule in AGENTS.md ("never use spawnSync while a server in the
 * same process has to answer the child") exists because a blocked event loop
 * starves the approval hook. During `exit` the event loop is already over and
 * nothing is waiting on us, so a blocking call is the only thing that can still
 * reap orphans. Do not copy this pattern anywhere else.
 *
 * Killing the tree (`/T`) matters: the agent shell spawns PowerShell / cmd /
 * node grandchildren, and terminating only the direct child leaves those
 * running against the user's machine.
 */

import { spawn, spawnSync } from 'node:child_process';

/** Every child PID this process spawned and has not reaped yet. */
const LIVE = new Set();

export function registerChild(pid) {
  if (pid) LIVE.add(pid);
}

export function unregisterChild(pid) {
  if (pid) LIVE.delete(pid);
}

export function liveChildPids() {
  return [...LIVE];
}

/** Await a full tree kill. Never rejects. Resolves to true when taskkill succeeded. */
export function killTree(pid, { platform = process.platform, timeoutMs = 10000 } = {}) {
  if (!pid) return Promise.resolve(false);
  if (platform !== 'win32') {
    try { process.kill(pid, 'SIGKILL'); return Promise.resolve(true); } catch { return Promise.resolve(false); }
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('exit', (code) => finish(code === 0));
    killer.on('error', () => finish(false));
    const timer = setTimeout(() => finish(false), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

/** Synchronous, last-resort tree kill. Only valid inside `process.on('exit')`. */
export function killTreeSync(pid, { platform = process.platform } = {}) {
  if (!pid) return false;
  try {
    if (platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      try { process.kill(-pid, 'SIGKILL'); } catch { process.kill(pid, 'SIGKILL'); }
    }
    return true;
  } catch {
    return false;
  }
}

/** Reap every child this process still owns. Returns the PIDs it tried to kill. */
export function killAllChildrenSync(opts) {
  const pids = liveChildPids();
  for (const pid of pids) killTreeSync(pid, opts);
  LIVE.clear();
  return pids;
}
