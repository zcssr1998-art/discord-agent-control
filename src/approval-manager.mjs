import crypto from 'node:crypto';

export class ApprovalManager {
  constructor({ timeoutMs }) {
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.sessionAllows = new Set();
    this.presenter = null;
  }

  setPresenter(fn) {
    this.presenter = fn;
  }

  isSessionAllowed(sessionId, ruleKey) {
    return Boolean(sessionId && ruleKey && this.sessionAllows.has(`${sessionId}:${ruleKey}`));
  }

  allowForSession(sessionId, ruleKey) {
    if (sessionId && ruleKey) this.sessionAllows.add(`${sessionId}:${ruleKey}`);
  }

  async request(meta) {
    if (this.isSessionAllowed(meta.sessionId, meta.ruleKey)) {
      return { decision: 'allow', reason: 'approved for session' };
    }
    if (!this.presenter) return { decision: 'deny', reason: 'approval UI unavailable' };

    const id = crypto.randomBytes(9).toString('hex');
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ decision: 'deny', reason: 'approval timed out' });
      }, this.timeoutMs);

      this.pending.set(id, { resolve, timer, meta });
      Promise.resolve(this.presenter({ id, ...meta })).catch(() => {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ decision: 'deny', reason: 'failed to present approval request' });
      });
    });
  }

  resolve(id, action) {
    const item = this.pending.get(id);
    if (!item) return false;
    clearTimeout(item.timer);
    this.pending.delete(id);

    if (action === 'allow-session') {
      this.allowForSession(item.meta.sessionId, item.meta.ruleKey);
      item.resolve({ decision: 'allow', reason: 'approved for session' });
    } else if (action === 'allow-once') {
      item.resolve({ decision: 'allow', reason: 'approved once' });
    } else {
      item.resolve({ decision: 'deny', reason: 'denied from Discord' });
    }
    return true;
  }
}
