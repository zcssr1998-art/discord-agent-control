// P2.2.6: runtime freshness / safe self-update core.
//
// This module is deliberately DEPENDENCY-FREE (node builtins + ./secrets.mjs)
// so a candidate commit can be validated inside a temporary `git worktree`
// before it is ever merged into the live checkout.
//
// Ownership model (do NOT create a second daemon):
//
//   Task Scheduler -> Supervisor -> Bridge -> Agent children
//
// Jarvis only *detects and requests* an update. It never replaces its own
// process tree: after a verified fast-forward it exits with RESTART_EXIT_CODE
// and the existing Supervisor relaunches the bridge from the same checkout.
//
// Design rules:
//   - fast-forward only; dirty/diverged checkout fails closed (no stash/reset);
//   - candidate verified in a throwaway worktree before the live checkout moves;
//   - previous known-good SHA recorded before applying;
//   - a bad SHA is quarantined so it cannot cause an update/restart loop;
//   - no secret is ever logged (all messages are redacted).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { redactSecrets } from './secrets.mjs';

export const RESTART_EXIT_CODE = 74;

/** Update lifecycle states surfaced in /status and /doctor. */
export const UPDATE_STATUS = Object.freeze({
  DISABLED: 'DISABLED',
  UP_TO_DATE: 'UP_TO_DATE',
  UPDATE_AVAILABLE: 'UPDATE_AVAILABLE',
  UPDATE_PENDING: 'UPDATE_PENDING',
  UPDATING: 'UPDATING',
  PAUSED: 'PAUSED',
  BLOCKED: 'BLOCKED',
  LAST_UPDATE_FAILED: 'LAST_UPDATE_FAILED',
});

/** Relationship between the live HEAD and the fetched remote branch. */
export const RELATION = Object.freeze({
  UNKNOWN: 'unknown',
  UP_TO_DATE: 'up_to_date',
  AHEAD: 'ahead',
  DIVERGED: 'diverged',
});

const SHA_RE = /^[0-9a-f]{40}$/i;

export function isValidSha(value) {
  return typeof value === 'string' && SHA_RE.test(value.trim());
}

export function shortSha(value) {
  return isValidSha(value) ? value.trim().slice(0, 7) : 'unknown';
}

/** First non-empty line, redacted and length-bounded; safe for logs/UI. */
export function oneLine(text, limit = 200) {
  const line = String(text ?? '').split(/\r?\n/).map((item) => item.trim()).find(Boolean) || '';
  return redactSecrets(line).slice(0, limit);
}

/** Parse `git status --porcelain` into entries, ignoring ignored files. */
export function parsePorcelain(text) {
  const entries = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const code = raw.slice(0, 2);
    const file = raw.slice(3).trim();
    if (!file) continue;
    entries.push({ code, file });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// durable update state
// ---------------------------------------------------------------------------

export function defaultUpdateState() {
  return {
    schemaVersion: 1,
    paused: false,
    pausedAt: null,
    pauseReason: null,
    lastCheckAt: null,
    localSha: null,
    checkoutSha: null,
    remote: null,
    branch: null,
    remoteSha: null,
    relation: RELATION.UNKNOWN,
    dirty: false,
    pendingSha: null,
    previousGoodSha: null,
    appliedSha: null,
    appliedAt: null,
    lastAppliedSha: null,
    lastAppliedAt: null,
    lastVerifiedAt: null,
    applyPendingVerify: false,
    quarantined: null,
    lastFailure: null,
    blockedReason: null,
    schema: null,
    notified: {},
  };
}

function readJson(file, fallback) {
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export class UpdateStateStore {
  constructor(file) {
    this.file = file;
    this.state = { ...defaultUpdateState(), ...readJson(file, {}) };
    if (!this.state.notified || typeof this.state.notified !== 'object') this.state.notified = {};
  }

  save() {
    try { writeJsonAtomic(this.file, this.state); } catch { /* state persistence is best-effort */ }
  }
}

/** Read-only access used by the supervisor-side update helper. */
export function readUpdateState(file) {
  return new UpdateStateStore(file);
}

// ---------------------------------------------------------------------------
// git plumbing (async spawn only; never spawnSync)
// ---------------------------------------------------------------------------

export function runGit(args, { cwd, timeoutMs = 60000, env = null } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('git', args, {
        cwd,
        windowsHide: true,
        env: env || process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ ok: false, code: -1, stdout: '', stderr: String(error?.message || error) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* ignore */ }
      resolve({ ok: false, code: -1, stdout, stderr: `${stderr}\ntimeout after ${timeoutMs}ms`.trim() });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, code: -1, stdout, stderr: String(error?.message || error) });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}

export function runNode(scriptPath, { cwd, nodeExe = process.execPath, timeoutMs = 180000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(nodeExe, [scriptPath], {
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ ok: false, code: -1, stdout: '', stderr: String(error?.message || error) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* ignore */ }
      resolve({ ok: false, code: -1, stdout, stderr: `${stderr}\ntimeout after ${timeoutMs}ms`.trim() });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, code: -1, stdout, stderr: String(error?.message || error) });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}

export async function gitOutput(args, options) {
  const result = await runGit(args, options);
  return result.ok ? result.stdout.trim() : null;
}

// ---------------------------------------------------------------------------
// candidate verification
// ---------------------------------------------------------------------------

/**
 * Verify a candidate SHA in a throwaway detached worktree so the known-good
 * live checkout is never mutated before the candidate passes.
 *
 * The gate is intentionally the minimum deterministic release gate:
 *   - scripts/check-syntax.mjs   (repo-wide syntax, dependency-free)
 *   - scripts/p226-update-smoke.mjs (focused update smoke, dependency-free)
 */
export async function runCandidateGate({
  root,
  sha,
  nodeExe = process.execPath,
  timeoutMs = 180000,
  logger = null,
} = {}) {
  if (!isValidSha(sha)) return { ok: false, reason: `invalid candidate sha: ${oneLine(sha)}` };
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-update-cand-'));
  const dir = path.join(parent, 'candidate');
  const log = (message) => { try { logger?.log?.(message); } catch { /* best effort */ } };
  try {
    const added = await runGit(['worktree', 'add', '--detach', dir, sha], { cwd: root, timeoutMs: 60000 });
    if (!added.ok) return { ok: false, reason: `git worktree add failed: ${oneLine(added.stderr || added.stdout)}` };
    const checks = ['scripts/check-syntax.mjs', 'scripts/p226-update-smoke.mjs'];
    for (const rel of checks) {
      const script = path.join(dir, rel);
      if (!fs.existsSync(script)) return { ok: false, reason: `candidate gate script missing: ${rel}` };
      // check-syntax already covers the whole repo; the focused smoke re-imports
      // the candidate's own updater module, so the gate is self-consistent.
      const result = await runNode(script, { cwd: dir, nodeExe, timeoutMs });
      log(`[update] candidate gate ${rel} -> ${result.ok ? 'PASS' : `FAIL (exit ${result.code})`}`);
      if (!result.ok) {
        return { ok: false, reason: `${rel} failed (exit ${result.code}): ${oneLine(result.stderr || result.stdout)}` };
      }
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `candidate gate error: ${oneLine(error?.message || error)}` };
  } finally {
    try { await runGit(['worktree', 'remove', '--force', dir], { cwd: root, timeoutMs: 30000 }); } catch { /* best effort */ }
    try { await runGit(['worktree', 'prune'], { cwd: root, timeoutMs: 30000 }); } catch { /* best effort */ }
    try { fs.rmSync(parent, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// ---------------------------------------------------------------------------
// pure status derivation (unit-testable)
// ---------------------------------------------------------------------------

/**
 * Map the observed facts to one lifecycle status. Kept pure so the precedence
 * (disabled > paused > in-flight > dirty/diverged/blocked > pending > available
 * > up-to-date) is trivially verifiable.
 */
export function deriveStatus({
  enabled = true,
  paused = false,
  inflight = false,
  relation = RELATION.UNKNOWN,
  dirty = false,
  localSha = null,
  remoteSha = null,
  quarantinedSha = null,
  safe = true,
  fetchOk = true,
} = {}) {
  if (!enabled) return { status: UPDATE_STATUS.DISABLED, blockedReason: null };
  if (!fetchOk) return { status: UPDATE_STATUS.BLOCKED, blockedReason: 'remote fetch unavailable' };
  if (inflight) return { status: UPDATE_STATUS.UPDATING, blockedReason: null };
  if (quarantinedSha && remoteSha && quarantinedSha === remoteSha) {
    return { status: UPDATE_STATUS.BLOCKED, blockedReason: `candidate ${shortSha(quarantinedSha)} is quarantined until the remote SHA changes` };
  }
  if (relation === RELATION.DIVERGED) {
    return { status: UPDATE_STATUS.BLOCKED, blockedReason: 'live checkout has diverged from the configured remote (no auto merge/rebase)' };
  }
  if (localSha && remoteSha && localSha === remoteSha) {
    return { status: UPDATE_STATUS.UP_TO_DATE, blockedReason: null };
  }
  if (relation !== RELATION.AHEAD) {
    return { status: paused ? UPDATE_STATUS.PAUSED : UPDATE_STATUS.UP_TO_DATE, blockedReason: null };
  }
  if (dirty) {
    return { status: UPDATE_STATUS.BLOCKED, blockedReason: 'worktree is dirty; refusing to overwrite local changes' };
  }
  if (paused) return { status: UPDATE_STATUS.PAUSED, blockedReason: null };
  if (!safe) return { status: UPDATE_STATUS.UPDATE_PENDING, blockedReason: null };
  return { status: UPDATE_STATUS.UPDATE_AVAILABLE, blockedReason: null };
}

// ---------------------------------------------------------------------------
// rollback (used by scripts/update-helper.mjs from the Supervisor)
// ---------------------------------------------------------------------------

/**
 * Restore the recorded previous known-good SHA and quarantine the failed
 * candidate. Refuses unless the live HEAD is exactly the applied candidate, so
 * an unrelated local change can never be discarded.
 */
export async function rollbackToPreviousGood({ root, stateFile, reason = 'post-update startup failure' }) {
  const store = new UpdateStateStore(stateFile);
  const state = store.state;
  const previous = state.previousGoodSha;
  const applied = state.appliedSha;
  if (!isValidSha(previous)) return { ok: false, reason: 'no previous known-good SHA recorded' };
  const head = await gitOutput(['rev-parse', 'HEAD'], { cwd: root });
  if (!isValidSha(head)) return { ok: false, reason: 'cannot read live HEAD' };
  if (isValidSha(applied) && head !== applied) {
    return { ok: false, reason: `live HEAD ${shortSha(head)} != applied ${shortSha(applied)}; refusing rollback` };
  }
  const reset = await runGit(['reset', '--hard', previous], { cwd: root, timeoutMs: 60000 });
  if (!reset.ok) return { ok: false, reason: `git reset failed: ${oneLine(reset.stderr || reset.stdout)}` };
  const at = new Date().toISOString();
  state.quarantined = { sha: applied || null, reason: redactSecrets(reason), at };
  state.lastFailure = { sha: applied || null, reason: redactSecrets(`${reason}; rolled back to ${shortSha(previous)}`), at };
  state.applyPendingVerify = false;
  state.appliedSha = null;
  state.pendingSha = null;
  state.localSha = previous;
  state.status = UPDATE_STATUS.LAST_UPDATE_FAILED;
  state.blockedReason = `rolled back to known-good ${shortSha(previous)}`;
  store.save();
  return { ok: true, restoredSha: previous, quarantinedSha: applied || null };
}

// ---------------------------------------------------------------------------
// Updater
// ---------------------------------------------------------------------------

export class Updater {
  constructor({
    root,
    remote = 'origin',
    branch = 'main',
    enabled = true,
    intervalMs = 300000,
    stateFile = null,
    runningSha = null,
    safeToRestart = null,
    onRequestRestart = null,
    onNotify = null,
    onReconcileSchema = null,
    candidateGate = runCandidateGate,
    logger = console,
    now = () => Date.now(),
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    restartExitCode = RESTART_EXIT_CODE,
  } = {}) {
    this.root = root;
    this.remote = String(remote || 'origin');
    this.branch = String(branch || 'main');
    this.enabled = enabled !== false;
    this.intervalMs = Number(intervalMs) > 0 ? Number(intervalMs) : 300000;
    this.stateFile = stateFile || path.join(root, 'data', 'update-state.json');
    // The code the running process actually loaded (build identity at startup).
    // This — not the checkout HEAD — decides whether the runtime is fresh: an
    // externally advanced checkout must never make a stale process look current.
    this.runningSha = isValidSha(runningSha) ? runningSha.trim() : null;
    this.safeToRestart = safeToRestart;
    this.onRequestRestart = onRequestRestart;
    this.onNotify = onNotify;
    this.onReconcileSchema = onReconcileSchema;
    this.candidateGate = candidateGate;
    this.logger = logger;
    this.now = now;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
    this.restartExitCode = restartExitCode;

    this.store = new UpdateStateStore(this.stateFile);
    this.store.state.remote = this.remote;
    this.store.state.branch = this.branch;
    this.inflight = false;
    this.timer = null;
    this.schemaResult = null;
  }

  #log(message) {
    const line = `[update] ${redactSecrets(String(message))}`;
    try { this.logger?.log?.(line); } catch { /* logging must never break the updater */ }
  }

  #safeMessage(reason) {
    return redactSecrets(oneLine(reason));
  }

  statusSnapshot() {
    const s = this.store.state;
    return {
      status: s.status || (this.enabled ? UPDATE_STATUS.UP_TO_DATE : UPDATE_STATUS.DISABLED),
      enabled: this.enabled,
      paused: Boolean(s.paused),
      remote: this.remote,
      branch: this.branch,
      localSha: s.localSha,
      checkoutSha: s.checkoutSha,
      runningSha: this.runningSha,
      remoteSha: s.remoteSha,
      relation: s.relation,
      dirty: Boolean(s.dirty),
      pendingSha: s.pendingSha,
      previousGoodSha: s.previousGoodSha,
      appliedSha: s.appliedSha,
      applyPendingVerify: Boolean(s.applyPendingVerify),
      lastAppliedSha: s.lastAppliedSha,
      lastAppliedAt: s.lastAppliedAt,
      lastVerifiedAt: s.lastVerifiedAt,
      lastCheckAt: s.lastCheckAt,
      quarantinedSha: s.quarantined?.sha ?? null,
      lastFailure: s.lastFailure ?? null,
      blockedReason: s.blockedReason ?? null,
      schema: this.schemaResult ?? s.schema ?? null,
    };
  }

  /** Human-readable multi-line view reused by /status, /doctor and /update. */
  describe() {
    const v = this.statusSnapshot();
    const lines = [
      `Status: ${v.status}${v.enabled ? '' : ' (disabled by config)'}`,
      `Source: ${v.remote}/${v.branch}`,
      `Local : ${shortSha(v.localSha)}  Remote: ${shortSha(v.remoteSha)}${v.relation && v.relation !== 'unknown' ? ` (${v.relation})` : ''}`,
    ];
    if (v.checkoutSha && v.localSha && v.checkoutSha !== v.localSha) {
      lines.push(`Checkout: ${shortSha(v.checkoutSha)} (differs from running ${shortSha(v.localSha)})`);
    }
    if (v.paused) lines.push(`Paused: yes${this.store.state.pauseReason ? ` (${this.store.state.pauseReason})` : ''}`);
    if (v.pendingSha) lines.push(`Pending: ${shortSha(v.pendingSha)}`);
    if (v.previousGoodSha) lines.push(`Known good: ${shortSha(v.previousGoodSha)}`);
    if (v.lastAppliedSha) lines.push(`Last applied: ${shortSha(v.lastAppliedSha)}${v.lastAppliedAt ? ` @ ${v.lastAppliedAt}` : ''}`);
    if (v.quarantinedSha) lines.push(`Quarantined: ${shortSha(v.quarantinedSha)}`);
    if (v.lastFailure?.reason) lines.push(`Last failure: ${this.#safeMessage(v.lastFailure.reason)}`);
    if (v.blockedReason) lines.push(`Blocked: ${this.#safeMessage(v.blockedReason)}`);
    if (v.schema) lines.push(`Command schema: ${v.schema.ok ? 'PASS' : 'FAIL'}${v.schema.workTaskMaxLength != null ? ` · /work task max_length=${v.schema.workTaskMaxLength}` : ''}${v.schema.error ? ` (${this.#safeMessage(v.schema.error)})` : ''}`);
    return lines.join('\n');
  }

  async #head() {
    const head = await gitOutput(['rev-parse', 'HEAD'], { cwd: this.root });
    return isValidSha(head) ? head.trim() : null;
  }

  async #isDirty() {
    const status = await gitOutput(['status', '--porcelain', '--untracked-files=normal'], { cwd: this.root });
    if (status == null) return true;
    return parsePorcelain(status).length > 0;
  }

  async #currentBranch() {
    const name = await gitOutput(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: this.root });
    return name ? name.trim() : null;
  }

  async #isAncestor(ancestor, descendant) {
    const result = await runGit(['merge-base', '--is-ancestor', ancestor, descendant], { cwd: this.root, timeoutMs: 30000 });
    return result.code === 0;
  }

  #notifyOnce(key, event) {
    const notified = this.store.state.notified || (this.store.state.notified = {});
    if (notified[key]) return;
    notified[key] = new Date().toISOString();
    this.store.save();
    Promise.resolve()
      .then(() => this.onNotify?.(event))
      .catch(() => { /* notifications are best-effort */ });
  }

  #block(reason, { notify = false, event = null } = {}) {
    this.store.state.status = UPDATE_STATUS.BLOCKED;
    this.store.state.blockedReason = this.#safeMessage(reason);
    this.store.save();
    this.#log(`blocked: ${this.store.state.blockedReason}`);
    if (notify && event) this.#notifyOnce(event.key, event.payload);
  }

  #fail(candidateSha, reason, { quarantine = true } = {}) {
    const at = new Date().toISOString();
    const clean = this.#safeMessage(reason);
    this.store.state.status = UPDATE_STATUS.LAST_UPDATE_FAILED;
    this.store.state.lastFailure = { sha: candidateSha || null, reason: clean, at };
    this.store.state.pendingSha = null;
    this.store.state.applyPendingVerify = false;
    if (quarantine && candidateSha) this.store.state.quarantined = { sha: candidateSha, reason: clean, at };
    this.store.save();
    this.#log(`failed candidate=${shortSha(candidateSha)}: ${clean}`);
    this.#notifyOnce(`failed:${candidateSha}`, {
      type: 'update-failed',
      sha: candidateSha,
      reason: clean,
    });
  }

  async #safeCheck() {
    if (typeof this.safeToRestart !== 'function') return { safe: true, reasons: [] };
    try {
      const result = await this.safeToRestart();
      if (result && typeof result === 'object') return { safe: Boolean(result.safe), reasons: result.reasons || [] };
      return { safe: Boolean(result), reasons: [] };
    } catch (error) {
      return { safe: false, reasons: [`safe-check error: ${this.#safeMessage(error?.message || error)}`] };
    }
  }

  /**
   * Fetch + evaluate the configured remote. A read-only fetch never mutates the
   * checkout. When the remote is ahead and the runtime is safely idle, the
   * verified fast-forward is applied automatically.
   */
  async refresh({ force = false, reason = 'interval' } = {}) {
    if (this.inflight) return this.statusSnapshot();
    if (!this.enabled) {
      this.store.state.status = UPDATE_STATUS.DISABLED;
      this.store.save();
      return this.statusSnapshot();
    }
    // A verified candidate was already applied and the Supervisor restart was
    // requested. Never re-deploy while that restart is in flight.
    if (this.store.state.applyPendingVerify) {
      this.store.state.status = UPDATE_STATUS.UPDATING;
      this.store.save();
      return this.statusSnapshot();
    }
    const nowMs = this.now();
    if (!force) {
      const last = this.store.state.lastCheckAt ? Date.parse(this.store.state.lastCheckAt) : 0;
      if (last && nowMs - last < this.intervalMs) return this.statusSnapshot();
    }

    if (!fs.existsSync(path.join(this.root, '.git'))) {
      this.#block('not a git checkout');
      return this.statusSnapshot();
    }

    const branchNow = await this.#currentBranch();
    if (!branchNow || branchNow !== this.branch) {
      this.#block(`live checkout branch '${branchNow || 'detached'}' != configured '${this.branch}'`);
      return this.statusSnapshot();
    }

    const checkoutHead = await this.#head();
    if (!checkoutHead) {
      this.#block('cannot read local HEAD');
      return this.statusSnapshot();
    }
    // Freshness is measured against the RUNNING code, not just the checkout.
    const local = this.runningSha || checkoutHead;
    if (!this.runningSha) this.runningSha = checkoutHead;

    this.store.state.checkoutSha = checkoutHead;
    this.store.state.localSha = local;
    this.store.state.remote = this.remote;
    this.store.state.branch = this.branch;
    this.store.state.lastCheckAt = new Date(nowMs).toISOString();
    const dirty = await this.#isDirty();
    this.store.state.dirty = dirty;

    const fetched = await runGit(['fetch', '--quiet', this.remote, this.branch], { cwd: this.root, timeoutMs: 120000 });
    if (!fetched.ok) {
      this.store.state.relation = RELATION.UNKNOWN;
      this.store.save();
      this.#block(`git fetch ${this.remote}/${this.branch} failed: ${oneLine(fetched.stderr || fetched.stdout)}`, {
        notify: true,
        event: { key: 'fetch-failed', payload: { type: 'update-blocked', reason: 'remote fetch failed' } },
      });
      return this.statusSnapshot();
    }

    const remoteSha = await gitOutput(['rev-parse', `${this.remote}/${this.branch}`], { cwd: this.root });
    if (!isValidSha(remoteSha)) {
      this.store.state.relation = RELATION.UNKNOWN;
      this.#block(`cannot resolve ${this.remote}/${this.branch}`);
      return this.statusSnapshot();
    }
    const remoteClean = remoteSha.trim();
    this.store.state.remoteSha = remoteClean;

    // A quarantine only applies to the exact SHA that failed. A new remote SHA
    // (or an explicit owner retry) clears it, so a fixed upstream can retry.
    if (this.store.state.quarantined?.sha && this.store.state.quarantined.sha !== remoteClean) {
      this.store.state.quarantined = null;
    }

    let relation = RELATION.UP_TO_DATE;
    if (local !== remoteClean) {
      const localIsAncestor = await this.#isAncestor(local, remoteClean);
      if (localIsAncestor) relation = RELATION.AHEAD;
      else {
        const remoteIsAncestor = await this.#isAncestor(remoteClean, local);
        relation = remoteIsAncestor ? RELATION.UP_TO_DATE : RELATION.DIVERGED;
      }
    }
    this.store.state.relation = relation;

    const safe = await this.#safeCheck();
    const derived = deriveStatus({
      enabled: this.enabled,
      paused: Boolean(this.store.state.paused),
      inflight: false,
      relation,
      dirty,
      localSha: local,
      remoteSha: remoteClean,
      quarantinedSha: this.store.state.quarantined?.sha ?? null,
      safe: safe.safe,
      fetchOk: true,
    });
    this.store.state.status = derived.status;
    this.store.state.blockedReason = derived.blockedReason;
    this.store.state.pendingSha = derived.status === UPDATE_STATUS.UPDATE_PENDING ? remoteClean : null;

    if (relation === RELATION.AHEAD) {
      this.store.state.pendingSha = (derived.status === UPDATE_STATUS.UPDATE_PENDING || derived.status === UPDATE_STATUS.UPDATE_AVAILABLE)
        ? remoteClean : null;
      if (derived.status === UPDATE_STATUS.UPDATE_PENDING) {
        this.#log(`update pending ${shortSha(local)} -> ${shortSha(remoteClean)} (busy: ${safe.reasons.join(', ') || 'runtime not idle'})`);
        this.#notifyOnce(`pending:${remoteClean}`, {
          type: 'update-pending',
          sha: remoteClean,
          previousSha: local,
          reasons: safe.reasons,
        });
      } else if (derived.status === UPDATE_STATUS.UPDATE_AVAILABLE) {
        this.#log(`update available ${shortSha(local)} -> ${shortSha(remoteClean)}`);
      } else if (derived.status === UPDATE_STATUS.BLOCKED) {
        this.#notifyOnce(`blocked:${remoteClean}`, {
          type: 'update-blocked',
          sha: remoteClean,
          previousSha: local,
          reason: derived.blockedReason,
        });
      }
    }
    this.store.save();
    this.#log(`check(${reason}) local=${shortSha(local)} remote=${shortSha(remoteClean)} relation=${relation} dirty=${dirty} -> ${derived.status}`);

    if (derived.status === UPDATE_STATUS.UPDATE_AVAILABLE) {
      await this.#deploy({ candidateSha: remoteClean, localSha: local });
    }
    return this.statusSnapshot();
  }

  async #deploy({ candidateSha, localSha }) {
    this.inflight = true;
    const state = this.store.state;
    state.status = UPDATE_STATUS.UPDATING;
    state.pendingSha = candidateSha;
    this.store.save();
    try {
      // Re-validate immediately before touching the live checkout.
      const branchNow = await this.#currentBranch();
      if (branchNow !== this.branch) { this.#fail(candidateSha, `branch changed to '${branchNow}' during deploy`); return; }
      const head = await this.#head();
      // The checkout may already be at the candidate (advanced externally or a
      // no-op re-apply); that is still a valid fast-forward target.
      if (head !== localSha && head !== candidateSha) {
        this.#fail(candidateSha, `HEAD moved (${shortSha(head)}) during deploy`, { quarantine: false });
        return;
      }
      const stillAncestor = head === candidateSha ? true : await this.#isAncestor(head, candidateSha);
      if (!stillAncestor) { this.#fail(candidateSha, 'candidate is not a fast-forward descendant', { quarantine: false }); return; }
      if (await this.#isDirty()) { this.#fail(candidateSha, 'worktree became dirty during deploy', { quarantine: false }); return; }

      this.#log(`verifying candidate ${shortSha(candidateSha)} in a staging worktree`);
      const gate = await this.candidateGate({ root: this.root, sha: candidateSha, logger: this.logger });
      if (!gate?.ok) { this.#fail(candidateSha, `candidate verification failed: ${gate?.reason || 'unknown'}`); return; }

      const merged = await runGit(['merge', '--ff-only', candidateSha], { cwd: this.root, timeoutMs: 120000 });
      if (!merged.ok) { this.#fail(candidateSha, `fast-forward merge failed: ${oneLine(merged.stderr || merged.stdout)}`, { quarantine: false }); return; }
      const newHead = await this.#head();
      if (newHead !== candidateSha) { this.#fail(candidateSha, `post-merge HEAD ${shortSha(newHead)} != candidate ${shortSha(candidateSha)}`); return; }

      const at = new Date().toISOString();
      state.previousGoodSha = localSha;
      state.appliedSha = candidateSha;
      state.checkoutSha = candidateSha;
      state.appliedAt = at;
      state.pendingSha = candidateSha;
      state.applyPendingVerify = true;
      state.status = UPDATE_STATUS.UPDATING;
      state.blockedReason = null;
      this.store.save();
      this.#log(`applied ${shortSha(localSha)} -> ${shortSha(candidateSha)}; restarting via the Supervisor`);
      this.#notifyOnce(`applied:${candidateSha}`, {
        type: 'update-applied',
        sha: candidateSha,
        previousSha: localSha,
      });
      if (typeof this.onRequestRestart === 'function') await this.onRequestRestart({ sha: candidateSha, previousSha: localSha });
    } finally {
      this.inflight = false;
    }
  }

  /**
   * Called once at startup. Confirms that a just-applied candidate is actually
   * the code now running and reconciles the Discord command schema. A mismatch
   * (the applied checkout did not become the running process) is recorded, not
   * silently ignored, and pending state is cleared to avoid a restart loop.
   */
  async reconcileAfterRestart() {
    const head = await this.#head();
    if (isValidSha(head)) this.runningSha = head.trim();
    this.store.state.checkoutSha = head;
    this.store.state.localSha = this.runningSha || head;
    if (this.store.state.applyPendingVerify) {
      const applied = this.store.state.appliedSha;
      if (head && applied && head === applied) {
        this.store.state.applyPendingVerify = false;
        this.store.state.lastAppliedSha = applied;
        this.store.state.lastAppliedAt = this.store.state.appliedAt || new Date().toISOString();
        this.store.state.lastVerifiedAt = new Date().toISOString();
        this.store.state.status = UPDATE_STATUS.UP_TO_DATE;
        this.store.state.pendingSha = null;
        this.store.state.blockedReason = null;
        this.store.state.lastFailure = null;
        this.store.state.quarantined = null;
        this.store.save();
        this.#log(`verified running SHA ${shortSha(head)} after restart`);
        this.#notifyOnce(`verified:${applied}`, { type: 'update-verified', sha: applied });
        if (typeof this.onReconcileSchema === 'function') {
          try {
            this.schemaResult = await this.onReconcileSchema();
            this.store.state.schema = this.schemaResult;
            this.store.save();
            this.#log(`command schema reconcile: ${this.schemaResult?.ok ? 'PASS' : 'FAIL'}`);
          } catch (error) {
            this.#log(`command schema reconcile failed: ${this.#safeMessage(error?.message || error)}`);
          }
        }
      } else {
        const reason = `running SHA ${shortSha(head)} != applied ${shortSha(applied)} after restart`;
        this.store.state.applyPendingVerify = false;
        this.store.state.status = UPDATE_STATUS.LAST_UPDATE_FAILED;
        this.store.state.lastFailure = { sha: applied || null, reason, at: new Date().toISOString() };
        this.store.save();
        this.#log(reason);
      }
    }
    this.store.save();
    return this.statusSnapshot();
  }

  pause(reason = 'owner') {
    this.store.state.paused = true;
    this.store.state.pausedAt = new Date().toISOString();
    this.store.state.pauseReason = this.#safeMessage(reason);
    if (this.store.state.status === UPDATE_STATUS.UPDATE_AVAILABLE) this.store.state.status = UPDATE_STATUS.PAUSED;
    this.store.save();
    this.#log('paused');
    return this.statusSnapshot();
  }

  async resume() {
    this.store.state.paused = false;
    this.store.state.pausedAt = null;
    this.store.state.pauseReason = null;
    this.store.save();
    this.#log('resumed');
    return this.refresh({ force: true, reason: 'resume' });
  }

  /** Periodic checker. `force` bypasses the configured interval. */
  async tick() {
    return this.refresh({ force: false, reason: 'interval' });
  }

  async start() {
    if (!this.enabled) {
      this.store.state.status = UPDATE_STATUS.DISABLED;
      this.store.save();
      this.#log('disabled by configuration');
      return this.statusSnapshot();
    }
    this.#log(`enabled source=${this.remote}/${this.branch} intervalMs=${this.intervalMs}`);
    await this.reconcileAfterRestart().catch((error) => this.#log(`reconcile failed: ${this.#safeMessage(error?.message || error)}`));
    await this.refresh({ force: true, reason: 'startup' }).catch((error) => this.#log(`startup check failed: ${this.#safeMessage(error?.message || error)}`));
    const period = Math.max(15000, Math.min(this.intervalMs, 60000));
    this.timer = this.setIntervalFn(() => { this.tick().catch(() => { /* never throw from a timer */ }); }, period);
    if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
    return this.statusSnapshot();
  }

  stop() {
    if (this.timer) {
      try { this.clearIntervalFn(this.timer); } catch { /* best effort */ }
      this.timer = null;
    }
  }
}

export default Updater;
