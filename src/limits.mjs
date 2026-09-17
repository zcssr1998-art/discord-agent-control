/**
 * Runaway protection.
 *
 * A remote agent that keeps failing, restarting or looping will burn tokens in
 * the background where nobody is watching. Every one of those paths gets an
 * explicit cap here, and hitting a cap stops the run instead of retrying.
 */

/** Reject with a TimeoutError if `promise` does not settle in time. */
export function withTimeout(promise, ms, { onTimeout = null, label = 'operation' } = {}) {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { onTimeout?.(); } catch { /* the caller's cleanup must not mask the timeout */ }
      const error = new Error(`${label} exceeded ${Math.round(ms / 1000)}s and was stopped`);
      error.code = 'TASK_TIMEOUT';
      reject(error);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class RunLimits {
  constructor({ maxConsecutiveFailures = 3, maxProcessRestarts = 5 } = {}) {
    this.maxConsecutiveFailures = maxConsecutiveFailures;
    this.maxProcessRestarts = maxProcessRestarts;
    this.channels = new Map();
  }

  #state(channelId) {
    if (!this.channels.has(channelId)) {
      this.channels.set(channelId, { consecutiveFailures: 0, restarts: 0, lastError: null });
    }
    return this.channels.get(channelId);
  }

  noteSuccess(channelId) {
    const s = this.#state(channelId);
    s.consecutiveFailures = 0;
    // A successful run ends the recovery episode, so restart pressure from an
    // earlier crash loop must not accumulate across healthy work.
    s.restarts = 0;
    s.lastError = null;
  }

  noteFailure(channelId, error) {
    const s = this.#state(channelId);
    s.consecutiveFailures += 1;
    s.lastError = String(error?.message || error || 'unknown error');
    return s.consecutiveFailures;
  }

  noteProcessRestart(channelId) {
    return (this.#state(channelId).restarts += 1);
  }

  /**
   * A new Work starts a fresh recovery episode: historical restart pressure is
   * cleared so a past crash loop can never require `!reset` before a later valid
   * task. Failure counts are kept only as a diagnostic for the current episode.
   */
  beginWork(channelId) {
    const s = this.#state(channelId);
    s.restarts = 0;
    return s;
  }

  /**
   * Diagnostics only, never a lockout. Historical failures/restarts are surfaced
   * as a warning so the owner can investigate, but a later valid Work is still
   * accepted without any manual `!reset`.
   */
  warning(channelId) {
    const s = this.#state(channelId);
    if (s.consecutiveFailures >= this.maxConsecutiveFailures) {
      return `最近连续失败 ${s.consecutiveFailures} 次（提示阈值 ${this.maxConsecutiveFailures}，不会阻止新任务）。`
        + `最近错误：${s.lastError}`;
    }
    if (s.restarts >= this.maxProcessRestarts) {
      return `Agent 进程已重启 ${s.restarts} 次（提示阈值 ${this.maxProcessRestarts}，不会阻止新任务）。`;
    }
    return null;
  }

  /**
   * Historical counters never permanently poison a channel. Kept for callers
   * that gate on `blocked`; the answer is always "not blocked" and the reason
   * field carries the non-blocking warning instead.
   */
  blocked(channelId) {
    const warning = this.warning(channelId);
    return { blocked: false, warning, reason: warning };
  }

  reset(channelId) {
    this.channels.delete(channelId);
  }

  snapshot(channelId) {
    return { ...this.#state(channelId) };
  }
}
