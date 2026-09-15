import fs from 'node:fs';
import path from 'node:path';

/**
 * Canonical workspace identity.
 *
 * Two paths that point at the same Windows workspace must collapse to one key:
 *   1. resolve to an absolute path
 *   2. resolve the real path when it is safe to do so
 *   3. normalize trailing separators
 *   4. compare case-insensitively on Windows
 *
 * This deliberately does not inspect the workspace contents: locking a folder is
 * not a reason to walk it.
 */
export function canonicalKey(cwd) {
  const input = String(cwd ?? '').trim();
  let resolved = path.resolve(input || '.');
  try {
    resolved = fs.realpathSync.native(resolved);
  } catch {
    try { resolved = fs.realpathSync(resolved); } catch { /* keep the resolved path */ }
  }
  // `path.resolve` already drops trailing separators except for a bare root;
  // strip any that survive so `D:\Repo\` and `D:\Repo` match.
  if (resolved.length > 3) resolved = resolved.replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function entryView(entry) {
  if (!entry) return null;
  return { channelId: entry.channelId, workspace: entry.workspace, label: entry.label ?? null };
}

/**
 * In-memory FIFO scheduler that guarantees one active Jarvis Work task per
 * canonical workspace while allowing different workspaces to run in parallel.
 *
 * The queue is intentionally not persisted: an active Agent already does not
 * survive a bridge restart, so persisting queued-but-not-started items would add
 * complexity without real recovery value. `run` is only invoked after the item
 * reaches the front of its workspace queue and acquires the lock, so a queued
 * item never creates an Agent.
 */
export class WorkspaceScheduler {
  constructor() {
    /** @type {Map<string, { key: string, active: object|null, queue: object[] }>} */
    this.slots = new Map();
  }

  canonicalKey(cwd) { return canonicalKey(cwd); }

  #slot(key) {
    let slot = this.slots.get(key);
    if (!slot) {
      slot = { key, active: null, queue: [] };
      this.slots.set(key, slot);
    }
    return slot;
  }

  /**
   * Queue (or immediately start) one Work task against a workspace.
   *
   * Returns the entry. The entry settles once the task is done, whether it ran
   * immediately or after waiting for the workspace. `onQueued` is called with the
   * queue position; `onStart` is called once the item acquires the workspace.
   */
  submit({ workspace, channelId = null, run, onQueued = null, onStart = null, label = null }) {
    if (typeof run !== 'function') throw new TypeError('WorkspaceScheduler.submit requires a run function');
    const key = canonicalKey(workspace);
    const slot = this.#slot(key);
    const entry = {
      key, workspace, channelId, run, onQueued, onStart, label,
      state: 'queued', cancelled: false, position: null,
      done: null, settle: null,
    };
    // `done` exists from the moment of submission so a caller can await a queued
    // item before the scheduler gets around to activating it.
    entry.done = new Promise((resolve, reject) => { entry.settle = { resolve, reject }; });
    entry.done.catch(() => {});

    if (slot.active) {
      slot.queue.push(entry);
      entry.position = slot.queue.length;
      // Defer so the caller can attach listeners before the notice fires.
      queueMicrotask(() => {
        if (entry.state !== 'queued') return;
        try { entry.onQueued?.({ position: entry.position, active: entryView(slot.active), key }); }
        catch { /* a notice failure must never affect scheduling */ }
      });
      return entry;
    }

    this.#activate(slot, entry);
    return entry;
  }

  #activate(slot, entry) {
    entry.state = 'active';
    entry.position = null;
    slot.active = entry;
    (async () => {
      try {
        entry.onStart?.({ key: slot.key });
        entry.settle.resolve(await entry.run());
      } catch (error) {
        entry.settle.reject(error);
      } finally {
        this.#release(slot, entry);
      }
    })();
  }

  #release(slot, entry) {
    // Identity guard: a stale release (double-finish) must not free the slot.
    if (slot.active !== entry) return;
    slot.active = null;
    while (slot.queue.length) {
      const next = slot.queue.shift();
      if (next.cancelled) continue;
      slot.queue.forEach((item, index) => { item.position = index + 1; });
      this.#activate(slot, next);
      return;
    }
    // No queued work left; drop the empty slot so `snapshot()` stays clean.
    this.slots.delete(slot.key);
  }

  /**
   * Remove one queued (not yet active) item owned by a channel/thread. Returns
   * the removed entry, or null when that channel has nothing queued. An active
   * task is never touched.
   */
  cancelQueued(channelId) {
    for (const slot of this.slots.values()) {
      const index = slot.queue.findIndex((item) => item.channelId === channelId && !item.cancelled);
      if (index === -1) continue;
      const [entry] = slot.queue.splice(index, 1);
      entry.cancelled = true;
      entry.state = 'cancelled';
      entry.settle.resolve({ cancelled: true });
      slot.queue.forEach((item, i) => { item.position = i + 1; });
      return entry;
    }
    return null;
  }

  /** Current Work state for a channel/thread: idle | running | queued (#N). */
  stateFor(channelId) {
    for (const slot of this.slots.values()) {
      if (slot.active?.channelId === channelId) return { state: 'running', workspace: slot.active.workspace };
      const queued = slot.queue.find((item) => item.channelId === channelId);
      if (queued) return { state: 'queued', position: queued.position, workspace: queued.workspace };
    }
    return { state: 'idle' };
  }

  /**
   * Without an argument: every workspace with active or queued work.
   * With a workspace: just that canonical workspace's slot.
   */
  snapshot(workspace) {
    const view = (slot) => ({
      workspace: slot.key,
      active: entryView(slot.active),
      queued: slot.queue.filter((item) => !item.cancelled).map((item) => entryView(item)),
      queueLength: slot.queue.filter((item) => !item.cancelled).length,
    });
    if (workspace !== undefined) {
      const slot = this.slots.get(canonicalKey(workspace));
      return slot ? view(slot) : { workspace: canonicalKey(workspace), active: null, queued: [], queueLength: 0 };
    }
    return [...this.slots.values()].map(view);
  }
}

export default WorkspaceScheduler;
