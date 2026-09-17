import crypto from 'node:crypto';

export class ApprovalManager {
  constructor({ timeoutMs }) {
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.sessionAllows = new Set();
    this.presenter = null;
    this.onSettled = null;
  }

  setPresenter(fn) {
    this.presenter = fn;
  }

  /** Called after every decision so the UI can leave the WAITING_APPROVAL state. */
  setSettledHandler(fn) {
    this.onSettled = fn;
  }

  isSessionAllowed(sessionId, ruleKey) {
    return Boolean(sessionId && ruleKey && this.sessionAllows.has(`${sessionId}:${ruleKey}`));
  }

  allowForSession(sessionId, ruleKey) {
    if (sessionId && ruleKey) this.sessionAllows.add(`${sessionId}:${ruleKey}`);
  }

  /** Drop all session grants — used by `!reset` so a reset really re-arms the gate. */
  clearSessionAllows(sessionId = null) {
    if (sessionId == null) {
      const n = this.sessionAllows.size;
      this.sessionAllows.clear();
      return n;
    }
    let n = 0;
    for (const key of [...this.sessionAllows]) {
      if (key.startsWith(`${sessionId}:`)) { this.sessionAllows.delete(key); n += 1; }
    }
    return n;
  }

  #settle(id, answer, meta) {
    if (this.onSettled) {
      try { this.onSettled({ id, answer, meta }); } catch { /* never break the gate */ }
    }
  }

  async request(meta) {
    if (this.isSessionAllowed(meta.sessionId, meta.ruleKey)) {
      return { decision: 'allow', reason: 'approved for session', auto: true };
    }
    if (!this.presenter) return { decision: 'deny', reason: 'approval UI unavailable' };

    const id = crypto.randomBytes(9).toString('hex');
    // APPROVAL_TIMEOUT_MS=0 (default) means no automatic expiry: an unattended
    // run waits for the owner instead of being auto-denied after a fixed window.
    // Stop/reset still cancels every pending gate immediately.
    const bounded = Number.isFinite(this.timeoutMs) && this.timeoutMs > 0;
    return await new Promise((resolve) => {
      const timer = bounded
        ? setTimeout(() => {
          this.pending.delete(id);
          const answer = { decision: 'deny', reason: 'approval timed out' };
          this.#settle(id, answer, meta);
          resolve(answer);
        }, this.timeoutMs)
        : null;

      this.pending.set(id, { resolve, timer, meta });
      Promise.resolve(this.presenter({ id, ...meta })).catch(() => {
        if (timer) clearTimeout(timer);
        this.pending.delete(id);
        const answer = { decision: 'deny', reason: 'failed to present approval request' };
        this.#settle(id, answer, meta);
        resolve(answer);
      });
    });
  }

  resolve(id, action) {
    const item = this.pending.get(id);
    if (!item) return false;
    if (item.timer) clearTimeout(item.timer);
    this.pending.delete(id);

    let answer;
    if (action === 'allow-session') {
      this.allowForSession(item.meta.sessionId, item.meta.ruleKey);
      answer = { decision: 'allow', reason: 'approved for session' };
    } else if (action === 'allow-once') {
      answer = { decision: 'allow', reason: 'approved once' };
    } else {
      answer = { decision: 'deny', reason: 'denied from Discord' };
    }
    this.#settle(id, answer, item.meta);
    item.resolve(answer);
    return true;
  }

  /** Deny every pending request belonging to a session (used by `!stop` / `!reset`). */
  cancelForSession(sessionId, reason = 'cancelled') {
    let n = 0;
    for (const [id, item] of [...this.pending]) {
      if (sessionId && item.meta.sessionId !== sessionId) continue;
      if (item.timer) clearTimeout(item.timer);
      this.pending.delete(id);
      const answer = { decision: 'deny', reason };
      this.#settle(id, answer, item.meta);
      item.resolve(answer);
      n += 1;
    }
    return n;
  }
}
